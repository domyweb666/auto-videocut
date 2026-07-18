/**
 * narrative_evidence 純函式單元測試
 * 執行: node scripts/test/test_narrative_evidence.js
 *
 * 覆蓋：分句（isGap 句界＋音訊靜音句界）、證據文稿（停頓行＋刪除標記）、
 * AI JSON 解析（含 ``` 包裝）、範圍驗證與句界吸附、合併聯集與 reasons 格式、
 * 新增比例計算。
 */
const assert = require('assert');
const {
  buildSentences, buildTranscript, parseAiJson,
  validateDeletions, expandRanges, mergeSelections, additionRatio
} = require('../lib/narrative_evidence');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

// ── 合成資料：兩句中間隔 4 秒長停頓，第三句與第二句緊鄰 ──
// idx: 0我 1們 2走 3[gap4s] 4我 5們 6走 7吧 8[gap0.3s] 9好
const W = [
  { text: '我', start: 0.0, end: 0.3, isGap: false },
  { text: '們', start: 0.3, end: 0.6, isGap: false },
  { text: '走', start: 0.6, end: 0.9, isGap: false },
  { text: '',   start: 0.9, end: 4.9, isGap: true },
  { text: '我', start: 4.9, end: 5.2, isGap: false },
  { text: '們', start: 5.2, end: 5.5, isGap: false },
  { text: '走', start: 5.5, end: 5.8, isGap: false },
  { text: '吧', start: 5.8, end: 6.1, isGap: false },
  { text: '',   start: 6.1, end: 6.4, isGap: true },
  { text: '好', start: 6.4, end: 6.7, isGap: false }
];

console.log('\n## 分句');

t('isGap ≥0.5s 切句、<0.5s 不切', () => {
  const s = buildSentences(W, []);
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual([s[0].startIdx, s[0].endIdx, s[0].text], [0, 2, '我們走']);
  assert.deepStrictEqual([s[1].startIdx, s[1].endIdx, s[1].text], [4, 9, '我們走吧好']);
});

t('音訊靜音 ≥0.5s 補切句界（短 gap 處）', () => {
  const s = buildSentences(W, [{ start: 6.1, end: 6.7 }]);
  assert.strictEqual(s.length, 3);
  assert.strictEqual(s[1].text, '我們走吧');
  assert.strictEqual(s[2].text, '好');
});

console.log('\n## 證據文稿');

t('停頓 ≥0.5s 產出 ⏸ 行，時間與句行格式正確', () => {
  const s = buildSentences(W, []);
  const txt = buildTranscript(W, s, new Set(), '刪');
  const lines = txt.split('\n');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].startsWith('S0|0-2|0:00.0-0:00.9|我們走'));
  assert.strictEqual(lines[1], '⏸ 4.0s');
  assert.ok(lines[2].startsWith('S1|4-9|'));
});

t('刪除標記連續字合併成一組〔刪:…〕', () => {
  const s = buildSentences(W, []);
  const txt = buildTranscript(W, s, new Set([4, 5]), '刪');
  assert.ok(txt.includes('〔刪:我們〕走吧'));
});

console.log('\n## AI 輸出解析');

t('裸 JSON 與 ```json 包裝都能解析', () => {
  const obj = { deletions: [{ start: 0, end: 2, type: '重錄', reason: 'x' }] };
  assert.deepStrictEqual(parseAiJson(JSON.stringify(obj)), obj);
  assert.deepStrictEqual(parseAiJson('```json\n' + JSON.stringify(obj) + '\n```'), obj);
  assert.deepStrictEqual(parseAiJson('好的，結果如下\n' + JSON.stringify(obj)), obj);
});

t('無 JSON 時丟錯', () => {
  assert.throws(() => parseAiJson('沒有東西'));
});

console.log('\n## 範圍驗證與句界吸附');

t('範圍吸附到整句（半句刀口 → 句界）', () => {
  const s = buildSentences(W, []);
  const { ranges, warnings } = validateDeletions([{ start: 1, end: 2, type: '重錄', reason: 'r' }], W, s);
  assert.strictEqual(ranges.length, 1);
  assert.deepStrictEqual([ranges[0].start, ranges[0].end], [0, 2]);
  assert.ok(ranges[0].snapped);
  assert.strictEqual(warnings.length, 1);
});

t('越界/顛倒範圍略過並警告', () => {
  const s = buildSentences(W, []);
  const { ranges, warnings } = validateDeletions(
    [{ start: 5, end: 2 }, { start: 0, end: 99 }], W, s);
  assert.strictEqual(ranges.length, 0);
  assert.strictEqual(warnings.length, 2);
});

console.log('\n## 合併與比例');

t('聯集合併＋reasons 冠 [敘事] 前綴、range key 格式', () => {
  const m = mergeSelections([3], { '3': '靜音 ≥1s' }, [{ start: 0, end: 2, type: '重錄', reason: '留後刪前' }]);
  assert.deepStrictEqual(m.indices, [0, 1, 2, 3]);
  assert.strictEqual(m.added, 3);
  assert.strictEqual(m.reasons['3'], '靜音 ≥1s');
  assert.strictEqual(m.reasons['0-2'], '[敘事] 重錄：留後刪前');
});

t('expandRanges 含範圍內 gap', () => {
  const set = expandRanges([{ start: 2, end: 4 }]);
  assert.deepStrictEqual(Array.from(set).sort((a, b) => a - b), [2, 3, 4]);
});

t('additionRatio 只算非 gap 殘餘字', () => {
  // 規則層刪 idx3(gap) 不影響分母；殘餘 8 個非 gap 字，敘事層刪 0-2 共 3 字
  const ratio = additionRatio(W, new Set([3]), new Set([0, 1, 2, 3]));
  assert.ok(Math.abs(ratio - 3 / 8) < 1e-9, `got ${ratio}`);
});

console.log(`\n結果: ${passed} 通過, ${failed} 失敗`);
process.exit(failed ? 1 : 0);
