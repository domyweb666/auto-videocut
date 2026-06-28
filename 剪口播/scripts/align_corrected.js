#!/usr/bin/env node
/**
 * gpt-4o 校正稿 → 對齊本地 Whisper 字級時間戳
 *
 * 用 Needleman-Wunsch 字元對齊（容許同音替換，非僅刪除），把「準確但無時間戳」的
 * gpt-4o(+文檔)校正稿，對齊到「有時間戳但有錯字」的 Whisper 字幕上：
 *   - 對上的字(match/同音替換)：直接拿 Whisper 該字的時間戳（音檔位置相同）
 *   - 校正稿多出的字(insert)：用前後鄰居內插時間
 *   - Whisper 多出的字(delete=被 gpt-4o 清掉的口誤/錯字)：略過 → 其時間落差成為剪輯點
 *
 * 輸出：corrected_subtitles_words.json（格式同 subtitles_words.json，文字=校正稿、時間=Whisper）
 *
 * 用法: node align_corrected.js <corrected_text.txt> <whisper_words.json> <out.json>
 */
const fs = require('fs');

const [, , correctedFile, whisperFile, outFile] = process.argv;
if (!correctedFile || !whisperFile || !outFile) {
  console.error('用法: node align_corrected.js <corrected_text.txt> <whisper_words.json> <out.json>');
  process.exit(1);
}

const PUNCT = /[，。！？、：；,.!?:;\s"'「」『』（）()]/;

// 校正稿 → 字元陣列，標點併到前一個 base 字
const rawText = fs.readFileSync(correctedFile, 'utf8');
const cChars = []; // {base, full}
for (const ch of rawText) {
  if (PUNCT.test(ch)) {
    if (cChars.length) cChars[cChars.length - 1].full += ch;
    continue;
  }
  cChars.push({ base: ch, full: ch });
}

// Whisper 非 gap 字（時間戳源）
const wAll = JSON.parse(fs.readFileSync(whisperFile, 'utf8'));
const flat = [];
for (const w of wAll) {
  if (w.isGap) continue;
  for (const ch of (w.text || '')) {
    if (PUNCT.test(ch)) continue;
    flat.push({ ch, start: w.start, end: w.end });
  }
}

const A = cChars.length, B = flat.length;
console.error(`校正稿 ${A} 字、Whisper ${B} 字，對齊中…`);

// ── Needleman-Wunsch（match +2 / mismatch 0 / gap -1）──
const GAP = -1, MATCH = 2, MIS = 0;
// 用 Int32 一維 DP 省記憶體
const dp = new Int32Array((A + 1) * (B + 1));
const tb = new Uint8Array((A + 1) * (B + 1)); // 0=diag,1=up(刪flat),2=left(插c)
const W = B + 1;
for (let i = 0; i <= A; i++) dp[i * W] = i * GAP;
for (let j = 0; j <= B; j++) dp[j] = j * GAP;
for (let i = 1; i <= A; i++) {
  for (let j = 1; j <= B; j++) {
    const s = cChars[i - 1].base === flat[j - 1].ch ? MATCH : MIS;
    const diag = dp[(i - 1) * W + (j - 1)] + s;
    const up = dp[(i - 1) * W + j] + GAP;   // c[i] 對空(插入)
    const left = dp[i * W + (j - 1)] + GAP; // flat[j] 對空(刪除)
    let best = diag, t = 0;
    if (up > best) { best = up; t = 2; }    // 插 c
    if (left > best) { best = left; t = 1; }// 刪 flat
    dp[i * W + j] = best; tb[i * W + j] = t;
  }
}

// ── 回溯，給每個校正字配時間 ──
const aligned = new Array(A).fill(null); // 每個 c 字對到的 flat（或 null=insert）
let i = A, j = B;
while (i > 0 && j > 0) {
  const t = tb[i * W + j];
  if (t === 0) { aligned[i - 1] = flat[j - 1]; i--; j--; }
  else if (t === 2) { i--; }            // c 插入，無 flat
  else { j--; }                          // flat 刪除（口誤/錯字）
}

// insert 字內插時間
const words = [];
for (let k = 0; k < A; k++) {
  let a = aligned[k];
  if (!a) {
    // 找前後最近已對齊的時間
    let prev = null, next = null;
    for (let p = k - 1; p >= 0; p--) if (aligned[p]) { prev = aligned[p]; break; }
    for (let n = k + 1; n < A; n++) if (aligned[n]) { next = aligned[n]; break; }
    const s = prev ? prev.end : (next ? next.start : 0);
    const e = next ? next.start : (prev ? prev.end : s);
    a = { start: s, end: Math.max(s, e) };
  }
  words.push({ text: cChars[k].full, start: +a.start.toFixed(3), end: +a.end.toFixed(3), isGap: false });
}

// 修時間單調性（對齊後偶有逆序）
for (let k = 1; k < words.length; k++) {
  if (words[k].start < words[k - 1].end) words[k].start = words[k - 1].end;
  if (words[k].end < words[k].start) words[k].end = words[k].start;
}

// 插入 gap 元素（與 generate_subtitles 一致：字間距 >0.1 視為 gap，>0.5 切 1s 塊）
const out = [];
let lastEnd = words.length ? words[0].start : 0;
for (const w of words) {
  const gap = w.start - lastEnd;
  if (gap > 0.1) {
    if (gap > 0.5) {
      let gs = lastEnd;
      while (gs < w.start) { const ge = Math.min(gs + 1, w.start); out.push({ text: '', start: +gs.toFixed(2), end: +ge.toFixed(2), isGap: true }); gs = ge; }
    } else out.push({ text: '', start: +lastEnd.toFixed(2), end: +w.start.toFixed(2), isGap: true });
  }
  out.push(w);
  lastEnd = w.end;
}

fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
const matched = aligned.filter(Boolean).length;
console.error(`✅ 對齊完成：${A} 字校正稿，其中 ${matched} 字對到時間戳、${A - matched} 字內插；輸出 ${out.length} 元素`);
