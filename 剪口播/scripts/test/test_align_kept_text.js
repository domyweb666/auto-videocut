/**
 * align_kept_text.js 單元測試
 * 執行: node scripts/test/test_align_kept_text.js
 */
const assert = require('assert');
const { alignKeptText, stripPunct } = require('../lib/align_kept_text');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

// 模擬 subtitles_words.json：每字一個 word，混 gap
function mkWords(chars) {
  return chars.split('').map((ch, i) => ({
    text: ch, start: i * 0.1, end: i * 0.1 + 0.1, isGap: false
  }));
}
// 模擬 polished.json：一個 phrase 包所有字
function mkPhrases(words, displayText) {
  return [{
    text: words.map(w => w.text).join(''),
    displayText: displayText || words.map(w => w.text).join(''),
    wordIndices: words.map((_, i) => i)
  }];
}

console.log('\n## stripPunct');
t('剝中英文標點', () => {
  assert.strictEqual(stripPunct('你好，世界。Hello, world!'), '你好世界Helloworld');
});
t('剝空白與換行', () => {
  assert.strictEqual(stripPunct('a b\nc\td'), 'abcd');
});

console.log('\n## alignKeptText 基本案例');
t('完全保留 → 0 刪除', () => {
  const words = mkWords('你好世界');
  const phrases = mkPhrases(words);
  const r = alignKeptText('你好世界', phrases, words);
  assert.strictEqual(r.deletedWordIndices.length, 0);
  assert.strictEqual(r.warnings.length, 0);
});

t('刪中間 → 索引正確', () => {
  const words = mkWords('你好世界');
  const phrases = mkPhrases(words);
  const r = alignKeptText('你界', phrases, words);
  assert.deepStrictEqual(r.deletedWordIndices, [1, 2]);
  assert.strictEqual(r.warnings.length, 0);
});

t('刪頭尾 → 索引正確', () => {
  const words = mkWords('ABCDE');
  const phrases = mkPhrases(words);
  const r = alignKeptText('CD', phrases, words);
  assert.deepStrictEqual(r.deletedWordIndices, [0, 1, 4]);
});

t('全刪 → 全索引', () => {
  const words = mkWords('你好');
  const phrases = mkPhrases(words);
  const r = alignKeptText('', phrases, words);
  assert.deepStrictEqual(r.deletedWordIndices, [0, 1]);
});

console.log('\n## 標點容忍');
t('Claude 加標點不影響對齊', () => {
  const words = mkWords('你好世界');
  const phrases = mkPhrases(words);
  const r = alignKeptText('你好，世界！', phrases, words);
  assert.strictEqual(r.deletedWordIndices.length, 0);
});

t('Claude 加換行分段', () => {
  const words = mkWords('ABCDEF');
  const phrases = mkPhrases(words);
  const r = alignKeptText('ABC\n\nDEF', phrases, words);
  assert.strictEqual(r.deletedWordIndices.length, 0);
});

console.log('\n## 違反「只刪不寫」約束 → 應有警告');
t('Claude 改字 → target 剩餘警告', () => {
  // 原文都是 A；Claude 輸出 X → 對不上 → target 剩餘
  const words = mkWords('AAAA');
  const phrases = mkPhrases(words);
  const r = alignKeptText('X', phrases, words);
  assert.ok(r.warnings.length > 0, '應產生警告');
  assert.ok(r.warnings[0].includes('剩餘'), '應為 target 剩餘警告');
});

t('合法刪除 30+ 字不觸發警告（只記入 deletionRuns）', () => {
  const words = mkWords('A'.repeat(50) + 'B');
  const phrases = mkPhrases(words);
  const r = alignKeptText('B', phrases, words);
  assert.strictEqual(r.warnings.length, 0, '合法刪除不應警告');
  assert.strictEqual(r.deletionRuns.length, 1, '應記錄 1 個 big run');
  assert.strictEqual(r.deletionRuns[0].length, 50);
});

t('Claude 新增字 → target 剩餘警告', () => {
  const words = mkWords('AB');
  const phrases = mkPhrases(words);
  const r = alignKeptText('ABCDE', phrases, words);
  assert.ok(r.warnings.some(w => w.includes('剩餘')), '應有 target 剩餘警告');
});

console.log('\n## 多 phrase + 多字 word');
t('跨 phrase 對齊', () => {
  const words = [
    { text: '你', start: 0, end: 0.1, isGap: false },
    { text: '好', start: 0.1, end: 0.2, isGap: false },
    { text: 'GPT', start: 0.2, end: 0.5, isGap: false }, // 多字 word
    { text: '世', start: 0.5, end: 0.6, isGap: false },
    { text: '界', start: 0.6, end: 0.7, isGap: false }
  ];
  const phrases = [
    { text: '你好', displayText: '你好，', wordIndices: [0, 1] },
    { text: 'GPT世界', displayText: 'GPT世界。', wordIndices: [2, 3, 4] }
  ];
  // Claude 保留 "你 GPT 界" → 應刪 idx 1, 3
  const r = alignKeptText('你 GPT 界', phrases, words);
  assert.deepStrictEqual(r.deletedWordIndices, [1, 3]);
});

t('多字 word 部分匹配 → 整 word 保留', () => {
  // 若 keptText 出現該 word 的任一字，整個 word 都被標為 kept
  // （因為 word 是最小剪輯單位）
  const words = [
    { text: 'Hello', start: 0, end: 0.5, isGap: false },
    { text: '世', start: 0.5, end: 0.6, isGap: false }
  ];
  const phrases = [{ text: 'Hello世', wordIndices: [0, 1] }];
  // Claude 只留 "Hel" 與 "世" → 對齊時 H/e/l 都標到 wordIdx 0 → 整個 word 0 保留
  const r = alignKeptText('Hel世', phrases, words);
  assert.deepStrictEqual(r.deletedWordIndices, []);
});

console.log(`\n=== 結果 ${passed} 通過 / ${failed} 失敗 ===`);
process.exit(failed === 0 ? 0 : 1);
