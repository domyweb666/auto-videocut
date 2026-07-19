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
  const mid = detectRetakesFuzzy(W('所以你可以把它想想所以你可以想要整隻羊狗後面'), '');
  assert.strictEqual(mid.length, 0, `中相似無校正稿不該標，實得 ${JSON.stringify(mid)}`);
});

t('fuzzy：exact 已涵蓋的範圍會被減掉', () => {
  // 這段是乾淨立即重錄 → exact 全包 → fuzzy 殘段 < MIN_RESIDUAL → 空
  const text = '那你需要口頭警告作為警告那你需要口頭警告作為處罰後面';
  const r = detectRetakesFuzzy(W(text), '那你需要口頭警告作為處罰後面');
  assert.strictEqual(r.length, 0, `exact 已涵蓋不該重標，實得 ${JSON.stringify(r)}`);
});

console.log('\ndetect_retakes fuzzy 遠距層（隔 1–2 句碎片）:');

// take1(19字) + 放棄碎片(26字) + take2(19字，尾 2 字不同) + 後續。gap≈33 字（>近距 25、≤遠距 60）
const FAR_TEXT = '而如果是正面情緒的話我們就會覺得開心' + '呃不對等一下我想一下這段要怎麼講比較好我們重新來一次' + '而如果是正面情緒的話我們就會覺得爽快' + '這樣的迴路就會被強化下去';
const FAR_CORRECTED = '而如果是正面情緒的話我們就會覺得爽快這樣的迴路就會被強化下去'; // 校正稿只留一次

t('遠距：take 中間隔一句放棄碎片 + 校正稿次數證據 → 標（連碎片一起刪）', () => {
  const r = detectRetakesFuzzy(W(FAR_TEXT), FAR_CORRECTED);
  assert.strictEqual(r.length, 1, `應標 1 段，實得 ${JSON.stringify(r)}`);
  assert.strictEqual(r[0].evidence, 'corrected-merge-far');
  assert.ok(Math.abs(r[0].start - 0.0) < 1e-6, 'start 應為 take1 開頭');
  // 刪到 take2 起點（第 44 字≈4.4s）：take1(18字)+碎片(26字)=44
  assert.ok(Math.abs(r[0].end - 4.4) < 0.15, `end 應≈4.4（take2 起點），實為 ${r[0].end}`);
});

t('遠距：無校正稿 → 整層不啟用，不標', () => {
  const r = detectRetakesFuzzy(W(FAR_TEXT), '');
  assert.strictEqual(r.length, 0, `無校正稿不該標遠距，實得 ${JSON.stringify(r)}`);
});

t('遠距：呼應句（校正稿兩次都在）→ 不標', () => {
  // 同一句開頭在遠處合法重現（強調/呼應），校正稿兩次都保留 → 次數證據不成立
  const text = '而如果是正面情緒的話我們就會覺得開心' + '呃不對等一下我想一下這段要怎麼講比較好我們重新來一次' + '而如果是正面情緒的話我們就會覺得開心';
  const corrected = text; // 校正稿原樣保留兩次
  const r = detectRetakesFuzzy(W(text), corrected);
  assert.strictEqual(r.length, 0, `呼應句不該標，實得 ${JSON.stringify(r)}`);
});

t('遠距：中間碎片超過 60 字 → 超出範圍不標', () => {
  const frag = '呃不對等一下我想一下這段要怎麼講比較好我們重新來一次然後這邊還有一些別的東西要先講完才輪得到那句話再說一次的機會出現';
  const text = '而如果是正面情緒的話我們就會覺得開心' + frag + '而如果是正面情緒的話我們就會覺得爽快' + '這樣的迴路就會被強化';
  const r = detectRetakesFuzzy(W(text), '而如果是正面情緒的話我們就會覺得爽快這樣的迴路就會被強化');
  assert.strictEqual(r.length, 0, `超過遠距上限不該標，實得 ${JSON.stringify(r)}`);
});

t('遠距：近距行為不受影響（原 fuzzy 測試已覆蓋，此處驗證同輸入結果不變）', () => {
  const text = '因為你心裡沒有見過心裡沒建立過這個印象所以';
  const corrected = '因為你心裡沒建立過這個印象所以';
  const r = detectRetakesFuzzy(W(text), corrected);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].evidence, 'corrected-merge');
});

console.log('\ndetect_retakes near-exact（一字之差短 take）:');

t('near-exact：4 字 take 一字之差、無校正稿 → 標', () => {
  // 「所以你可」→「所以你說」：exact 的 MINLEN/PREFIX 擋掉、fuzzy 舊 MIN_TAKE 5 也擋掉
  const r = detectRetakesFuzzy(W('所以你可所以你說後面繼續講很多內容'), '');
  assert.strictEqual(r.length, 1, `應標 1 段，實得 ${JSON.stringify(r)}`);
  assert.strictEqual(r[0].evidence, 'near-exact');
  assert.ok(Math.abs(r[0].start - 0.0) < 1e-6 && Math.abs(r[0].end - 0.4) < 0.05,
    `應刪 take1 [0,0.4]，實得 [${r[0].start},${r[0].end}]`);
});

t('near-exact：列舉句（校正稿兩個 take 都在）→ 不標', () => {
  // 「在台北市/在台北縣」是列舉不是重錄，靠校正稿兩個都保留來站隊
  const text = '在台北市在台北縣都有分店可以去看看';
  const r = detectRetakesFuzzy(W(text), text);
  assert.strictEqual(r.length, 0, `列舉不該標，實得 ${JSON.stringify(r)}`);
});

t('near-exact：差兩字以上的 4 字 take → 不標（維持舊行為）', () => {
  const r = detectRetakesFuzzy(W('所以你可所後你說去後面繼續講很多內容'), '');
  assert.strictEqual(r.filter(x => x.evidence === 'near-exact').length, 0,
    `編輯距離 >1 不該以 near-exact 標`);
});

console.log('\ndetect_retakes 幻覺守門:');

t('whisper 幻覺複寫（第二份 take 時間戳塌陷）→ 不標', () => {
  // 真實案例：「是基於當時原始人類的規則」whisper 複寫兩次，第二份全部 0 長度擠在同一時間點
  const words = [...'是為了幫助原始人類更好的生存'].map((ch, i) => ({ text: ch, start: +(i * 0.2).toFixed(2), end: +((i + 1) * 0.2).toFixed(2), isGap: false }));
  let t0 = words[words.length - 1].end;
  // take1：正常時間戳
  [...'是基於當時原始人類的規則'].forEach((ch, i) => words.push({ text: ch, start: +(t0 + i * 0.18).toFixed(2), end: +(t0 + (i + 1) * 0.18).toFixed(2), isGap: false }));
  const t1 = words[words.length - 1].end;
  // take2：幻覺——全部塌在同一時間點（0 長度）
  [...'是基於當時原始人類的規則'].forEach(ch => words.push({ text: ch, start: t1, end: t1, isGap: false }));
  [...'可是問題是現在環境變了'].forEach((ch, i) => words.push({ text: ch, start: +(t1 + 0.02 + i * 0.2).toFixed(2), end: +(t1 + 0.02 + (i + 1) * 0.2).toFixed(2), isGap: false }));
  const ex = detectRetakes(words);
  assert.strictEqual(ex.length, 0, `exact 不該把幻覺當重錄，實得 ${JSON.stringify(ex)}`);
  const fz = detectRetakesFuzzy(words, '');
  assert.strictEqual(fz.length, 0, `fuzzy 不該把幻覺當重錄，實得 ${JSON.stringify(fz)}`);
});

t('正常時間戳的真重錄不受守門影響', () => {
  const r = detectRetakes(W('那你需要口頭警告作為警告那你需要口頭警告作為處罰後面'));
  assert.strictEqual(r.length, 1);
});

console.log('\ndetect_retakes 講稿（reference.txt）證據層:');

t('講稿次數差：轉錄兩次、講稿一次 → 標 reference-merge', () => {
  // 同 corrected-merge 案例，但改用講稿當證據（新 BytePlus 流程沒有校正稿）
  const text = '因為你心裡沒有見過心裡沒建立過這個印象所以';
  const r = detectRetakesFuzzy(W(text), '', { referenceText: '因為你心裡沒建立過這個印象所以' });
  assert.strictEqual(r.length, 1, `應標 1 段，實得 ${JSON.stringify(r)}`);
  assert.strictEqual(r[0].evidence, 'reference-merge');
});

t('講稿排比句：兩個變體講稿裡都有（各一次）→ 不標', () => {
  const text = '把它想像成是你自己而人的角色想像成是造物主它用演化';
  const r = detectRetakesFuzzy(W(text), '', { referenceText: text });
  assert.strictEqual(r.length, 0, `排比不該標，實得 ${JSON.stringify(r)}`);
});

t('即興段守門：探針都不在講稿 → 無證據，退回純相似度（中相似不標）', () => {
  // 中等相似（無稿時 SIM_SOLO 擋掉的那段），講稿完全無關 → 不能因「講稿裡找不到」就當重錄
  const text = '所以你可以把它想想所以你可以想要整隻羊狗後面';
  const r = detectRetakesFuzzy(W(text), '', { referenceText: '今天要講的主題是情緒與決策的關係完全不同的內容' });
  assert.strictEqual(r.length, 0, `即興段不該標，實得 ${JSON.stringify(r)}`);
});

t('繁簡正規化：轉錄簡體、講稿繁體 → 仍能配上（opencc）', () => {
  const text = '因為你心裡沒有見過心裡沒建立過這個印象所以'; // BytePlus zh-CN 簡體轉錄
  const r = detectRetakesFuzzy(W(text), '', { referenceText: '因為你心裡沒建立過這個印象所以' }); // 使用者講稿繁體
  assert.strictEqual(r.length, 1, `繁簡混用應標 1 段，實得 ${JSON.stringify(r)}`);
  assert.strictEqual(r[0].evidence, 'reference-merge');
});

t('遠距層：只有講稿（無校正稿）也啟用 → 標 reference-merge-far', () => {
  // 同 FAR_TEXT 結構：take1 + 放棄碎片 + take2，講稿只寫一次
  const r = detectRetakesFuzzy(W(FAR_TEXT), '', { referenceText: '而如果是正面情緒的話我們就會覺得爽快這樣的迴路就會被強化下去' });
  assert.strictEqual(r.length, 1, `講稿應讓遠距層啟用，實得 ${JSON.stringify(r)}`);
  assert.strictEqual(r[0].evidence, 'reference-merge-far');
  assert.ok(Math.abs(r[0].end - 4.4) < 0.15, `end 應≈4.4（take2 起點），實為 ${r[0].end}`);
});

t('遠距層：講稿裡開頭出現兩次（刻意呼應）→ 次數相等，不標', () => {
  const text = '而如果是正面情緒的話我們就會覺得開心' + '呃不對等一下我想一下這段要怎麼講比較好我們重新來一次' + '而如果是正面情緒的話我們就會覺得開心';
  const ref = '而如果是正面情緒的話我們就會覺得開心中間有別的內容而如果是正面情緒的話我們就會覺得開心';
  const r = detectRetakesFuzzy(W(text), '', { referenceText: ref });
  assert.strictEqual(r.length, 0, `講稿呼應句不該標，實得 ${JSON.stringify(r)}`);
});

t('有校正稿時：校正稿優先，講稿不改變既有行為', () => {
  const text = '因為你心裡沒有見過心裡沒建立過這個印象所以';
  const corrected = '因為你心裡沒建立過這個印象所以';
  const r = detectRetakesFuzzy(W(text), corrected, { referenceText: '完全無關的講稿' });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].evidence, 'corrected-merge');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
