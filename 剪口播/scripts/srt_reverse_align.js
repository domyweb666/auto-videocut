#!/usr/bin/env node
/**
 * srt_reverse_align.js — SRT 反向對齊工具
 *
 * 從手動編輯過的 SRT 字幕（保留想要的句子）反推
 * 出哪些 word indices 應該被刪除，輸出可直接供
 * execute-cut 或 cut_video.sh 使用的刪除清單。
 *
 * 使用情境：
 *   1. 先用 Whisper / generate_cut_srt.js 產生原始 SRT
 *   2. 在字幕編輯器中刪掉不想要的字幕條目（用原始時間戳）
 *   3. 執行本工具，反推出 delete_indices.json 與 delete_segments.json
 *
 * 用法:
 *   node srt_reverse_align.js <edited.srt> <subtitles_words.json> [output_dir]
 *
 * 輸出:
 *   <output_dir>/delete_indices.json   — word index 列表（可供前端 loadDeleteIndices）
 *   <output_dir>/delete_segments.json  — 時間區間列表（可直接傳給 cut_video.sh）
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ── 解析參數 ──
const srtFile   = process.argv[2];
const wordsFile = process.argv[3];
const outDir    = process.argv[4] || (wordsFile && path.dirname(wordsFile));

if (!srtFile || !wordsFile) {
  console.error('用法: node srt_reverse_align.js <edited.srt> <subtitles_words.json> [output_dir]');
  process.exit(1);
}
if (!fs.existsSync(srtFile))   { console.error('❌ 找不到 SRT:', srtFile);   process.exit(1); }
if (!fs.existsSync(wordsFile)) { console.error('❌ 找不到字詞檔:', wordsFile); process.exit(1); }

// ── 解析 SRT ──
function parseSrtTime(str) {
  // 格式: HH:MM:SS,mmm 或 HH:MM:SS.mmm
  const m = str.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
}

function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    // 找時間軸行（可能在第 1 或第 2 行，前面可能有序號）
    let timeLine = '';
    let textStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) { timeLine = lines[i]; textStart = i + 1; break; }
    }
    if (!timeLine) continue;
    const parts = timeLine.split('-->');
    if (parts.length !== 2) continue;
    const start = parseSrtTime(parts[0]);
    const end   = parseSrtTime(parts[1]);
    const text  = lines.slice(textStart).join(' ').trim();
    if (end > start && text) cues.push({ start, end, text });
  }
  return cues;
}

const srtText = fs.readFileSync(srtFile, 'utf8');
const cues    = parseSrt(srtText);
console.log(`📄 SRT 解析完成：${cues.length} 條字幕`);
if (cues.length === 0) { console.error('❌ SRT 無有效條目'); process.exit(1); }

// ── 載入字詞時間戳 ──
const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const realWords = words.filter(w => !w.isGap);
console.log(`📝 字詞數：${words.length}（非 gap：${realWords.length}）`);

// ── 建立 SRT cue 的時間索引（sort by start）──
cues.sort((a, b) => a.start - b.start);

// 判斷字詞是否被 SRT cue 覆蓋（任意一條 cue 時間範圍包含該字詞中心點）
function isCovered(word) {
  const mid = (word.start + word.end) / 2;
  // 二分搜尋加速
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid2 = (lo + hi) >> 1;
    const c = cues[mid2];
    if (c.end <= mid) { lo = mid2 + 1; }
    else if (c.start > mid) { hi = mid2 - 1; }
    else { return true; } // c.start <= mid < c.end
  }
  return false;
}

// ── 計算刪除 indices ──
const deleteIndices = [];
let keptCount  = 0;
let skippedGap = 0;

for (let i = 0; i < words.length; i++) {
  const w = words[i];
  if (w.isGap) { skippedGap++; continue; }
  if (isCovered(w)) {
    keptCount++;
  } else {
    deleteIndices.push(i);
  }
}

console.log(`\n📊 比對結果：`);
console.log(`   保留：${keptCount} 字`);
console.log(`   刪除：${deleteIndices.length} 字`);
console.log(`   Gap 跳過：${skippedGap}`);
const delPct = realWords.length > 0
  ? Math.round(deleteIndices.length / realWords.length * 100) : 0;
console.log(`   刪除率：${delPct}%`);

if (deleteIndices.length === 0) {
  console.log('ℹ️  沒有需要刪除的字詞，請確認 SRT 時間戳與 subtitles_words.json 是否對應同一份原始影片');
}

// ── 轉換成連續區間（用於 cut_video.sh）──
function indicesToSegments(idxList, allWords) {
  const s = new Set(idxList);
  const segs = [];
  let segStart = null;
  for (let i = 0; i < allWords.length; i++) {
    if (s.has(i)) {
      if (segStart === null) segStart = allWords[i].start;
    } else {
      if (segStart !== null) {
        segs.push({ start: segStart, end: allWords[i - 1].end });
        segStart = null;
      }
    }
  }
  if (segStart !== null) segs.push({ start: segStart, end: allWords[allWords.length - 1].end });
  return segs;
}

const deleteSegments = indicesToSegments(deleteIndices, words);
const totalDelSec = deleteSegments.reduce((s, seg) => s + seg.end - seg.start, 0);
console.log(`   刪除區間：${deleteSegments.length} 段，共 ${totalDelSec.toFixed(1)}s`);

// ── 輸出 ──
fs.mkdirSync(outDir, { recursive: true });

const idxOut  = path.join(outDir, 'delete_indices.json');
const segsOut = path.join(outDir, 'delete_segments.json');

fs.writeFileSync(idxOut,  JSON.stringify(deleteIndices,  null, 2));
fs.writeFileSync(segsOut, JSON.stringify(deleteSegments, null, 2));

console.log(`\n✅ 已輸出：`);
console.log(`   ${idxOut}`);
console.log(`   ${segsOut}`);
console.log(`\n接下來可以執行：`);
console.log(`   bash cut_video.sh <input_video> ${segsOut} <output.mp4>`);
