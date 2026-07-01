#!/usr/bin/env node
/**
 * 苦工層「第二半」精修：停頓壓平 + 切點吸附。
 *
 * 輸入是「內容決策」的刪除清單（時間區段），輸出是「刀怎麼落」精修後的刪除清單。
 * 不碰 14 條選擇規則、不碰 cut_video.sh 切割核心，只對 delete_segments 做一次後處理。
 *
 *   ① 停頓壓平：把過長的句間停頓壓到一致的 target_sec（在停頓中補 partial delete）。
 *      靜音來源＝音訊實測（silences.json，由 detect_silences.js 產），
 *      不靠 STT gap —— 因為 Google STT zh-TW 的字時間戳幾乎零間隔，
 *      真實停頓被吸進字時長裡，isGap 看不到（實測 616/618 對相鄰字零間隔）。
 *      無 silences.json 時退回讀 isGap（舊行為）。
 *   ② 切點吸附：刀點邊界往最近 RMS 波谷微調，避免切在音節中間。
 *
 * 用法:
 *   node refine_segments.js <subtitles_words.json> <delete_segments.json> \
 *        <audio_rms.json> <silences.json> [out=delete_segments.refined.json] [config.json]
 *
 * 設計分流（重要）：
 *   原始 delete_segments.json = 內容訊號，訓練/diff/F1 用。
 *   本腳本輸出的 refined = 苦工，ffmpeg 落刀 + SRT 用。兩者不可混。
 */

const fs = require('fs');
const path = require('path');

// ── 參數 ──
const wordsFile = process.argv[2];
const deleteFile = process.argv[3];
const rmsFile = process.argv[4];
const silencesFile = process.argv[5];
const outputFile = process.argv[6] || 'delete_segments.refined.json';
const configFileArg = process.argv[7];

if (!wordsFile || !deleteFile) {
  console.error('用法: node refine_segments.js <subtitles_words.json> <delete_segments.json> <audio_rms.json> <silences.json> [out] [config.json]');
  process.exit(1);
}

// ── 讀 config（找 training_config.json）──
function loadConfig() {
  const candidates = [
    configFileArg,
    path.join(__dirname, '..', 'training_config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
    } catch (_) { /* 忽略，用預設 */ }
  }
  return {};
}
const config = loadConfig();

const PF = config.pause_flatten || {};
const PF_ENABLED = PF.enabled !== false;
const PF_FLOOR = PF.floor_sec ?? 0.20;
const PF_TARGET = PF.target_sec ?? 0.25;
// 轉場留白：原始保留停頓 ≥ PF_LONG_PAUSE 視為段落/主題切換，只壓到 PF_LONG_TARGET（比氣口留更多呼吸）。
// 未設定時 PF_LONG_TARGET 退回 PF_TARGET（＝舊的單一 target 行為，向下相容）。
const PF_LONG_PAUSE = PF.long_pause_sec ?? Infinity;
const PF_LONG_TARGET = PF.long_target_sec ?? PF_TARGET;
const PF_KEEP_SIDE = PF.keep_side || 'tail';
const PF_PROTECT_IDX = new Set(PF.protect_idx || []);
const PF_PROTECT_RANGES = (PF.protect_ranges || []).filter(r => Array.isArray(r) && r.length === 2);

const CS = config.cut_snap || {};
const CS_ENABLED = CS.enabled !== false;
const CS_WINDOW = CS.window_sec ?? 0.12;
const CS_MAX_INTRUDE = CS.max_intrude_sec ?? 0.06;
const CS_MARGIN_DB = CS.valley_margin_db ?? 6.0;

const EPS = 1e-4;

// ── 讀輸入 ──
const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
let deleteSegs = JSON.parse(fs.readFileSync(deleteFile, 'utf8'));
if (!Array.isArray(deleteSegs)) deleteSegs = deleteSegs.segments || deleteSegs.deleteList || [];
deleteSegs = deleteSegs
  .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
  .map(s => ({ start: s.start, end: s.end }));

const duration = words.length ? words[words.length - 1].end : 0;

// ── 靜音來源：優先音訊實測（silences.json），退回 isGap ──
let silenceIntervals = [];
let silenceSource = 'none';
if (silencesFile && fs.existsSync(silencesFile)) {
  try {
    let raw = JSON.parse(fs.readFileSync(silencesFile, 'utf8'));
    if (!Array.isArray(raw)) raw = raw.silences || [];
    silenceIntervals = raw
      .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
      .map(s => ({ start: s.start, end: s.end }));
    if (silenceIntervals.length) silenceSource = 'audio';
  } catch (_) { /* 落到 fallback */ }
}
if (!silenceIntervals.length) {
  // fallback：用 STT gap（在 Google STT 上幾乎無效，但保留相容/離線情境）
  words.forEach((w, idx) => {
    if (w.isGap) silenceIntervals.push({ start: w.start, end: w.end, idx });
  });
  if (silenceIntervals.length) silenceSource = 'stt-gap(fallback)';
}

// ── 工具 ──
function mergeSegs(segs, mergeGap = 0) {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + mergeGap) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}
function keptSubIntervals(a, b, segs) {
  const overlaps = segs
    .filter(s => s.end > a && s.start < b)
    .map(s => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) }))
    .sort((x, y) => x.start - y.start);
  const out = [];
  let cursor = a;
  for (const o of overlaps) {
    if (o.start > cursor) out.push({ start: cursor, end: o.start });
    cursor = Math.max(cursor, o.end);
  }
  if (cursor < b) out.push({ start: cursor, end: b });
  return out;
}
function isProtectedInterval(sil) {
  if (sil.idx !== undefined && PF_PROTECT_IDX.has(sil.idx)) return true;
  for (const [a, b] of PF_PROTECT_RANGES) {
    // 停頓與保護時間範圍有重疊 → 視為味道（挖坑），不壓
    if (sil.end > a && sil.start < b) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════
// Step A — 停頓壓平
// ══════════════════════════════════════════════════════
let baseSegs = mergeSegs(deleteSegs);
const pauseAdds = [];
let flattenedCount = 0;      // 氣口（壓到 target_sec）
let longFlattenedCount = 0;  // 轉場（壓到 long_target_sec）

// 依原始保留停頓長度分兩段：短的是氣口壓到 target，長的是段落/轉場只壓到 long_target。
// 分流鐵律「廢話剪光、氣口留短、轉場留白」的「氣口 vs 轉場」就在這裡分。
function targetFor(len) {
  return len >= PF_LONG_PAUSE - EPS ? PF_LONG_TARGET : PF_TARGET;
}

if (PF_ENABLED) {
  if (PF_TARGET <= 0.2 + EPS) {
    console.error(`⚠️ pause_flatten.target_sec=${PF_TARGET} <= MERGE_GAP(0.2)，留的靜音可能被 cut_video.sh 合併吃掉。建議 >0.2`);
  }
  if (Number.isFinite(PF_LONG_PAUSE) && PF_LONG_TARGET < PF_TARGET - EPS) {
    console.error(`⚠️ pause_flatten.long_target_sec=${PF_LONG_TARGET} < target_sec=${PF_TARGET}，轉場反而留得比氣口短，多半設反了。`);
  }
  for (const sil of silenceIntervals) {
    if (isProtectedInterval(sil)) continue;                 // 味道：挖坑，不壓
    const kept = keptSubIntervals(sil.start, sil.end, baseSegs);
    for (const seg of kept) {
      const len = seg.end - seg.start;
      if (len < PF_FLOOR - EPS) continue;                   // 太短：正常呼吸
      const tgt = targetFor(len);                           // 氣口 vs 轉場，挑對應保留量
      if (len <= tgt + EPS) continue;                       // 已夠短
      const cut = len - tgt;
      if (PF_KEEP_SIDE === 'head') {
        pauseAdds.push({ start: seg.start + tgt, end: seg.end });
      } else if (PF_KEEP_SIDE === 'mid') {
        const half = cut / 2;
        pauseAdds.push({ start: seg.start, end: seg.start + half });
        pauseAdds.push({ start: seg.end - half, end: seg.end });
      } else {
        pauseAdds.push({ start: seg.start, end: seg.end - tgt }); // tail（預設）
      }
      if (tgt === PF_LONG_TARGET && PF_LONG_TARGET !== PF_TARGET) longFlattenedCount++;
      else flattenedCount++;
    }
  }
}

let workSegs = mergeSegs([...baseSegs, ...pauseAdds]);

// ══════════════════════════════════════════════════════
// Step B — 切點吸附
// ══════════════════════════════════════════════════════
let snappedCount = 0;
const snapMovedMs = [];

if (CS_ENABLED && rmsFile && fs.existsSync(rmsFile)) {
  const rms = JSON.parse(fs.readFileSync(rmsFile, 'utf8'));
  const series = rms.series || [];
  const floorDb = rms.rms_floor_db ?? -60;

  if (series.length) {
    const times = series.map(p => p[0]);
    function idxAt(t) {
      let lo = 0, hi = times.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function dbAt(t) { const i = idxAt(t); return series[i] ? series[i][1] : floorDb; }
    function valleyIn(a, b) {
      let bestT = null, bestDb = Infinity;
      for (let i = idxAt(a); i < series.length && series[i][0] <= b; i++) {
        if (series[i][1] < bestDb) { bestDb = series[i][1]; bestT = series[i][0]; }
      }
      return bestT === null ? null : { t: bestT, db: bestDb };
    }
    const snapBoundary = (b, intrudeDir) => {
      let lo, hi;
      if (intrudeDir < 0) { lo = b - CS_MAX_INTRUDE; hi = b + CS_WINDOW; }
      else { lo = b - CS_WINDOW; hi = b + CS_MAX_INTRUDE; }
      lo = Math.max(0, lo); hi = Math.min(duration, hi);
      const v = valleyIn(lo, hi);
      if (!v) return b;
      if (dbAt(b) - v.db >= CS_MARGIN_DB) {
        snapMovedMs.push(Math.round((v.t - b) * 1000));
        snappedCount++;
        return v.t;
      }
      return b;
    };
    workSegs = workSegs.map(s => {
      let ns = s.start, ne = s.end;
      if (s.start > EPS) ns = snapBoundary(s.start, -1);
      if (s.end < duration - EPS) ne = snapBoundary(s.end, +1);
      if (ne <= ns) { ns = s.start; ne = s.end; }
      return { start: ns, end: ne };
    });
    workSegs = mergeSegs(workSegs);
  }
} else if (CS_ENABLED) {
  console.error(`⚠️ 找不到 RMS 序列 ${rmsFile}，跳過切點吸附（僅做停頓壓平）`);
}

// ── 輸出 ──
const refined = workSegs
  .filter(s => s.end - s.start > EPS)
  .map(s => ({ start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000 }));

fs.writeFileSync(outputFile, JSON.stringify(refined, null, 2));

const origTotal = baseSegs.reduce((a, s) => a + (s.end - s.start), 0);
const refinedTotal = refined.reduce((a, s) => a + (s.end - s.start), 0);
const avgMove = snapMovedMs.length
  ? (snapMovedMs.reduce((a, b) => a + Math.abs(b), 0) / snapMovedMs.length).toFixed(0) : 0;

console.error('📊 精修結果:');
console.error(`   靜音來源: ${silenceSource}（${silenceIntervals.length} 段）`);
console.error(`   停頓壓平: 氣口 ${flattenedCount} 處（壓到 ${PF_TARGET}s）` +
  (Number.isFinite(PF_LONG_PAUSE) ? `、轉場 ${longFlattenedCount} 處（≥${PF_LONG_PAUSE}s，留 ${PF_LONG_TARGET}s）` : ''));
console.error(`   切點吸附: ${snappedCount} 個邊界（平均移動 ${avgMove}ms）`);
console.error(`   刪除總長: ${origTotal.toFixed(2)}s → ${refinedTotal.toFixed(2)}s`);
console.error(`   區段數: ${baseSegs.length} → ${refined.length}`);
console.error(`✅ 已保存: ${outputFile}`);
