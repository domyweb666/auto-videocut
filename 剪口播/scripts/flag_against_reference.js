#!/usr/bin/env node
/**
 * 辨識稿 vs 參考文檔（講稿）→ 標出疑似「聽錯的同音字」（防「說 a 變 b 沒人發現」）
 *
 * 作法：Needleman-Wunsch 字元對齊（容忍講者沒照唸的插入/刪除），
 * 對齊到的「字不同」位置，比對拼音：
 *   - 同音不同字（聽寫 vs 聽鞋）→ 高度疑似辨識聽錯 → 標 _suspect + _refHint（講稿的正確字）
 *   - 不同音 → 多半是講者即興，不標（避免滿江紅）
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

// ── Needleman-Wunsch（match +2 / mismatch 0 / gap -1）──
const GAP = -1, MATCH = 2, MIS = 0, W = B + 1;
const dp = new Int32Array((A + 1) * W);
const tb = new Uint8Array((A + 1) * W); // 0=diag, 2=插a(辨識多), 1=刪r(講稿多)
for (let i = 0; i <= A; i++) dp[i * W] = i * GAP;
for (let j = 0; j <= B; j++) dp[j] = j * GAP;
for (let i = 1; i <= A; i++) {
  for (let j = 1; j <= B; j++) {
    const s = aChars[i - 1].ch === rChars[j - 1] ? MATCH : MIS;
    const diag = dp[(i - 1) * W + (j - 1)] + s;
    const up = dp[(i - 1) * W + j] + GAP;
    const left = dp[i * W + (j - 1)] + GAP;
    let best = diag, t = 0;
    if (up > best) { best = up; t = 2; }
    if (left > best) { best = left; t = 1; }
    dp[i * W + j] = best; tb[i * W + j] = t;
  }
}

// ── 回溯：找同音替換 ──
const refHint = {}; // wi -> 累積講稿正確字
let suspectCount = 0;
let i = A, j = B;
while (i > 0 && j > 0) {
  const t = tb[i * W + j];
  if (t === 0) {
    const a = aChars[i - 1], r = rChars[j - 1];
    if (a.ch !== r && py(a.ch) === py(r) && /[一-鿿]/.test(a.ch)) {
      // 同音不同字 → 疑似聽錯
      if (!subs[a.wi]._suspect) suspectCount++;
      subs[a.wi]._suspect = true;
      refHint[a.wi] = r + (refHint[a.wi] || '');
    }
    i--; j--;
  } else if (t === 2) { i--; }
  else { j--; }
}
for (const wi in refHint) subs[wi]._refHint = refHint[wi];

fs.writeFileSync(outFile, JSON.stringify(subs, null, 2));
console.error(`✅ 對齊 ${A} 字 vs 講稿 ${B} 字，標出 ${suspectCount} 個疑似聽錯（同音）`);
