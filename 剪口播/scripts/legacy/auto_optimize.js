#!/usr/bin/env node
/**
 * 自動優化器（autoresearch 風格）
 *
 * 核心邏輯：
 * 1. 讀取已有的轉錄數據（不花錢）
 * 2. 自動搜索最佳參數組合
 * 3. 每次實驗：修改 config → 跑 auto_select → compare → 算 F1
 * 4. 保留最佳參數，丟棄劣化的
 *
 * 用法: node auto_optimize.js [training_output_dir]
 * 預設: ./training_output
 *
 * 前提：至少需要一支影片的 subtitles_words.json + edited_words.json
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const TRAINING_DIR = path.resolve(process.argv[2] || 'training_output');
const CONFIG_PATH = path.join(SCRIPT_DIR, '..', 'training_config.json');

// ── 找出所有有完整轉錄的影片 ──
function findReadyVideos() {
  if (!fs.existsSync(TRAINING_DIR)) return [];
  const videos = [];
  for (const dir of fs.readdirSync(TRAINING_DIR)) {
    const fullDir = path.join(TRAINING_DIR, dir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    const subsPath = path.join(fullDir, '1_轉錄', 'subtitles_words.json');
    const editedPath = path.join(fullDir, '2_分析', 'edited_words.json');
    if (fs.existsSync(subsPath) && fs.existsSync(editedPath)) {
      videos.push({ name: dir, subsPath, editedPath, analysisDir: path.join(fullDir, '2_分析') });
    }
  }
  return videos;
}

// ── 用指定 config 跑一次完整評估，回傳平均 F1 ──
function evaluate(config, videos) {
  // 暫存 config
  const tmpConfig = path.join(SCRIPT_DIR, '..', 'training_config.json');
  const backup = fs.existsSync(tmpConfig) ? fs.readFileSync(tmpConfig, 'utf8') : null;
  fs.writeFileSync(tmpConfig, JSON.stringify(config, null, 2));

  let totalTP = 0, totalFP = 0, totalFN = 0;

  try {
    for (const v of videos) {
      // Step 1: auto_select_rules
      const autoPath = path.join(v.analysisDir, '_opt_auto.json');
      execFileSync('node', [
        path.join(SCRIPT_DIR, 'auto_select_rules.js'),
        v.subsPath,
        autoPath
      ], { stdio: 'pipe' });

      // Step 2: compare_transcriptions
      const diffOutput = execFileSync('node', [
        path.join(SCRIPT_DIR, 'compare_transcriptions.js'),
        v.subsPath,
        v.editedPath,
        autoPath
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

      const report = JSON.parse(diffOutput);
      // 使用過濾版指標（忽略 1-2 字 LCS 碎片雜訊）
      const af = report.accuracy_filtered;
      if (af) {
        totalTP += af.tp;
        totalFP += af.fp;
        totalFN += af.fn;
      } else {
        // 向下相容：舊版 report 沒有 accuracy_filtered
        totalTP += report.truePositiveCount || 0;
        totalFP += (report.falsePositives || []).length;
        totalFN += (report.falseNegatives || []).length;
      }

      // 清理暫存
      try { fs.unlinkSync(autoPath); } catch (e) {}
    }
  } finally {
    // 還原 config
    if (backup !== null) {
      fs.writeFileSync(tmpConfig, backup);
    }
  }

  const precision = totalTP / (totalTP + totalFP) || 0;
  const recall = totalTP / (totalTP + totalFN) || 0;
  const f1 = 2 * precision * recall / (precision + recall) || 0;

  return { f1, precision, recall, tp: totalTP, fp: totalFP, fn: totalFN };
}

// ── 深拷貝 config ──
function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

// ── 主流程 ──
function main() {
  const videos = findReadyVideos();
  if (videos.length === 0) {
    console.error('❌ 找不到已完成轉錄的影片');
    console.error(`   請先跑一次訓練（在 ${TRAINING_DIR} 下產生 subtitles_words.json + edited_words.json）`);
    process.exit(1);
  }

  console.log(`🎯 自動優化器`);
  console.log(`📂 數據目錄: ${TRAINING_DIR}`);
  console.log(`📊 可用影片: ${videos.length} 支 (${videos.map(v => v.name).join(', ')})`);
  console.log('');

  // 讀取當前 config 作為基線
  const baseConfig = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};

  console.log('═══ Phase 0: 基線評估 ═══');
  const baseline = evaluate(baseConfig, videos);
  console.log(`   基線: F1=${(baseline.f1 * 100).toFixed(1)}% P=${(baseline.precision * 100).toFixed(1)}% R=${(baseline.recall * 100).toFixed(1)}% (TP=${baseline.tp} FP=${baseline.fp} FN=${baseline.fn})`);

  let bestConfig = cloneConfig(baseConfig);
  let bestScore = baseline;
  let experimentCount = 0;
  let improvedCount = 0;
  const history = [{ experiment: 0, change: '基線', ...fmtScore(baseline) }];

  // ════════════════════════════════════
  // Phase 1: 靜音閾值搜索
  // ════════════════════════════════════
  console.log('\n═══ Phase 1: 靜音閾值搜索 ═══');
  const silenceValues = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0];

  for (const threshold of silenceValues) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    if (!testConfig.silence) testConfig.silence = {};
    testConfig.silence.threshold = threshold;

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} silence=${threshold}s → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `silence.threshold=${threshold}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 2: sentence_gap 搜索
  // ════════════════════════════════════
  console.log('\n═══ Phase 2: 分句間隔搜索 ═══');
  const gapValues = [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];

  for (const gap of gapValues) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    if (!testConfig.silence) testConfig.silence = {};
    testConfig.silence.sentence_gap = gap;

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} gap=${gap}s → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `sentence_gap=${gap}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 3: 重複句前綴長度
  // ════════════════════════════════════
  console.log('\n═══ Phase 3: 重複句前綴長度 ═══');
  const prefixValues = [3, 4, 5, 6, 7, 8];

  for (const len of prefixValues) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    if (!testConfig.repeat) testConfig.repeat = {};
    testConfig.repeat.prefix_len = len;

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} prefix_len=${len} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `prefix_len=${len}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 4: 殘句參數
  // ════════════════════════════════════
  console.log('\n═══ Phase 4: 殘句偵測參數 ═══');
  const incompleteCharValues = [5, 8, 10, 12, 15, 20];
  const incompleteOverlapValues = [1, 2, 3];

  for (const maxChars of incompleteCharValues) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    if (!testConfig.incomplete_sentence) testConfig.incomplete_sentence = {};
    testConfig.incomplete_sentence.max_chars = maxChars;

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} max_chars=${maxChars} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `incomplete.max_chars=${maxChars}`, ...fmtScore(score), adopted: improved });
  }

  for (const minOverlap of incompleteOverlapValues) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    if (!testConfig.incomplete_sentence) testConfig.incomplete_sentence = {};
    testConfig.incomplete_sentence.min_overlap = minOverlap;

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} min_overlap=${minOverlap} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `incomplete.min_overlap=${minOverlap}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 5: 句內重複參數
  // ════════════════════════════════════
  console.log('\n═══ Phase 5: 句內重複參數 ═══');
  const intraConfigs = [
    { min_len: 2, max_len: 3, max_gap: 3 },
    { min_len: 2, max_len: 4, max_gap: 4 },
    { min_len: 2, max_len: 5, max_gap: 5 },
    { min_len: 2, max_len: 4, max_gap: 6 },
    { min_len: 3, max_len: 5, max_gap: 4 },
    { min_len: 2, max_len: 6, max_gap: 8 },
  ];

  for (const intra of intraConfigs) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.intra_repeat = intra;

    const label = `${intra.min_len}-${intra.max_len}/gap${intra.max_gap}`;
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} intra=${label} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `intra_repeat=${label}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 6: 語氣詞列表（逐一測試移除）
  // ════════════════════════════════════
  console.log('\n═══ Phase 6: 語氣詞篩選 ═══');
  const baseFillers = bestConfig.filler_words || ['嗯', '啊', '哎', '誒', '呃', '額', '唉', '哦', '噢', '呀', '欸'];

  // 6a: 嘗試移除每個語氣詞
  for (const filler of [...baseFillers]) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.filler_words = (testConfig.filler_words || baseFillers).filter(f => f !== filler);

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} 移除「${filler}」→ F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `remove filler「${filler}」`, ...fmtScore(score), adopted: improved });
  }

  // 6b: 嘗試新增候選語氣詞
  const candidateFillers = ['那', '對', '就', '這', '好', '吧', '呢', '喔', '齁', '蛤', '厚', '吼', '嘿', '耶', '喂', '嗯嗯', '啊啊'];
  for (const filler of candidateFillers) {
    if ((bestConfig.filler_words || []).includes(filler)) continue;
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    if (!testConfig.filler_words) testConfig.filler_words = [];
    testConfig.filler_words.push(filler);

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} 加入「${filler}」→ F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `add filler「${filler}」`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 7: 卡頓詞模式
  // ════════════════════════════════════
  console.log('\n═══ Phase 7: 卡頓詞模式 ═══');
  const candidateStutters = [
    '好好好', '對對對', '嗯嗯嗯', '啊啊啊',
    '的的', '了了', '是是',
    '其實其實', '因為因為', '可是可是', '但是但是',
    '不是不是', '或者或者', '如果如果'
  ];

  for (const pattern of candidateStutters) {
    if ((bestConfig.stutter_patterns || []).includes(pattern)) continue;
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    if (!testConfig.stutter_patterns) testConfig.stutter_patterns = [];
    testConfig.stutter_patterns.push(pattern);

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} 加入「${pattern}」→ F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `add stutter「${pattern}」`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 8: 語意重複偵測參數
  // ════════════════════════════════════
  console.log('\n═══ Phase 8: 語意重複偵測 ═══');
  const semParams = [
    { similarity: 0.30, lcs_ratio: 0.30, min_len: 4, window: 3 },
    { similarity: 0.35, lcs_ratio: 0.35, min_len: 5, window: 4 },
    { similarity: 0.40, lcs_ratio: 0.35, min_len: 6, window: 5 },
    { similarity: 0.45, lcs_ratio: 0.40, min_len: 6, window: 5 },
    { similarity: 0.50, lcs_ratio: 0.45, min_len: 6, window: 5 },
    { similarity: 0.35, lcs_ratio: 0.30, min_len: 4, window: 8 },
    { similarity: 0.30, lcs_ratio: 0.25, min_len: 4, window: 10 },
    { similarity: 0.40, lcs_ratio: 0.30, min_len: 5, window: 8 },
    { similarity: 0.35, lcs_ratio: 0.35, min_len: 5, window: 6 },
    { similarity: 0.45, lcs_ratio: 0.40, min_len: 5, window: 4 },
  ];

  for (const sp of semParams) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.semantic_repeat = sp;

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} sim=${sp.similarity} lcs=${sp.lcs_ratio} min=${sp.min_len} win=${sp.window} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `semantic_repeat sim=${sp.similarity} lcs=${sp.lcs_ratio}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 9: Gap 密度區偵測
  // ════════════════════════════════════
  console.log('\n═══ Phase 9: Gap 密度區偵測 ═══');
  const gapDensityConfigs = [
    { enabled: true, window: 6, threshold: 0.5, min_gaps: 3 },
    { enabled: true, window: 8, threshold: 0.5, min_gaps: 4 },
    { enabled: true, window: 8, threshold: 0.6, min_gaps: 4 },
    { enabled: true, window: 10, threshold: 0.5, min_gaps: 5 },
    { enabled: true, window: 10, threshold: 0.6, min_gaps: 5 },
    { enabled: true, window: 12, threshold: 0.5, min_gaps: 6 },
  ];

  for (const gdc of gapDensityConfigs) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.gap_density = gdc;

    const label = `w=${gdc.window} t=${gdc.threshold} g=${gdc.min_gaps}`;
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} ${label} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `gap_density ${label}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 10: 寬窗口重複偵測
  // ════════════════════════════════════
  console.log('\n═══ Phase 10: 寬窗口重複偵測 ═══');
  const wideRepeatConfigs = [
    { enabled: true, min_len: 8, similarity: 0.4, window: 15 },
    { enabled: true, min_len: 10, similarity: 0.45, window: 15 },
    { enabled: true, min_len: 10, similarity: 0.5, window: 20 },
    { enabled: true, min_len: 10, similarity: 0.5, window: 30 },
    { enabled: true, min_len: 12, similarity: 0.55, window: 25 },
    { enabled: true, min_len: 8, similarity: 0.35, window: 20 },
    { enabled: true, min_len: 6, similarity: 0.5, window: 30 },
    { enabled: true, min_len: 15, similarity: 0.5, window: 30 },
  ];

  for (const wrc of wideRepeatConfigs) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.wide_repeat = wrc;

    const label = `min=${wrc.min_len} sim=${wrc.similarity} win=${wrc.window}`;
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} ${label} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `wide_repeat ${label}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 11: 咳嗽/雜音偵測
  // ════════════════════════════════════
  console.log('\n═══ Phase 11: 咳嗽/雜音偵測 ═══');
  {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.cough_detection = { enabled: true, words: ['咳', '咳咳', '咳咳咳', '嗯哼'] };

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} 咳嗽偵測 → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: 'cough_detection', ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 12: 短句刪除
  // ════════════════════════════════════
  console.log('\n═══ Phase 12: 短句刪除 ═══');
  const shortSentConfigs = [
    { enabled: true, max_len: 2, min_gap: 0.5 },
    { enabled: true, max_len: 2, min_gap: 0.8 },
    { enabled: true, max_len: 3, min_gap: 0.5 },
    { enabled: true, max_len: 3, min_gap: 0.8 },
    { enabled: true, max_len: 4, min_gap: 0.8 },
    { enabled: true, max_len: 5, min_gap: 1.0 },
  ];

  for (const ssc of shortSentConfigs) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.short_sentence = ssc;

    const label = `max=${ssc.max_len} gap=${ssc.min_gap}`;
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} ${label} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `short_sentence ${label}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 13: 組合微調（結合最佳新規則再搜索舊參數）
  // ════════════════════════════════════
  console.log('\n═══ Phase 13: 組合微調 ═══');
  // 重新搜索靜音閾值（新規則可能改變最佳靜音設定）
  for (const threshold of [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5]) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.silence.threshold = threshold;

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} silence=${threshold}s → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `silence.threshold=${threshold} (round2)`, ...fmtScore(score), adopted: improved });
  }

  // 重新搜索語意重複參數
  for (const sp of [
    { similarity: 0.40, lcs_ratio: 0.35, min_len: 5, window: 5 },
    { similarity: 0.45, lcs_ratio: 0.40, min_len: 5, window: 6 },
    { similarity: 0.50, lcs_ratio: 0.45, min_len: 5, window: 5 },
    { similarity: 0.55, lcs_ratio: 0.50, min_len: 6, window: 5 },
    { similarity: 0.50, lcs_ratio: 0.45, min_len: 8, window: 8 },
  ]) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.semantic_repeat = sp;

    const label = `sim=${sp.similarity} lcs=${sp.lcs_ratio} min=${sp.min_len}`;
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} ${label} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `semantic_repeat ${label} (round2)`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 14: 精煉微調
  // ════════════════════════════════════
  console.log('\n═══ Phase 14: 精煉微調 ═══');
  const bestSilence = bestConfig.silence?.threshold ?? 1.0;
  const fineValues = [
    bestSilence - 0.15, bestSilence - 0.1, bestSilence - 0.05,
    bestSilence + 0.05, bestSilence + 0.1, bestSilence + 0.15
  ].filter(v => v >= 0.1 && v <= 3.0);

  for (const threshold of fineValues) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.silence.threshold = Math.round(threshold * 100) / 100;

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} silence=${testConfig.silence.threshold}s → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `silence.threshold=${testConfig.silence.threshold} (fine)`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 18: 放棄句首參數
  // ════════════════════════════════════
  console.log('\n═══ Phase 18: 放棄句首偵測 ═══');
  for (const mc of [4, 6, 8, 10, 12]) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.abandoned_start = { enabled: true, max_chars: mc };

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} max_chars=${mc} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `abandoned_start.max_chars=${mc}`, ...fmtScore(score), adopted: improved });
  }

  // 測試停用放棄句首
  {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.abandoned_start = { enabled: false };
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    console.log(`   ${improved ? '✅' : '  '} disabled → F1=${(score.f1 * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);
    if (improved) { bestConfig = testConfig; bestScore = score; improvedCount++; }
    history.push({ experiment: experimentCount, change: 'abandoned_start.disabled', ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 19: 語意重複精調（AND 邏輯後重新搜索）
  // ════════════════════════════════════
  console.log('\n═══ Phase 19: 語意重複 (AND 邏輯) ═══');
  const semConfigs2 = [
    { similarity: 0.35, lcs_ratio: 0.35, min_len: 6, window: 5 },
    { similarity: 0.40, lcs_ratio: 0.35, min_len: 6, window: 5 },
    { similarity: 0.40, lcs_ratio: 0.40, min_len: 6, window: 6 },
    { similarity: 0.45, lcs_ratio: 0.40, min_len: 6, window: 6 },
    { similarity: 0.45, lcs_ratio: 0.35, min_len: 5, window: 8 },
    { similarity: 0.50, lcs_ratio: 0.40, min_len: 6, window: 8 },
    { similarity: 0.40, lcs_ratio: 0.30, min_len: 5, window: 10 },
    { similarity: 0.35, lcs_ratio: 0.30, min_len: 5, window: 8 },
  ];
  for (const sc of semConfigs2) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.semantic_repeat = sc;
    const label = `sim=${sc.similarity} lcs=${sc.lcs_ratio} min=${sc.min_len} win=${sc.window}`;
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    console.log(`   ${improved ? '✅' : '  '} ${label} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);
    if (improved) { bestConfig = testConfig; bestScore = score; improvedCount++; }
    history.push({ experiment: experimentCount, change: `semantic_repeat_v2 ${label}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 16: Take 分組參數
  // ════════════════════════════════════
  console.log('\n═══ Phase 16: Take 分組參數 ═══');
  const takeConfigs = [
    { similarity: 0.45, window: 8, prefix_len: 4 },
    { similarity: 0.50, window: 8, prefix_len: 5 },
    { similarity: 0.55, window: 8, prefix_len: 5 },
    { similarity: 0.55, window: 10, prefix_len: 5 },
    { similarity: 0.60, window: 8, prefix_len: 5 },
    { similarity: 0.60, window: 10, prefix_len: 5 },
    { similarity: 0.60, window: 10, prefix_len: 6 },
    { similarity: 0.65, window: 8, prefix_len: 6 },
    { similarity: 0.65, window: 10, prefix_len: 6 },
    { similarity: 0.70, window: 8, prefix_len: 6 },
  ];

  for (const tc of takeConfigs) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.take_group = { ...testConfig.take_group, similarity: tc.similarity, window: tc.window, prefix_len: tc.prefix_len };

    const label = `sim=${tc.similarity} win=${tc.window} prefix=${tc.prefix_len}`;
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} ${label} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `take_group ${label}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 17: repeat.prefix_len 搜索
  // ════════════════════════════════════
  console.log('\n═══ Phase 17: 重複句前綴長度 ═══');
  for (const pl of [3, 4, 5, 6, 7, 8]) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    testConfig.repeat = { ...testConfig.repeat, prefix_len: pl };

    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} prefix_len=${pl} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `repeat.prefix_len=${pl}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // Phase 15: 上下文靜音分級閾值
  // ════════════════════════════════════
  console.log('\n═══ Phase 15: 上下文靜音分級 ═══');
  const tierConfigs = [
    { tier_between: 0.1, tier_adjacent: 0.3 },
    { tier_between: 0.2, tier_adjacent: 0.5 },
    { tier_between: 0.3, tier_adjacent: 0.6 },
    { tier_between: 0.3, tier_adjacent: 0.8 },
    { tier_between: 0.3, tier_adjacent: 1.0 },
    { tier_between: 0.5, tier_adjacent: 0.8 },
    { tier_between: 0.5, tier_adjacent: 1.0 },
    { tier_between: 0.5, tier_adjacent: 1.2 },
  ];

  for (const tc of tierConfigs) {
    experimentCount++;
    const testConfig = cloneConfig(bestConfig);
    if (!testConfig.silence) testConfig.silence = {};
    testConfig.silence.tier_between = tc.tier_between;
    testConfig.silence.tier_adjacent = tc.tier_adjacent;

    const label = `between=${tc.tier_between} adjacent=${tc.tier_adjacent}`;
    const score = evaluate(testConfig, videos);
    const improved = score.f1 > bestScore.f1;
    const marker = improved ? '✅' : '  ';

    console.log(`   ${marker} ${label} → F1=${(score.f1 * 100).toFixed(1)}% P=${(score.precision * 100).toFixed(1)}% R=${(score.recall * 100).toFixed(1)}% ${improved ? '(↑ 採用)' : ''}`);

    if (improved) {
      bestConfig = testConfig;
      bestScore = score;
      improvedCount++;
    }
    history.push({ experiment: experimentCount, change: `silence.tiers ${label}`, ...fmtScore(score), adopted: improved });
  }

  // ════════════════════════════════════
  // 結果報告
  // ════════════════════════════════════
  console.log('\n' + '═'.repeat(50));
  console.log('🏆 優化完成');
  console.log('═'.repeat(50));
  console.log(`   實驗數: ${experimentCount}`);
  console.log(`   採用數: ${improvedCount}`);
  console.log(`   基線 F1: ${(baseline.f1 * 100).toFixed(1)}%`);
  console.log(`   最佳 F1: ${(bestScore.f1 * 100).toFixed(1)}%`);
  console.log(`   提升: +${((bestScore.f1 - baseline.f1) * 100).toFixed(1)}%`);
  console.log('');
  console.log('📋 最佳參數:');
  console.log(JSON.stringify(bestConfig, null, 2));

  // 寫入最佳 config
  bestConfig._updated = new Date().toISOString();
  bestConfig._source = 'auto_optimize';
  bestConfig._baseline_f1 = baseline.f1;
  bestConfig._best_f1 = bestScore.f1;
  bestConfig._experiments = experimentCount;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(bestConfig, null, 2));
  console.log(`\n✅ 已寫入 ${CONFIG_PATH}`);

  // 寫入歷程記錄
  const historyPath = path.join(TRAINING_DIR, 'optimization_history.json');
  fs.writeFileSync(historyPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    videos: videos.map(v => v.name),
    baseline: fmtScore(baseline),
    best: fmtScore(bestScore),
    experiments: experimentCount,
    improvements: improvedCount,
    history
  }, null, 2));
  console.log(`📊 歷程記錄: ${historyPath}`);
}

function fmtScore(s) {
  return {
    f1: Math.round(s.f1 * 1000) / 1000,
    precision: Math.round(s.precision * 1000) / 1000,
    recall: Math.round(s.recall * 1000) / 1000,
    tp: s.tp, fp: s.fp, fn: s.fn
  };
}

main();
