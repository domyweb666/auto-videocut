#!/usr/bin/env node
/* subtitle_segment_llm.test.js — 斷行驗證(只斷不改字) + 時間對回 + 失敗退回，皆不呼叫真 Claude */
const { buildSegmentPrompt, parseSegmentResponse, charsFromWords, segmentByLLM } = require('./subtitle_segment_llm');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name); fail++; } }
function eq(name, got, want) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + '\n     got:  ' + g + '\n     want: ' + w); fail++; } }

const C = (text, start, end) => ({ text, start, end, isGap: false });
const words = [C('甲', 0, .3), C('乙', .3, .6), C('丙', .6, .9), C('丁', .9, 1.2), C('戊', 1.2, 1.5), C('己', 1.5, 1.8)];

console.log('charsFromWords（多字元內插）:');
const cw = charsFromWords([C('念，', 2.1, 2.4)]);
eq('「念，」拆兩個字元、時間內插', cw.chars.map(c => [c.ch, +c.start.toFixed(2), +c.end.toFixed(2)]),
  [['念', 2.1, 2.25], ['，', 2.25, 2.4]]);

console.log('buildSegmentPrompt:');
ok('帶入逐字稿', buildSegmentPrompt('甲乙丙').includes('甲乙丙'));
ok('含「只能斷行」鐵律', /只能斷行|不准改/.test(buildSegmentPrompt('x')));

console.log('parseSegmentResponse（逐字驗證＝紅線）:');
eq('正常斷行通過', parseSegmentResponse('甲乙丙\n丁戊己', '甲乙丙丁戊己'), ['甲乙丙', '丁戊己']);
ok('Claude 改了字（己→庚）→ 作廢', parseSegmentResponse('甲乙丙\n丁戊庚', '甲乙丙丁戊己') === null);
ok('Claude 少一個字 → 作廢', parseSegmentResponse('甲乙丙\n丁戊', '甲乙丙丁戊己') === null);
ok('Claude 加標點 → 作廢', parseSegmentResponse('甲乙丙，\n丁戊己', '甲乙丙丁戊己') === null);
eq('去 markdown 圍欄後通過', parseSegmentResponse('```\n甲乙丙\n丁戊己\n```', '甲乙丙丁戊己'), ['甲乙丙', '丁戊己']);
eq('行內空白去掉不影響', parseSegmentResponse('甲 乙 丙\n丁戊己', '甲乙丙丁戊己'), ['甲乙丙', '丁戊己']);

console.log('segmentByLLM（注入假 Claude）:');
let calls = 0;
const fake = ret => (prompt, model) => { calls++; return ret; };
const res = segmentByLLM(words, { callClaude: fake('甲乙丙\n丁戊己') });
eq('回傳 cues 文字', res.map(c => c.text), ['甲乙丙', '丁戊己']);
eq('時間對回（第1行 0→0.9、第2行 0.9→1.8）',
  res.map(c => [+c.start.toFixed(2), +c.end.toFixed(2)]), [[0, 0.9], [0.9, 1.8]]);
ok('字元不符 → 回 null（退回機械）', segmentByLLM(words, { callClaude: fake('甲乙丙\n丁戊庚') }) === null);
ok('超長行 → 回 null', segmentByLLM(words, { callClaude: fake('甲乙丙丁戊己'), maxLine: 5 }) === null);

calls = 0;
ok('文字超過 maxChars → 直接退回、不呼叫 Claude', segmentByLLM(words, { callClaude: fake('x'), maxChars: 3 }) === null && calls === 0);
ok('Claude 丟例外 → 回 null 不炸', segmentByLLM(words, { callClaude: () => { throw new Error('boom'); } }) === null);

console.log(`\n${pass} 過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
