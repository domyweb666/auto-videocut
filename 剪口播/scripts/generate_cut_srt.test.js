#!/usr/bin/env node
/* generate_cut_srt.test.js — SRT 文字面(index 對齊) + 斷句(橫式 16 字) 整合測試 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name); fail++; } }
function eq(name, got, want) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + '\n     got:  ' + g + '\n     want: ' + w); fail++; } }

const SCRIPT = path.join(__dirname, 'generate_cut_srt.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srttest-'));
const W = (text, start, end) => ({ text, start, end, isGap: false });
function run(words, segs, outName, delIdx) {
  const wf = path.join(TMP, 'w.json'), df = path.join(TMP, 'd.json'), of = path.join(TMP, outName);
  fs.writeFileSync(wf, JSON.stringify(words));
  fs.writeFileSync(df, JSON.stringify(segs));
  const args = [SCRIPT, wf, df, of];
  if (delIdx) { const idf = path.join(TMP, 'idx.json'); fs.writeFileSync(idf, JSON.stringify(delIdx)); args.push('--delete-indices', idf); }
  execFileSync('node', args, { stdio: 'pipe' });
  return fs.readFileSync(of, 'utf8');
}
function cueTexts(srt) { return srt.split(/\r?\n\r?\n/).filter(Boolean).map(b => b.split(/\r?\n/).slice(2).join('')).filter(Boolean); }

console.log('文字面：index 選集覆蓋 >50% 時間重疊（修「多一個字／掉一個字」）:');
// 乙[1.0,1.2] 被使用者依 index 刪除；但精修後刪除段只蓋到 [1.11,1.2]（45%）→ 舊 isWordKept 會「保留」乙（多字）
const words = [W('甲', 0, 1), W('乙', 1.0, 1.2), W('丙', 2, 3)];
const segsPartial = [{ start: 1.11, end: 1.2 }];
const withIdx = cueTexts(run(words, segsPartial, 'a.srt', [1])).join('');
const withoutIdx = cueTexts(run(words, segsPartial, 'b.srt')).join('');
eq('--delete-indices：文字＝審核頁選集（乙被刪，不多字）', withIdx, '甲丙');
ok('不給 index 時舊發音區判斷會把邊界字「乙」留下（重現 bug）', withoutIdx.includes('乙'));

console.log('斷句：橫式短行、只斷標點、去行末標點、不掛虛詞:');
// 造一段逐字稿（標點黏在前字上，跟 byteplus 逐字稿一致）
function toWords(str, t0) {
  const els = []; let t = t0 || 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (/[，。！？、；：]/.test(ch) && els.length) { els[els.length - 1].text += ch; els[els.length - 1].end = t; }
    else { els.push(W(ch, t, t + 0.3)); t += 0.3; }
  }
  return els;
}
const longWords = toWords('這個世界很危險，我要先確保不犯錯，而且以後也絕對不能再犯任何一個錯誤了。', 0);
const cues = cueTexts(run(longWords, [], 'c.srt'));
ok('每條 ≤ 18 字（橫式上限）', cues.every(c => c.length <= 18));
ok('至少斷成多條（長句有被切）', cues.length >= 3);
ok('行末不留標點（字幕不顯示，斷行即停頓）', cues.every(c => !/[，。！？、；：]$/.test(c)));
ok('逗號不會被擠到下一行行首', cues.every(c => !/^[，。！？、；：]/.test(c)));
// 無標點長串硬斷時不掛虛詞（句末「了。」這種帶標點的合理不算）：造 的 在第 17 字的無標點長串
const forced = cueTexts(run(toWords('一二三四五六七八九十甲乙丙丁戊己的庚辛壬癸。', 0), [], 'f.srt'));
ok('無標點硬斷不掛虛詞（斷點避開「的」）', forced.every(c => c.slice(-1) !== '的'));

console.log('短完整句 + 去標點:');
eq('句末標點去掉、整句一條', cueTexts(run(toWords('我不能退。', 0), [], 'd.srt')), ['我不能退']);
// 頓號清單不從中間斷開（整串留一行，≤ 上限時）
const listCues = cueTexts(run(toWords('就是生存、安全、歸屬、地位、成就。', 0), [], 'e.srt'));
ok('頓號清單不從中間斷（整串留一行）', listCues.some(c => c.includes('生存、安全、歸屬')));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} 過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
