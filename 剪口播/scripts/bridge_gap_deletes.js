#!/usr/bin/env node
/**
 * bridge_gap_deletes.js — 審核頁手動刪除的「梳齒死氣」橋接（audit #4）
 *
 * 問題：審核頁 gap 元素不渲染不可選，逐字點刪一句話時，字與字之間的
 * 0.2~0.3s gap 會留在保留區；剪完這些殘 gap 首尾相接，串成 1s+ 死空氣。
 * （/api/execute-cut 的 AI 流程有字級 gap 擴展，同一頁兩種刪法品質不同。）
 *
 * 修法：落檔前檢查相鄰兩個刪除段之間的間隙——若間隙內沒有任何「發音字」
 * （只有 isGap 元素或完全無元素），把兩段併成一段。有發音字＝使用者刻意
 * 保留內容，不動。與 execute-cut 的 gap 擴展行為對齊。
 *
 * 純函式、無 IO；由 training_server.js 的 /api/cut/<name> 在寫
 * delete_segments.json 前呼叫，SRT/TXT/verify 下游自然吃到同一份。
 */

const VOICE_OVERLAP_EPS = 0.03; // 發音字與間隙重疊 >30ms 才算「間隙內有內容」（容忍邊界毛邊）

/**
 * @param {Array<{start:number,end:number}>} deleteList 刪除段（可含 reason 等附加欄位，保留）
 * @param {Array<{start:number,end:number,isGap?:boolean,text?:string}>} words subtitles_words.json 內容
 * @returns 橋接後的刪除段（新陣列；輸入不合法時原樣回傳排序副本）
 */
function bridgeGapDeletes(deleteList, words) {
  if (!Array.isArray(deleteList) || deleteList.length < 2) return Array.isArray(deleteList) ? deleteList.slice() : [];
  const segs = deleteList
    .filter(s => s && isFinite(s.start) && isFinite(s.end) && s.end > s.start)
    .map(s => Object.assign({}, s))
    .sort((a, b) => a.start - b.start);
  if (segs.length < 2) return segs;

  const voiced = (Array.isArray(words) ? words : [])
    .filter(w => w && !w.isGap && isFinite(w.start) && isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const out = [segs[0]];
  for (let i = 1; i < segs.length; i++) {
    const prev = out[out.length - 1];
    const cur = segs[i];
    if (cur.start <= prev.end + 1e-6) { // 重疊/相接：直接併
      prev.end = Math.max(prev.end, cur.end);
      continue;
    }
    let hasVoice = false;
    for (const w of voiced) {
      if (w.end <= prev.end + VOICE_OVERLAP_EPS) continue;
      if (w.start >= cur.start - VOICE_OVERLAP_EPS) break;
      const ov = Math.min(w.end, cur.start) - Math.max(w.start, prev.end);
      if (ov > VOICE_OVERLAP_EPS) { hasVoice = true; break; }
    }
    if (hasVoice) out.push(cur);
    else prev.end = Math.max(prev.end, cur.end); // 間隙只有靜音/gap → 橋接併段
  }
  return out;
}

module.exports = bridgeGapDeletes;
module.exports.bridgeGapDeletes = bridgeGapDeletes;

if (require.main === module) {
  const fs = require('fs');
  const [delFile, wordsFile] = process.argv.slice(2);
  if (!delFile || !wordsFile) { console.error('用法: node bridge_gap_deletes.js <delete_segments.json> <subtitles_words.json>'); process.exit(1); }
  const dl = JSON.parse(fs.readFileSync(delFile, 'utf8'));
  const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
  const out = bridgeGapDeletes(dl, words);
  console.log(JSON.stringify(out, null, 2));
  console.error(`段數 ${dl.length} → ${out.length}`);
}
