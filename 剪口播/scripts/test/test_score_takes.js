/**
 * score_takes.js 單元測試
 * 執行: node scripts/test/test_score_takes.js
 *
 * 重點驗證規則 B 的「後段唸糊才翻盤」守門：
 *   - 缺 confidence → 永遠不翻盤（安全退回留後刪前）
 *   - 後段唸糊（confidence 明顯偏低且較虛）→ 翻盤改刪後留前
 *   - 後段只是音量小但 confidence 正常 → 不翻盤（音量≠唸糊）
 */
const assert = require('assert');
const { phraseAcoustic, laterIsMumble } = require('../score_takes');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

// 建一個 audio_features 表：wordIdx → 特徵
function mkFeats(map) {
  const words = {};
  for (const [idx, f] of Object.entries(map)) words[idx] = f;
  return { meta: {}, words };
}
const phrase = (...idx) => ({ wordIndices: idx });

console.log('\n## phraseAcoustic 聚合');
t('平均 assertiveness / rms / voiced / confidence', () => {
  const feats = mkFeats({
    0: { assertiveness: 0.8, rms_norm: 0.6, voiced_ratio: 1.0, confidence: 0.9 },
    1: { assertiveness: 0.6, rms_norm: 0.4, voiced_ratio: 0.8, confidence: 0.7 },
  });
  const ac = phraseAcoustic(phrase(0, 1), feats);
  assert.ok(Math.abs(ac.assertiveness - 0.7) < 1e-9);
  assert.ok(Math.abs(ac.rms_norm - 0.5) < 1e-9);
  assert.ok(Math.abs(ac.voiced_ratio - 0.9) < 1e-9);
  assert.ok(Math.abs(ac.confidence - 0.8) < 1e-9);
  assert.strictEqual(ac.hasConf, true);
});
t('缺 confidence → confidence=null, hasConf=false', () => {
  const feats = mkFeats({ 0: { assertiveness: 0.7, rms_norm: 0.5, voiced_ratio: 1.0, confidence: null } });
  const ac = phraseAcoustic(phrase(0), feats);
  assert.strictEqual(ac.confidence, null);
  assert.strictEqual(ac.hasConf, false);
});
t('gap 字（不在特徵表）自動略過；全缺 → null', () => {
  const feats = mkFeats({ 0: { assertiveness: 0.7 } });
  assert.strictEqual(phraseAcoustic(phrase(99), feats), null);
});

console.log('\n## laterIsMumble 翻盤守門');
const strong = { assertiveness: 0.75, rms_norm: 0.6, voiced_ratio: 1.0, confidence: 0.95, hasConf: true };
t('後段唸糊（conf 0.45 vs 0.95、較虛）→ 翻盤', () => {
  const weakMumble = { assertiveness: 0.5, rms_norm: 0.3, voiced_ratio: 0.6, confidence: 0.45, hasConf: true };
  assert.strictEqual(laterIsMumble(strong, weakMumble), true);
});
t('缺 confidence（hasConf=false）→ 不翻盤（安全退回留後）', () => {
  const noConf = { assertiveness: 0.3, rms_norm: 0.2, voiced_ratio: 0.5, confidence: null, hasConf: false };
  assert.strictEqual(laterIsMumble({ ...strong, hasConf: false, confidence: null }, noConf), false);
});
t('後段音量小但 confidence 正常（0.88）→ 不翻盤（音量≠唸糊）', () => {
  const quietButClear = { assertiveness: 0.55, rms_norm: 0.25, voiced_ratio: 0.9, confidence: 0.88, hasConf: true };
  assert.strictEqual(laterIsMumble(strong, quietButClear), false);
});
t('後段 conf 偏低但差距 < confMargin（0.92 vs 0.95）→ 不翻盤', () => {
  const slightly = { assertiveness: 0.55, rms_norm: 0.4, voiced_ratio: 0.9, confidence: 0.92, hasConf: true };
  assert.strictEqual(laterIsMumble(strong, slightly), false);
});
t('後段 conf 低但篤定度不比前段虛（weaker 不成立）→ 不翻盤', () => {
  const lowConfButStrong = { assertiveness: 0.78, rms_norm: 0.7, voiced_ratio: 1.0, confidence: 0.45, hasConf: true };
  assert.strictEqual(laterIsMumble(strong, lowConfButStrong), false);
});

console.log(`\n${failed === 0 ? '✅ 全部通過' : '❌ 有失敗'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
