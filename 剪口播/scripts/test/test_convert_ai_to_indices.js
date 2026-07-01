/**
 * convert_ai_to_indices.js 單元測試
 * 執行: node scripts/test/test_convert_ai_to_indices.js
 *
 * 重點覆蓋 inlineFillerWordIndices（audit P1#2：AI 標好的句中嗯/呃
 * 過去從未進 auto_selected.json），並對既有三種路徑做回歸防護。
 */
const assert = require('assert');
const convertAiToIndices = require('../convert_ai_to_indices');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

// 模擬 subtitles_words.json：每字 0.1s，可指定哪些 index 是 gap
function mkWords(n, gapIdxs = []) {
  const gaps = new Set(gapIdxs);
  return Array.from({ length: n }, (_, i) => ({
    text: gaps.has(i) ? '' : `字${i}`,
    start: i * 0.1, end: i * 0.1 + 0.1,
    isGap: gaps.has(i),
  }));
}

console.log('\n## inlineFillerWordIndices（句中雜音字）');

t('保留句的 filler 進 indices，reason 為 AI:inline_filler', () => {
  const words = mkWords(6);
  const phrases = [{ wordIndices: [0, 1, 2, 3, 4, 5], inlineFillerWordIndices: [2, 4] }];
  const { indices, reasons } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [2, 4]);
  assert.strictEqual(reasons['2'], 'AI:inline_filler');
  assert.strictEqual(reasons['4'], 'AI:inline_filler');
});

t('aiDelete 句的 inlineFillerWordIndices 不重複處理（整句已刪）', () => {
  const words = mkWords(3);
  const phrases = [{ aiDelete: true, wordIndices: [0, 1, 2], inlineFillerWordIndices: [1] }];
  const { indices, reasons } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [0, 1, 2]);
  // reason 應是整句刪除的區間 reason，不是 inline_filler
  assert.strictEqual(reasons['1'], undefined);
  assert.ok(reasons['0-2']);
});

t('非法 index（負數/越界/非數字）忽略不炸', () => {
  const words = mkWords(3);
  const phrases = [{ wordIndices: [0, 1, 2], inlineFillerWordIndices: [-1, 99, '2', null, 1] }];
  const { indices } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [1]);
});

t('words 未提供時仍可加入（無越界檢查來源）', () => {
  const phrases = [{ wordIndices: [0, 1, 2], inlineFillerWordIndices: [1] }];
  const { indices, reasons } = convertAiToIndices(phrases, undefined);
  assert.deepStrictEqual(indices, [1]);
  assert.strictEqual(reasons['1'], 'AI:inline_filler');
});

t('已有 reason 的 index 不被 inline_filler 覆蓋', () => {
  const words = mkWords(4);
  const phrases = [{
    wordIndices: [0, 1, 2, 3],
    wordDeleteIdx: [2], wordDeleteReason: 'AI:word_surgery',
    inlineFillerWordIndices: [2, 3],
  }];
  const { indices, reasons } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [2, 3]);
  assert.strictEqual(reasons['2'], 'AI:word_surgery');
  assert.strictEqual(reasons['3'], 'AI:inline_filler');
});

console.log('\n## 既有路徑回歸防護');

t('aiDelete：wordIndices + gapIndices 全刪，記區間 reason', () => {
  const words = mkWords(5, [2]);
  const phrases = [{ aiDelete: true, deleteCategory: 'repeat', wordIndices: [0, 1, 3], gapIndices: [2] }];
  const { indices, reasons } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [0, 1, 2, 3]);
  assert.strictEqual(reasons['0-3'], 'AI:repeat');
});

t('gapDelete：短 gap（<1.85s）整段刪除，reason AI:pause', () => {
  const words = mkWords(4, [2]);
  const phrases = [{ wordIndices: [0, 1], gapAfterIdx: 2 }, { wordIndices: [3] }];
  phrases[0].gapDelete = true;
  const { indices, reasons } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [2]);
  assert.strictEqual(reasons['2'], 'AI:pause');
});

t('wordDeleteIdx：local index 正確映射為 global index', () => {
  const words = mkWords(6);
  const phrases = [{ wordIndices: [3, 4, 5], wordDeleteIdx: [1] }];
  const { indices, reasons } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [4]);
  assert.strictEqual(reasons['4'], 'AI:word_surgery');
});

t('gap-filling：夾在兩個刪除句之間的 gap 一併刪除', () => {
  const words = mkWords(5, [2]);
  const phrases = [
    { aiDelete: true, wordIndices: [0, 1] },
    { aiDelete: true, wordIndices: [3, 4] },
  ];
  const { indices } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [0, 1, 2, 3, 4]);
});

t('filler 與整句刪除混合：兩者標記都進 indices', () => {
  const words = mkWords(8);
  const phrases = [
    { aiDelete: true, wordIndices: [0, 1, 2] },
    { wordIndices: [3, 4, 5, 6, 7], inlineFillerWordIndices: [5] },
  ];
  const { indices, reasons } = convertAiToIndices(phrases, words);
  assert.deepStrictEqual(indices, [0, 1, 2, 5]);
  assert.strictEqual(reasons['5'], 'AI:inline_filler');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} 結果 ${passed} 通過 / ${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);
