#!/usr/bin/env node
/* user_corrections.test.js — FP/FN 詞組化 + 只在有落差時 append */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCorrections, appendCorrections } = require('./user_corrections');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name); fail++; } }
function eq(name, got, want) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + '\n     got:  ' + g + '\n     want: ' + w); fail++; } }

const C = (text, isGap) => ({ text, start: 0, end: 0.3, isGap: !!isGap });
// 甲乙丙丁戊己：0甲 1乙 2丙 3丁 4戊 5己
const words = [C('甲'), C('乙'), C('丙'), C('丁'), C('戊'), C('己')];

console.log('buildCorrections:');
// AI 預選刪 0,1,2（甲乙丙）＋4（戊）；使用者最終只刪 2,3（丙丁）
// → FP（AI刪你留）= 0,1（甲乙）連續一組、4（戊）單字被濾；FN（你刪AI沒抓）= 3（丁）單字被濾
const autoSelected = [0, 1, 2, 4];
const autoReasons = { 0: '疑似重錄(相似80%)', 1: '疑似重錄(相似80%)', 2: '咳嗽', 4: '語意重複' };
const deletedIndices = [2, 3];
const corr = buildCorrections(words, autoSelected, deletedIndices, autoReasons);
eq('FP 併成詞組「甲乙」（AI 刪你留）', corr.falsePositives.map(f => f.text), ['甲乙']);
ok('FP 帶 reason', corr.falsePositives[0].reason.includes('疑似重錄'));
eq('FN 單字「丁」去標點<2 被濾（無 few-shot 價值）', corr.falseNegatives, []);

console.log('詞組化（跨 gap 併、非連續斷開）:');
// 0甲 1乙 2(gap) 3丙 4戊 —— FP=0,1,3,4，1與3中間只隔 gap → 併「甲乙丙戊」
const w2 = [C('甲'), C('乙'), C('', true), C('丙'), C('戊')];
const c2 = buildCorrections(w2, [0, 1, 3, 4], [], {});
eq('中間只隔 gap → 併成一組', c2.falsePositives.map(f => f.text), ['甲乙丙戊']);

console.log('appendCorrections:');
const tf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')), 'user_corrections.jsonl');
ok('完全吻合不寫檔（回 null）', appendCorrections('v', { falsePositives: [], falseNegatives: [] }, tf) === null);
ok('吻合時檔案不存在', !fs.existsSync(tf));
const rec = appendCorrections('vidX', corr, tf);
ok('有落差才寫一筆', rec && rec.videoName === 'vidX');
ok('檔案有一行 JSONL', fs.existsSync(tf) && fs.readFileSync(tf, 'utf8').trim().split('\n').length === 1);
const parsed = JSON.parse(fs.readFileSync(tf, 'utf8').trim());
ok('schema 有 videoName/falsePositives/falseNegatives', 'videoName' in parsed && Array.isArray(parsed.falsePositives) && Array.isArray(parsed.falseNegatives));
try { fs.rmSync(path.dirname(tf), { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} 過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
