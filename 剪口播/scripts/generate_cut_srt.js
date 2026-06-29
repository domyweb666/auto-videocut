#!/usr/bin/env node
/**
 * 生成剪輯後影片的 SRT 字幕
 *
 * 從原始 subtitles_words.json + delete_segments.json
 * 計算保留文字的新時間戳，輸出標準 SRT 格式
 *
 * 用法: node generate_cut_srt.js <subtitles_words.json> <delete_segments.json> [output.srt]
 */

const fs = require('fs');
const path = require('path');

const wordsFile = process.argv[2];
const deleteFile = process.argv[3];
const outputFile = process.argv[4] || 'output_cut.srt';

if (!wordsFile || !deleteFile) {
  console.error('用法: node generate_cut_srt.js <subtitles_words.json> <delete_segments.json> [output.srt]');
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const deleteSegments = JSON.parse(fs.readFileSync(deleteFile, 'utf8'))
  .sort((a, b) => a.start - b.start);

// ── 時間映射函數（複用 generate_subtitles.js 邏輯）──
function getDeletedTimeBefore(time) {
  let deleted = 0;
  for (const seg of deleteSegments) {
    if (seg.end <= time) {
      deleted += seg.end - seg.start;
    } else if (seg.start < time) {
      deleted += time - seg.start;
    }
  }
  return deleted;
}

// 一個字被刪除的比例（重疊時長 / 字時長）。
// 用比例而非「任何重疊」判斷：Google STT 會把停頓吸進字的 end 裡，
// 停頓壓平的 partial delete 落在字尾的靜音上，但字本身有講出來——
// 不能因為字尾的靜音被刪就把整個字（含字幕文字）丟掉。
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

// ── 篩選保留的文字並重映射時間 ──
// start/end 各自用「該時間點之前被刪的累積量」映射，
// 字內若有被刪的停頓，end 會被自然拉近，字幕不會多停留。
const keptWords = [];
for (const w of words) {
  if (w.isGap) continue;
  if (deletedFraction(w.start, w.end) > 0.5) continue;   // 主體被刪才丟

  const newStart = w.start - getDeletedTimeBefore(w.start);
  let newEnd = w.end - getDeletedTimeBefore(w.end);
  if (newEnd <= newStart) newEnd = newStart + 0.05;       // 防呆
  keptWords.push({
    text: w.text,
    start: Math.round(newStart * 1000) / 1000,
    end: Math.round(newEnd * 1000) / 1000
  });
}

console.error(`📝 保留字數: ${keptWords.length}/${words.filter(w => !w.isGap).length}`);

// ── 分句：按間隔 ≥0.3s 切分 ──
const cues = [];
let currentCue = { text: '', start: 0, end: 0 };

for (let i = 0; i < keptWords.length; i++) {
  const w = keptWords[i];

  if (currentCue.text === '') {
    // 開始新句
    currentCue.start = w.start;
    currentCue.end = w.end;
    currentCue.text = w.text;
  } else {
    const gap = w.start - currentCue.end;

    // 分句條件：間隔 ≥0.3s 或 單句超過 20 字
    if (gap >= 0.3 || currentCue.text.length >= 20) {
      cues.push({ ...currentCue });
      currentCue = { text: w.text, start: w.start, end: w.end };
    } else {
      currentCue.text += w.text;
      currentCue.end = w.end;
    }
  }
}
if (currentCue.text) cues.push(currentCue);

// ── 合併太短的句（<0.5s 或 <2字）──
const mergedCues = [];
for (const cue of cues) {
  if (mergedCues.length > 0 && (cue.end - cue.start < 0.5 || cue.text.length < 2)) {
    // 合併到前一句
    const prev = mergedCues[mergedCues.length - 1];
    prev.text += cue.text;
    prev.end = cue.end;
  } else {
    mergedCues.push({ ...cue });
  }
}

// ── 格式化 SRT ──
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.min(999, Math.floor((seconds % 1) * 1000));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

let srt = '';
mergedCues.forEach((cue, i) => {
  srt += `${i + 1}\n`;
  srt += `${formatTime(cue.start)} --> ${formatTime(cue.end)}\n`;
  srt += `${cue.text}\n\n`;
});

fs.writeFileSync(outputFile, srt, 'utf8');
console.error(`✅ 已產出 SRT: ${outputFile} (${mergedCues.length} 條字幕)`);
