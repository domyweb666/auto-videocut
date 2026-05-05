#!/usr/bin/env node
/**
 * 匯出訓練摘要供 Claude Code 分析剪輯風格
 *
 * 讀取 training_output 下所有 diff_report.json，
 * 合併 FP/FN 模式，附帶上下文範例，輸出結構化摘要。
 *
 * 用法: node summarize_training.js [training_output_dir]
 * 輸出: training_output/style_summary.json + style_summary.md
 */

const fs = require('fs');
const path = require('path');

const TRAINING_DIR = path.resolve(process.argv[2] || 'training_output');

// ── 收集所有 diff_report + words 資料 ──
function collectData() {
  if (!fs.existsSync(TRAINING_DIR)) {
    console.error(`❌ 找不到目錄: ${TRAINING_DIR}`);
    process.exit(1);
  }

  const videos = [];
  for (const dir of fs.readdirSync(TRAINING_DIR)) {
    const fullDir = path.join(TRAINING_DIR, dir);
    if (!fs.statSync(fullDir).isDirectory()) continue;

    const diffPath = path.join(fullDir, '2_分析', 'diff_report.json');
    const wordsPath = path.join(fullDir, '1_轉錄', 'subtitles_words.json');

    if (!fs.existsSync(diffPath)) continue;

    const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
    diff._videoName = dir;

    // 載入原始 words（用於提供上下文）
    let words = null;
    if (fs.existsSync(wordsPath)) {
      words = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
    }

    videos.push({ name: dir, diff, words });
  }

  return videos;
}

// ── 取得某個 idx 前後的上下文文字 ──
function getContext(words, idx, windowSize = 5) {
  if (!words) return { before: '', after: '' };

  const beforeParts = [];
  const afterParts = [];

  // 往前取 windowSize 個非 gap 元素
  let count = 0;
  for (let j = idx - 1; j >= 0 && count < windowSize; j--) {
    if (!words[j].isGap) {
      beforeParts.unshift(words[j].text);
      count++;
    }
  }

  // 往後取 windowSize 個非 gap 元素
  count = 0;
  for (let j = idx + 1; j < words.length && count < windowSize; j++) {
    if (!words[j].isGap) {
      afterParts.push(words[j].text);
      count++;
    }
  }

  return {
    before: beforeParts.join(''),
    after: afterParts.join('')
  };
}

// ── 主流程 ──
function main() {
  const videos = collectData();
  if (videos.length === 0) {
    console.error('❌ 找不到任何 diff_report.json');
    process.exit(1);
  }

  console.error(`📊 讀取 ${videos.length} 支影片的訓練資料`);

  // ── 合併指標 ──
  let totalTP = 0, totalFP = 0, totalFN = 0;
  const allFPs = [];  // { text, isGap, reason, duration, video, context }
  const allFNs = [];
  const categoryStats = {};
  const silenceDistribution = {};

  for (const { name, diff, words } of videos) {
    const fps = diff.falsePositives || [];
    const fns = diff.falseNegatives || [];
    const tp = diff.truePositiveCount || (diff.aiCount - fps.length);

    totalTP += tp;
    totalFP += fps.length;
    totalFN += fns.length;

    // 收集 FP 帶上下文
    for (const fp of fps) {
      const ctx = getContext(words, fp.idx);
      allFPs.push({
        text: fp.isGap ? `[靜音 ${((fp.end || 0) - (fp.start || 0)).toFixed(1)}s]` : fp.text,
        isGap: fp.isGap || false,
        reason: fp.reason || '',
        duration: fp.isGap ? (fp.end || 0) - (fp.start || 0) : 0,
        video: name,
        context: ctx,
        start: fp.start
      });
    }

    // 收集 FN 帶上下文
    for (const fn of fns) {
      const ctx = getContext(words, fn.idx);
      allFNs.push({
        text: fn.isGap ? `[靜音 ${((fn.end || 0) - (fn.start || 0)).toFixed(1)}s]` : fn.text,
        isGap: fn.isGap || false,
        reason: fn.reason || '',
        duration: fn.isGap ? (fn.end || 0) - (fn.start || 0) : 0,
        video: name,
        context: ctx,
        start: fn.start
      });
    }

    // 合併分類統計
    if (diff.categoryStats) {
      for (const [cat, stats] of Object.entries(diff.categoryStats)) {
        if (!categoryStats[cat]) categoryStats[cat] = { tp: 0, fp: 0, fn: 0 };
        categoryStats[cat].tp += stats.tp || 0;
        categoryStats[cat].fp += stats.fp || 0;
        categoryStats[cat].fn += stats.fn || 0;
      }
    }

    // 合併靜音分佈
    if (diff.silenceAnalysis?.distribution) {
      for (const [bucket, counts] of Object.entries(diff.silenceAnalysis.distribution)) {
        if (!silenceDistribution[bucket]) silenceDistribution[bucket] = { kept: 0, deleted: 0 };
        silenceDistribution[bucket].kept += counts.kept || 0;
        silenceDistribution[bucket].deleted += counts.deleted || 0;
      }
    }
  }

  // ── 計算各規則表現 ──
  const rulePerformance = {};
  for (const [cat, stats] of Object.entries(categoryStats)) {
    const p = stats.tp / (stats.tp + stats.fp) || 0;
    const r = stats.tp / (stats.tp + stats.fn) || 0;
    rulePerformance[cat] = {
      precision: Math.round(p * 1000) / 10,
      recall: Math.round(r * 1000) / 10,
      f1: Math.round(2 * p * r / (p + r || 1) * 1000) / 10,
      tp: stats.tp, fp: stats.fp, fn: stats.fn
    };
  }

  // ── FP 分析：按文字+規則分組 ──
  const fpGroups = {};
  for (const fp of allFPs) {
    if (fp.text.length <= 1 && !fp.isGap) continue; // 跳過單字碎片
    const key = fp.isGap ? `[靜音]|${fp.reason.split(' ')[0]}` : `${fp.text}|${fp.reason.split(':')[0].split('(')[0].trim()}`;
    if (!fpGroups[key]) fpGroups[key] = { text: fp.text, rule: fp.reason.split(':')[0].split('(')[0].trim(), count: 0, examples: [] };
    fpGroups[key].count++;
    if (fpGroups[key].examples.length < 5) {
      fpGroups[key].examples.push({
        video: fp.video,
        at: `@${(fp.start || 0).toFixed(1)}s`,
        contextBefore: fp.context.before,
        contextAfter: fp.context.after,
        fullReason: fp.reason
      });
    }
  }

  const topFPPatterns = Object.values(fpGroups)
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  // ── FN 分析：合併連續 FN 成短語 ──
  // 先按影片分組，連續 FN 合併
  const fnPhrases = {};
  const fnByVideo = {};
  for (const fn of allFNs) {
    if (!fnByVideo[fn.video]) fnByVideo[fn.video] = [];
    fnByVideo[fn.video].push(fn);
  }

  for (const [vid, fns] of Object.entries(fnByVideo)) {
    // 合併連續的非 gap FN
    let phrase = null;
    for (const fn of fns) {
      if (fn.isGap) {
        if (phrase && phrase.text.length > 1) {
          const key = phrase.text.length > 12 ? phrase.text.slice(0, 12) + '...' : phrase.text;
          if (!fnPhrases[key]) fnPhrases[key] = { text: key, count: 0, examples: [] };
          fnPhrases[key].count++;
          if (fnPhrases[key].examples.length < 5) {
            fnPhrases[key].examples.push({ video: vid, at: `@${phrase.start.toFixed(1)}s`, contextBefore: phrase.contextBefore, contextAfter: phrase.contextAfter });
          }
        }
        phrase = null;
        continue;
      }
      if (!phrase) {
        phrase = { text: fn.text, start: fn.start || 0, contextBefore: fn.context.before, contextAfter: fn.context.after };
      } else {
        phrase.text += fn.text;
        phrase.contextAfter = fn.context.after;
      }
    }
    if (phrase && phrase.text.length > 1) {
      const key = phrase.text.length > 12 ? phrase.text.slice(0, 12) + '...' : phrase.text;
      if (!fnPhrases[key]) fnPhrases[key] = { text: key, count: 0, examples: [] };
      fnPhrases[key].count++;
      if (fnPhrases[key].examples.length < 5) {
        fnPhrases[key].examples.push({ video: vid, at: `@${phrase.start.toFixed(1)}s`, contextBefore: phrase.contextBefore, contextAfter: phrase.contextAfter });
      }
    }
  }

  const topFNPatterns = Object.values(fnPhrases)
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  // ── 整體指標 ──
  const precision = totalTP / (totalTP + totalFP) || 0;
  const recall = totalTP / (totalTP + totalFN) || 0;
  const f1 = 2 * precision * recall / (precision + recall) || 0;

  // ── 輸出 JSON ──
  const summary = {
    generatedAt: new Date().toISOString(),
    videoCount: videos.length,
    videoNames: videos.map(v => v.name),
    overallMetrics: {
      precision: Math.round(precision * 1000) / 10,
      recall: Math.round(recall * 1000) / 10,
      f1: Math.round(f1 * 1000) / 10,
      tp: totalTP, fp: totalFP, fn: totalFN
    },
    rulePerformance,
    topFPPatterns,
    topFNPatterns,
    silenceDistribution,
    fpSummary: {
      total: allFPs.length,
      gapCount: allFPs.filter(f => f.isGap).length,
      textCount: allFPs.filter(f => !f.isGap).length,
      significantCount: allFPs.filter(f => f.isGap || f.text.length >= 3).length
    },
    fnSummary: {
      total: allFNs.length,
      gapCount: allFNs.filter(f => f.isGap).length,
      textCount: allFNs.filter(f => !f.isGap).length,
      significantCount: allFNs.filter(f => f.isGap || f.text.length >= 3).length
    }
  };

  const jsonPath = path.join(TRAINING_DIR, 'style_summary.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  // ── 輸出可讀 Markdown ──
  let md = `# 剪輯風格分析摘要\n\n`;
  md += `生成時間: ${summary.generatedAt}\n`;
  md += `影片數: ${summary.videoCount} (${summary.videoNames.join(', ')})\n\n`;

  md += `## 整體表現\n\n`;
  md += `| 指標 | 值 |\n|------|------|\n`;
  md += `| 精確率 | ${summary.overallMetrics.precision}% |\n`;
  md += `| 召回率 | ${summary.overallMetrics.recall}% |\n`;
  md += `| F1 | ${summary.overallMetrics.f1}% |\n`;
  md += `| TP | ${totalTP} | FP | ${totalFP} | FN | ${totalFN} |\n\n`;

  md += `## 各規則表現\n\n`;
  md += `| 規則 | 精確率 | 召回率 | F1 | FP | FN |\n`;
  md += `|------|--------|--------|------|------|------|\n`;
  for (const [cat, perf] of Object.entries(rulePerformance).sort((a, b) => (b[1].fp + b[1].fn) - (a[1].fp + a[1].fn))) {
    md += `| ${cat} | ${perf.precision}% | ${perf.recall}% | ${perf.f1}% | ${perf.fp} | ${perf.fn} |\n`;
  }

  md += `\n## Top FP 模式（AI 刪了但使用者保留）\n\n`;
  for (const fp of topFPPatterns.slice(0, 15)) {
    md += `### ${fp.text} — ${fp.count} 次 (規則: ${fp.rule})\n`;
    for (const ex of fp.examples.slice(0, 3)) {
      md += `- ${ex.video} ${ex.at}: ...${ex.contextBefore}**[${fp.text}]**${ex.contextAfter}...\n`;
      if (ex.fullReason) md += `  規則判斷: ${ex.fullReason}\n`;
    }
    md += '\n';
  }

  md += `## Top FN 模式（使用者刪了但 AI 沒抓到）\n\n`;
  for (const fn of topFNPatterns.slice(0, 15)) {
    md += `### 「${fn.text}」 — ${fn.count} 次\n`;
    for (const ex of fn.examples.slice(0, 3)) {
      md += `- ${ex.video} ${ex.at}: ...${ex.contextBefore}**[${fn.text}]**${ex.contextAfter}...\n`;
    }
    md += '\n';
  }

  md += `## 靜音時長分佈\n\n`;
  md += `| 時長 | 使用者保留 | 使用者刪除 | 保留率 |\n`;
  md += `|------|-----------|-----------|--------|\n`;
  for (const [bucket, d] of Object.entries(silenceDistribution).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    const total = d.kept + d.deleted;
    md += `| ${bucket}s | ${d.kept} | ${d.deleted} | ${total > 0 ? Math.round(d.kept / total * 100) : '-'}% |\n`;
  }

  const mdPath = path.join(TRAINING_DIR, 'style_summary.md');
  fs.writeFileSync(mdPath, md);

  console.error(`✅ 已生成:`);
  console.error(`   ${jsonPath}`);
  console.error(`   ${mdPath}`);
  console.error(`   影片數: ${summary.videoCount}`);
  console.error(`   整體 F1: ${summary.overallMetrics.f1}%`);
  console.error(`   FP: ${totalFP} (靜音${summary.fpSummary.gapCount}/文字${summary.fpSummary.textCount})`);
  console.error(`   FN: ${totalFN} (靜音${summary.fnSummary.gapCount}/文字${summary.fnSummary.textCount})`);
}

main();
