#!/usr/bin/env node
/**
 * 生成剪輯後影片的純文字文稿（TXT）
 *
 * 從原始 subtitles_words.json + delete_segments.json 取「保留的文字」，
 * 依句末標點（。！？）分段，輸出無時間碼的乾淨文稿——跟審核頁文稿呈現一致。
 *
 * 用法: node generate_cut_txt.js <subtitles_words.json> <delete_segments.json> [output.txt]
 */

const fs = require('fs');

const wordsFile = process.argv[2];
const deleteFile = process.argv[3];
const outputFile = process.argv[4] || 'output_cut.txt';

if (!wordsFile || !deleteFile) {
  console.error('用法: node generate_cut_txt.js <subtitles_words.json> <delete_segments.json> [output.txt]');
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const deleteSegments = JSON.parse(fs.readFileSync(deleteFile, 'utf8')).sort((a, b) => a.start - b.start);

// 一個字被刪的比例（與 generate_cut_srt.js 同標準：主體被刪才丟，字尾靜音被壓不算）
function deletedFraction(start, end) {
  const dur = end - start;
  if (dur <= 0) return 0;
  let overlap = 0;
  for (const seg of deleteSegments) {
    const lo = Math.max(start, seg.start);
    const hi = Math.min(end, seg.end);
    if (hi > lo) overlap += hi - lo;
  }
  return overlap / dur;
}

// 串起保留文字
let text = '';
for (const w of words) {
  if (w.isGap) continue;
  if (deletedFraction(w.start, w.end) > 0.5) continue;
  text += (w.text || '');
}

// 依句末標點分段（。！？…），與審核頁文稿一致；太短的句併回前段避免碎片
const SENT_END = /[。！？!?…]["」』）)]?/;
const paras = [];
let cur = '';
for (let i = 0; i < text.length; i++) {
  cur += text[i];
  // 命中句末標點，且不是緊接還有結尾引號/括號
  if (SENT_END.test(text[i])) {
    // 吃掉可能的結尾引號/括號
    while (i + 1 < text.length && /["」』）)]/.test(text[i + 1])) { cur += text[++i]; }
    if (cur.trim().length >= 4 || paras.length === 0) paras.push(cur);
    else paras[paras.length - 1] += cur; // 太短併回前段
    cur = '';
  }
}
if (cur.trim()) paras.push(cur);

fs.writeFileSync(outputFile, paras.join('\n\n') + '\n', 'utf8');
console.error(`✅ 已產出 TXT 文稿: ${outputFile}（${paras.length} 段，${text.length} 字）`);
