#!/usr/bin/env node
/**
 * 驗證 auto_selected.json 的正確性
 *
 * 檢查項目：
 * 1. 所有 idx 在 subtitles_words.json 有效範圍內
 * 2. 被刪文字不含受保護的連接詞
 * 3. 刪除區間內的 gap 沒有遺漏
 *
 * 用法: node validate_selection.js <subtitles_words.json> <auto_selected.json>
 */

const fs = require('fs');
const path = require('path');

const wordsFile = process.argv[2];
const selectedFile = process.argv[3];

if (!wordsFile || !selectedFile) {
  console.error('用法: node validate_selection.js <subtitles_words.json> <auto_selected.json>');
  process.exit(1);
}

if (!fs.existsSync(wordsFile)) {
  console.error(`❌ 找不到: ${wordsFile}`);
  process.exit(1);
}
if (!fs.existsSync(selectedFile)) {
  console.error(`❌ 找不到: ${selectedFile}`);
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const rawSelected = JSON.parse(fs.readFileSync(selectedFile, 'utf8'));
// 支援兩種格式：純陣列 或 { indices: [...], reasons: {...} }
const selected = Array.isArray(rawSelected) ? rawSelected : (rawSelected.indices || []);
const selectedSet = new Set(selected);

// 讀取受保護連接詞
const PROTECTED_WORDS = [];
const habitDir = path.join(__dirname, '..', '用户习惯');
const connFile = path.join(habitDir, '10-保留連接詞.md');
if (fs.existsSync(connFile)) {
  const content = fs.readFileSync(connFile, 'utf8');
  const match = content.match(/```\n([\s\S]*?)```/);
  if (match) {
    match[1].split(/[、，\n]/).forEach(w => {
      const trimmed = w.trim();
      if (trimmed) PROTECTED_WORDS.push(trimmed);
    });
  }
}

let errors = 0;
let warnings = 0;

console.log(`📋 驗證: ${selected.length} 個選取項, ${words.length} 個字幕元素`);
console.log(`🛡️ 受保護連接詞: ${PROTECTED_WORDS.length} 個`);
console.log('---');

// 1. 檢查 idx 範圍
const outOfRange = selected.filter(i => i < 0 || i >= words.length);
if (outOfRange.length > 0) {
  console.error(`❌ 超出範圍的 idx (${outOfRange.length} 個): ${outOfRange.join(', ')}`);
  errors += outOfRange.length;
}

// 檢查重複 idx
const dupes = selected.filter((v, i) => selected.indexOf(v) !== i);
if (dupes.length > 0) {
  console.warn(`⚠️ 重複的 idx (${dupes.length} 個): ${[...new Set(dupes)].join(', ')}`);
  warnings += dupes.length;
}

// 2. 檢查受保護連接詞
const protectedHits = [];
for (const idx of selected) {
  if (idx < 0 || idx >= words.length) continue;
  const w = words[idx];
  if (w.isGap) continue;

  for (const pw of PROTECTED_WORDS) {
    if (w.text === pw) {
      protectedHits.push({ idx, text: w.text, start: w.start });
      break;
    }
  }
}

// 檢查連續文字組合是否構成受保護詞（多字詞跨多個 idx 的情況）
for (const pw of PROTECTED_WORDS) {
  if (pw.length <= 1) continue;
  for (let i = 0; i < words.length; i++) {
    if (!selectedSet.has(i) || words[i].isGap) continue;
    let combined = '';
    let j = i;
    while (j < words.length && combined.length < pw.length + 2) {
      if (!words[j].isGap) combined += words[j].text;
      if (combined === pw && selectedSet.has(j)) {
        // 檢查從 i 到 j 是否全部被選取
        let allSelected = true;
        for (let k = i; k <= j; k++) {
          if (!words[k].isGap && !selectedSet.has(k)) { allSelected = false; break; }
        }
        if (allSelected && !protectedHits.some(h => h.idx === i)) {
          protectedHits.push({ idx: `${i}-${j}`, text: pw, start: words[i].start });
        }
        break;
      }
      j++;
    }
  }
}

if (protectedHits.length > 0) {
  console.error(`❌ 誤刪受保護連接詞 (${protectedHits.length} 個):`);
  protectedHits.forEach(h => {
    console.error(`   idx=${h.idx} "${h.text}" @${h.start.toFixed(2)}s`);
  });
  errors += protectedHits.length;
}

// 3. 檢查刪除區間的 gap 完整性
// 找出連續的非 gap 刪除區間，檢查中間的 gap 是否也被選取
const selectedNonGap = selected.filter(i => i >= 0 && i < words.length && !words[i].isGap).sort((a, b) => a - b);

let missingGaps = [];
for (let si = 0; si < selectedNonGap.length - 1; si++) {
  const curr = selectedNonGap[si];
  const next = selectedNonGap[si + 1];

  // 如果兩個被選的非 gap 元素之間只有 gap，那些 gap 也應該被選取
  if (next - curr <= 1) continue;

  let allBetweenAreGaps = true;
  let hasUnselectedGap = false;
  for (let k = curr + 1; k < next; k++) {
    if (!words[k].isGap) {
      allBetweenAreGaps = false;
      break;
    }
    if (!selectedSet.has(k)) {
      hasUnselectedGap = true;
    }
  }

  if (allBetweenAreGaps && hasUnselectedGap) {
    for (let k = curr + 1; k < next; k++) {
      if (!selectedSet.has(k)) {
        missingGaps.push(k);
      }
    }
  }
}

if (missingGaps.length > 0) {
  console.error(`❌ 刪除區間內遺漏的 gap (${missingGaps.length} 個): ${missingGaps.slice(0, 20).join(', ')}${missingGaps.length > 20 ? '...' : ''}`);
  errors += missingGaps.length;
}

// 統計摘要
const deletedText = selected
  .filter(i => i >= 0 && i < words.length && !words[i].isGap)
  .map(i => words[i].text)
  .join('');
const deletedGaps = selected.filter(i => i >= 0 && i < words.length && words[i].isGap).length;
const deletedDuration = selected
  .filter(i => i >= 0 && i < words.length)
  .reduce((sum, i) => sum + (words[i].end - words[i].start), 0);

console.log('---');
console.log(`📊 統計: 刪除 ${selected.length} 個元素 (文字${selected.length - deletedGaps}個 + 靜音${deletedGaps}個)`);
console.log(`⏱️ 刪除時長: ${deletedDuration.toFixed(2)}s`);
console.log(`📝 刪除文字: ${deletedText.substring(0, 100)}${deletedText.length > 100 ? '...' : ''}`);

if (errors > 0) {
  console.log(`\n🔴 驗證失敗: ${errors} 個錯誤, ${warnings} 個警告`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`\n🟡 驗證通過（有警告）: ${warnings} 個警告`);
} else {
  console.log(`\n🟢 驗證通過`);
}
