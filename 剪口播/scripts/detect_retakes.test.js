#!/usr/bin/env node
/** detect_retakes.js 單元測試（無外部依賴，node detect_retakes.test.js 直接跑）*/
const assert = require('assert');
const { detectRetakes, detectRetakesFuzzy } = require('./detect_retakes.js');

// 用等長等距的假字級（每字 0.1s）造 whisper_words，方便斷言時間段。
function W(text) {
  return [...text].map((ch, i) => ({ text: ch, start: +(i * 0.1).toFixed(2), end: +((i + 1) * 0.1).toFixed(2), isGap: false }));
}
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } }

console.log('detect_retakes:');

t('乾淨立即重錄：刪前留後', () => {
  // 「那你需要口頭警告作為警告」+「那你需要口頭警告作為處罰」
  const r = detectRetakes(W('那你需要口頭警告作為警告那你需要口頭警告作為處罰後面'));
  assert.strictEqual(r.length, 1);
  assert.ok(Math.abs(r[0].start - 0.0) < 1e-6, 'start 應為第一個 take 開頭');
  // 刪到第二個 take 起點附近（第 12 字≈1.2s）。位移錨點 merge 後可能多吃 1~2 個「重複字」前綴
  // （如把第二 take 開頭的「那你」也一併刪掉），屬無害容差 → 接受 [1.2, 1.5]。
  assert.ok(r[0].end >= 1.2 - 1e-6 && r[0].end <= 1.5 + 1e-6, `end 應落在 [1.2,1.5]，實為 ${r[0].end}`);
});

t('排比句不誤判（想像成是你自己/想像成是造物主）', () => {
  // 兩個「想像成是」但後面接不同內容 → 共同前綴只到錨點 → 剔除
  const r = detectRetakes(W('想像成是你自己而人的角色想像成是造物主它用演化'));
  assert.strictEqual(r.length, 0, `不該偵測到重錄，實得 ${JSON.stringify(r)}`);
});

t('三連 take 併成一段、只留最後', () => {
  // 「長期反復」+「長期反復就會」+「長期反復就會得慢性病」
  const r = detectRetakes(W('長期反復長期反復就會長期反復就會得慢性病然後'));
  assert.strictEqual(r.length, 1, `應併成 1 段，實得 ${r.length}`);
  assert.ok(Math.abs(r[0].start - 0.0) < 1e-6);
  // 最後一個 take「長期反復就會得慢性病」起點≈第 10 字≈1.0s（同上，允許多吃重複前綴的容差）
  assert.ok(r[0].end >= 1.0 - 1e-6 && r[0].end <= 1.3 + 1e-6, `end 應落在 [1.0,1.3]（保留最後 take），實為 ${r[0].end}`);
});

t('無重複 → 空', () => {
  assert.strictEqual(detectRetakes(W('情緒會影響信念信念影響決策這是完整的一句話沒有任何重錄')).length, 0);
});

t('gap 元素(isGap)被忽略、不影響字序', () => {
  const words = [...W('那你需要口頭警告作為警告')];
  words.push({ text: '', start: 2.4, end: 3.4, isGap: true }); // 中間插一段靜音 gap
  words.push(...[...'那你需要口頭警告作為處罰尾'].map((ch, i) => ({ text: ch, start: +(3.4 + i * 0.1).toFixed(2), end: +(3.4 + (i + 1) * 0.1).toFixed(2), isGap: false })));
  const r = detectRetakes(words);
  assert.strictEqual(r.length, 1, `應偵測到 1 段跨 gap 的重錄，實得 ${r.length}`);
});

console.log('\ndetect_retakes fuzzy:');

t('fuzzy：一兩字差 + 校正稿合併證據 → 標', () => {
  // 「心裡沒有見過」→「心裡沒建立過」（exact 抓不到：最長共同子串只有 3 字）
  const text = '因為你心裡沒有見過心裡沒建立過這個印象所以';
  const corrected = '因為你心裡沒建立過這個印象所以'; // 校正稿只留一次
  const r = detectRetakesFuzzy(W(text), corrected);
  assert.strictEqual(r.length, 1, `應標 1 段，實得 ${JSON.stringify(r)}`);
  assert.strictEqual(r[0].evidence, 'corrected-merge');
});

t('fuzzy：排比句（校正稿兩次都在）→ 不標', () => {
  const text = '把它想像成是你自己而人的角色想像成是造物主它用演化';
  const corrected = '把它想像成是你自己而人的角色想像成是造物主它用演化'; // 兩次都保留＝原稿本來就這樣
  const r = detectRetakesFuzzy(W(text), corrected);
  assert.strictEqual(r.length, 0, `排比不該標，實得 ${JSON.stringify(r)}`);
});

t('fuzzy：無校正稿時退回高相似度門檻', () => {
  // 前綴只到一半（exact 的 PREFIX_RATIO 擋掉）但整體相似度高 → 無校正稿也標
  const hi = detectRetakesFuzzy(W('你可以把它想像成獎勵你可以把它當作是獎勵後面繼續講'), '');
  assert.strictEqual(hi.length, 1, `高相似無校正稿應標，實得 ${JSON.stringify(hi)}`);
  // 相似度中等（差很多字）→ 無校正稿不標
  const mid = detectRetakesFuzzy(W('所以你可以把它想想所以你可以想要整只羊狗後面'), '');
  assert.strictEqual(mid.length, 0, `中相似無校正稿不該標，實得 ${JSON.stringify(mid)}`);
});

t('fuzzy：exact 已涵蓋的範圍會被減掉', () => {
  // 這段是乾淨立即重錄 → exact 全包 → fuzzy 殘段 < MIN_RESIDUAL → 空
  const text = '那你需要口頭警告作為警告那你需要口頭警告作為處罰後面';
  const r = detectRetakesFuzzy(W(text), '那你需要口頭警告作為處罰後面');
  assert.strictEqual(r.length, 0, `exact 已涵蓋不該重標，實得 ${JSON.stringify(r)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
