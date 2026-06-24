#!/usr/bin/env node
/**
 * score_takes.js — 用聲學「篤定度」(assertiveness) 取代「盲目留後刪前」選 take。
 *
 * 文字稿是平的：同一句重錄三次，文字幾乎一樣，看不出哪次最好。聲音不是——講得
 * 篤定那次音量飽、語速穩、voiced 高、STT confidence 高。extract_audio_features.py
 * 已把這些合成成每個字的 assertiveness；這支模組把它聚合到 phrase 層，讓規則層
 * 的「兩段重複留哪段」從「無腦留後者」升級成「留講得篤定那段」。
 *
 * 設計原則：缺特徵時一律回 null，讓呼叫端優雅退回原本行為，絕不亂猜。
 *
 * 當模組用（不單獨執行）：
 *   const { loadAudioFeatures, phraseAssertiveness } = require('./score_takes');
 */

const fs = require('fs');

/**
 * 載入 extract_audio_features.py 產出的 audio_features.json。
 * 不存在 / 壞檔 / 格式不符 → 回 null（呼叫端據此退回文字判斷）。
 * @returns {{meta:object, words:Object<string,object>}|null}
 */
function loadAudioFeatures(featPath) {
  if (!featPath || !fs.existsSync(featPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(featPath, 'utf8'));
    if (!data || typeof data.words !== 'object') return null;
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * 一個 phrase 的平均 assertiveness：取其 wordIndices 在特徵表內有值的字平均。
 * 特徵表以 word idx（字串）為 key，gap 字不在表內、自動略過。
 * 沒有任何字命中特徵 → 回 null（讓呼叫端不要拿這段做篤定度比較）。
 * @returns {number|null}
 */
function phraseAssertiveness(phrase, feats) {
  if (!feats || !feats.words || !phrase || !Array.isArray(phrase.wordIndices)) return null;
  let sum = 0;
  let n = 0;
  for (const idx of phrase.wordIndices) {
    const f = feats.words[String(idx)];
    if (f && typeof f.assertiveness === 'number') {
      sum += f.assertiveness;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

/**
 * 一個 phrase 的聲學聚合：同時回傳 assertiveness / rms_norm / voiced_ratio /
 * confidence 的平均（各自只平均「有值」的字），外加 hasConf 旗標。
 * 用於規則 B 的「後段唸糊」判定——唸糊的唯一可靠訊號是 STT confidence，
 * 音量/voiced 只是輔證；缺哪個訊號就回 null，呼叫端據此不拿它做判斷。
 * 沒有任何字命中特徵 → 回 null。
 * @returns {{assertiveness:number, rms_norm:number|null, voiced_ratio:number|null,
 *           confidence:number|null, hasConf:boolean}|null}
 */
function phraseAcoustic(phrase, feats) {
  if (!feats || !feats.words || !phrase || !Array.isArray(phrase.wordIndices)) return null;
  let sA = 0, nA = 0, sR = 0, nR = 0, sV = 0, nV = 0, sC = 0, nC = 0;
  for (const idx of phrase.wordIndices) {
    const f = feats.words[String(idx)];
    if (!f) continue;
    if (typeof f.assertiveness === 'number') { sA += f.assertiveness; nA += 1; }
    if (typeof f.rms_norm === 'number') { sR += f.rms_norm; nR += 1; }
    if (typeof f.voiced_ratio === 'number') { sV += f.voiced_ratio; nV += 1; }
    if (typeof f.confidence === 'number') { sC += f.confidence; nC += 1; }
  }
  if (nA === 0) return null;
  return {
    assertiveness: sA / nA,
    rms_norm: nR > 0 ? sR / nR : null,
    voiced_ratio: nV > 0 ? sV / nV : null,
    confidence: nC > 0 ? sC / nC : null,
    hasConf: nC > 0,
  };
}

/**
 * 規則 B 翻盤判定：相鄰重複「前段 vs 後段」，後段是否為「唸糊壞 take」，
 * 是的話才該推翻「留後刪前」預設、改成刪後留前。
 * 條件（全部成立才算唸糊）：
 *   1. 兩段都有 STT confidence（缺則無法判斷唸糊 → 一律 false，安全退回留後）
 *   2. 後段 confidence 低於 confFloor（絕對偏低）
 *   3. 後段比前段 confidence 低 confMargin 以上（相對更糊）
 *   4. 後段整體篤定度比前段低 assertMargin 以上（音量/語速/voiced 也較虛，排除單純語氣差異）
 * @param {object|null} acA phraseAcoustic(前段)
 * @param {object|null} acB phraseAcoustic(後段)
 * @returns {boolean}
 */
function laterIsMumble(acA, acB, { confFloor = 0.6, confMargin = 0.15, assertMargin = 0.05 } = {}) {
  if (!acA || !acB || !acA.hasConf || !acB.hasConf) return false;
  return acB.confidence < confFloor
      && (acA.confidence - acB.confidence) >= confMargin
      && (acA.assertiveness - acB.assertiveness) >= assertMargin;
}

module.exports = { loadAudioFeatures, phraseAssertiveness, phraseAcoustic, laterIsMumble };
