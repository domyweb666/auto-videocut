#!/usr/bin/env node
/**
 * 辨識稿 vs 參考文檔（講稿）→ 標出疑似「聽錯的同音字」（防「說 a 變 b 沒人發現」）
 *
 * 作法：Needleman-Wunsch 字元對齊（容忍講者沒照唸的插入/刪除），
 * 對齊到的「字不同」位置，比對拼音：
 *   - 同音不同字（聽寫 vs 聽鞋）→ 高度疑似辨識聽錯 → 標 _suspect + _refHint（講稿的正確字）
 *   - 不同音 → 多半是講者即興，不標（避免滿江紅）
 *
 * 記憶體：NW 的 DP 矩陣是 O(A×B)，60 分鐘口播（~18k 字）對講稿會吃到 GB 級直接 OOM。
 * 故長輸入先用「兩邊都唯一的 K-gram 錨點」切塊（錨點區間字元完全相同、必無 suspect），
 * 塊內才跑 NW；單塊仍超過 MAX_CELLS（兩邊該區間差異巨大）就略過該塊的標註——
 * 此功能是 advisory 高亮，寧可漏標不可炸掉整條轉錄流程。
 * 短輸入（A×B ≤ MAX_CELLS）走單塊，行為與舊版完全一致。
 *
 * 直接就地標註 subtitles_words.json 的 word：加 _suspect:true / _refHint:'<講稿字>'
 *
 * 用法: node flag_against_reference.js <subtitles_words.json> <reference.txt> [out.json]
 */
const fs = require('fs');
const { pinyin } = require('pinyin-pro');

const [, , subsFile, refFile, outArg] = process.argv;
if (!subsFile || !refFile) {
  console.error('用法: node flag_against_reference.js <subtitles_words.json> <reference.txt> [out.json]');
  process.exit(1);
}
const outFile = outArg || subsFile;

const PUNCT = /[，。！？、：；,.!?:;\s"'「」『』（）()…—\-]/;
const py = ch => pinyin(ch, { toneType: 'none', type: 'string' });

// ── 辨識稿：攤平成 base 字，記住所屬 word index ──
const subs = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
const aChars = []; // {ch, wi}
subs.forEach((w, wi) => {
  if (w.isGap) return;
  for (const ch of (w.text || '')) {
    if (PUNCT.test(ch)) continue;
    aChars.push({ ch, wi });
  }
});

// ── 參考文檔：攤平成字 ──
const refText = fs.readFileSync(refFile, 'utf8');
const rChars = [];
for (const ch of refText) {
  if (PUNCT.test(ch)) continue;
  rChars.push(ch);
}

const A = aChars.length, B = rChars.length;
if (!A || !B) {
  console.error('⚠️ 辨識稿或參考文檔為空，跳過標註');
  fs.writeFileSync(outFile, JSON.stringify(subs, null, 2));
  process.exit(0);
}

const MAX_CELLS = 9e6; // 單塊 NW 上限（dp Int32+tb Uint8 ≈ 45MB）
const refHint = {};    // wi -> 累積講稿正確字
let suspectCount = 0;
let skippedBlocks = 0;

// ── 單塊 NW＋回溯（[aLo,aHi) × [rLo,rHi)，記憶體 O(塊面積)）──
function alignBlock(aLo, aHi, rLo, rHi) {
  const An = aHi - aLo, Bn = rHi - rLo;
  if (An <= 0 || Bn <= 0) return;
  if (An * Bn > MAX_CELLS) {
    skippedBlocks++;
    console.error(`⚠️ 區塊過大略過標註（辨識 ${An} 字 × 講稿 ${Bn} 字，兩邊此區間差異過大）`);
    return;
  }
  // Needleman-Wunsch（match +2 / mismatch 0 / gap -1）
  const GAP = -1, MATCH = 2, MIS = 0, W = Bn + 1;
  const dp = new Int32Array((An + 1) * W);
  const tb = new Uint8Array((An + 1) * W); // 0=diag, 2=插a(辨識多), 1=刪r(講稿多)
  for (let i = 0; i <= An; i++) dp[i * W] = i * GAP;
  for (let j = 0; j <= Bn; j++) dp[j] = j * GAP;
  for (let i = 1; i <= An; i++) {
    for (let j = 1; j <= Bn; j++) {
      const s = aChars[aLo + i - 1].ch === rChars[rLo + j - 1] ? MATCH : MIS;
      const diag = dp[(i - 1) * W + (j - 1)] + s;
      const up = dp[(i - 1) * W + j] + GAP;
      const left = dp[i * W + (j - 1)] + GAP;
      let best = diag, t = 0;
      if (up > best) { best = up; t = 2; }
      if (left > best) { best = left; t = 1; }
      dp[i * W + j] = best; tb[i * W + j] = t;
    }
  }
  // 回溯：找同音替換
  let i = An, j = Bn;
  while (i > 0 && j > 0) {
    const t = tb[i * W + j];
    if (t === 0) {
      const a = aChars[aLo + i - 1], r = rChars[rLo + j - 1];
      if (a.ch !== r && py(a.ch) === py(r) && /[一-鿿]/.test(a.ch)) {
        if (!subs[a.wi]._suspect) suspectCount++;
        subs[a.wi]._suspect = true;
        refHint[a.wi] = r + (refHint[a.wi] || '');
      }
      i--; j--;
    } else if (t === 2) { i--; }
    else { j--; }
  }
}

// ── 錨點：兩邊都唯一的 K-gram，LIS 保證單調遞增 ──
function findAnchors(K) {
  const strA = aChars.map(c => c.ch).join('');
  const strR = rChars.join('');
  const posA = new Map(), posR = new Map(); // gram → 位置（重複出現記 -1）
  for (let i = 0; i + K <= strA.length; i++) {
    const g = strA.substr(i, K);
    posA.set(g, posA.has(g) ? -1 : i);
  }
  for (let j = 0; j + K <= strR.length; j++) {
    const g = strR.substr(j, K);
    posR.set(g, posR.has(g) ? -1 : j);
  }
  const pairs = [];
  for (const [g, i] of posA) {
    if (i < 0) continue;
    const j = posR.get(g);
    if (j === undefined || j < 0) continue;
    pairs.push([i, j]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  // 對 j 做 LIS（嚴格遞增），剔除交叉錨點（兩邊順序不一致的巧合 gram）
  const tails = [], tailIdx = [], prev = new Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < j) lo = mid + 1; else hi = mid; }
    tails[lo] = j; tailIdx[lo] = k;
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
    if (lo === tails.length - 1 || tails.length === lo + 1) { /* extended */ }
  }
  const lis = [];
  let k = tailIdx[tails.length - 1];
  while (k !== undefined && k >= 0) { lis.push(pairs[k]); k = prev[k]; }
  lis.reverse();
  return lis;
}

if (A * B <= MAX_CELLS) {
  // 短輸入：單塊全域對齊（與舊版行為一致）
  alignBlock(0, A, 0, B);
} else {
  const K = 10;
  const anchors = findAnchors(K);
  console.error(`ℹ️ 輸入較長（${A}×${B} 字），錨點切塊對齊：${anchors.length} 個錨點`);
  let pa = 0, pr = 0;
  for (const [ai, rj] of anchors) {
    if (ai < pa || rj < pr) continue; // 與前一錨點區間重疊 → 跳過此錨點
    alignBlock(pa, ai, pr, rj);
    pa = ai + K; pr = rj + K; // 錨點區間兩邊字元完全相同，必無 suspect，直接略過
  }
  alignBlock(pa, A, pr, B);
}

for (const wi in refHint) subs[wi]._refHint = refHint[wi];

fs.writeFileSync(outFile, JSON.stringify(subs, null, 2));
console.error(`✅ 對齊 ${A} 字 vs 講稿 ${B} 字，標出 ${suspectCount} 個疑似聽錯（同音）${skippedBlocks ? `；${skippedBlocks} 個過大區塊略過` : ''}`);
