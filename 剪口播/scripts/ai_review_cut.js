#!/usr/bin/env node
/**
 * ai_review_cut.js — 獨立審核員（2026-07-18 新增）
 *
 * 定位：做的人與驗的人分開。拿原始證據文稿（含時間戳停頓）＋最終刪除標記，
 * 開一個「沒參與剪輯決策」的 Claude 會話盲審，找三種問題：
 *   漏剪（重錄雙份都留）、錯剪（強調句/獨有資訊被殺）、接縫（刪除邊界斷裂）。
 * 只出報告，不動刀（同 seam_coldread 純建議層精神——絕不自動改選集）。
 *
 * 用法:
 *   node ai_review_cut.js [--model <m>] [--silences <f>] \
 *     <subtitles_words.json> <final_selected.json> [report_basename]
 *
 * 輸出（與 final_selected.json 同層）:
 *   <basename>.json  結構化 findings
 *   <basename>.md    人讀報告（按嚴重度排序）
 *   basename 預設 review_report
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { buildSentences, buildTranscript, parseAiJson, fmtTime } = require('./lib/narrative_evidence');

// ── 解析參數 ──
let MODEL = '', SILENCES_FILE = '';
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--model' && process.argv[i + 1])         MODEL = process.argv[++i];
  else if (a === '--silences' && process.argv[i + 1]) SILENCES_FILE = process.argv[++i];
  else positional.push(a);
}

const wordsFile = positional[0];
const selectedFile = positional[1];
const baseName = positional[2] || 'review_report';

if (!wordsFile || !selectedFile) {
  console.error('用法: node ai_review_cut.js [--model <m>] [--silences <f>] <subtitles_words.json> <final_selected.json> [report_basename]');
  process.exit(1);
}

const outDir = path.dirname(selectedFile);
const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 讀檔 ──
const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const selRaw = JSON.parse(fs.readFileSync(selectedFile, 'utf8'));
const delIndices = Array.isArray(selRaw) ? selRaw : (selRaw.indices || []);
const delSet = new Set(delIndices);

let silences = [];
const silPath = SILENCES_FILE || path.join(outDir, 'silences.json');
try { silences = JSON.parse(fs.readFileSync(silPath, 'utf8')); } catch (e) {}

// ── 證據文稿（最終刪除標記）──
const sentences = buildSentences(words, silences);
const transcript = buildTranscript(words, sentences, delSet, '刪');
console.error(`📖 ${words.length} word → ${sentences.length} 句；最終刪除 ${delSet.size} idx`);

// ── 組 prompt ──
const PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'ai_review_cut_prompt.md'), 'utf8'
).replace(/^<!--[\s\S]*?-->\s*/m, '').trim();

let notesSection = '';
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'training_config.json'), 'utf8'));
  const notes = config.notes || {};
  if (notes.proper_nouns && notes.proper_nouns.length > 0) {
    notesSection = `\n## 專有名詞（不是錯字，不因此報 finding）\n${notes.proper_nouns.join('、')}\n`;
  }
} catch (e) {}

const prompt = PROMPT_TEMPLATE
  .replace('{{NOTES_SECTION}}', notesSection)
  .replace('{{INPUT_TEXT}}', transcript);

// ── 呼叫 Claude（獨立會話 = 盲審；本腳本不傳任何決策理由給它）──
console.error(`\n🕵️ 呼叫獨立審核員 [模型: ${MODEL || 'default'}]...`);
const startTime = Date.now();
let rawOut;
try {
  const modelFlag = MODEL ? ` --model ${MODEL}` : '';
  rawOut = execSync(claudeCmd + ' -p -' + modelFlag, {
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

// ── 解析 ──
let parsed;
try {
  parsed = parseAiJson(rawOut);
} catch (e) {
  console.error(`❌ 輸出解析失敗: ${e.message}\n--- 原始輸出前 500 字 ---\n${rawOut.slice(0, 500)}`);
  process.exit(1);
}
const findings = Array.isArray(parsed.findings) ? parsed.findings : [];

// 附上時間碼方便人工核對
const sevOrder = { '高': 0, '中': 1, '低': 2 };
findings.sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));
for (const f of findings) {
  const s = Number(f.start), e = Number(f.end);
  if (Number.isInteger(s) && words[s] && Number.isInteger(e) && words[e]) {
    f.time = `${fmtTime(words[s].start)}-${fmtTime(words[e].end)}`;
  }
}

// ── 輸出 ──
const jsonPath = path.join(outDir, `${baseName}.json`);
const mdPath = path.join(outDir, `${baseName}.md`);
fs.writeFileSync(jsonPath, JSON.stringify({
  findings,
  stats: { total: findings.length,
           高: findings.filter(f => f.severity === '高').length,
           中: findings.filter(f => f.severity === '中').length,
           低: findings.filter(f => f.severity === '低').length },
  model: MODEL || 'default',
  generatedAt: new Date().toISOString()
}, null, 2), 'utf8');

const mdLines = [
  `# 剪輯審核報告（${path.basename(selectedFile)}）`,
  '',
  `共 ${findings.length} 條發現。審核員只報告不動刀；要採納哪條由人在審核頁操作。`,
  '',
  '| 嚴重度 | 類型 | idx | 時間 | 發現 | 建議 |',
  '|---|---|---|---|---|---|'
];
for (const f of findings) {
  mdLines.push(`| ${f.severity || '?'} | ${f.type || '?'} | ${f.start}-${f.end} | ${f.time || ''} | ${String(f.description || '').replace(/\|/g, '／')} | ${String(f.suggestion || '').replace(/\|/g, '／')} |`);
}
if (findings.length === 0) mdLines.push('| - | - | - | - | 未發現問題 | - |');
fs.writeFileSync(mdPath, mdLines.join('\n') + '\n', 'utf8');

console.error(`✅ 審核完成：${findings.length} 條（高 ${findings.filter(f=>f.severity==='高').length}／中 ${findings.filter(f=>f.severity==='中').length}／低 ${findings.filter(f=>f.severity==='低').length}）`);
console.error(`   報告：${mdPath}`);
console.error(`   結構化：${jsonPath}`);
if (findings.some(f => f.severity === '高')) process.exitCode = 0; // 純建議層，不以 exit code 擋流程
