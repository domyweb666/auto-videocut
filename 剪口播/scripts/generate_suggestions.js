#!/usr/bin/env node
/**
 * 從 diff_report.json 生成結構化學習建議
 *
 * 輸入: diff_report.json (單支) 或多個 diff_report.json (批量)
 * 輸出: suggestions array，每項包含：
 *   - 規則類別、目前設定、AI做法、SRT顯示、建議修改、具體範例
 *
 * 用法:
 *   單支: node generate_suggestions.js <diff_report.json> [training_config.json]
 *   批量: node generate_suggestions.js --batch <dir> [training_config.json]
 */

const fs = require('fs');
const path = require('path');

module.exports = { generateSuggestions, generateBatchSuggestions };

// ── 主函數 ──
function generateSuggestions(diffReport, config) {
  const suggestions = [];
  const fps = diffReport.falsePositives || [];  // AI 刪了，SRT 保留
  const fns = diffReport.falseNegatives || [];  // AI 沒刪，SRT 刪了

  // 1. 靜音閾值分析
  const silFPs = fps.filter(e => e.isGap);
  const silFNs = fns.filter(e => e.isGap);
  if (silFPs.length > 0 || silFNs.length > 0) {
    suggestions.push(...analyzeSilence(silFPs, silFNs, config));
  }

  // 2. 語氣詞分析（AI 刪了但 SRT 保留）
  const fillerWords = config.filler_words || [];
  const fillerFPs = fps.filter(e => !e.isGap && fillerWords.includes(e.text));
  if (fillerFPs.length > 0) {
    suggestions.push(...analyzeFillers(fillerFPs, fillerWords, config));
  }

  // 3. 受保護詞被 AI 標記（FP 中有連接詞）
  // 這裡只列出供人工確認，不自動建議刪除
  const nonGapFPs = fps.filter(e => !e.isGap && !fillerWords.includes(e.text));
  if (nonGapFPs.length > 0) {
    suggestions.push(...analyzeNonGapFPs(nonGapFPs, config));
  }

  // 4. AI 漏刪的文字（FN 中的非靜音）
  const textFNs = fns.filter(e => !e.isGap);
  if (textFNs.length > 0) {
    suggestions.push(...analyzeTextFNs(textFNs, config));
  }

  return suggestions;
}

// ── 批量分析 ──
function generateBatchSuggestions(diffReports, config) {
  // 合併所有 diff，再整體分析
  const merged = {
    falsePositives: [],
    falseNegatives: [],
    aiCount: 0,
    userCount: 0,
    _videoCount: diffReports.length,
    _perVideo: []
  };

  for (const report of diffReports) {
    merged.falsePositives.push(...(report.falsePositives || []).map(e => ({
      ...e, _video: report._videoName || report.srtFile || report.source || '?'
    })));
    merged.falseNegatives.push(...(report.falseNegatives || []).map(e => ({
      ...e, _video: report._videoName || report.srtFile || report.source || '?'
    })));
    merged.aiCount += report.aiCount || 0;
    merged.userCount += report.userCount || 0;
    merged._perVideo.push({
      name: report._videoName || report.srtFile,
      fp: (report.falsePositives || []).length,
      fn: (report.falseNegatives || []).length,
      precision: report.accuracy?.precision,
      recall: report.accuracy?.recall
    });
  }

  const suggestions = generateSuggestions(merged, config);

  // 為批量模式新增 sampleCount
  suggestions.forEach(s => {
    s.sampleCount = s.examples ? s.examples.length : 0;
    s.videoCount = diffReports.length;
    // 批量模式：≥10 樣本才建議
    if (s.sampleCount < 3) s.hidden = true;
  });

  return suggestions.filter(s => !s.hidden);
}

// ── 靜音閾值分析 ──
function analyzeSilence(silFPs, silFNs, config) {
  const currentThreshold = config.silence?.threshold ?? 1.0;
  const suggestions = [];

  // FP（AI 刪了但 SRT 保留）：哪些靜音時長被誤刪？
  if (silFPs.length > 0) {
    const durations = silFPs.map(e => ({
      start: e.start,
      duration: (e.end || e.start + 1) - e.start,
      _video: e._video
    })).sort((a, b) => a.duration - b.duration);

    const maxFPDuration = Math.max(...durations.map(d => d.duration));
    const avgFPDuration = durations.reduce((s, d) => s + d.duration, 0) / durations.length;

    // 建議新閾值 = max 誤刪靜音 + 0.1s（向上取整到 0.1s）
    const suggestedThreshold = Math.round((maxFPDuration + 0.1) * 10) / 10;

    if (suggestedThreshold !== currentThreshold && suggestedThreshold > currentThreshold) {
      const buckets = groupByBucket(durations.map(d => d.duration), 0.2);

      suggestions.push({
        id: 'silence-threshold-raise',
        category: '靜音閾值',
        ruleFile: '3-静音段处理.md',
        configPath: 'silence.threshold',
        icon: '🔇',
        severity: silFPs.length >= 5 ? 'high' : 'medium',

        current: `≥${currentThreshold}s 自動刪除`,
        aiAction: `AI 刪除了 ${silFPs.length} 段靜音（≥${currentThreshold}s）`,
        srtShows: `SRT 保留了其中 ${silFPs.length} 段（最長 ${maxFPDuration.toFixed(1)}s，平均 ${avgFPDuration.toFixed(1)}s）`,
        suggestion: `將靜音閾值從 ${currentThreshold}s 提高到 ${suggestedThreshold}s`,
        change: { path: 'silence.threshold', from: currentThreshold, to: suggestedThreshold },

        examples: durations.slice(-8).map(d => ({  // 顯示最長的 8 個
          label: `靜音 ${d.duration.toFixed(1)}s`,
          at: `@${d.start.toFixed(1)}s`,
          aiAction: '❌ 刪除',
          srtAction: '✅ SRT 保留',
          video: d._video
        })),

        distribution: buckets,  // 時長分佈，用於繪圖
        checked: false
      });
    }
  }

  // FN（AI 沒刪但 SRT 刪了）：有沒有應刪的短靜音？
  if (silFNs.length > 0) {
    const durations = silFNs.map(e => ({
      start: e.start,
      duration: (e.end || e.start + 0.5) - e.start,
      _video: e._video
    }));
    const avgFNDuration = durations.reduce((s, d) => s + d.duration, 0) / durations.length;

    if (avgFNDuration < currentThreshold - 0.1) {
      const suggestedThreshold = Math.round((avgFNDuration - 0.05) * 10) / 10;
      if (suggestedThreshold >= 0.2) {
        suggestions.push({
          id: 'silence-threshold-lower',
          category: '靜音閾值',
          ruleFile: '3-静音段处理.md',
          configPath: 'silence.threshold',
          icon: '✂️',
          severity: silFNs.length >= 5 ? 'high' : 'low',

          current: `≥${currentThreshold}s 自動刪除`,
          aiAction: `AI 保留了 ${silFNs.length} 段靜音（<${currentThreshold}s）`,
          srtShows: `SRT 刪除了這些靜音（平均 ${avgFNDuration.toFixed(1)}s）`,
          suggestion: `將靜音閾值從 ${currentThreshold}s 降低到 ${suggestedThreshold}s`,
          change: { path: 'silence.threshold', from: currentThreshold, to: suggestedThreshold },

          examples: durations.slice(0, 6).map(d => ({
            label: `靜音 ${d.duration.toFixed(1)}s`,
            at: `@${d.start.toFixed(1)}s`,
            aiAction: '✅ 保留',
            srtAction: '❌ SRT 刪除',
            video: d._video
          })),
          checked: false
        });
      }
    }
  }

  return suggestions;
}

// ── 語氣詞分析 ──
function analyzeFillers(fillerFPs, fillerWords, config) {
  const suggestions = [];
  const byWord = {};
  for (const fp of fillerFPs) {
    byWord[fp.text] = byWord[fp.text] || [];
    byWord[fp.text].push(fp);
  }

  for (const [word, instances] of Object.entries(byWord)) {
    if (instances.length < 2) continue;  // 至少 2 個才列出
    suggestions.push({
      id: `filler-keep-${word}`,
      category: '語氣詞保留',
      ruleFile: '2-语气词检测.md',
      configPath: 'filler_exceptions',
      icon: '💬',
      severity: instances.length >= 5 ? 'high' : 'medium',

      current: `「${word}」在語氣詞清單中，一律刪除`,
      aiAction: `AI 刪除了 ${instances.length} 個「${word}」`,
      srtShows: `SRT 保留了所有 ${instances.length} 個「${word}」`,
      suggestion: `將「${word}」加入語氣詞例外清單（保留）`,
      change: { path: 'filler_exceptions', action: 'add', value: word },

      examples: instances.slice(0, 6).map(fp => ({
        label: `「${word}」`,
        at: `@${fp.start.toFixed(1)}s`,
        aiAction: '❌ 刪除',
        srtAction: '✅ SRT 保留',
        video: fp._video
      })),
      checked: false
    });
  }

  return suggestions;
}

// ── 非語氣詞的 FP（AI 標了但 SRT 保留）──
function analyzeNonGapFPs(fps, config) {
  if (fps.length === 0) return [];

  // 按詞語分組，找出高頻被誤刪的詞
  const byText = {};
  for (const fp of fps) {
    if (!fp.text || fp.text.length > 5) continue;  // 忽略長文字（可能是殘句）
    byText[fp.text] = byText[fp.text] || [];
    byText[fp.text].push(fp);
  }

  const suggestions = [];
  for (const [text, instances] of Object.entries(byText)) {
    if (instances.length < 2) continue;
    suggestions.push({
      id: `protect-word-${text}`,
      category: '保護詞彙',
      ruleFile: '10-保留連接詞.md',
      configPath: null,  // 需要手動編輯 .md 檔
      icon: '🛡️',
      severity: instances.length >= 3 ? 'high' : 'low',

      current: `「${text}」未在保護清單中`,
      aiAction: `AI 刪除了 ${instances.length} 個「${text}」`,
      srtShows: `SRT 全部保留（${instances.length} 次）`,
      suggestion: `將「${text}」加入保護詞清單（10-保留連接詞.md）`,
      change: { path: 'protected_words', action: 'add_to_md', value: text, file: '用户习惯/10-保留連接詞.md' },

      examples: instances.slice(0, 5).map(fp => ({
        label: `「${text}」`,
        at: `@${fp.start.toFixed(1)}s`,
        aiAction: '❌ 刪除',
        srtAction: '✅ SRT 保留',
        video: fp._video
      })),
      checked: false
    });
  }

  return suggestions;
}

// ── AI 漏刪的文字 FN（SRT 刪了但 AI 沒刪）──
// 將連續被刪的字合併為短語，避免單字碎片（如「個」「元」）產生無意義建議
function analyzeTextFNs(fns, config) {
  if (fns.length === 0) return [];

  // Step 1: 按影片分組，將連續 FN 合併成短語
  const byVideo = {};
  for (const fn of fns) {
    const vid = fn._video || '_default';
    if (!byVideo[vid]) byVideo[vid] = [];
    byVideo[vid].push(fn);
  }

  const allPhrases = [];
  for (const [vid, videoFns] of Object.entries(byVideo)) {
    // 按原始索引排序
    videoFns.sort((a, b) => (a.idx != null && b.idx != null) ? a.idx - b.idx : a.start - b.start);

    let phrase = { texts: [videoFns[0].text || ''], start: videoFns[0].start, end: videoFns[0].end, _video: vid };

    for (let i = 1; i < videoFns.length; i++) {
      const prev = videoFns[i - 1];
      const curr = videoFns[i];
      // 連續條件：idx 差 ≤2（容許中間有 gap）且時間差 < 2s
      const idxClose = (curr.idx != null && prev.idx != null) ? (curr.idx - prev.idx) <= 2 : false;
      const timeClose = (curr.start - (prev.end || prev.start)) < 2;

      if (idxClose && timeClose) {
        phrase.texts.push(curr.text || '');
        phrase.end = curr.end;
      } else {
        allPhrases.push({ text: phrase.texts.join(''), start: phrase.start, _video: phrase._video });
        phrase = { texts: [curr.text || ''], start: curr.start, end: curr.end, _video: vid };
      }
    }
    allPhrases.push({ text: phrase.texts.join(''), start: phrase.start, _video: phrase._video });
  }

  // Step 2: 統計短語頻率
  // - 跳過單字碎片（length ≤ 1）
  // - 跳過過長短語（> 12 字，通常是整段刪除，不是可歸納的模式）
  const byPhrase = {};
  for (const p of allPhrases) {
    if (!p.text || p.text.length > 12 || p.text.length <= 1) continue;
    byPhrase[p.text] = byPhrase[p.text] || [];
    byPhrase[p.text].push(p);
  }

  const suggestions = [];
  for (const [text, instances] of Object.entries(byPhrase)) {
    if (instances.length < 3) continue;  // ≥3 次出現才建議
    suggestions.push({
      id: `delete-pattern-${text}`,
      category: '應刪模式',
      ruleFile: null,
      configPath: null,
      icon: '✂️',
      severity: instances.length >= 5 ? 'high' : 'medium',

      current: `「${text}」未在任何刪除規則中`,
      aiAction: `AI 保留了 ${instances.length} 個「${text}」`,
      srtShows: `SRT 刪除了所有 ${instances.length} 個`,
      suggestion: `將「${text}」加入刪除模式清單`,
      change: { path: 'delete_patterns', action: 'add', value: text },

      examples: instances.slice(0, 5).map(p => ({
        label: `「${text}」`,
        at: `@${p.start.toFixed(1)}s`,
        aiAction: '✅ 保留',
        srtAction: '❌ SRT 刪除',
        video: p._video
      })),
      checked: false
    });
  }

  // 按出現次數排序（高→低）
  suggestions.sort((a, b) => {
    const aCount = parseInt(a.aiAction.match(/\d+/)?.[0] || 0);
    const bCount = parseInt(b.aiAction.match(/\d+/)?.[0] || 0);
    return bCount - aCount;
  });

  return suggestions;
}

// ── 工具函數 ──
function groupByBucket(values, bucketSize) {
  const buckets = {};
  for (const v of values) {
    const key = (Math.floor(v / bucketSize) * bucketSize).toFixed(1);
    buckets[key] = (buckets[key] || 0) + 1;
  }
  return buckets;
}

// ── CLI 入口 ──
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--batch') {
    const dir = args[1];
    const configPath = args[2] || path.join(__dirname, '..', 'training_config.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const reports = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f.includes('diff_report'))
      .map(f => { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); r._videoName = f.replace('diff_report_','').replace('.json',''); return r; });
    const suggestions = generateBatchSuggestions(reports, config);
    console.log(JSON.stringify(suggestions, null, 2));
  } else {
    const diffFile = args[0];
    const configPath = args[1] || path.join(__dirname, '..', 'training_config.json');
    const diff = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const suggestions = generateSuggestions(diff, config);
    console.log(JSON.stringify(suggestions, null, 2));
  }
}
