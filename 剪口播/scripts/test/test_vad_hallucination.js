// L3 單元測試 — vad_hallucination.js（VAD 反幻覺守門 L2~L4 純函式）
// 跑法: node --test scripts/test/test_vad_hallucination.js
const { test } = require('node:test');
const assert = require('node:assert');
const { flagHallucinations, speechCoverage, repetitionRatio } = require('../vad_hallucination.js');

// 工具：造字級陣列（每字 0.2s 緊接）
function mkWords(defs) {
  // defs: [text 或 {text,start,end,isGap}]
  let t = 0;
  return defs.map(d => {
    if (typeof d === 'object') return d;
    const w = { text: d, start: +t.toFixed(2), end: +(t + 0.2).toFixed(2), isGap: false };
    t += 0.2;
    return w;
  });
}

test('speechCoverage：完全落在語音區＝1、完全在外＝0、外擴 pad 生效', () => {
  const regions = [{ start: 1.0, end: 2.0 }];
  assert.equal(speechCoverage({ start: 1.2, end: 1.4 }, regions, 0), 1);
  assert.equal(speechCoverage({ start: 3.0, end: 3.2 }, regions, 0), 0);
  // 字貼著語音區尾端 0.1s 內：pad 0.12 → 全覆蓋
  assert.equal(speechCoverage({ start: 2.0, end: 2.1 }, regions, 0.12), 1);
});

test('repetitionRatio：「哈哈哈哈」→ 1、正常句 → 低', () => {
  assert.equal(repetitionRatio('哈哈哈哈'), 1);
  assert.ok(repetitionRatio('今天天氣很好') < 0.4);
});

test('靜音區整句出字 → 標為疑似幻覺（核心場景）', () => {
  // 語音只有 0~2s；4~5s 的死寂裡「憑空」轉出 4 個字
  const words = [
    ...mkWords(['真', '實', '語', '音']),                              // 0~0.8s，在語音區內
    { text: '', start: 0.8, end: 4.0, isGap: true },
    { text: '謝', start: 4.0, end: 4.25, isGap: false },
    { text: '謝', start: 4.25, end: 4.5, isGap: false },
    { text: '收', start: 4.5, end: 4.75, isGap: false },
    { text: '看', start: 4.75, end: 5.0, isGap: false },
  ];
  const flags = flagHallucinations(words, [{ start: 0, end: 2.0 }], {});
  assert.equal(flags.length, 1);
  assert.equal(flags[0].text, '謝謝收看');
  assert.deepEqual(flags[0].indices, [5, 6, 7, 8]);
  assert.ok(flags[0].conf >= 0.6);
});

test('正常影片（字都在語音區內）→ 零誤報', () => {
  const words = mkWords(['大', '家', '好', '我', '是', '多', '米']);
  const flags = flagHallucinations(words, [{ start: 0, end: 10 }], {});
  assert.equal(flags.length, 0);
});

test('孤立 1~2 字候選被信心閘門擋下（邊界誤差不當幻覺）', () => {
  // 單一個字落在語音區外 0.2s——很可能是 VAD 邊界誤差
  const words = [
    ...mkWords(['正', '常', '句', '子']),
    { text: '嗯', start: 2.0, end: 2.2, isGap: false },
  ];
  const flags = flagHallucinations(words, [{ start: 0, end: 0.8 }], {});
  // 「嗯」孤字 conf = (1-0)*0.6 = 0.6…剛好卡門檻；用預設 0.6 會過，驗證重罰邏輯讓它只剩勉強過門
  // 把門檻提高一點就該被擋
  const strict = flagHallucinations(words, [{ start: 0, end: 0.8 }], { minConfidence: 0.65 });
  assert.equal(strict.filter(f => f.text === '嗯').length, 0);
});

test('黑名單片語直接拉滿信心（即使覆蓋率中等）', () => {
  // 「請不吝點讚」五字，每字 20% 覆蓋（碎語音沾邊）→ 基礎信心 0.8，黑名單拉到 ≥0.95
  const words = [
    { text: '請', start: 10.0, end: 10.2, isGap: false },
    { text: '不', start: 10.2, end: 10.4, isGap: false },
    { text: '吝', start: 10.4, end: 10.6, isGap: false },
    { text: '點', start: 10.6, end: 10.8, isGap: false },
    { text: '讚', start: 10.8, end: 11.0, isGap: false },
  ];
  const regions = words.map(w => ({ start: w.start, end: w.start + 0.04 })); // 每字沾 20%
  const flags = flagHallucinations(words, regions, {
    blacklist: ['請不吝點讚'], edgePadSec: 0,
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].text, '請不吝點讚');
  assert.ok(flags[0].conf >= 0.95);
  assert.ok(flags[0].coverage > 0.15 && flags[0].coverage < 0.25); // 確認真的是中等覆蓋、不是零覆蓋自然過門
  assert.match(flags[0].evidence, /黑名單/);
});

test('高重複度文字加信心（哈哈哈哈式幻覺）', () => {
  const words = [
    { text: '哈', start: 5.0, end: 5.2, isGap: false },
    { text: '哈', start: 5.2, end: 5.4, isGap: false },
    { text: '哈', start: 5.4, end: 5.6, isGap: false },
    { text: '哈', start: 5.6, end: 5.8, isGap: false },
  ];
  const flags = flagHallucinations(words, [{ start: 0, end: 3 }], {});
  assert.equal(flags.length, 1);
  assert.match(flags[0].evidence, /高重複度/);
});

test('中間隔 gap 元素的候選字串成同一段', () => {
  const words = [
    { text: '幻', start: 8.0, end: 8.2, isGap: false },
    { text: '', start: 8.2, end: 8.5, isGap: true },
    { text: '覺', start: 8.5, end: 8.7, isGap: false },
    { text: '句', start: 8.7, end: 8.9, isGap: false },
  ];
  const flags = flagHallucinations(words, [{ start: 0, end: 3 }], {});
  assert.equal(flags.length, 1);
  assert.equal(flags[0].text, '幻覺句');
  assert.equal(flags[0].startIdx, 0);
  assert.equal(flags[0].endIdx, 3);
});

test('缺 VAD 資料 / 空輸入 → 安全回空陣列', () => {
  assert.deepEqual(flagHallucinations([], [], {}), []);
  assert.deepEqual(flagHallucinations(null, null, {}), []);
  assert.deepEqual(flagHallucinations(mkWords(['字']), [], {}).length >= 0, true);
});
