#!/usr/bin/env node
/**
 * 套用「常犯辨識錯字」修正表到 subtitles_words.json（回饋迴路）
 *
 * 迴路：使用者回報「辨識老把 X 聽成 Y」→ 助理把 {wrong:'Y', right:'X'} 加進
 * 用户习惯/錯字修正表.json → 下次剪輯自動套，不用講稿也生效。
 *
 * 安全限制：只套「等長」替換（聽錯多半同長），逐字換、保留每個字的時間戳；
 * 不等長的略過（避免時間錯位）。BytePlus 多為單字一詞，逐字替換安全。
 *
 * 用法: node apply_corrections.js <subtitles_words.json> <錯字修正表.json> [out.json]
 */
const fs = require('fs');
const [, , subsFile, tableFile, outArg] = process.argv;
if (!subsFile || !tableFile) {
  console.error('用法: node apply_corrections.js <subtitles_words.json> <table.json> [out.json]');
  process.exit(1);
}
const outFile = outArg || subsFile;

const subs = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
let table = [];
try { table = (JSON.parse(fs.readFileSync(tableFile, 'utf8')).corrections) || []; }
catch (e) { console.error('⚠️ 讀修正表失敗，跳過:', e.message); fs.writeFileSync(outFile, JSON.stringify(subs, null, 2)); process.exit(0); }

const PUNCT = /[，。！？、：；,.!?:;\s"'「」『』（）()…—\-]/g;

// 攤平非 gap 詞的 base 字（去標點），記住所屬 word index 與字元值
const flat = []; // {wi, ch}
subs.forEach((w, wi) => {
  if (w.isGap) return;
  const b = (w.text || '').replace(PUNCT, '');
  for (const ch of b) flat.push({ wi, ch });
});
let base = flat.map(f => f.ch).join('');

let applied = 0;
for (const c of table) {
  const wrong = c && c.wrong, right = c && c.right;
  if (!wrong || !right || wrong.length !== right.length) continue;
  let from = 0, p;
  while ((p = base.indexOf(wrong, from)) >= 0) {
    for (let k = 0; k < wrong.length; k++) {
      const f = flat[p + k];
      // 替換該 word.text 內的這個 base 字（保留其後標點）
      subs[f.wi].text = subs[f.wi].text.replace(f.ch, right[k]);
      f.ch = right[k];
    }
    base = base.slice(0, p) + right + base.slice(p + wrong.length);
    applied++;
    from = p + right.length;
  }
}

fs.writeFileSync(outFile, JSON.stringify(subs, null, 2));
console.error(`✅ 套用辨識錯字修正 ${applied} 處`);
