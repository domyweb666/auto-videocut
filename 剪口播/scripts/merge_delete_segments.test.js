#!/usr/bin/env node
/**
 * merge_delete_segments.js 單元測試（合成資料，無需音訊/API）。
 * 覆蓋 audit P0#1 的核心情境：兩刪除段間 ≤ MERGE_GAP 的短保留區必須被吞進合併結果，
 * 且 SRT/TXT/verify 消費端與 cut_video.sh 落刀吃到同一份最終清單。
 * 用法: node merge_delete_segments.test.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { MERGE_GAP, normalizeSegments, mergeDeleteSegments } = require(path.join(__dirname, 'merge_delete_segments.js'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } }
function approx(a, b, e = 1e-9) { return Math.abs(a - b) <= e; }
function totalLen(segs) { return segs.reduce((s, x) => s + (x.end - x.start), 0); }

// ── 測試 1：MERGE_GAP 內的短保留區被吞掉 ──
console.log('\n[測試 1] 間隔 ≤ MERGE_GAP 合併、> MERGE_GAP 不合併');
{
  const merged = mergeDeleteSegments([
    { start: 5.0, end: 8.0 },
    { start: 8.1, end: 12.0 },   // 間隔 0.1 ≤ 0.2 → 合併
    { start: 20.0, end: 22.0 },
    { start: 22.25, end: 24.0 }, // 間隔 0.25 > 0.2 → 不合併
  ]);
  ok(merged.length === 3, '4 段 → 3 段');
  ok(approx(merged[0].start, 5.0) && approx(merged[0].end, 12.0), '前兩段合併成 [5,12]（吞掉 0.1s 保留區）');
  ok(approx(totalLen(merged), 7 + 2 + 1.75), '刪除總長含被吞的保留區');
}

// ── 測試 2：亂序輸入 + 重疊段 ──
console.log('\n[測試 2] 亂序輸入先排序、重疊段取最大 end');
{
  const merged = mergeDeleteSegments([
    { start: 10.0, end: 11.0 },
    { start: 1.0, end: 3.0 },
    { start: 2.0, end: 2.5 },   // 完全被 [1,3] 包住
  ]);
  ok(merged.length === 2, '3 段 → 2 段');
  ok(approx(merged[0].end, 3.0), '被包住的段不會縮短外層 end');
}

// ── 測試 3：冪等性（合併結果再合併一次不變）──
console.log('\n[測試 3] 冪等性');
{
  const once = mergeDeleteSegments([{ start: 0, end: 1 }, { start: 1.1, end: 2 }, { start: 5, end: 6 }]);
  const twice = mergeDeleteSegments(once);
  ok(JSON.stringify(once) === JSON.stringify(twice), '對已合併清單再跑一次 = 不變');
}

// ── 測試 4：格式兼容與髒資料 ──
console.log('\n[測試 4] normalizeSegments 兼容三種格式、剔除非數值段');
{
  ok(normalizeSegments({ segments: [{ start: 1, end: 2 }] }).length === 1, '{segments:[...]} 可讀');
  ok(normalizeSegments({ deleteList: [{ start: 1, end: 2 }] }).length === 1, '{deleteList:[...]} 可讀');
  ok(normalizeSegments([{ start: 1, end: 2 }, { start: 'x', end: 3 }, null]).length === 1, '非數值/null 段被剔除');
}

// ── 測試 5：CLI 落地 final.json（cut_video.sh 的呼叫方式）──
console.log('\n[測試 5] CLI: <input>.json → <input>.final.json');
{
  const TMP = path.join(__dirname, '_t_merge');
  fs.mkdirSync(TMP, { recursive: true });
  const inFile = path.join(TMP, 'del.json');
  fs.writeFileSync(inFile, JSON.stringify([{ start: 0, end: 1 }, { start: 1.15, end: 2 }]));
  execFileSync('node', [path.join(__dirname, 'merge_delete_segments.js'), inFile], { stdio: 'pipe' });
  const out = JSON.parse(fs.readFileSync(path.join(TMP, 'del.final.json'), 'utf8'));
  ok(out.length === 1 && approx(out[0].end, 2), '預設輸出路徑正確、內容已合併');
}

// ── 測試 6：SRT 消費端與落刀同源（audit P0#1 回歸）──
// 被吞短保留區裡的字要從字幕消失，且其後字幕時間 = 原時間 − 合併後刪除累計（不漂移）
console.log('\n[測試 6] generate_cut_srt.js 端到端：吞掉的字不進字幕、時間不漂移');
{
  const TMP = path.join(__dirname, '_t_merge');
  fs.mkdirSync(TMP, { recursive: true });
  const words = [
    { text: '開頭的話。', start: 0.0, end: 5.0 },
    { text: '喔', start: 8.0, end: 8.1 },       // 落在被吞的 0.1s 保留區
    { text: '結尾的話。', start: 12.0, end: 17.0 },
  ];
  const dels = [{ start: 5.0, end: 8.0 }, { start: 8.1, end: 12.0 }]; // 合併後 [5,12]
  const wf = path.join(TMP, 'words.json'), df = path.join(TMP, 'dels.json'), sf = path.join(TMP, 'out.srt');
  fs.writeFileSync(wf, JSON.stringify(words));
  fs.writeFileSync(df, JSON.stringify(dels));
  execFileSync('node', [path.join(__dirname, 'generate_cut_srt.js'), wf, df, sf], { stdio: 'pipe' });
  const srt = fs.readFileSync(sf, 'utf8');
  ok(!srt.includes('喔'), '被吞保留區裡的「喔」不進字幕');
  ok(srt.includes('00:00:05,000 --> 00:00:10,000'), '「結尾的話」映射到 5.0~10.0（12−7=5，不是舊版漂移後的 5.1）');
}

console.log(`\n── 結果：${pass} 通過 / ${fail} 失敗 ──`);
process.exit(fail ? 1 : 0);
