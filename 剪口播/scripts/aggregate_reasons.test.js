#!/usr/bin/env node
/* aggregate_reasons.test.js — 分類法 + 聚合 + 渲染 純函式測試 */
const { classifyReason, normalizeTemplate } = require('./reason_taxonomy');
const { collectRecords, aggregate, renderMarkdown, extractSnippet } = require('./aggregate_reasons');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + '\n     got:  ' + g + '\n     want: ' + w); fail++; }
}
function ok(name, cond) { if (cond) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name); fail++; } }

console.log('classifyReason（用真實 pipeline 理由字串）:');
const cases = [
  ['靜音 10.3s', 'silence', false],
  ['重複Take(2次): "就是說你沒有一個主心骨..." → 保留第2次', 'retake', true],
  ['重錄take：刪「甲乙丙」留後一次', 'retake', true],
  ['疑似重錄(相似85%)：刪「甲」留「乙」', 'retake_fuzzy', true],
  ['相鄰重複: 前5字「甲乙丙丁戊」相同（bigram）', 'repeat', true],
  ['重複句: "害我多米粗減..."', 'repeat', true],
  ['句內重複: "什麼該"', 'intra_repeat', true],
  ['長片段重複: "甲乙丙" × 3', 'repeat', true],
  ['語意重複(75%): "甲..." ↔ "乙..."', 'semantic', true],
  ['語意重複建議(嵌入92%，低信心請確認)：與「甲乙丙」重複，刪較短', 'semantic', true],
  ['AI: 語意重複，保留後者（P1）', 'semantic', true],
  ['AI: 後者不完整，保留前者（P2）', 'ai_pair', true],
  ['放棄句首: 「所以」（連接詞開頭+停頓 0.8s+下句更長）', 'abandoned', true],
  ['殘句: "害我多米粗減"', 'abandoned', true],
  ['卡頓詞: 「那個那個」', 'stutter', false],
  ['連續語氣詞', 'filler', false],
  ['AI:inline_filler', 'filler', false],
  ['AI:pause', 'filler', false],
  ['清喉(ML 信心60%)', 'cough', false],
  ['咳嗽/雜音: "咳"', 'cough', false],
  ['Whisper 幻覺（中國頻道結尾語）', 'hallucination', false],
  ['話語標記開頭: 「就是說...」(4字短句)', 'filler', false],
];
cases.forEach(([r, k, c]) => {
  const cl = classifyReason(r);
  ok(`「${r.slice(0, 16)}」→ ${k}/${c ? '繞圈' : '非'}`, cl.key === k && cl.circling === c);
});

console.log('normalizeTemplate（同模式歸一）:');
eq('數量/引號/id 抽掉',
  normalizeTemplate('重複Take(3次): 「甲乙丙」 → 保留第3次'),
  '重複Take(N次): 「…」 → 保留第N次');
ok('兩條不同數字歸成同一樣板',
  normalizeTemplate('重複Take(2次): 「甲」') === normalizeTemplate('重複Take(5次): 「乙丙」'));
eq('秒數與百分比', normalizeTemplate('靜音 10.3s'), '靜音 Xs');

console.log('extractSnippet:');
eq('撈引號內文', extractSnippet('重複句: "害我多米粗減"'), '害我多米粗減');
eq('中文引號', extractSnippet('刪「甲乙丙」留後'), '甲乙丙');

console.log('collectRecords（帶字幕→取完整文字與秒數）:');
const words = [
  { text: '甲', start: 1.0, end: 1.3, isGap: false }, // 0
  { text: '乙', start: 1.3, end: 1.6, isGap: false }, // 1
  { text: '丙', start: 1.6, end: 1.9, isGap: false }, // 2
  { text: '丁', start: 1.9, end: 2.2, isGap: false }, // 3
];
const autoRaw = { indices: [0, 1, 2], reasons: { '0-2': '重複Take(2次): "甲乙丙" → 保留第2次' } };
const recs = collectRecords(autoRaw, words, 'vidA');
eq('一段刪除一筆記錄', recs.length, 1);
eq('取到完整刪除文字（非理由裡的截斷）', recs[0].text, '甲乙丙');
eq('算出刪除秒數', recs[0].seconds, 0.9);
eq('分類 retake/circling', [recs[0].family, recs[0].circling], ['retake', true]);
ok('純陣列（無理由）→ 無記錄', collectRecords([0, 1, 2], words, 'v').length === 0);
eq('無字幕時從理由撈例子',
  collectRecords({ indices: [5], reasons: { '5': '句內重複: "什麼該"' } }, null, 'v')[0].text, '什麼該');

console.log('aggregate（跨影片）:');
const records = [
  { video: 'A', family: 'retake', label: '整句重錄', circling: true, template: 't1', text: '甲乙丙丁', seconds: 2.0 },
  { video: 'A', family: 'retake', label: '整句重錄', circling: true, template: 't1', text: '戊己庚', seconds: 1.5 },
  { video: 'B', family: 'semantic', label: '語意繞圈', circling: true, template: 't2', text: '辛壬', seconds: 1.0 },
  { video: 'B', family: 'cough', label: '咳嗽清喉', circling: false, template: 't3', text: '咳', seconds: 0.4 },
];
const sum = aggregate(records);
eq('影片數', sum.totals.videos, 2);
eq('繞圈段數', sum.totals.circlingDeletions, 3);
eq('繞圈總秒數', sum.totals.circlingSeconds, 4.5);
eq('retake 排最前（次數最多的繞圈類）', sum.families[0].key, 'retake');
eq('retake 出現 2 支?其實 1 支', sum.families[0].videoCount, 1);
eq('circling 清單排除咳嗽', sum.circling.map(f => f.key).sort(), ['retake', 'semantic']);
ok('例子有去重且帶影片', sum.families[0].examples.length === 2);

console.log('renderMarkdown:');
const md = renderMarkdown(sum, {});
ok('有標題', md.includes('# 錄影前提詞紀律'));
ok('列出最常繞的類別', md.includes('整句重錄') && md.includes('語意繞圈'));
ok('帶紀律提示', md.includes('紀律：'));
ok('帶使用者自己的例子', md.includes('甲乙丙丁'));
ok('預設不列咳嗽（非繞圈）', !md.includes('咳嗽清喉'));
ok('--all 會列咳嗽', renderMarkdown(sum, { all: true }).includes('咳嗽清喉'));
ok('空資料給友善訊息', renderMarkdown(aggregate([]), {}).includes('還沒有可聚合的資料'));

console.log(`\n${pass} 過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
