#!/usr/bin/env node
// review_scorecard 單元測試
const assert = require('assert');
const { buildScorecard, categoryOf } = require('../review_scorecard');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✅ ' + name); } catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + e.message); } }

// 10 個字（每字 0.5s）+ 一個 gap
const words = [...Array(10)].map((_, i) => ({ text: '字' + i, start: i * 0.5, end: (i + 1) * 0.5, isGap: false }));
words.push({ text: '', start: 5.0, end: 5.6, isGap: true });

t('categoryOf 分類正確', () => {
  assert.strictEqual(categoryOf('重錄take：刪「x」留後一次'), 'retake_exact');
  assert.strictEqual(categoryOf('疑似重錄(相似67%，講稿佐證)：刪「a」留「b」'), 'retake_fuzzy');
  assert.strictEqual(categoryOf('清喉(ML 信心80%)'), 'cough');
  assert.strictEqual(categoryOf('語意重複建議(嵌入92%…)'), 'semantic');
  assert.strictEqual(categoryOf('reviewer: 「他只是壓垮」是截斷…'), 'ai');
  assert.strictEqual(categoryOf(''), 'ai');
});

t('全接受：預選=最終 → acceptRate 1', () => {
  const auto = [0, 1, 2];
  const reasons = { 0: '重錄take：x', 1: '重錄take：x', 2: '重錄take：x' };
  const final = [{ start: 0, end: 1.5 }]; // 蓋住 0,1,2
  const card = buildScorecard(words, auto, reasons, final);
  assert.strictEqual(card.categories.retake_exact.preselected, 3);
  assert.strictEqual(card.categories.retake_exact.accepted, 3);
  assert.strictEqual(card.categories.retake_exact.acceptRate, 1);
  assert.strictEqual(card.missed.words, 0);
});

t('退回＝誤刪訊號：預選 3 字使用者只留 1 字刪', () => {
  const auto = [0, 1, 2];
  const reasons = { 0: '清喉(ML 信心60%)', 1: '清喉(ML 信心60%)', 2: '清喉(ML 信心60%)' };
  const final = [{ start: 0, end: 0.5 }]; // 只刪字 0
  const card = buildScorecard(words, auto, reasons, final);
  assert.strictEqual(card.categories.cough.accepted, 1);
  assert.strictEqual(card.categories.cough.rejected, 2);
});

t('手動補刪＝漏刪訊號', () => {
  const auto = [0];
  const reasons = { 0: '重錄take：x' };
  const final = [{ start: 0, end: 0.5 }, { start: 4.0, end: 5.0 }]; // 補刪字 8,9
  const card = buildScorecard(words, auto, reasons, final);
  assert.strictEqual(card.missed.words, 2);
  assert.ok(Math.abs(card.missed.sec - 1.0) < 0.01);
});

t('gap 元素不進統計', () => {
  const auto = [0, 10]; // 10 是 gap
  const reasons = { 0: '重錄take：x' };
  const final = [{ start: 0, end: 0.5 }, { start: 5.0, end: 5.6 }];
  const card = buildScorecard(words, auto, reasons, final);
  const total = Object.values(card.categories).reduce((t, c) => t + c.preselected, 0);
  assert.strictEqual(total, 1, 'gap 不該被計入預選');
  assert.strictEqual(card.missed.words, 0, 'gap 不該被計入漏刪');
});

t('邊界字：最終刪除只沾到字的 20% → 不算刪（40% 判準）', () => {
  const auto = [2];
  const reasons = { 2: '重錄take：x' };
  const card = buildScorecard(words, auto, reasons, [{ start: 1.0, end: 1.1 }]); // 只蓋字2(1.0-1.5) 的 20%
  assert.strictEqual(card.categories.retake_exact.rejected, 1);
});

console.log(`\n結果: ${pass} 通過, ${fail} 失敗`);
process.exit(fail ? 1 : 0);
