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
const path = require('path');
const { mergeDeleteSegments } = require(path.join(__dirname, 'merge_delete_segments.js'));
const { computeKeptWords, keptWordsByIndex, loadSilences } = require(path.join(__dirname, 'kept_words.js'));

const argv = process.argv.slice(2);
// --delete-indices <file>：審核頁字級刪除選集（與 SRT 同）；有給就以它決定保留哪些字。
let deleteIdxArg = null;
const di = argv.indexOf('--delete-indices');
if (di >= 0) { deleteIdxArg = argv[di + 1]; argv.splice(di, 2); }
const wordsFile = argv[0];
const deleteFile = argv[1];
const outputFile = argv[2] || 'output_cut.txt';

if (!wordsFile || !deleteFile) {
  console.error('用法: node generate_cut_txt.js <subtitles_words.json> <delete_segments.json> [output.txt]');
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
// 與 generate_cut_srt.js 同標準：吃 MERGE_GAP 合併後的最終刪除清單，
// 被吞掉的短保留區裡的字不進文稿（那些字在成品裡已被剪掉）
const deleteSegments = mergeDeleteSegments(JSON.parse(fs.readFileSync(deleteFile, 'utf8')));

// 字的去留判斷：有審核頁字級選集就照它（與審核頁文稿逐字一致）；否則退回發音區 >50% 判斷。
const silences = loadSilences(path.join(path.dirname(wordsFile), '..', '2_分析', 'silences.json'));
let deletedSet = null;
if (deleteIdxArg) {
  try {
    const raw = JSON.parse(fs.readFileSync(deleteIdxArg, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.deletedIndices || raw.indices || []);
    deletedSet = new Set(arr);
  } catch (e) { console.error(`⚠️ delete-indices 解析失敗，退回發音區判斷: ${e.message}`); }
}

// 串起保留文字
let text = '';
const keptSrc = deletedSet ? keptWordsByIndex(words, deletedSet) : computeKeptWords(words, deleteSegments, silences);
for (const w of keptSrc) {
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
