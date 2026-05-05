#!/usr/bin/env node
/**
 * ai_word_surgery.js — 字詞手術層（Layer 4: Word-level Surgery）
 *
 * 對 ai_cut_pairs 決定保留的 phrase 做「句內字詞精修」，
 * 把要刪除的字元索引寫入 phrase.wordDeleteIdx（相對於 phrase.wordIndices）。
 *
 * 用法:
 *   node ai_word_surgery.js [--model <model>] <ai_sentences.json> [ai_sentences_surgery.json]
 *
 * 若省略輸出檔名，則就地覆寫輸入檔。
 *
 * 輸出：在每個保留的 phrase 上新增欄位
 *   wordDeleteIdx: [0, 6, 7]          // 相對於 phrase.wordIndices
 *   wordDeleteReason: "去除冗贅字"     // AI 判決理由
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── 解析參數 ──
let MODEL = '';
let WORDS_FILE = '';  // subtitles_words.json 路徑（選用）
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--model' && process.argv[i + 1]) {
    MODEL = process.argv[++i];
  } else if (a === '--words-file' && process.argv[i + 1]) {
    WORDS_FILE = process.argv[++i];
  } else {
    positional.push(a);
  }
}

const inputFile  = positional[0];
const outputFile = positional[1] || inputFile;  // 預設就地覆寫

if (!inputFile) {
  console.error('用法: node ai_word_surgery.js [--model <model>] <ai_sentences.json> [output.json]');
  process.exit(1);
}
if (!fs.existsSync(inputFile)) {
  console.error('\u274C 找不到輸入檔:', inputFile);
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 讀取 prompt ──
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'ai_word_surgery_prompt.md');
let PROMPT_RAW = '';
try {
  PROMPT_RAW = fs.readFileSync(PROMPT_PATH, 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim();
} catch (e) {
  console.error('\u274C 無法讀取 prompt:', PROMPT_PATH);
  process.exit(1);
}

// ── 載入 Skills（供 {{NOTES_SECTION}}）──
let notesSection = '';
try {
  const skillsPath = path.join(__dirname, '..', 'editing_skills.md');
  if (fs.existsSync(skillsPath)) {
    const skills = fs.readFileSync(skillsPath, 'utf8')
      .replace(/^<!--[\s\S]*?-->\s*/gm, '')
      .trim();
    notesSection = '\n## 個人剪輯風格說明書\n' + skills + '\n';
  }
} catch (e) {}

// ── 載入 words（若有）供顯示準確的詞級 token ──
let wordsData = null;
if (WORDS_FILE && fs.existsSync(WORDS_FILE)) {
  try { wordsData = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8')); } catch (e) {}
}

// ── 載入 ai_sentences ──
const phrases = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
console.log('\uD83D\uDCDD 共 ' + phrases.length + ' phrases');

// 處理保留的 phrase（aiDelete=false）和從未被判斷的 phrase（aiDelete=undefined）
// 排除：aiDelete=true（規則/AI 已刪）、gapDelete=true（靜音段刪）
const keptIdx = [];
for (let i = 0; i < phrases.length; i++) {
  const p = phrases[i];
  if (p.aiDelete === true || p.gapDelete === true) continue;
  // 太短的 phrase 不處理（開頭詞手術至少需要 ≥4 個 word）
  const txt = (p.displayText || p.text || '').replace(/[，。！？、：；,.!?:;\s]/g, '');
  if (txt.length < 4) continue;
  // 沒有 wordIndices 就沒得刪
  if (!Array.isArray(p.wordIndices) || p.wordIndices.length < 3) continue;
  keptIdx.push(i);
}
const unjudgedCount = keptIdx.filter(i => phrases[i].aiDelete === undefined).length;
console.log('\u270F\uFE0F  候選 phrase: ' + keptIdx.length + ' 個（AI 保留: ' + (keptIdx.length - unjudgedCount) + '，未判斷: ' + unjudgedCount + '）');

if (keptIdx.length === 0) {
  // 直接寫出原檔（可能是同路徑）
  if (outputFile !== inputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(phrases, null, 2));
  }
  console.log('\u2705 無需手術，直接輸出');
  process.exit(0);
}

// ── 建立 phrase 清單（每個 phrase 顯示詞級 token 與索引）──
// deleteIdx 對應 phrase.wordIndices 的位置（0-based），非 text 字元位置。
function buildPhraseLine(phrase, phraseIdx) {
  const wis = phrase.wordIndices || [];
  // 取得每個詞的文字：優先從 wordsData，否則退化為 phrase.text 的字元切割
  let tokens;
  if (wordsData) {
    tokens = wis.map(wi => (wordsData[wi] ? wordsData[wi].text : '?') || '?');
  } else {
    // fallback：把 phrase.text 按字元切（可能有 2-char 詞錯位，但聊勝於無）
    const text = (phrase.text || phrase.displayText || '').replace(/[，。！？、：；,.!?:;\s]/g, '');
    const chars = Array.from(text);
    tokens = chars.length === wis.length ? chars : chars;
  }
  const tokenLine = tokens.join(' ');
  const idxLine   = tokens.map((_, i) => String(i).padStart(String(Math.max(tokens.length - 1, 0)).length, ' ')).join(' ');
  const label = phrase.aiDelete === false ? '[kept]' : '[unjudged]';
  return '[' + phraseIdx + '] ' + label + ' ' + JSON.stringify(phrase.displayText || phrase.text || '')
    + '\n     詞: ' + tokenLine
    + '\n     idx: ' + idxLine;
}

// ── 分批（每批 ~30 個 phrase，避免 token 爆）──
const BATCH_SIZE = 30;
const batches = [];
for (let i = 0; i < keptIdx.length; i += BATCH_SIZE) {
  batches.push(keptIdx.slice(i, i + BATCH_SIZE));
}

// ── 解析 JSON ──
function parseJSON(raw) {
  const s = raw.trim();
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

// ── 組 prompt ──
const SPLIT_MARKER = '<!-- AUTORESEARCH_END -->';
function buildPrompt(phrasesSection) {
  let editable, tail;
  if (PROMPT_RAW.includes(SPLIT_MARKER)) {
    [editable, tail] = PROMPT_RAW.split(SPLIT_MARKER);
  } else {
    editable = PROMPT_RAW;
    tail = '\n## 待處理 phrase 批次\n{{PHRASES_SECTION}}\n\n## 輸出格式\nJSON only。';
  }
  return editable
    .replace('{{NOTES_SECTION}}', notesSection)
    .trimEnd()
    + '\n\n'
    + tail
    .replace('{{PHRASES_SECTION}}', phrasesSection)
    .trimStart();
}

// ── 快取 ──
const crypto = require('crypto');
const cacheFile = (outputFile || inputFile).replace(/\.json$/, '_surgery_cache.json');
const textsHash = crypto.createHash('md5')
  .update(keptIdx.map(i => phrases[i].text || phrases[i].displayText || '').join('|'))
  .digest('hex').slice(0, 12);

if (fs.existsSync(cacheFile)) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.hash === textsHash && cached.model === (MODEL || 'default')) {
      console.log('\u26A1 surgery 快取命中（hash=' + textsHash + '），直接套用');
      for (const [idxStr, v] of Object.entries(cached.decisions || {})) {
        const idx = parseInt(idxStr, 10);
        if (!phrases[idx]) continue;
        const deleteIdx = Array.isArray(v.deleteIdx) ? v.deleteIdx : [];
        if (deleteIdx.length === 0) continue;
        phrases[idx].wordDeleteIdx = deleteIdx;
        if (v.reason) phrases[idx].wordDeleteReason = v.reason;
      }
      fs.writeFileSync(outputFile, JSON.stringify(phrases, null, 2));
      console.log('\u2705 已寫出: ' + outputFile);
      process.exit(0);
    }
  } catch (e) {}
}

// ── 逐批呼叫 Claude ──
console.log('\n\uD83E\uDD16 呼叫 Claude 做字詞手術 [模型: ' + (MODEL || 'default') + ', ' + batches.length + ' 批]');
const allDecisions = {};  // phraseIdx (string) → { deleteIdx, reason }

for (let b = 0; b < batches.length; b++) {
  const batch = batches[b];
  const section = batch.map(i => buildPhraseLine(phrases[i], i)).join('\n\n');
  const prompt = buildPrompt(section);
  let raw;
  try {
    const modelFlag = MODEL ? ' --model ' + MODEL : '';
    raw = execSync(claudeCmd + ' -p -' + modelFlag, {
      input:     prompt,
      encoding:  'utf8',
      timeout:   180000,
      maxBuffer: 5 * 1024 * 1024,
      stdio:     ['pipe', 'pipe', 'pipe'],
      shell:     true,
    }).trim();
  } catch (e) {
    console.warn('\u26A0\uFE0F 批 ' + (b + 1) + '/' + batches.length + ' Claude 呼叫失敗: ' + e.message.slice(0, 100));
    continue;
  }
  const json = parseJSON(raw);
  if (!json || typeof json !== 'object') {
    console.warn('\u26A0\uFE0F 批 ' + (b + 1) + '/' + batches.length + ' 回傳格式無法解析');
    continue;
  }
  for (const [idxStr, v] of Object.entries(json)) {
    if (!v || !Array.isArray(v.deleteIdx)) continue;
    allDecisions[idxStr] = { deleteIdx: v.deleteIdx, reason: v.reason || '' };
  }
  console.log('   批 ' + (b + 1) + '/' + batches.length + ' 完成（' + Object.keys(json).length + ' 個判決）');
}

// ── 套用判決 + 驗證 ──
let appliedCount = 0;
let skippedTooMany = 0;
let skippedProtected = 0;

// 保留連接詞（硬約束：命中就不刪）
const PROTECTED_CHARS = new Set([
  '但','是','如','果','事','實','上','也','就','說','你','要','那','麼','所','以',
  '因','此','換','句','話','我','們','怎','比',
  '不','沒','別','未',  // 否定詞
]);

for (const [idxStr, v] of Object.entries(allDecisions)) {
  const idx = parseInt(idxStr, 10);
  const p = phrases[idx];
  if (!p || p.aiDelete || p.gapDelete) continue;

  const wis = p.wordIndices || [];
  const text = (p.text || p.displayText || '').replace(/[，。！？、：；,.!?:;\s]/g, '');
  const chars = Array.from(text);

  // 過濾 deleteIdx：out-of-range 去掉，否定詞保護（防模型誤刪）
  const clean = [];
  let hadProtected = false;
  for (const di of v.deleteIdx) {
    if (typeof di !== 'number' || di < 0 || di >= wis.length) continue;
    const ch = chars[di];
    if (ch && PROTECTED_CHARS.has(ch)) { hadProtected = true; continue; }
    clean.push(di);
  }
  if (hadProtected) skippedProtected++;

  // 硬上限：不超過 phrase 長度的 40%
  const maxDel = Math.floor(wis.length * 0.4);
  if (clean.length > maxDel) {
    skippedTooMany++;
    continue;
  }

  if (clean.length === 0) continue;
  p.wordDeleteIdx = clean.sort((a, b) => a - b);
  if (v.reason) p.wordDeleteReason = v.reason;
  appliedCount++;
}

// ── 儲存快取 ──
try {
  fs.writeFileSync(cacheFile, JSON.stringify({
    hash: textsHash,
    model: MODEL || 'default',
    decisions: allDecisions,
  }, null, 2));
} catch (e) {
  console.warn('\u26A0\uFE0F 快取儲存失敗: ' + e.message);
}

fs.writeFileSync(outputFile, JSON.stringify(phrases, null, 2));
console.log('\n\u2705 字詞手術完成：' + appliedCount + ' 個 phrase 有 wordDeleteIdx');
if (skippedProtected) console.log('   跳過 ' + skippedProtected + ' 個保留詞觸發');
if (skippedTooMany)   console.log('   跳過 ' + skippedTooMany + ' 個超過 40% 上限');
console.log('\u2705 已寫出: ' + outputFile);
