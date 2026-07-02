#!/usr/bin/env node
/*
 * build_timeline_map.js — 由保留段清單產出「理想時間 → 成品時間」分段映射
 *
 * 為什麼需要：cut_video.sh 兩條路徑的每個保留段在成品裡的實際長度都 ≠ 理想長度——
 *   單趟路徑：concat filter 每段推進 max(影片段長, 音訊段長)，影片段長受 frame 邊界/VFR 抖動
 *            （實測 41 段合成片：Σmax 預測 188.5657s vs 成品 188.565s，誤差 <1ms）
 *   多段路徑：每個 seg 檔重編碼後 frame 進位 + AAC priming
 * 段數一多每段 +6~20ms，106 段累積 +2s → SRT 用理想時間軸會片尾漂移。
 *
 * 用法: node build_timeline_map.js <segments.json> <packets|segfiles> <actualDur> <out.json> <tmpDir> <fps>
 *   packets  模式：讀 <tmpDir>/vpkts.csv（ffprobe 原片 video packet 的 pts,duration）精算每段影片長
 *   segfiles 模式：ffprobe segments.json 每個 seg 檔的 format duration（多段 concat 路徑）
 * 殘差（AAC priming、封裝零頭）按段均攤，讓映射總長 == ffprobe 成品實測。
 * predictedDuration 保留「均攤前」的模型預測值，verify_export 用它對帳實測、抓真正的 concat bug。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [, , segsPath, mode, actualStr, outPath, tmpDir, fpsStr] = process.argv;
if (!segsPath || !mode || !outPath) {
  console.error('用法: node build_timeline_map.js <segments.json> <packets|segfiles> <actualDur> <out.json> <tmpDir> <fps>');
  process.exit(1);
}

const segs = JSON.parse(fs.readFileSync(segsPath, 'utf8')); // [{i, start, end, out}]
const actual = parseFloat(actualStr);
const fps = parseFloat(fpsStr) || 30;

if (!Array.isArray(segs) || segs.length === 0) {
  console.error('❌ segments.json 為空');
  process.exit(1);
}

// 每段在成品裡的實際推進量
const adv = [];

if (mode === 'packets') {
  // trim 保留 pts ∈ [start, end) 的 frame；段影片長 = 末 frame pts − 首 frame pts + 末 frame duration
  const raw = fs.readFileSync(path.join(tmpDir, 'vpkts.csv'), 'utf8');
  const pk = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const [p, d] = line.split(',');
    const pts = parseFloat(p);
    if (!Number.isFinite(pts)) continue;
    pk.push({ pts, dur: parseFloat(d) });
  }
  pk.sort((a, b) => a.pts - b.pts);
  const ptsArr = pk.map(x => x.pts);
  const lowerBound = t => {
    let lo = 0, hi = ptsArr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ptsArr[m] < t) lo = m + 1; else hi = m; }
    return lo;
  };
  for (const s of segs) {
    const a = s.end - s.start;
    const i0 = lowerBound(s.start - 1e-9);
    const i1 = lowerBound(s.end - 1e-9);
    let v = 0;
    if (i1 > i0) {
      const last = pk[i1 - 1];
      const lastDur = Number.isFinite(last.dur) && last.dur > 0 ? last.dur : 1 / fps;
      v = last.pts - pk[i0].pts + lastDur;
    }
    adv.push(Math.max(v, a));
  }
} else if (mode === 'segfiles') {
  for (const s of segs) {
    let d = NaN;
    try {
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'file:' + s.out], { encoding: 'utf8' });
      d = parseFloat((r.stdout || '').trim());
    } catch (_) {}
    adv.push(Number.isFinite(d) && d > 0 ? d : (s.end - s.start));
  }
} else {
  console.error('❌ 未知模式: ' + mode);
  process.exit(1);
}

const ideal = segs.reduce((t, s) => t + (s.end - s.start), 0);
const predicted = adv.reduce((t, x) => t + x, 0);
// 殘差均攤：讓映射總長對齊成品實測（AAC priming、封裝零頭都在這裡吸收）
const resid = Number.isFinite(actual) && actual > 0 ? (actual - predicted) / segs.length : 0;

let cursor = 0;
const mapped = segs.map((s, i) => {
  const len = Math.max(0, adv[i] + resid);
  const e = {
    srcStart: +s.start.toFixed(4), srcEnd: +s.end.toFixed(4),
    dstStart: +cursor.toFixed(4), dstEnd: +(cursor + len).toFixed(4),
  };
  cursor += len;
  return e;
});

fs.writeFileSync(outPath, JSON.stringify({
  version: 1,
  mode,
  idealDuration: +ideal.toFixed(3),
  predictedDuration: +predicted.toFixed(3),
  actualDuration: Number.isFinite(actual) ? +actual.toFixed(3) : null,
  segments: mapped,
}, null, 1));

console.error(`🧭 timeline_map: 理想 ${ideal.toFixed(2)}s／預測 ${predicted.toFixed(2)}s／實測 ${Number.isFinite(actual) ? actual.toFixed(2) : '?'}s（殘差均攤每段 ${(resid * 1000).toFixed(1)}ms）→ ${outPath}`);
