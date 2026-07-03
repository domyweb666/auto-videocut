#!/usr/bin/env node
/* seam_coldread.test.js — 純函式單元測試（不呼叫 Claude，用假的 callClaude 注入） */
const {
  buildSeams, buildColdReadPrompt, parseColdReadResponse, coldReadSeams, keptContext, deletedText,
} = require('./seam_coldread');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + '\n     got:  ' + g + '\n     want: ' + w); fail++; }
}
function ok(name, cond) { if (cond) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name); fail++; } }

// 字元桶模型：C=內容字，G=1秒靜音桶
const C = (text, start, end) => ({ text, start, end, isGap: false });
const G = (start, end) => ({ text: '', start, end, isGap: true });

// 稿：先說[重來一次]後面 然[嗯]後
//  idx: 0先 1說 | 2重 3來 4一 5次(刪) | 6後 7面 | 8然 | 9嗯(刪) | 10後
const words = [
  C('先', 1.0, 1.3), C('說', 1.3, 1.6),
  C('重', 1.6, 1.9), C('來', 1.9, 2.2), C('一', 2.2, 2.5), C('次', 2.5, 2.8),
  C('後', 2.8, 3.1), C('面', 3.1, 3.4),
  C('然', 3.4, 3.7),
  C('嗯', 3.7, 3.85),
  C('後', 3.85, 4.15),
];
const deleted = [2, 3, 4, 5, 9];
const delSet = new Set(deleted);

console.log('buildSeams:');
const seams = buildSeams(words, delSet);
eq('只抓到一個達門檻接縫（整句重錄）', seams.length, 1);
eq('接縫落在保留字 1→6 之間', [seams[0].beforeIdx, seams[0].afterIdx], [1, 6]);
eq('接縫涵蓋的刪除 index', seams[0].delIdxs, [2, 3, 4, 5]);
eq('接縫編號從 1 起', seams[0].seamNo, 1);
ok('刪掉 1 個口水字（嗯）不算接縫', !seams.some(s => s.delIdxs.includes(9)));

console.log('門檻邊界:');
ok('minSeamChars 提高到 5 → 4 字重錄被濾掉', buildSeams(words, delSet, { minSeamChars: 5, minSeamSec: 99 }).length === 0);
ok('空刪除清單 → 零接縫', buildSeams(words, new Set()).length === 0);

console.log('buildColdReadPrompt:');
const { prompt, keptText } = buildColdReadPrompt(words, delSet, seams);
eq('冷讀稿在接縫處插 ⟦1⟧', keptText, '先說⟦1⟧後面然後');
ok('prompt 帶入冷讀稿', prompt.includes('先說⟦1⟧後面然後'));
ok('prompt 帶入三類判準', prompt.includes('指代斷裂') && prompt.includes('邏輯跳接') && prompt.includes('話題突兀'));

console.log('keptContext / deletedText:');
eq('往前取保留文字', keptContext(words, delSet, 1, -1, 24), '先說');
eq('往後取保留文字', keptContext(words, delSet, 6, 1, 24), '後面然後');
eq('刪除段文字', deletedText(words, [2, 3, 4, 5]), '重來一次');

console.log('parseColdReadResponse:');
const raw1 = '{"1":{"break":true,"type":"指代斷裂","concern":"沒交代先行詞"}}';
const fl1 = parseColdReadResponse(raw1, seams);
eq('break:true 被收', fl1.length, 1);
eq('type 帶出', fl1[0].type, '指代斷裂');
eq('break:false 不收', parseColdReadResponse('{"1":{"break":false}}', seams).length, 0);
eq('不存在的接縫編號忽略', parseColdReadResponse('{"9":{"break":true,"type":"邏輯跳接","concern":"x"}}', seams).length, 0);
eq('非法 type 退回接縫疑慮',
  parseColdReadResponse('{"1":{"break":true,"type":"亂寫","concern":"x"}}', seams)[0].type, '接縫疑慮');
eq('Claude 包了 markdown 圍欄也能解析',
  parseColdReadResponse('```json\n{"1":{"break":true,"type":"話題突兀","concern":"硬切"}}\n```', seams).length, 1);

console.log('coldReadSeams（注入假 Claude）:');
let called = 0;
const fakeClaude = () => { called++; return raw1; };
const res = coldReadSeams(words, deleted, { callClaude: fakeClaude });
eq('回傳一個標記接縫', res.seams.length, 1);
eq('meta 統計', [res.meta.totalSeams, res.meta.flagged], [1, 1]);
eq('補上前後文與刪除文字',
  [res.seams[0].beforeText, res.seams[0].afterText, res.seams[0].delText],
  ['先說', '後面然後', '重來一次']);
ok('afterIdx 指向接縫後第一個保留字', res.seams[0].afterIdx === 6);

let called2 = 0;
coldReadSeams(words, [], { callClaude: () => { called2++; return raw1; } });
ok('零接縫時不呼叫 Claude（省額度）', called2 === 0);

const resErr = coldReadSeams(words, deleted, { callClaude: () => { throw new Error('claude boom'); } });
ok('Claude 失敗不炸、回空清單', resErr.seams.length === 0 && /boom/.test(resErr.meta.error || ''));

console.log(`\n${pass} 過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
