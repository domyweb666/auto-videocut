#!/usr/bin/env node
/**
 * merge_delete_segments.js — MERGE_GAP 合併規則的單一事實來源
 *
 * cut_video.sh 落刀時會把「兩個刪除段之間 ≤ MERGE_GAP 的短保留區」一併剪掉。
 * 這條規則過去只存在 cut_video.sh 與 verify_export.js 各自的複製品裡，
 * generate_cut_srt.js / generate_cut_txt.js 沒有跟上 → 被吞的保留字仍留在
 * 字幕裡、其後每條字幕時間漂移（audit P0#1）。
 *
 * 現在四個消費者一律走本模組：
 *   - cut_video.sh          → CLI 呼叫，落地 <delete>.final.json 後直接吃 final
 *   - generate_cut_srt.js   → require 後在記憶體合併
 *   - generate_cut_txt.js   → require 後在記憶體合併
 *   - verify_export.js      → require 後在記憶體合併
 *
 * CLI 用法: node merge_delete_segments.js <delete_segments.json> [output.json]
 *   output 省略時寫到 <input 去掉 .json>.final.json
 */

const MERGE_GAP = 0.2; // 兩刪除段間隔 ≤ 此值時，中間的短保留區一併剪掉

// 兼容 [{start,end}] 或 {segments:[...]} / {deleteList:[...]}，並剔除非數值段
function normalizeSegments(raw) {
  const arr = Array.isArray(raw) ? raw : ((raw && (raw.segments || raw.deleteList)) || []);
  return arr.filter(s => s && Number.isFinite(s.start) && Number.isFinite(s.end));
}

// 排序 + MERGE_GAP 合併 → 最終刪除清單（與 cut_video.sh 實際落刀行為一致）
// 對已合併的清單再跑一次是冪等的（合併後段距必 > mergeGap）
function mergeDeleteSegments(raw, mergeGap = MERGE_GAP) {
  const sorted = normalizeSegments(raw).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (!last || seg.start > last.end + mergeGap) merged.push({ ...seg });
    else last.end = Math.max(last.end, seg.end);
  }
  return merged;
}

module.exports = { MERGE_GAP, normalizeSegments, mergeDeleteSegments };

if (require.main === module) {
  const fs = require('fs');
  const input = process.argv[2];
  if (!input) {
    console.error('用法: node merge_delete_segments.js <delete_segments.json> [output.json]');
    process.exit(1);
  }
  const output = process.argv[3] || input.replace(/\.json$/i, '') + '.final.json';
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const merged = mergeDeleteSegments(raw);
  fs.writeFileSync(output, JSON.stringify(merged, null, 2));
  console.error(`✅ 最終刪除清單: ${output}（${normalizeSegments(raw).length} 段 → 合併後 ${merged.length} 段）`);
}
