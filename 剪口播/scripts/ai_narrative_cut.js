#!/usr/bin/env node
/**
 * ai_narrative_cut.js — 敘事層決策（2026-07-18 新路線，取代 ai_narrative_pass 的 polished 稿路線）
 *
 * 跟舊路線的三個差別（見 decisions.md ADR-2026-07-18）：
 *   1. 吃原始 subtitles_words.json（含 isGap 時間戳）——停頓就是重錄的證據，不吃洗過的 polished 稿
 *   2. 輸出 idx 範圍決策 JSON——不讓 AI 重抄全文再對齊反推（杜絕抄寫漂移）
 *   3. 留後刪前鐵則進 prompt（規則 04），錯刪比囉嗦傷
 *
 * 流程:
 *   subtitles_words.json + auto_selected.json (規則層) [+ silences.json]
 *     ↓ 分句（音訊靜音優先）→ 組證據文稿（停頓 + 已刪標記）
 *     ↓ Claude 判斷敘事級瑕疵 → 回傳 {deletions:[{start,end,type,reason}]}
 *     ↓ 驗證 + 吸附句界 + 比例守門（預設新增 >25% 視為過度介入，中止）
 *     ↓ 合併: 最終刪除 = 規則層 ∪ 敘事層
 *   輸出 auto_selected_narrative.json（{indices, reasons, mode, layers}，審核頁可直接讀）
 *
 * 用法:
 *   node ai_narrative_cut.js [--model <m>] [--silences <silences.json>] [--max-ratio 0.25] [--dry-run] \
 *     <subtitles_words.json> <auto_selected.json> [output_path]
 *
 *   --dry-run  只印證據文稿統計與 prompt 長度，不呼叫 Claude
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');
const {
  buildSentences, buildTranscript, parseAiJson,
  validateDeletions, expandRanges, mergeSelections, additionRatio
} = require('./lib/narrative_evidence');

// ── 解析參數 ──
let MODEL = '', SILENCES_FILE = '', MAX_RATIO = 0.25, DRY_RUN = false;
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--model' && process.argv[i + 1])         MODEL = process.argv[++i];
  else if (a === '--silences' && process.argv[i + 1]) SILENCES_FILE = process.argv[++i];
  else if (a === '--max-ratio' && process.argv[i + 1]) MAX_RATIO = parseFloat(process.argv[++i]);
  else if (a === '--dry-run')                          DRY_RUN = true;
  else positional.push(a);
}

const wordsFile = positional[0];
const rulesFile = positional[1];
const outputFile = positional[2]
  || (rulesFile && path.join(path.dirname(rulesFile), 'auto_selected_narrative.json'));

if (!wordsFile || !rulesFile) {
  console.error('用法: node ai_narrative_cut.js [--model <m>] [--silences <f>] [--max-ratio 0.25] [--dry-run] <subtitles_words.json> <auto_selected.json> [output]');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 讀檔 ──
const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const rulesRaw = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
const rulesIndices = Array.isArray(rulesRaw) ? rulesRaw : (rulesRaw.indices || []);
const rulesReasons = Array.isArray(rulesRaw) ? {} : (rulesRaw.reasons || {});
const rulesSet = new Set(rulesIndices);

// silences.json：沒指定就找 auto_selected 同層（SKILL 4.0 慣例放 2_分析/）
let silences = [];
const silPath = SILENCES_FILE || path.join(path.dirname(rulesFile), 'silences.json');
try {
  silences = JSON.parse(fs.readFileSync(silPath, 'utf8'));
  console.error(`🔇 音訊靜音 ${silences.length} 段（${path.basename(silPath)}）`);
} catch (e) {
  console.error('ℹ️ 無 silences.json，分句退回 isGap（Google STT 上效果差，建議先跑 detect_silences）');
}

// ── 組證據文稿 ──
const sentences = buildSentences(words, silences);
const transcript = buildTranscript(words, sentences, rulesSet, '刪');
console.error(`📖 ${words.length} word → ${sentences.length} 句；規則層已刪 ${rulesSet.size} idx`);

// ── 組 prompt ──
const PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'ai_narrative_cut_prompt.md'), 'utf8'
).replace(/^<!--[\s\S]*?-->\s*/m, '').trim();

let notesSection = '';
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'training_config.json'), 'utf8'));
  const notes = config.notes || {};
  if (notes.proper_nouns && notes.proper_nouns.length > 0) {
    notesSection = `\n## 專有名詞（判斷相似時視為同一詞，不因錯字誤判）\n${notes.proper_nouns.join('、')}\n`;
  }
} catch (e) {}

let protectedSection = '';
try {
  const p = fs.readFileSync(path.join(__dirname, '..', '用户习惯', '10-保留連接詞.md'), 'utf8').trim();
  protectedSection = `\n## 使用者習慣：保留連接詞（整句刪除不受此限，但不可只為清詞而刪句）\n${p}\n`;
} catch (e) {}

const prompt = PROMPT_TEMPLATE
  .replace('{{NOTES_SECTION}}', notesSection)
  .replace('{{PROTECTED_SECTION}}', protectedSection)
  .replace('{{INPUT_TEXT}}', transcript);

if (DRY_RUN) {
  console.error(`🧪 dry-run：prompt ${prompt.length} 字，前 40 行證據文稿如下`);
  console.log(transcript.split('\n').slice(0, 40).join('\n'));
  process.exit(0);
}

// ── 呼叫 Claude ──
console.error(`\n🤖 呼叫 Claude（敘事層決策）[模型: ${MODEL || 'default'}]...`);
const startTime = Date.now();
let rawOut;
try {
  const modelFlag = MODEL ? ` --model ${MODEL}` : '';
  rawOut = llmExec(modelFlag, {
    input: prompt,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  }).trim();
} catch (err) {
  console.error(`❌ Claude 呼叫失敗: ${err.message}`);
  process.exit(1);
}
console.error(`⏱ ${(Date.now() - startTime) / 1000 | 0}s`);

// ── 解析 + 驗證 ──
let parsed;
try {
  parsed = parseAiJson(rawOut);
} catch (e) {
  console.error(`❌ 輸出解析失敗: ${e.message}\n--- 原始輸出前 500 字 ---\n${rawOut.slice(0, 500)}`);
  process.exit(1);
}

const { ranges, warnings } = validateDeletions(parsed.deletions, words, sentences);
warnings.forEach(w => console.error(`⚠️ ${w}`));

const narrativeSet = expandRanges(ranges);
const ratio = additionRatio(words, rulesSet, narrativeSet);
console.error(`✂️ 敘事層決策 ${ranges.length} 段，新增刪除比例 ${(ratio * 100).toFixed(1)}%（殘餘內容基準）`);

if (ratio > MAX_RATIO) {
  console.error(`❌ 新增刪除 ${(ratio * 100).toFixed(1)}% 超過上限 ${(MAX_RATIO * 100).toFixed(0)}%——視為過度介入，不輸出。`);
  console.error('   （fine-cut 哲學：內容幾乎全留。要放寬用 --max-ratio，但先想想是不是 prompt 或素材有問題）');
  process.exit(1);
}
if (ratio > 0.15) {
  console.error(`⚠️ 新增刪除超過 15%，偏多，建議在審核頁逐段確認敘事層決策`);
}

// ── 合併輸出 ──
const merged = mergeSelections(rulesIndices, rulesReasons, ranges);
const out = {
  indices: merged.indices,
  reasons: merged.reasons,
  mode: 'narrative_cut',
  layers: {
    rules: rulesSet.size,
    narrative_ranges: ranges.length,
    narrative_added: merged.added
  },
  deletions: ranges,
  model: MODEL || 'default',
  generatedAt: new Date().toISOString()
};
fs.writeFileSync(outputFile, JSON.stringify(out, null, 2), 'utf8');
console.error(`✅ 已輸出 ${outputFile}（規則 ${rulesSet.size} ∪ 敘事 +${merged.added} = ${merged.indices.length} idx）`);
console.error('   下一步：node validate_selection.js <subtitles_words.json> <本輸出> 驗保護詞，再進審核頁');
