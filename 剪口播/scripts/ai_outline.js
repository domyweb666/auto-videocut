#!/usr/bin/env node
/**
 * ai_outline.js — 整集意圖層（Layer 3: Intent）
 *
 * 把全集 polished.json 的 phrase 列表送給 Claude，
 * 切分成語意完整的 thought-units，每個標明主題與重要性（core/support/redundant）。
 * 輸出 outline.json 供下游 phrase_prefilter.js 和 ai_cut_pairs.js 使用。
 *
 * 用法:
 *   node ai_outline.js [--model <model>] <polished.json> [outline.json]
 *
 * 輸出格式:
 *   {
 *     "model": "...",
 *     "ts": "...",
 *     "phraseCount": 42,
 *     "units": [
 *       { "id": 1, "topic": "...", "importance": "core|support|redundant", "start": 0, "end": 5 }
 *     ],
 *     "phraseUnit": { "0": 1, "1": 1, ... }  // phraseIdx → unitId 快速查詢表
 *   }
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

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

const inputFile  = positional[0];
const outputFile = positional[1]
  || (inputFile && path.join(path.dirname(inputFile), 'outline.json'));

if (!inputFile) {
  console.error('用法: node ai_outline.js [--model <model>] <polished.json> [outline.json]');
  process.exit(1);
}
if (!fs.existsSync(inputFile)) {
  console.error('❌ 找不到輸入檔:', inputFile);
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 讀取 prompt 模板 ──
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'ai_outline_prompt.md');
let PROMPT_RAW = '';
try {
  PROMPT_RAW = fs.readFileSync(PROMPT_PATH, 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim();
} catch (e) {
  console.error('❌ 無法讀取 prompt:', PROMPT_PATH);
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
    notesSection = `\n## 個人剪輯風格說明書\n${skills}\n`;
  }
} catch (e) {}

// ── 載入 phrase 列表 ──
const phrases = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
console.log(`📝 共 ${phrases.length} 個 phrases`);

if (phrases.length === 0) {
  console.error('❌ polished.json 沒有 phrase 資料');
  process.exit(1);
}

// ── 建立 phrase 清單（供 AI 閱讀）──
// 只顯示 displayText，避免 token 浪費；加 gapAfter 讓 AI 感知段落邊界
function getPhraseLine(p, idx) {
  const text = (p.displayText || p.text || '').trim();
  const gap  = typeof p.gapAfter === 'number' && p.gapAfter >= 0.5
    ? ` ▏${p.gapAfter.toFixed(1)}s`
    : '';
  const time = p.startTime != null ? ` @${p.startTime.toFixed(1)}s` : '';
  return `[${idx}]${time} ${text}${gap}`;
}

const phrasesSection = phrases.map((p, i) => getPhraseLine(p, i)).join('\n');

// ── 組 prompt ──
const SPLIT_MARKER = '<!-- AUTORESEARCH_END -->';
function buildPrompt() {
  let editable, tail;
  if (PROMPT_RAW.includes(SPLIT_MARKER)) {
    [editable, tail] = PROMPT_RAW.split(SPLIT_MARKER);
  } else {
    editable = PROMPT_RAW;
    tail = '\n## 影片段落\n{{PHRASES_SECTION}}\n\n## 輸出格式\n\nJSON only，key 為段落編號。';
  }
  return editable
    .replace('{{NOTES_SECTION}}', notesSection)
    .trimEnd()
    + '\n\n'
    + tail
    .replace('{{PHRASES_SECTION}}', phrasesSection)
    .trimStart();
}

// ── 解析 JSON ──
function parseJSON(raw) {
  const s = raw.trim();
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

// ── 快取（根據 phrase 文字 hash）──
const crypto = require('crypto');
const cacheFile = outputFile.replace(/\.json$/, '_cache.json');
const phrasesHash = crypto.createHash('md5')
  .update(phrases.map(p => p.displayText || p.text || '').join('|'))
  .digest('hex').slice(0, 12);

if (fs.existsSync(cacheFile)) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.hash === phrasesHash && cached.model === (MODEL || 'default')) {
      console.log(`⚡ outline 快取命中（hash=${phrasesHash}），跳過 Claude 呼叫`);
      fs.writeFileSync(outputFile, JSON.stringify(cached.result, null, 2));
      console.log(`✅ 已寫出: ${outputFile}`);
      process.exit(0);
    }
  } catch (e) {}
}

// ── 呼叫 Claude ──
console.log(`\n🤖 呼叫 Claude 分析整集意圖 [模型: ${MODEL || 'default'}]`);
const prompt = buildPrompt();

let raw;
try {
  const modelFlag = MODEL ? ` --model ${MODEL}` : '';
  raw = llmExec(modelFlag, {
    input:     prompt,
    encoding:  'utf8',
    timeout:   180000,
    maxBuffer: 5 * 1024 * 1024,
    stdio:     ['pipe', 'pipe', 'pipe'],
    shell:     true,
  }).trim();
} catch (e) {
  console.error('❌ Claude 呼叫失敗:', e.message.slice(0, 120));
  process.exit(1);
}

const json = parseJSON(raw);
if (!json || !Array.isArray(json.units)) {
  console.error('❌ Claude 回傳格式無法解析:\n', raw.slice(0, 300));
  process.exit(1);
}

// ── 驗證：確認所有 phrase 都被覆蓋 ──
const covered = new Set();
for (const u of json.units) {
  const start = u.start ?? u.startPhraseIdx ?? 0;
  const end   = u.end   ?? u.endPhraseIdx   ?? start;
  u.start = start;
  u.end   = end;
  for (let i = start; i <= end; i++) covered.add(i);
}

// 補齊未覆蓋的 phrase（放進最近的 unit，或新建一個 redundant unit）
const uncovered = [];
for (let i = 0; i < phrases.length; i++) {
  if (!covered.has(i)) uncovered.push(i);
}
if (uncovered.length > 0) {
  console.warn(`⚠️ ${uncovered.length} 個 phrase 未被 outline 覆蓋，補入 redundant unit`);
  json.units.push({
    id: json.units.length + 1,
    topic: '(未分類段落)',
    importance: 'redundant',
    start: uncovered[0],
    end:   uncovered[uncovered.length - 1],
  });
}

// ── 建立 phraseUnit 快查表 ──
const phraseUnit = {};
for (const u of json.units) {
  for (let i = u.start; i <= u.end; i++) {
    phraseUnit[i] = u.id;
  }
}

const result = {
  model:       MODEL || 'default',
  ts:          new Date().toISOString(),
  phraseCount: phrases.length,
  units:       json.units,
  phraseUnit,
};

// 儲存快取
try {
  fs.writeFileSync(cacheFile, JSON.stringify({ hash: phrasesHash, model: MODEL || 'default', result }, null, 2));
} catch (e) {
  console.warn('⚠️ 快取儲存失敗:', e.message);
}

fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
console.log(`\n✅ outline 完成：${json.units.length} 個 thought-units`);
console.log(`   core:      ${json.units.filter(u => u.importance === 'core').length} 個`);
console.log(`   support:   ${json.units.filter(u => u.importance === 'support').length} 個`);
console.log(`   redundant: ${json.units.filter(u => u.importance === 'redundant').length} 個`);
console.log(`✅ 已寫出: ${outputFile}`);
