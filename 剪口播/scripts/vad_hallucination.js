#!/usr/bin/env node
/*
 * vad_hallucination.js — 反幻覺守門第二～四層（純函式，接 vad_guard.py 的第一層輸出）
 *
 * 借鑑 arkiv 的四層反幻覺架構，對應到本 pipeline：
 *   L1 VAD 語音區偵測      → vad_guard.py 產出 vad_regions.json（音訊層真相）
 *   L2 字級交叉比對        → 每個轉錄字算「被語音區覆蓋的時間比例」，低於門檻＝候選
 *   L3 空白/重複/黑名單過濾 → 候選字串成連續段，黑名單片語/高重複度加信心、孤字降信心
 *   L4 信心閘門            → conf ≥ min_confidence 才交給審核頁預選（WYSIWYG，絕不自動刪；
 *                            呼應規則 04 的 confidence-gated 精神——沒有硬證據就零動作）
 *
 * 邊界防呆：VAD 語音區先外擴 edgePadSec 再算覆蓋（VAD 切點有 ±數十 ms 誤差，
 * 不外擴會把貼著語音邊界的正常字誤當幻覺）。
 */

/** 單字被語音區（已外擴）覆蓋的時間比例 0~1 */
function speechCoverage(word, regions, edgePadSec) {
  const dur = Math.max(word.end - word.start, 0.01);
  let ov = 0;
  for (const r of regions) {
    const a = Math.max(word.start, r.start - edgePadSec);
    const b = Math.min(word.end, r.end + edgePadSec);
    if (b > a) ov += b - a;
  }
  return Math.min(ov / dur, 1);
}

/** 文字重複度：最常見字元的佔比（「哈哈哈哈」「對對對對」這類幻覺特徵） */
function repetitionRatio(text) {
  const chars = Array.from(String(text || ''));
  if (chars.length < 2) return 0;
  const freq = {};
  for (const c of chars) freq[c] = (freq[c] || 0) + 1;
  return Math.max(...Object.values(freq)) / chars.length;
}

/**
 * 主函式：回傳疑似幻覺段清單
 * @param {Array} words  subtitles_words.json（{text,start,end,isGap}）
 * @param {Array} regions  VAD 語音段 [{start,end}]
 * @param {Object} opts {overlapMax, edgePadSec, minConfidence, blacklist}
 * @returns {Array<{startIdx,endIdx,indices,start,end,text,coverage,conf,evidence}>}
 */
function flagHallucinations(words, regions, opts = {}) {
  const overlapMax = opts.overlapMax ?? 0.25;   // 覆蓋率低於此＝候選
  const edgePadSec = opts.edgePadSec ?? 0.12;   // VAD 邊界容忍
  const minConfidence = opts.minConfidence ?? 0.6;
  const blacklist = opts.blacklist || [];
  if (!Array.isArray(words) || !Array.isArray(regions)) return [];

  // L2：逐字算覆蓋率，標候選（gap 元素本來就無聲，跳過但不打斷連續段）
  const cand = new Map(); // idx → coverage
  words.forEach((w, i) => {
    if (!w || w.isGap || !w.text) return;
    if (typeof w.start !== 'number' || typeof w.end !== 'number' || w.end <= w.start) return;
    const cov = speechCoverage(w, regions, edgePadSec);
    if (cov < overlapMax) cand.set(i, cov);
  });
  if (!cand.size) return [];

  // L3：串連續段（中間只隔 gap 元素也算連續——幻覺常整句落在同一片死寂裡）
  const runs = [];
  let run = null;
  words.forEach((w, i) => {
    if (cand.has(i)) {
      if (run && words.slice(run.endIdx + 1, i).every(x => x && x.isGap)) {
        run.endIdx = i; run.indices.push(i);
      } else {
        if (run) runs.push(run);
        run = { startIdx: i, endIdx: i, indices: [i] };
      }
    }
  });
  if (run) runs.push(run);

  // L3 評分 + L4 閘門
  const out = [];
  for (const r of runs) {
    const text = r.indices.map(i => words[i].text).join('');
    const covAvg = r.indices.reduce((t, i) => t + cand.get(i), 0) / r.indices.length;
    let conf = 1 - covAvg;               // 基礎信心＝無語音程度
    const ev = [];
    if (blacklist.some(p => p && text.includes(p))) { conf = Math.max(conf, 0.95); ev.push('黑名單片語'); }
    if (text.length >= 4 && repetitionRatio(text) >= 0.7) { conf = Math.min(conf + 0.15, 1); ev.push('高重複度'); }
    // 孤立短字（1~2 字）最可能是邊界誤差而非幻覺 → 重罰，讓它過不了閘門除非黑名單/零覆蓋
    if (text.length <= 2 && !ev.includes('黑名單片語')) conf *= 0.6;
    if (conf < minConfidence) continue;   // L4：信心不足＝零動作（寧漏勿誤）
    out.push({
      startIdx: r.startIdx,
      endIdx: r.endIdx,
      indices: r.indices,
      start: words[r.startIdx].start,
      end: words[r.endIdx].end,
      text,
      coverage: +covAvg.toFixed(3),
      conf: +conf.toFixed(3),
      evidence: ev.join('+'),
    });
  }
  return out;
}

module.exports = { flagHallucinations, speechCoverage, repetitionRatio };

// CLI：node vad_hallucination.js <subtitles_words.json> <vad_regions.json> [blacklist.json]
if (require.main === module) {
  const fs = require('fs');
  const [, , subsPath, vadPath, blPath] = process.argv;
  if (!subsPath || !vadPath) {
    console.error('用法: node vad_hallucination.js <subtitles_words.json> <vad_regions.json> [blacklist.json]');
    process.exit(1);
  }
  const words = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
  const vad = JSON.parse(fs.readFileSync(vadPath, 'utf8'));
  let blacklist = [];
  if (blPath && fs.existsSync(blPath)) blacklist = JSON.parse(fs.readFileSync(blPath, 'utf8')).phrases || [];
  const flags = flagHallucinations(Array.isArray(words) ? words : (words.words || []), vad.speech || vad, { blacklist });
  console.log(JSON.stringify(flags, null, 1));
  console.error(`[vad_hallucination] 疑似幻覺 ${flags.length} 段`);
}
