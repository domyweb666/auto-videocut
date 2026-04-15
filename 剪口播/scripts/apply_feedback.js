#!/usr/bin/env node
/**
 * 單支影片自動學習：讀取 diff_report.json，更新 training_config.json
 *
 * 策略：保守調整，避免單支影片的偏差汙染
 * - 靜音閾值：≥5 個同方向 FP/FN → ±0.1s（上限3.0 下限0.5）
 * - 語氣詞例外：同一個詞被恢復 ≥3 次 → 加入 filler_exceptions
 * - 其他變更：僅記錄到 feedback_history.jsonl，不自動套用
 *
 * 用法: node apply_feedback.js <diff_report.json> [training_config.json]
 */

const fs = require('fs');
const path = require('path');

const diffFile = process.argv[2];
const configFile = process.argv[3] || path.join(__dirname, '..', 'training_config.json');
const historyFile = path.join(path.dirname(configFile), 'feedback_history.jsonl');

if (!diffFile || !fs.existsSync(diffFile)) {
  console.error('用法: node apply_feedback.js <diff_report.json> [training_config.json]');
  process.exit(1);
}

const diff = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
const config = fs.existsSync(configFile)
  ? JSON.parse(fs.readFileSync(configFile, 'utf8'))
  : {};

const adjustments = [];
const warnings = [];

// ── 分析 False Positives（AI 標了但使用者取消）──
const fps = diff.falsePositives || [];
const fns = diff.falseNegatives || [];

// 1. 靜音閾值分析
const silenceFPs = fps.filter(e => e.isGap);
const silenceFNs = fns.filter(e => e.isGap);

const currentThreshold = config.silence?.threshold ?? 1.0;

if (silenceFPs.length >= 5) {
  // 使用者大量恢復靜音 → 閾值太低，需要提高
  const newThreshold = Math.min(3.0, Math.round((currentThreshold + 0.1) * 10) / 10);
  if (newThreshold !== currentThreshold) {
    if (!config.silence) config.silence = {};
    config.silence.threshold = newThreshold;
    adjustments.push({
      param: 'silence.threshold',
      from: currentThreshold,
      to: newThreshold,
      reason: `${silenceFPs.length} silence FPs → raise threshold`
    });
  }
} else if (silenceFNs.length >= 5) {
  // 使用者大量手動刪短靜音 → 閾值太高，需要降低
  const newThreshold = Math.max(0.5, Math.round((currentThreshold - 0.1) * 10) / 10);
  if (newThreshold !== currentThreshold) {
    if (!config.silence) config.silence = {};
    config.silence.threshold = newThreshold;
    adjustments.push({
      param: 'silence.threshold',
      from: currentThreshold,
      to: newThreshold,
      reason: `${silenceFNs.length} silence FNs → lower threshold`
    });
  }
}

// 2. 語氣詞例外分析
const fillerWords = config.filler_words || [];
const fillerExceptions = config.filler_exceptions || [];
const restoredFillers = {};

for (const fp of fps) {
  if (!fp.isGap && fillerWords.includes(fp.text)) {
    restoredFillers[fp.text] = (restoredFillers[fp.text] || 0) + 1;
  }
}

for (const [word, count] of Object.entries(restoredFillers)) {
  if (count >= 3 && !fillerExceptions.includes(word)) {
    if (!config.filler_exceptions) config.filler_exceptions = [];
    config.filler_exceptions.push(word);
    adjustments.push({
      param: 'filler_exceptions',
      action: 'add',
      word,
      reason: `"${word}" restored ${count} times → add to exceptions`
    });
  }
}

// 3. 受保護詞被刪（只記錄警告，不自動移除）
for (const fn of fns) {
  if (!fn.isGap && fn.text) {
    // 記錄但不行動
  }
}

// 4. 統計摘要
const fpByReason = {};
for (const fp of fps) {
  const reason = fp.reason || (fp.isGap ? 'silence' : 'text');
  fpByReason[reason] = (fpByReason[reason] || 0) + 1;
}

const fnByType = { silence: silenceFNs.length, text: fns.length - silenceFNs.length };

// ── 寫入更新後的 config ──
if (adjustments.length > 0) {
  config._updated = new Date().toISOString();
  config._source = 'apply_feedback';
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  console.log(`✅ 已更新 training_config.json (${adjustments.length} 項調整)`);
  adjustments.forEach(a => {
    if (a.from !== undefined) {
      console.log(`   ${a.param}: ${a.from} → ${a.to} (${a.reason})`);
    } else {
      console.log(`   ${a.param}: ${a.action} "${a.word}" (${a.reason})`);
    }
  });
} else {
  console.log('📋 無需調整（差異不足以觸發更新）');
}

// ── 追加到 feedback_history.jsonl ──
const historyEntry = {
  timestamp: new Date().toISOString(),
  diffFile: path.basename(diffFile),
  aiCount: diff.aiCount,
  userCount: diff.userCount,
  fpCount: fps.length,
  fnCount: fns.length,
  fpByReason,
  fnByType,
  adjustments,
  warnings
};

fs.appendFileSync(historyFile, JSON.stringify(historyEntry) + '\n');
console.log(`📝 已記錄到 feedback_history.jsonl`);
