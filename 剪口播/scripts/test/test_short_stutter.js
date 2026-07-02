/**
 * findShortStutterRepeats 單元測試（規則 C2：短單元立即重複）
 * 執行: node scripts/test/test_short_stutter.js
 *
 * 覆蓋：清單外短卡頓（我覺得我覺得）、白名單（動詞重疊/笑聲/慣用疊用）、
 * 逐一式（一個一個）、三連副本、最長單位優先、與規則 G 的分界（≤5 字）。
 */
const assert = require('assert');
const { findShortStutterRepeats, findGappedRepeats } = require('../rule_utils');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

console.log('\n## 應偵測（清單外短卡頓）');

t('「我覺得我覺得你」→ 抓到 3 字單位，刪前留後', () => {
  const hits = findShortStutterRepeats('我覺得我覺得你');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].unit, '我覺得');
  assert.strictEqual(hits[0].copies, 2);
  assert.deepStrictEqual([hits[0].deleteStart, hits[0].deleteEnd], [0, 3]);
});

t('「可以可以」→ 抓到 2 字單位', () => {
  const hits = findShortStutterRepeats('可以可以');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].unit, '可以');
});

t('「然後就然後就開始」→ 抓到 3 字單位', () => {
  const hits = findShortStutterRepeats('然後就然後就開始');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].unit, '然後就');
});

t('三連副本「那我們那我們那我們說」→ copies=3，刪前 2 份', () => {
  const hits = findShortStutterRepeats('那我們那我們那我們說');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].copies, 3);
  assert.deepStrictEqual([hits[0].deleteStart, hits[0].deleteEnd], [0, 6]);
});

t('句中位置「所以呢可以可以這樣」→ start 對齊', () => {
  const hits = findShortStutterRepeats('所以呢可以可以這樣');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].start, 3);
  assert.deepStrictEqual([hits[0].deleteStart, hits[0].deleteEnd], [3, 5]);
});

t('最長單位優先：「就是說就是說」抓 3 字單位而非 2 字', () => {
  const hits = findShortStutterRepeats('就是說就是說');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].unit, '就是說');
});

t('一個 phrase 兩處卡頓都抓到', () => {
  const hits = findShortStutterRepeats('可以可以那我們就先這樣這樣處理');
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].unit, '可以');
  assert.strictEqual(hits[1].unit, '這樣');
});

console.log('\n## 不應偵測（合法重疊）');

t('動詞重疊「我們來討論討論」不動', () => {
  assert.strictEqual(findShortStutterRepeats('我們來討論討論').length, 0);
});

t('笑聲「哈哈哈哈」不動', () => {
  assert.strictEqual(findShortStutterRepeats('哈哈哈哈').length, 0);
});

t('逐一式「一個一個來」「一步一步走」不動', () => {
  assert.strictEqual(findShortStutterRepeats('一個一個來').length, 0);
  assert.strictEqual(findShortStutterRepeats('一步一步走').length, 0);
});

t('慣用疊用「等等等等」不動', () => {
  assert.strictEqual(findShortStutterRepeats('等等等等').length, 0);
});

t('單字疊詞「謝謝」「慢慢來」天然不掃（單位最短 2 字）', () => {
  assert.strictEqual(findShortStutterRepeats('謝謝').length, 0);
  assert.strictEqual(findShortStutterRepeats('慢慢來').length, 0);
});

t('無重複的正常句不動', () => {
  assert.strictEqual(findShortStutterRepeats('今天我們來聊一本書').length, 0);
});

t('隔字重複（A+中間+A）不在本規則範圍', () => {
  // 「可以的可以」中間隔了字，不是立即重複
  assert.strictEqual(findShortStutterRepeats('可以的可以').length, 0);
});

console.log('\n## 邊界與選項');

t('函式預設 maxLen=5：6 字單位不掃', () => {
  const text = '這本書講的是這本書講的是什麼';  // 6 字單位
  assert.strictEqual(findShortStutterRepeats(text).length, 0);
});

t('maxLen=20（prefilter C2 預設）：句中長單位重複抓得到', () => {
  const text = '這只會讓他們進而質疑先前所知道的一切進而質疑先前所知道的一切';
  const hits = findShortStutterRepeats(text, { maxLen: 20 });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].unit, '進而質疑先前所知道的一切');
  assert.strictEqual(hits[0].copies, 2);
  assert.strictEqual(hits[0].start, 6);
});

t('自訂白名單覆蓋預設', () => {
  const hits = findShortStutterRepeats('討論討論', { whitelist: [] });
  assert.strictEqual(hits.length, 1);  // 空白名單 → 討論討論 變成可抓
});

t('空字串/超短字串安全', () => {
  assert.strictEqual(findShortStutterRepeats('').length, 0);
  assert.strictEqual(findShortStutterRepeats('好').length, 0);
  assert.strictEqual(findShortStutterRepeats('好的').length, 0);
});

console.log('\n## 規則 C3：句內隔字重複（findGappedRepeats）');

const SKIP = new Set(['什麼', '這個', '那個', '就是', '一個', '我們', '覺得']);

t('「我覺得呃我覺得」→ 刪前面的 A+中間', () => {
  const hits = findGappedRepeats('我覺得呃我覺得很好', { commonSkip: SKIP });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].fragment, '我覺得');
  assert.deepStrictEqual([hits[0].deleteStart, hits[0].deleteEnd], [0, 4]);
});

t('中間是口頭禪詞「就是」也算口誤：「這本書就是這本書很棒」', () => {
  const hits = findGappedRepeats('這本書就是這本書很棒', { commonSkip: SKIP });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].fragment, '這本書');
});

t('中間是內容詞 → 列舉句型不動：「定位一個白板藍海戰略一個白板」', () => {
  const hits = findGappedRepeats('定位一個白板藍海戰略一個白板', { commonSkip: SKIP });
  assert.strictEqual(hits.length, 0, `列舉不該標，實得 ${JSON.stringify(hits)}`);
});

t('常見詞跳過：「什麼該捨棄什麼該採用」不動', () => {
  assert.strictEqual(findGappedRepeats('什麼該捨棄什麼該採用', { commonSkip: SKIP }).length, 0);
});

t('零間隔（AA）不歸 C3 管（那是 C2 的）', () => {
  assert.strictEqual(findGappedRepeats('我覺得我覺得', { commonSkip: SKIP }).length, 0);
});

t('間隔超過 maxGap 不動', () => {
  // 中間 5 個「相異」遲疑字 > maxGap 4（相同遲疑字會自成 A?A 命中，那是合理行為）
  assert.strictEqual(findGappedRepeats('這本書呃嗯啊欸哦這本書', { commonSkip: SKIP, maxGap: 4 }).length, 0);
});

t('正常句子不動', () => {
  assert.strictEqual(findGappedRepeats('今天我們來聊一本關於習慣的書', { commonSkip: SKIP }).length, 0);
});

console.log(`\n結果: ${passed} 通過, ${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
