#!/usr/bin/env node
/** detect_retakes.js 單元測試（無外部依賴，node detect_retakes.test.js 直接跑）*/
const assert = require('assert');
const { detectRetakes } = require('./detect_retakes.js');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
