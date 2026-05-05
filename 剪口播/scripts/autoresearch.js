#!/usr/bin/env node
/**
 * Autoresearch 自動優化器 v2
 *
 * 整合三個階段：
 *   1. 錯誤模式分析（FP/FN 分類）
 *   2. 參數網格搜索（auto_optimize.js）
 *   3. 新規則候選測試（基於 FN 模式自動發現）
 *
 * 用法: node autoresearch.js [training_output_dir]
 * 預設: ./training_output
 *
 * 輸出:
 *   - 更新 training_config.json
 *   - training_output/autoresearch_report.json（完整分析報告）
 *   - stdout 摘要
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const TRAINING_DIR = path.resolve(process.argv[2] || 'training_output');
const CONFIG_PATH = path.join(SCRIPT_DIR, '..', 'training_config.json');

// ══════════════════════════════════════
// 工具函數
// ══════════════════════════════════════

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

function evaluate(config, videos) {
  const tmpConfig = CONFIG_PATH;
  const backup = fs.existsSync(tmpConfig) ? fs.readFileSync(tmpConfig, 'utf8') : null;
  fs.writeFileSync(tmpConfig, JSON.stringify(config, null, 2));

  let totalTP = 0, totalFP = 0, totalFN = 0;
  const perVideo = [];

  try {
    for (const v of videos) {
      try {
        const autoPath = path.join(v.analysisDir, '_research_auto.json');
        execFileSync('node', [
          path.join(SCRIPT_DIR, 'auto_select_rules.js'),
          v.subsPath, autoPath
        ], { stdio: 'pipe', timeout: 60000 });

        const diffOutput = execFileSync('node', [
          path.join(SCRIPT_DIR, 'compare_transcriptions.js'),
          v.subsPath, v.editedPath, autoPath
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });

        const report = JSON.parse(diffOutput);
        const af = report.accuracy_filtered;
        if (af) {
          totalTP += af.tp;
          totalFP += af.fp;
          totalFN += af.fn;
          const p = af.tp / (af.tp + af.fp) || 0;
          const r = af.tp / (af.tp + af.fn) || 0;
          const f1 = 2 * p * r / (p + r) || 0;
          perVideo.push({ name: v.name, f1, precision: p, recall: r, ...af });
        }

        // Collect FP/FN details for analysis
        if (perVideo.length > 0) {
          perVideo[perVideo.length - 1].fps = (report.falsePositives || [])
            .filter(e => e.isGap || (e.text && e.text.length >= 3))
            .map(e => ({ text: e.text, reason: e.reason, isGap: e.isGap }));
          perVideo[perVideo.length - 1].fns = (report.falseNegatives || [])
            .filter(e => !e.isGap && e.text && e.text.length >= 3)
            .map(e => ({ text: e.text, idx: e.idx }));
        }

        try { fs.unlinkSync(autoPath); } catch (e) {}
      } catch (videoErr) {
        console.error(`   ⚠️ 影片 ${v.name} 評估失敗: ${videoErr.message}`);
      }
    }
  } finally {
    if (backup !== null) fs.writeFileSync(tmpConfig, backup);
  }

  const precision = totalTP / (totalTP + totalFP) || 0;
  const recall = totalTP / (totalTP + totalFN) || 0;
  const f1 = 2 * precision * recall / (precision + recall) || 0;

  return { f1, precision, recall, tp: totalTP, fp: totalFP, fn: totalFN, perVideo };
}

function evaluateQuick(config, videos) {
  const tmpConfig = CONFIG_PATH;
  const backup = fs.existsSync(tmpConfig) ? fs.readFileSync(tmpConfig, 'utf8') : null;
  fs.writeFileSync(tmpConfig, JSON.stringify(config, null, 2));

  let totalTP = 0, totalFP = 0, totalFN = 0;

  try {
    for (const v of videos) {
      try {
        const autoPath = path.join(v.analysisDir, '_research_auto.json');
        execFileSync('node', [
          path.join(SCRIPT_DIR, 'auto_select_rules.js'),
          v.subsPath, autoPath
        ], { stdio: 'pipe', timeout: 60000 });

        const diffOutput = execFileSync('node', [
          path.join(SCRIPT_DIR, 'compare_transcriptions.js'),
          v.subsPath, v.editedPath, autoPath
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });

        const report = JSON.parse(diffOutput);
        const af = report.accuracy_filtered;
        if (af) { totalTP += af.tp; totalFP += af.fp; totalFN += af.fn; }
        try { fs.unlinkSync(autoPath); } catch (e) {}
      } catch (videoErr) {
        // 單支影片失敗不影響其他
      }
    }
  } finally {
    if (backup !== null) fs.writeFileSync(tmpConfig, backup);
  }

  const precision = totalTP / (totalTP + totalFP) || 0;
  const recall = totalTP / (totalTP + totalFN) || 0;
  const f1 = 2 * precision * recall / (precision + recall) || 0;
  return { f1, precision, recall, tp: totalTP, fp: totalFP, fn: totalFN };
}

function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

function fmtScore(s) {
  return `F1=${(s.f1 * 100).toFixed(1)}% P=${(s.precision * 100).toFixed(1)}% R=${(s.recall * 100).toFixed(1)}%`;
}

// ══════════════════════════════════════
// 主流程
// ══════════════════════════════════════

console.log('🔬 Autoresearch v2');
console.log(`📂 數據目錄: ${TRAINING_DIR}`);

const videos = findReadyVideos();
console.log(`📊 可用影片: ${videos.length} 支`);

if (videos.length === 0) {
  console.error('❌ 沒有可用的訓練影片');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// 確保所有必要的巢狀物件都存在（避免 modifier 中 TypeError）
if (!config.silence) config.silence = {};
if (!config.repeat) config.repeat = {};
if (!config.semantic_repeat) config.semantic_repeat = {};
if (!config.take_group) config.take_group = {};
if (!config.short_sentence) config.short_sentence = {};
if (!config.intra_repeat) config.intra_repeat = {};
if (!config.wide_repeat) config.wide_repeat = {};
if (!config.cough_detection) config.cough_detection = {};
if (!config.abandoned_start) config.abandoned_start = {};
if (!config.incomplete_sentence) config.incomplete_sentence = {};

// 填入 auto_select_rules.js 使用的預設值（讓 autoresearch 有基準可調）
config.silence.threshold = config.silence.threshold ?? 1.2;
config.silence.sentence_gap = config.silence.sentence_gap ?? 0.5;
config.repeat.prefix_len = config.repeat.prefix_len ?? 5;
config.semantic_repeat.similarity = config.semantic_repeat.similarity ?? 0.45;
config.semantic_repeat.lcs_ratio = config.semantic_repeat.lcs_ratio ?? 0.4;
config.take_group.similarity = config.take_group.similarity ?? 0.55;
config.take_group.window = config.take_group.window ?? 10;
config.short_sentence.max_len = config.short_sentence.max_len ?? 3;
config.short_sentence.min_gap = config.short_sentence.min_gap ?? 0.8;

// ══════════════════════════════════════
// Phase 1: 基線評估 + 錯誤模式分析
// ══════════════════════════════════════
console.log('\n═══ Phase 1: 基線評估 + 錯誤模式分析 ═══');
const baseline = evaluate(config, videos);
console.log(`   基線: ${fmtScore(baseline)} (TP=${baseline.tp} FP=${baseline.fp} FN=${baseline.fn})`);

// Per-video breakdown
const below90 = baseline.perVideo.filter(v => v.f1 < 0.9);
console.log(`   低於 90%: ${below90.length}/${videos.length} 支`);
for (const v of below90.sort((a, b) => a.f1 - b.f1)) {
  console.log(`     ❌ ${v.name}: F1=${(v.f1 * 100).toFixed(1)}% (FP=${v.fp} FN=${v.fn})`);
}

// FP analysis
const allFPs = baseline.perVideo.flatMap(v => (v.fps || []).map(fp => ({ ...fp, video: v.name })));
const fpByRule = {};
for (const fp of allFPs) {
  let key;
  const r = fp.reason || '';
  if (r.includes('Take')) key = '重複Take';
  else if (r.includes('上下文')) key = '上下文靜音';
  else if (r.includes('語意')) key = '語意重複';
  else if (r.includes('句內')) key = '句內重複';
  else if (r.includes('靜音')) key = '靜音';
  else if (r.includes('殘句')) key = '殘句';
  else if (r.includes('口語贅詞')) key = '口語贅詞';
  else key = r.slice(0, 15) || 'unknown';
  fpByRule[key] = (fpByRule[key] || 0) + 1;
}
console.log('\n   FP 分佈:');
for (const [k, v] of Object.entries(fpByRule).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`     ${k}: ${v}`);
}

// FN analysis - find most common deleted words
const allFNs = baseline.perVideo.flatMap(v => (v.fns || []).map(fn => ({ ...fn, video: v.name })));
const fnByText = {};
for (const fn of allFNs) {
  fnByText[fn.text] = (fnByText[fn.text] || 0) + 1;
}
const topFNWords = Object.entries(fnByText).sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('\n   FN 最常見漏刪詞:');
for (const [word, count] of topFNWords) {
  console.log(`     「${word}」: ${count}x`);
}

// ══════════════════════════════════════
// Phase 2: 參數網格搜索
// ══════════════════════════════════════
console.log('\n═══ Phase 2: 參數網格搜索 ═══');

let bestConfig = cloneConfig(config);
let bestF1 = baseline.f1;
let adoptedCount = 0;

function ensureConfigSections(cfg) {
  if (!cfg.silence) cfg.silence = {};
  if (!cfg.repeat) cfg.repeat = {};
  if (!cfg.semantic_repeat) cfg.semantic_repeat = {};
  if (!cfg.take_group) cfg.take_group = {};
  if (!cfg.short_sentence) cfg.short_sentence = {};
  if (!cfg.intra_repeat) cfg.intra_repeat = {};
  if (!cfg.wide_repeat) cfg.wide_repeat = {};
  if (!cfg.cough_detection) cfg.cough_detection = {};
  if (!cfg.abandoned_start) cfg.abandoned_start = {};
  if (!cfg.incomplete_sentence) cfg.incomplete_sentence = {};
}

function tryAndAdopt(label, modifier) {
  const testConfig = cloneConfig(bestConfig);
  ensureConfigSections(testConfig);
  modifier(testConfig);
  const score = evaluateQuick(testConfig, videos);
  const improved = score.f1 > bestF1 + 0.00005;
  const marker = improved ? '✅' : '  ';
  console.log(`   ${marker} ${label} → ${fmtScore(score)}${improved ? ' (↑ 採用)' : ''}`);
  if (improved) {
    Object.assign(bestConfig, testConfig);
    bestF1 = score.f1;
    adoptedCount++;
  }
  return improved;
}

// 2a: Silence threshold
console.log('   [靜音閾值]');
for (const t of [1.5, 1.6, 1.7, 1.8, 1.85, 1.9, 2.0, 2.2]) {
  tryAndAdopt(`silence=${t}s`, c => { c.silence.threshold = t; });
}

// 2b: Sentence gap
console.log('   [分句間隔]');
for (const g of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  tryAndAdopt(`gap=${g}s`, c => { c.silence.sentence_gap = g; });
}

// 2c: Repeat prefix
console.log('   [重複前綴]');
for (const p of [3, 4, 5, 6]) {
  tryAndAdopt(`prefix=${p}`, c => { c.repeat.prefix_len = p; });
}

// 2d: Semantic repeat
console.log('   [語意重複]');
for (const sim of [0.4, 0.45, 0.5, 0.55, 0.6]) {
  for (const lcs of [0.35, 0.4, 0.45, 0.5]) {
    tryAndAdopt(`sem sim=${sim} lcs=${lcs}`, c => {
      c.semantic_repeat.similarity = sim;
      c.semantic_repeat.lcs_ratio = lcs;
    });
  }
}

// 2e: Take group
console.log('   [Take 分組]');
for (const sim of [0.5, 0.55, 0.6, 0.65]) {
  for (const win of [6, 8, 10]) {
    tryAndAdopt(`take sim=${sim} win=${win}`, c => {
      c.take_group.similarity = sim;
      c.take_group.window = win;
    });
  }
}

// 2f: Short sentence
console.log('   [短句刪除]');
for (const ml of [2, 3, 4, 5]) {
  for (const mg of [0.3, 0.5, 0.8]) {
    tryAndAdopt(`short max=${ml} gap=${mg}`, c => {
      c.short_sentence.max_len = ml;
      c.short_sentence.min_gap = mg;
    });
  }
}

console.log(`\n   參數搜索採用: ${adoptedCount} 項`);

// ══════════════════════════════════════
// Phase 3: 新規則候選測試（口語贅詞）
// ══════════════════════════════════════
console.log('\n═══ Phase 3: 口語贅詞候選測試 ═══');

// Candidates from FN analysis
const currentFillers = bestConfig.verbal_fillers || [];
const candidates = topFNWords
  .filter(([word]) => word.length >= 2 && word.length <= 4)
  .map(([word, count]) => word)
  .filter(w => !currentFillers.includes(w));

let fillerAdopted = 0;
for (const word of candidates.slice(0, 20)) {
  const improved = tryAndAdopt(`+「${word}」`, c => {
    c.verbal_fillers = [...(c.verbal_fillers || []), word];
  });
  if (improved) {
    currentFillers.push(word);
    fillerAdopted++;
  }
}
console.log(`   新贅詞採用: ${fillerAdopted} 個`);

// ══════════════════════════════════════
// Phase 4: 最終評估
// ══════════════════════════════════════
console.log('\n═══ Phase 4: 最終評估 ═══');
const finalScore = evaluate(bestConfig, videos);
console.log(`   最終: ${fmtScore(finalScore)} (TP=${finalScore.tp} FP=${finalScore.fp} FN=${finalScore.fn})`);

const finalBelow90 = finalScore.perVideo.filter(v => v.f1 < 0.9);
console.log(`   低於 90%: ${finalBelow90.length}/${videos.length} 支`);
for (const v of finalBelow90.sort((a, b) => a.f1 - b.f1)) {
  console.log(`     ❌ ${v.name}: F1=${(v.f1 * 100).toFixed(1)}% (FP=${v.fp} FN=${v.fn})`);
}

// 改善摘要
const deltaF1 = finalScore.f1 - baseline.f1;
const deltaFP = finalScore.fp - baseline.fp;
const deltaFN = finalScore.fn - baseline.fn;
console.log(`\n   改善: F1 ${deltaF1 >= 0 ? '+' : ''}${(deltaF1 * 100).toFixed(2)}pp, FP ${deltaFP >= 0 ? '+' : ''}${deltaFP}, FN ${deltaFN >= 0 ? '+' : ''}${deltaFN}`);

// ══════════════════════════════════════
// 寫入結果
// ══════════════════════════════════════
bestConfig._updated = new Date().toISOString();
bestConfig._source = 'autoresearch_v2';
bestConfig._baseline_f1 = baseline.f1;
bestConfig._best_f1 = finalScore.f1;
fs.writeFileSync(CONFIG_PATH, JSON.stringify(bestConfig, null, 2));
console.log(`\n✅ 已寫入 ${CONFIG_PATH}`);

// Save report
const report = {
  timestamp: new Date().toISOString(),
  videos: videos.length,
  baseline: { f1: baseline.f1, precision: baseline.precision, recall: baseline.recall, fp: baseline.fp, fn: baseline.fn },
  final: { f1: finalScore.f1, precision: finalScore.precision, recall: finalScore.recall, fp: finalScore.fp, fn: finalScore.fn },
  perVideo: finalScore.perVideo.map(v => ({ name: v.name, f1: v.f1, precision: v.precision, recall: v.recall, fp: v.fp, fn: v.fn })),
  fpDistribution: fpByRule,
  topFNWords: Object.fromEntries(topFNWords),
  adoptedParams: adoptedCount,
  adoptedFillers: fillerAdopted
};
const reportPath = path.join(TRAINING_DIR, 'autoresearch_report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`📊 報告: ${reportPath}`);

console.log('\n══════════════════════════════════════');
console.log(`🎯 Autoresearch 完成`);
console.log(`   ${baseline.f1 < finalScore.f1 ? '📈' : '📊'} F1: ${(baseline.f1 * 100).toFixed(1)}% → ${(finalScore.f1 * 100).toFixed(1)}%`);
console.log(`   🎬 ${videos.length} 支影片, ${videos.length - finalBelow90.length}/${videos.length} ≥ 90%`);
console.log('══════════════════════════════════════');
