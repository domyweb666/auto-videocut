#!/usr/bin/env node
/**
 * refine_segments.js 單元測試（合成資料，無需音訊/API）。
 * 用法: node refine_segments.test.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = path.join(__dirname, '_t_refine');
fs.mkdirSync(TMP, { recursive: true });
const p = (f) => path.join(TMP, f);

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } }
function approx(a, b, e = 0.011) { return Math.abs(a - b) <= e; }
function totalLen(segs) { return segs.reduce((s, x) => s + (x.end - x.start), 0); }
function hasSeg(segs, a, b) { return segs.some(s => approx(s.start, a) && approx(s.end, b)); }

function run(words, deletes, rms, cfg, silences) {
  fs.writeFileSync(p('words.json'), JSON.stringify(words));
  fs.writeFileSync(p('del.json'), JSON.stringify(deletes));
  if (rms) fs.writeFileSync(p('rms.json'), JSON.stringify(rms));
  if (silences) fs.writeFileSync(p('sil.json'), JSON.stringify(silences));
  fs.writeFileSync(p('cfg.json'), JSON.stringify(cfg));
  execFileSync('node', [
    path.join(__dirname, 'refine_segments.js'),
    p('words.json'), p('del.json'),
    rms ? p('rms.json') : p('nope.json'),
    silences ? p('sil.json') : p('nope.json'),
    p('out.json'), p('cfg.json'),
  ], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(p('out.json'), 'utf8'));
}

const baseCfg = {
  pause_flatten: { enabled: true, floor_sec: 0.20, target_sec: 0.25, keep_side: 'tail', protect_idx: [] },
  cut_snap: { enabled: false },
};

// ── 測試 1：停頓壓平基本行為 ──
console.log('\n[測試 1] 停頓壓平：0.6s gap → 留 0.25s');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 1.1, isGap: true },   // 0.6s 保留 gap
    { text: 'b', start: 1.1, end: 1.6, isGap: false },
  ];
  const out = run(words, [], null, baseCfg);
  ok(out.length === 1, '產生 1 段 partial delete');
  // tail：留靠後 0.25s → 刪 [0.5, 1.1-0.25=0.85]
  ok(hasSeg(out, 0.5, 0.85), 'tail 模式刪前段 [0.5, 0.85]，留下 [0.85,1.1]=0.25s');
}

// ── 測試 2：邊界條件 ──
console.log('\n[測試 2] floor 以下不動、target 以下不動');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 0.65, isGap: true },  // 0.15s < floor
    { text: 'b', start: 0.65, end: 1.0, isGap: false },
    { text: '', start: 1.0, end: 1.25, isGap: true },  // 0.25s == target
    { text: 'c', start: 1.25, end: 1.7, isGap: false },
  ];
  const out = run(words, [], null, baseCfg);
  ok(out.length === 0, '兩個 gap 都不該被壓（一個太短、一個已達標）');
}

// ── 測試 3：protect_idx（味道：挖坑）──
console.log('\n[測試 3] protect_idx 的 gap 不壓');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 1.3, isGap: true },   // 0.8s，但受保護
    { text: 'b', start: 1.3, end: 1.8, isGap: false },
  ];
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.pause_flatten.protect_idx = [1];
  const out = run(words, [], null, cfg);
  ok(out.length === 0, 'idx=1 受保護，留長不壓');
}

// ── 測試 4：keep_side 變體 ──
console.log('\n[測試 4] keep_side head / mid');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 1.1, isGap: true },   // 0.6s
    { text: 'b', start: 1.1, end: 1.6, isGap: false },
  ];
  const head = run(words, [], null, { ...baseCfg, pause_flatten: { ...baseCfg.pause_flatten, keep_side: 'head' } });
  ok(hasSeg(head, 0.75, 1.1), 'head 模式刪後段 [0.75,1.1]，留 [0.5,0.75]');
  const mid = run(words, [], null, { ...baseCfg, pause_flatten: { ...baseCfg.pause_flatten, keep_side: 'mid' } });
  ok(approx(totalLen(mid), 0.35), 'mid 模式總刪 0.35s（兩頭各砍 0.175）');
  ok(mid.length === 2, 'mid 模式產生兩段');
}

// ── 測試 5：gap 內已有部分內容刪除，只壓剩餘 ──
console.log('\n[測試 5] gap 部分已被內容刪除，只壓剩餘');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 1.5, isGap: true },   // 1.0s gap
    { text: 'b', start: 1.5, end: 2.0, isGap: false },
  ];
  // 內容刪除已吃掉 gap 前 0.4s（[0.5,0.9]）→ 剩 0.6s 保留 → 壓到 0.25
  const out = run(words, [{ start: 0.5, end: 0.9 }], null, baseCfg);
  // 剩餘保留子區間 [0.9,1.5]=0.6s → tail 留 0.25 → 刪 [0.9, 1.25]
  ok(out.some(s => approx(s.start, 0.9) && approx(s.end, 1.25)) || hasSeg(out, 0.5, 1.25),
     '只壓未刪的剩餘段，留 0.25s');
  // 驗證最終留在 gap 內的靜音 = 0.25s
  const keptInGap = 1.0 - totalLen(out.map(s => ({ start: Math.max(0.5, s.start), end: Math.min(1.5, s.end) })));
  ok(approx(keptInGap, 0.25), `gap 內最終留 ${keptInGap.toFixed(3)}s ≈ 0.25s`);
}

// ── 測試 6：切點吸附（合成 RMS，邊界貼波谷）──
console.log('\n[測試 6] 切點吸附：邊界移到 RMS 波谷');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: 'x', start: 0.5, end: 1.0, isGap: false },  // 要刪的內容
    { text: 'b', start: 1.0, end: 1.6, isGap: false },
  ];
  // RMS：在 0.55 有明顯波谷（-55dB），其餘 -20dB。刪除 [0.5,1.0]，
  // start=0.5 左邊是保留內容 a，往右(靜音側)找到 0.55 波谷 → 應移到 ~0.55
  const series = [];
  for (let t = 0; t <= 1.6; t += 0.05) {
    let db = -20;
    if (approx(t, 0.55, 0.026)) db = -55;
    series.push([Math.round(t * 100) / 100, db]);
  }
  const rms = { frame_sec: 0.05, rms_floor_db: -60, series };
  const cfg = { pause_flatten: { enabled: false }, cut_snap: { enabled: true, window_sec: 0.12, max_intrude_sec: 0.06, valley_margin_db: 6.0 } };
  const out = run(words, [{ start: 0.5, end: 1.0 }], rms, cfg);
  ok(out.length === 1, '仍為 1 段');
  ok(approx(out[0].start, 0.55, 0.03), `start 0.5 → ${out[0].start} 吸附到波谷 0.55`);
}

// ── 測試 7：無 RMS 檔 → 吸附略過，壓平仍運作 ──
console.log('\n[測試 7] 無 RMS：吸附略過，壓平仍運作');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 1.1, isGap: true },
    { text: 'b', start: 1.1, end: 1.6, isGap: false },
  ];
  const cfg = { pause_flatten: { enabled: true, floor_sec: 0.2, target_sec: 0.25, keep_side: 'tail' }, cut_snap: { enabled: true } };
  const out = run(words, [], null, cfg);  // rms=null → 餵不存在的路徑
  ok(hasSeg(out, 0.5, 0.85), '無 RMS 時壓平照常，吸附安靜略過');
}

// ── 測試 8：音訊靜音來源（真實情境：STT 零間隔，靜音只在 silences.json）──
console.log('\n[測試 8] 音訊靜音來源：字全連續(無 isGap)，壓平仍運作');
{
  // 模擬 Google STT：字時間戳全連續，完全沒有 isGap
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: 'b', start: 0.5, end: 1.3, isGap: false },   // 此「字」其實含 0.6s 停頓
    { text: 'c', start: 1.3, end: 1.8, isGap: false },
  ];
  // 音訊實測：在 0.7-1.3 有 0.6s 靜音（被吸進 b 的時長裡）
  const silences = [{ start: 0.7, end: 1.3, dur: 0.6 }];
  const cfg = { pause_flatten: { enabled: true, floor_sec: 0.2, target_sec: 0.25, keep_side: 'tail' }, cut_snap: { enabled: false } };
  const out = run(words, [], null, cfg, silences);
  ok(out.length === 1, 'isGap 全無，仍從 silences.json 抓到並壓平');
  ok(hasSeg(out, 0.7, 1.05), 'tail：刪 [0.7,1.05]，留 [1.05,1.3]=0.25s');
}

// ── 測試 9：protect_ranges（時間範圍挖坑）──
console.log('\n[測試 9] protect_ranges：時間範圍內的停頓不壓');
{
  const words = [{ text: 'a', start: 0.0, end: 2.0, isGap: false }];
  const silences = [{ start: 0.5, end: 1.3, dur: 0.8 }];
  const cfg = { pause_flatten: { enabled: true, floor_sec: 0.2, target_sec: 0.25, keep_side: 'tail', protect_ranges: [[0.4, 1.4]] }, cut_snap: { enabled: false } };
  const out = run(words, [], null, cfg, silences);
  ok(out.length === 0, '停頓落在保護範圍內，不壓');
}

// ── 測試 10：兩段壓平（氣口 vs 轉場）──
console.log('\n[測試 10] 轉場分段：長停頓留 0.6s，短停頓留 0.3s');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 2.0, isGap: true },   // 1.5s ≥ long_pause → 轉場
    { text: 'b', start: 2.0, end: 2.5, isGap: false },
    { text: '', start: 2.5, end: 3.3, isGap: true },   // 0.8s < long_pause → 氣口
    { text: 'c', start: 3.3, end: 3.8, isGap: false },
  ];
  const cfg = { pause_flatten: { enabled: true, floor_sec: 0.2, target_sec: 0.3, long_pause_sec: 1.2, long_target_sec: 0.6, keep_side: 'tail' }, cut_snap: { enabled: false } };
  const out = run(words, [], null, cfg);
  ok(out.length === 2, '產生兩段（一轉場一氣口）');
  ok(hasSeg(out, 0.5, 1.4), '轉場：刪 [0.5,1.4]，留 [1.4,2.0]=0.6s');
  ok(hasSeg(out, 2.5, 3.0), '氣口：刪 [2.5,3.0]，留 [3.0,3.3]=0.3s');
}

// ── 測試 11：未設 long_pause_sec → 退回單一 target（向下相容）──
console.log('\n[測試 11] 無 long_pause_sec：長停頓也只壓到 target');
{
  const words = [
    { text: 'a', start: 0.0, end: 0.5, isGap: false },
    { text: '', start: 0.5, end: 2.0, isGap: true },   // 1.5s，但沒有轉場設定
    { text: 'b', start: 2.0, end: 2.5, isGap: false },
  ];
  const out = run(words, [], null, baseCfg);           // baseCfg 無 long_pause_sec，target 0.25
  ok(out.length === 1, '仍是單段');
  ok(hasSeg(out, 0.5, 1.75), '退回舊行為：壓到 target 0.25s（刪 [0.5,1.75]）');
}

// ── 總結（先印，確保結果一定看得到）──
console.log(`\n── 結果：${pass} 通過 / ${fail} 失敗 ──`);

// ── 清理：逐檔刪，避免 Windows 上 fs.rmSync(recursive) 在 teardown native crash ──
try {
  for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f));
  fs.rmdirSync(TMP);
} catch (_) { /* 留下空殼也無妨 */ }

process.exit(fail ? 1 : 0);
