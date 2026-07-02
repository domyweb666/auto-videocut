#!/usr/bin/env node
/**
 * kept_words.js — 「哪些字算保留」的單一事實來源
 *
 * generate_cut_srt / generate_cut_txt / verify_export / refine_segments（刀口原子化）
 * 全部吃這一套判斷。判斷不同源，就會出現「SRT 有這個字但影片沒講」的縫。
 *
 * 規則：
 *   一個字的「發音區」被刪超過 KEEP_THRESHOLD（0.5）才視為刪除。
 *   發音區 = 字的時間跨度扣掉音訊實測靜音（silences.json）——
 *   STT 會把停頓灌進字尾時長（實例：單字 timestamp 拉到 6.6s），
 *   停頓壓平刪的是字尾靜音，字本身有講出來，不能因此把字丟掉。
 *   沒有靜音資料時退回用整個字跨度算（與 2026-07-01 前的行為相容）。
 *
 * 注意：deleteSegs 一律傳「MERGE_GAP 合併後」的清單（mergeDeleteSegments 產物），
 * 跟 cut_video.sh 實際落刀同一份，否則被吞掉的短保留區會算錯。
 */

const KEEP_THRESHOLD = 0.5;

// 區間 [start,end] 扣掉 cuts（已排序與否皆可），回傳保留子區間
function subtractIntervals(start, end, cuts) {
  const overlaps = (cuts || [])
    .filter(c => c.end > start && c.start < end)
    .map(c => ({ start: Math.max(start, c.start), end: Math.min(end, c.end) }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = start;
  for (const o of overlaps) {
    if (o.start > cursor) out.push({ start: cursor, end: o.start });
    cursor = Math.max(cursor, o.end);
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out;
}

// 字的發音區：字跨度扣掉靜音。整跨度都在靜音裡（或無靜音資料）→ 退回整跨度。
function speechIntervalsOf(word, silences) {
  if (!silences || !silences.length) return [{ start: word.start, end: word.end }];
  const speech = subtractIntervals(word.start, word.end, silences);
  return speech.length ? speech : [{ start: word.start, end: word.end }];
}

function intervalsTotal(ivs) {
  let t = 0;
  for (const iv of ivs) t += Math.max(0, iv.end - iv.start);
  return t;
}

// intervals 與 segs 的重疊總長
function overlapTotal(ivs, segs) {
  let ov = 0;
  for (const iv of ivs) {
    for (const s of segs) {
      const lo = Math.max(iv.start, s.start);
      const hi = Math.min(iv.end, s.end);
      if (hi > lo) ov += hi - lo;
    }
  }
  return ov;
}

// 發音區被刪比例（0~1）。零時長字回 0（保留）。
function deletedFractionSpeech(word, deleteSegs, silences) {
  const speech = speechIntervalsOf(word, silences);
  const dur = intervalsTotal(speech);
  if (dur <= 0) return 0;
  return overlapTotal(speech, deleteSegs) / dur;
}

function isWordKept(word, deleteSegs, silences) {
  return deletedFractionSpeech(word, deleteSegs, silences) <= KEEP_THRESHOLD;
}

// 保留字清單（跳過 isGap）。回傳原字物件（不複製）。
function computeKeptWords(words, deleteSegs, silences) {
  return words.filter(w => !w.isGap && isWordKept(w, deleteSegs, silences));
}

// 讀 silences.json（[{start,end}] 或 {silences:[...]}），失敗回 null（呼叫端降級）
function loadSilences(file) {
  const fs = require('fs');
  try {
    if (!file || !fs.existsSync(file)) return null;
    let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) raw = raw.silences || [];
    const out = raw
      .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
      .map(s => ({ start: s.start, end: s.end }));
    return out.length ? out : null;
  } catch (_) { return null; }
}

module.exports = {
  KEEP_THRESHOLD,
  subtractIntervals,
  speechIntervalsOf,
  intervalsTotal,
  overlapTotal,
  deletedFractionSpeech,
  isWordKept,
  computeKeptWords,
  loadSilences,
};
