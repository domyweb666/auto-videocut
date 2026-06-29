#!/usr/bin/env node
/**
 * 從「音訊」實測靜音區段（不靠 STT gap）。
 *
 * 為什麼存在：Google STT zh-TW 回傳的字級時間戳幾乎全是「零間隔」
 * （word.end == next.start），真實停頓被吸進字時長裡，subtitles_words.json
 * 的 isGap 看不到。停頓壓平 / 死空氣刪除若只讀 isGap 會幾乎失效，
 * 必須改從音訊實測。本腳本用 ffmpeg silencedetect（與 verify_export.js 同一工具）。
 *
 * 用法:
 *   node detect_silences.js <audio> [out=silences.json] [noise_db=-30] [min_dur=0.20]
 * 輸出: [{ start, end, dur }, ...]（秒，升序）
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const audio = process.argv[2];
const out = process.argv[3] || 'silences.json';
const noiseDb = process.argv[4] || '-30';
const minDur = process.argv[5] || '0.20';

if (!audio) {
  console.error('用法: node detect_silences.js <audio> [out] [noise_db] [min_dur]');
  process.exit(1);
}
if (!fs.existsSync(audio)) {
  console.error('找不到音訊: ' + audio);
  process.exit(1);
}

// ffmpeg silencedetect → stderr
let stderr = '';
try {
  execFileSync('ffmpeg', [
    '-hide_banner', '-i', 'file:' + audio,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    '-f', 'null', '-',
  ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
} catch (e) {
  // ffmpeg 對 -f null 正常結束也可能走 catch（依平台），stderr 在 e.stderr
  stderr = (e.stderr || '').toString();
}
if (!stderr) {
  // 某些平台正常結束無 throw，重跑一次抓 stderr（保險）
  try {
    const r = require('child_process').spawnSync('ffmpeg', [
      '-hide_banner', '-i', 'file:' + audio,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
      '-f', 'null', '-',
    ], { encoding: 'utf8' });
    stderr = (r.stderr || '').toString();
  } catch (_) { /* ignore */ }
}

// 解析 silence_start / silence_end（與 verify_export.js 一致）
const sils = [];
let curStart = null;
for (const line of stderr.split('\n')) {
  let m = line.match(/silence_start:\s*(-?[\d.]+)/);
  if (m) { curStart = parseFloat(m[1]); continue; }
  m = line.match(/silence_end:\s*(-?[\d.]+)/);
  if (m && curStart !== null) {
    const end = parseFloat(m[1]);
    if (end > curStart) sils.push({ start: Math.max(0, curStart), end, dur: end - curStart });
    curStart = null;
  }
}

sils.sort((a, b) => a.start - b.start);
fs.writeFileSync(out, JSON.stringify(sils, null, 2));
console.error(`🔇 偵測到 ${sils.length} 段靜音（noise=${noiseDb}dB, d≥${minDur}s）→ ${out}`);
