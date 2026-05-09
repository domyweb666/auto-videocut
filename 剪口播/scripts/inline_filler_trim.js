#!/usr/bin/env node
/**
 * inline_filler_trim.js — 句中單字 filler 清理
 *
 * 跑在 ai_polish_audit 之後。掃所有「保留」的句子，找句中 isolated 的雜音字
 * （嗯、呃這類 100% 確定是 hesitation），標進新欄位 inlineFillerWordIndices。
 * 介面會把這些 word index 加進刪除集合，但 phrase 整句仍保留。
 *
 * 設計原則：極端保守
 * - 只動 STRICT_FILLERS 列表內的字
 * - 不碰「那個」「就是」「我覺得」等有合法用法的詞
 * - 句子只有 1 個字 → 不動（避免把整句變空）
 * - 句首/句尾的雜音 → discourse_opener rule 已經整句刪過，這裡不重複
 *
 * 用法：
 *   node inline_filler_trim.js <sentences.json> <subtitles_words.json>
 */

const fs = require('fs');
const path = require('path');

const sentencesPath = process.argv[2];
const wordsPath = process.argv[3];

if (!sentencesPath || !wordsPath) {
  console.error('用法: node inline_filler_trim.js <sentences.json> <subtitles_words.json>');
  process.exit(1);
}

// 嚴格雜音清單：只動這些。其他「那個/就是/我覺得」太曖昧，不自動清。
const STRICT_FILLERS = new Set([
  '嗯', '呃', '欸', '哦', '噢',
  // 「啊」單字也納入但要更嚴格判斷（前後標點才動）
]);
const SOFT_FILLERS = new Set(['啊']); // 需要更嚴格條件才動

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const sentences = loadJSON(sentencesPath);
const words = loadJSON(wordsPath);

if (!Array.isArray(sentences) || !Array.isArray(words)) {
  console.error('❌ 輸入檔格式錯誤');
  process.exit(1);
}

let totalTrimmed = 0;
const trimDetails = [];

for (let si = 0; si < sentences.length; si++) {
  const s = sentences[si];
  if (s.aiDelete) continue;                       // 整句刪了 → 不用再處理
  if (!Array.isArray(s.wordIndices) || s.wordIndices.length < 2) continue; // 只 1 個字不動

  const trims = [];
  for (let wi = 0; wi < s.wordIndices.length; wi++) {
    const globalIdx = s.wordIndices[wi];
    if (globalIdx < 0 || globalIdx >= words.length) continue;
    const w = words[globalIdx];
    if (!w || w.isGap) continue;
    const text = (w.text || w.word || '').trim();
    if (!text) continue;

    const isStrict = STRICT_FILLERS.has(text);
    const isSoft = SOFT_FILLERS.has(text);
    if (!isStrict && !isSoft) continue;

    // 句首/句尾的 filler 已交給 discourse_opener rule（會整句刪）—— 跳過邊界位置
    if (wi === 0 || wi === s.wordIndices.length - 1) continue;

    // 軟性雜音額外條件：前面字必須是標點（逗號/句點）才動
    if (isSoft) {
      const prevIdx = s.wordIndices[wi - 1];
      const prev = words[prevIdx];
      const prevText = (prev && (prev.text || prev.word) || '').trim();
      // 「啊」前面如果是標點才視為 hesitation
      if (!/[，。、？！,.?!]$/.test(prevText)) continue;
    }

    trims.push(globalIdx);
  }

  if (trims.length > 0) {
    s.inlineFillerWordIndices = trims;
    totalTrimmed += trims.length;
    trimDetails.push({ si, count: trims.length, sample: (s.displayText || s.text || '').slice(0, 30) });
  }
}

fs.writeFileSync(sentencesPath, JSON.stringify(sentences, null, 2));

console.error(`📐 inline filler 清理：共標出 ${totalTrimmed} 個句中雜音字（嗯/呃/欸/哦/噢/啊）`);
if (trimDetails.length > 0 && trimDetails.length <= 10) {
  for (const d of trimDetails) console.error(`  [${d.si}] ${d.count} 個 → ${d.sample}…`);
} else if (trimDetails.length > 10) {
  console.error(`  影響 ${trimDetails.length} 個句子（前 5 個範例）：`);
  for (const d of trimDetails.slice(0, 5)) console.error(`  [${d.si}] ${d.count} 個 → ${d.sample}…`);
}
