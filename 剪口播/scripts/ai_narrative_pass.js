#!/usr/bin/env node
/**
 * Layered 剪輯 — 第二遍敘事級 AI 剪輯
 *
 * 流程:
 *   subtitles_words.json + polished.json + auto_selected.json (規則層輸出)
 *     ↓ 過濾掉規則層已刪的 word，得到「殘餘文稿」
 *     ↓ 餵給 Claude 做敘事級重複偵測（聚焦在跨段落的同觀點重講）
 *     ↓ 對齊回原始 word index
 *     ↓ 合併: 最終刪除 = 規則層 ∪ AI 層
 *   輸出 auto_selected_layered.json
 *
 * 用法:
 *   node ai_narrative_pass.js [--model <m>] <polished.json> <subtitles_words.json> <auto_selected.json> [output_path]
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');
const { alignKeptText } = require('./lib/align_kept_text');

// ── 解析參數 ──
let MODEL = '';
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--model' && process.argv[i + 1]) {
    MODEL = process.argv[++i];
  } else {
    positional.push(a);
  }
}

const polishedFile  = positional[0];
const wordsFile     = positional[1];
const rulesFile     = positional[2];
const outputFile    = positional[3]
  || (polishedFile && path.join(path.dirname(polishedFile), 'auto_selected_layered.json'));

if (!polishedFile || !wordsFile || !rulesFile) {
  console.error('用法: node ai_narrative_pass.js [--model <m>] <polished.json> <subtitles_words.json> <auto_selected.json> [output_path]');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 讀檔 ──
const phrases = JSON.parse(fs.readFileSync(polishedFile, 'utf8'));
const words   = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const rulesRaw = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
const rulesIndices = Array.isArray(rulesRaw) ? rulesRaw : (rulesRaw.indices || []);
const rulesDelSet = new Set(rulesIndices);

console.error(`📖 載入：${phrases.length} 段、${words.length} 個 word、規則層刪 ${rulesDelSet.size} 個 word`);

// ── 建立殘餘 phrases（過濾掉規則層已刪的 wordIdx）──
// 規則：保留 displayText 的標點，但用「字→wordIdx 映射」過濾掉被刪字
function buildResidualPhrase(phrase) {
  const remaining = phrase.wordIndices.filter(wi => !rulesDelSet.has(wi));
  if (remaining.length === 0) return null;

  // 重建 displayText：保留標點、過濾被刪字
  const charToWordIdx = [];
  for (const wi of phrase.wordIndices) {
    const w = words[wi];
    if (!w || !w.text) continue;
    for (const _c of w.text) charToWordIdx.push(wi);
  }
  const origText  = phrase.text || '';
  const display   = phrase.displayText || origText;
  let textPos = 0;
  let result  = '';
  for (const c of display) {
    if (textPos < origText.length && c === origText[textPos]) {
      const wi = charToWordIdx[textPos];
      if (!rulesDelSet.has(wi)) result += c;
      textPos++;
    } else {
      // 標點或 Claude 加的字
      result += c;
    }
  }

  return {
    text:        remaining.map(wi => words[wi].text).join(''),
    displayText: result,
    wordIndices: remaining
  };
}

const residualPhrases = phrases.map(buildResidualPhrase).filter(p => p !== null);
const residualWordCount = residualPhrases.reduce((s, p) => s + p.wordIndices.length, 0);
console.error(`📝 殘餘：${residualPhrases.length} 段、${residualWordCount} 個 word`);

if (residualPhrases.length === 0) {
  console.error('❌ 規則層已刪光所有內容，無需 AI 第二遍');
  process.exit(1);
}

// ── 載入 prompt 模板 ──
const PROMPT_TEMPLATE_PATH = path.join(__dirname, '..', 'prompts', 'ai_narrative_pass_prompt.md');
const PROMPT_TEMPLATE_RAW = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8')
  .replace(/^<!--[\s\S]*?-->\s*/m, '')
  .trim();

// 讀 NOTES（專有名詞）
let notesSection = '';
try {
  const configPath = path.join(__dirname, '..', 'training_config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const notes = config.notes || {};
    if (notes.proper_nouns && notes.proper_nouns.length > 0) {
      notesSection += `\n## 專有名詞（必須保留，不可拆字）\n${notes.proper_nouns.join('、')}\n`;
    }
  }
} catch (e) {}

// 讀敘事層專屬守則（narrative_style_guide.md，由 ai_extract_narrative_style_batch.js 產出）
// 這份守則只包含規則層之後、人工再多刪的敘事決策模式，不與規則層重疊
let styleGuideSection = '';
try {
  const narrativeGuidePath = path.join(__dirname, 'training_output', 'narrative_style_guide.md');
  if (fs.existsSync(narrativeGuidePath)) {
    const raw = fs.readFileSync(narrativeGuidePath, 'utf8').trim();
    styleGuideSection = `\n## 這位編輯者的敘事剪輯習慣（從 43 支影片的 X→Y 差異學習）\n\n以下規則是規則層清理完後，人工編輯還會額外做的敘事判斷。請以此為參考，判斷哪些段落應進一步刪除。\n\n${raw}\n\n---\n\n`;
    console.error(`🎨 已載入敘事守則（${raw.length} 字）`);
  } else {
    console.error(`ℹ️ 尚無敘事守則（narrative_style_guide.md），以通用 prompt 執行`);
  }
} catch (e) {
  console.error(`⚠️ 敘事守則載入失敗: ${e.message}`);
}

const inputText = residualPhrases.map(p => p.displayText).join('\n');
const charCount = inputText.length;
console.error(`📝 殘餘文稿 ${charCount} 字（給 Claude 看的）`);

const prompt = PROMPT_TEMPLATE_RAW
  .replace('{{NOTES_SECTION}}', notesSection)
  .replace('{{STYLE_GUIDE_SECTION}}', styleGuideSection)
  .replace('{{INPUT_TEXT}}', inputText);

// ── 呼叫 Claude ──
console.error(`\n🤖 呼叫 Claude（敘事級剪輯）[模型: ${MODEL || 'default'}]...`);
const startTime = Date.now();

let keptText;
try {
  const modelFlag = MODEL ? ` --model ${MODEL}` : '';
  keptText = llmExec(modelFlag, {
    input:     prompt,
    encoding:  'utf8',
    timeout:   600000,
    maxBuffer: 20 * 1024 * 1024,
    stdio:     ['pipe', 'pipe', 'pipe'],
    shell:     true
  }).trim();
} catch (err) {
  console.error(`❌ Claude 呼叫失敗: ${err.message}`);
  process.exit(1);
}

// 移除可能的 ```text ... ``` 包裝
keptText = keptText
  .replace(/^```(?:text|markdown|md)?\s*\n/i, '')
  .replace(/\n```\s*$/, '')
  .trim();

// 後處理防呆：截掉 Claude 違規附加的尾部內容
const TRIM_MARKERS = [
  /^---+\s*$/, /^\*\*\*+\s*$/, /^___+\s*$/,
  /^#+\s+/,
  /^\*\*[^*]*[:：][\s\S]*\*\*\s*$/,
  /^\|.*\|.*\|/
];
function shouldTrimAt(line) { return TRIM_MARKERS.some(re => re.test(line)); }
{
  const lines = keptText.split('\n');
  let cutAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (shouldTrimAt(lines[i].trim())) { cutAt = i; break; }
  }
  if (cutAt >= 0) {
    keptText = lines.slice(0, cutAt).join('\n').trim();
    console.error(`⚠️ 後處理：第 ${cutAt + 1} 行為違規 marker，截掉後段`);
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.error(`✅ Claude 回應 ${keptText.length} 字（耗時 ${elapsed}s）`);

// ── 對齊（殘餘文稿 → 殘餘 wordIdx；返回的索引仍是原始 word 索引空間）──
console.error(`\n🔗 對齊...`);
const alignResult = alignKeptText(keptText, residualPhrases, words);

console.error(`   殘餘字數: ${alignResult.stats.origChars}`);
console.error(`   保留字數: ${alignResult.stats.keptChars}`);
console.error(`   AI 第二遍刪 word: ${alignResult.deletedWordIndices.length}`);

if (alignResult.deletionRuns.length > 0) {
  const sumLen = alignResult.deletionRuns.reduce((s, r) => s + r.length, 0);
  console.error(`   大段刪除（≥30字）${alignResult.deletionRuns.length} 處，共 ${sumLen} 字`);
}

if (alignResult.warnings.length > 0) {
  console.error(`\n⚠️ 對齊警告 ${alignResult.warnings.length} 條（Claude 違反「只刪不寫」）：`);
  for (const w of alignResult.warnings) console.error(`   ${w}`);
} else {
  console.error(`   ✅ Claude 完全遵守「只刪不寫」約束`);
}

// 保守度檢查
const cutRate = alignResult.deletedWordIndices.length / residualWordCount;
if (cutRate > 0.20) {
  console.error(`⚠️ AI 第二遍刪除率 ${(cutRate*100).toFixed(1)}% 超過 20%，可能過度介入`);
}

// ── 合併: rules ∪ narrative ──
const finalDeleted = new Set(rulesDelSet);
const narrativeOnly = [];
for (const idx of alignResult.deletedWordIndices) {
  if (!finalDeleted.has(idx)) narrativeOnly.push(idx);
  finalDeleted.add(idx);
}
const finalIndices = [...finalDeleted].sort((a, b) => a - b);

// ── 合併 reasons ──
const finalReasons = {};
const rulesReasons = (rulesRaw && rulesRaw.reasons) || {};
for (const idx of finalIndices) {
  if (rulesDelSet.has(idx)) {
    finalReasons[idx] = `[規則] ${rulesReasons[idx] || '規則層刪除'}`;
  } else {
    finalReasons[idx] = '[AI 敘事] 跨段落重複觀點';
  }
}

const output = {
  indices:  finalIndices,
  reasons:  finalReasons,
  mode:     'layered',
  layers: {
    rules:       { count: rulesDelSet.size },
    narrative:   { count: narrativeOnly.length, deletion_runs: alignResult.deletionRuns }
  },
  alignment_warnings: alignResult.warnings,
  stats: {
    original_words:    words.filter(w => !w.isGap).length,
    after_rules_words: residualWordCount,
    after_ai_words:    residualWordCount - alignResult.deletedWordIndices.length,
    rules_deleted:     rulesDelSet.size,
    narrative_deleted: narrativeOnly.length,
    total_deleted:     finalIndices.length,
    ai_cut_rate:       cutRate
  },
  meta: {
    model:           MODEL || 'default',
    elapsed_seconds: parseFloat(elapsed)
  }
};

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

const keptTextFile = path.join(path.dirname(outputFile), 'kept_text_narrative.txt');
fs.writeFileSync(keptTextFile, keptText);

console.error(`\n✅ 完成`);
console.error(`   📄 合併刪除清單: ${outputFile}`);
console.error(`   📄 AI 第二遍輸出: ${keptTextFile}`);
console.error(`   📊 規則層刪 ${rulesDelSet.size} + AI 第二遍刪 ${narrativeOnly.length} = 共 ${finalIndices.length} 個 word`);
