#!/usr/bin/env node
/**
 * 苦工層「第二半」精修：停頓壓平 + 切點吸附。
 *
 * 輸入是「內容決策」的刪除清單（時間區段），輸出是「刀怎麼落」精修後的刪除清單。
 * 不碰 14 條選擇規則、不碰 cut_video.sh 切割核心，只對 delete_segments 做一次後處理。
 *
 *   ① 停頓壓平：保留的 gap（句間 0.2–0.8s 不規則小停頓）壓到一致的 target_sec。
 *      作法 = 在 gap 內補一段 partial delete，刪掉多出來的靜音，留 target_sec。
 *   ② 切點吸附：刀點邊界往最近的靜音波谷（局部 RMS 最低點）微調，
 *      避免切在音節中間。只動靜音裡的刀點，word 時間戳不變。
 *
 * 用法:
 *   node refine_segments.js <subtitles_words.json> <delete_segments.json> \
 *        <audio_rms.json> [out=delete_segments.refined.json] [config.json]
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
const outputFile = process.argv[5] || 'delete_segments.refined.json';
const configFileArg = process.argv[6];

if (!wordsFile || !deleteFile) {
  console.error('用法: node refine_segments.js <subtitles_words.json> <delete_segments.json> <audio_rms.json> [out] [config.json]');
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
const PF_KEEP_SIDE = PF.keep_side || 'tail';
const PF_PROTECT = new Set(PF.protect_idx || []);

const CS = config.cut_snap || {};
const CS_ENABLED = CS.enabled !== false;
const CS_WINDOW = CS.window_sec ?? 0.12;
const CS_MAX_INTRUDE = CS.max_intrude_sec ?? 0.06;
const CS_MARGIN_DB = CS.valley_margin_db ?? 6.0;

const EPS = 1e-4;

// ── 讀輸入 ──
const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
let deleteSegs = JSON.parse(fs.readFileSync(deleteFile, 'utf8'));
// 相容：陣列直接用；物件取 segments/deleteList
if (!Array.isArray(deleteSegs)) deleteSegs = deleteSegs.segments || deleteSegs.deleteList || [];
deleteSegs = deleteSegs
  .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
  .map(s => ({ start: s.start, end: s.end }));

const duration = words.length ? words[words.length - 1].end : 0;

// ── 工具：合併相鄰/重疊區段 ──
function mergeSegs(segs, mergeGap = 0) {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + mergeGap) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

// ── 工具：算 [a,b] 與刪除集合的交集總長 ──
function deletedWithin(a, b, segs) {
  let sum = 0;
  for (const s of segs) {
    const lo = Math.max(a, s.start);
    const hi = Math.min(b, s.end);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
}

// ── 工具：回傳 [a,b] 內「未被刪」的子區間（升序）──
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

// ══════════════════════════════════════════════════════
// Step A — 停頓壓平
// ══════════════════════════════════════════════════════
let baseSegs = mergeSegs(deleteSegs);
const pauseAdds = [];
let flattenedCount = 0;

if (PF_ENABLED) {
  // 約束檢查：target 必須 > cut_video.sh 的 MERGE_GAP(0.2)，否則留的靜音會被合併吃掉
  if (PF_TARGET <= 0.2 + EPS) {
    console.error(`⚠️ pause_flatten.target_sec=${PF_TARGET} <= MERGE_GAP(0.2)，留的靜音可能被 cut_video.sh 合併吃掉。建議 >0.2`);
  }

  words.forEach((w, idx) => {
    if (!w.isGap) return;
    if (PF_PROTECT.has(idx)) return;                    // 味道：挖坑，不壓
    const gStart = w.start, gEnd = w.end;

    // 此 gap 內尚未被刪、且夠長的子區間才壓
    const kept = keptSubIntervals(gStart, gEnd, baseSegs);
    for (const seg of kept) {
      const len = seg.end - seg.start;
      if (len < PF_FLOOR - EPS) continue;               // 太短：正常呼吸，不動
      if (len <= PF_TARGET + EPS) continue;             // 已夠短
      const cut = len - PF_TARGET;                       // 要砍掉的量
      if (PF_KEEP_SIDE === 'head') {
        // 留靠前（句尾那側），砍後段
        pauseAdds.push({ start: seg.start + PF_TARGET, end: seg.end });
      } else if (PF_KEEP_SIDE === 'mid') {
        // 留中間，砍兩頭
        const half = cut / 2;
        pauseAdds.push({ start: seg.start, end: seg.start + half });
        pauseAdds.push({ start: seg.end - half, end: seg.end });
      } else {
        // 預設 tail：留靠後（下一句開口前留一口氣），砍前段
        pauseAdds.push({ start: seg.start, end: seg.end - PF_TARGET });
      }
      flattenedCount++;
    }
  });
}

let workSegs = mergeSegs([...baseSegs, ...pauseAdds]);

// ══════════════════════════════════════════════════════
// Step B — 切點吸附
// ══════════════════════════════════════════════════════
let snappedCount = 0;
let snapMovedMs = [];

if (CS_ENABLED && fs.existsSync(rmsFile)) {
  const rms = JSON.parse(fs.readFileSync(rmsFile, 'utf8'));
  const series = rms.series || [];          // [[t, db], ...] 升序
  const floorDb = rms.rms_floor_db ?? -60;

  if (series.length) {
    const times = series.map(p => p[0]);

    // 二分找最接近 t 的索引
    function idxAt(t) {
      let lo = 0, hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < t) lo = mid + 1; else hi = mid;
      }
      return lo;
    }
    function dbAt(t) {
      const i = idxAt(t);
      return series[i] ? series[i][1] : floorDb;
    }
    // 在 [a,b] 內找 RMS 最低點時間
    function valleyIn(a, b) {
      let bestT = null, bestDb = Infinity;
      let i = idxAt(a);
      for (; i < series.length && series[i][0] <= b; i++) {
        if (series[i][1] < bestDb) { bestDb = series[i][1]; bestT = series[i][0]; }
      }
      return bestT === null ? null : { t: bestT, db: bestDb };
    }

    // 對 keep 區段的內部邊界吸附。
    // keep = 對 [0,duration] 扣掉 workSegs。內部邊界 = 每個 delete 區段的 start 與 end
    // （它們都緊貼保留內容）。對每個邊界往波谷微調，但限制吃進有聲的量。
    const snapBoundary = (b, intrudeDir) => {
      // intrudeDir: -1 表示「往左是有聲側」(此邊界是 delete.start，左邊是保留內容)
      //             +1 表示「往右是有聲側」(此邊界是 delete.end，右邊是保留內容)
      // 往有聲側最多移 CS_MAX_INTRUDE；往靜音側（delete 內部）可移滿 window。
      let lo, hi;
      if (intrudeDir < 0) { lo = b - CS_MAX_INTRUDE; hi = b + CS_WINDOW; }
      else { lo = b - CS_WINDOW; hi = b + CS_MAX_INTRUDE; }
      lo = Math.max(0, lo); hi = Math.min(duration, hi);
      const v = valleyIn(lo, hi);
      if (!v) return b;
      const here = dbAt(b);
      if (here - v.db >= CS_MARGIN_DB) {        // 找到明顯更安靜的點才移
        snapMovedMs.push(Math.round((v.t - b) * 1000));
        snappedCount++;
        return v.t;
      }
      return b;
    };

    workSegs = workSegs.map(s => {
      let ns = s.start, ne = s.end;
      // 跳過貼著影片頭尾的邊界（沒有對側保留內容）
      if (s.start > EPS) ns = snapBoundary(s.start, -1);   // start：左邊是保留內容
      if (s.end < duration - EPS) ne = snapBoundary(s.end, +1); // end：右邊是保留內容
      if (ne <= ns) { ns = s.start; ne = s.end; }          // 防呆：吸附後反向則還原
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
  ? (snapMovedMs.reduce((a, b) => a + Math.abs(b), 0) / snapMovedMs.length).toFixed(0)
  : 0;

console.error('📊 精修結果:');
console.error(`   停頓壓平: ${flattenedCount} 處（壓到 ${PF_TARGET}s）`);
console.error(`   切點吸附: ${snappedCount} 個邊界（平均移動 ${avgMove}ms）`);
console.error(`   刪除總長: ${origTotal.toFixed(2)}s → ${refinedTotal.toFixed(2)}s`);
console.error(`   區段數: ${baseSegs.length} → ${refined.length}`);
console.error(`✅ 已保存: ${outputFile}`);
