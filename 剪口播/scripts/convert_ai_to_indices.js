#!/usr/bin/env node
/**
 * 格式轉換：ai_sentencize.js 輸出 → compare_transcriptions.js 輸入
 *
 * 將 phrase-level 的 AI 刪除標記轉換為 word-level indices
 *
 * 輸入: phrases (ai_sentencize.js 產出的 sentences.json 陣列)
 * 輸入: words  (subtitles_words.json 陣列，用於填充連續刪除間的 gap)
 * 輸出: { indices: [sorted word indices], reasons: { "startIdx-endIdx": "reason" } }
 */

// ── 常數：與執行端 (training_server.js enrichSentences) 保持一致 ──
const AUTO_GAP_THRESHOLD = 1.85; // 靜音超過此秒數 → 啟用 trim（保留前段，刪除後段）
const SILENCE_KEEP_SECS  = 0.5;  // trim 時保留在句尾的靜音秒數

// 收集一個 phrase 後面的完整連續 gap 群組
function collectGapGroup(phrase, words) {
  if (phrase.gapAfterIndices && phrase.gapAfterIndices.length > 0) {
    return phrase.gapAfterIndices.slice();
  }
  if (phrase.gapAfterIdx === undefined || !words) return [];
  const group = [phrase.gapAfterIdx];
  let k = phrase.gapAfterIdx + 1;
  while (k < words.length && words[k] && words[k].isGap) {
    group.push(k);
    k++;
  }
  return group;
}

// 對一個 gap 群組套用 trim 邏輯，回傳應刪除的 indices + 應保留的 indices
function splitGapForTrim(gapGroup, words) {
  if (gapGroup.length === 0) return { toDelete: [], toKeep: [] };
  const first = words[gapGroup[0]];
  const last  = words[gapGroup[gapGroup.length - 1]];
  if (!first || !last) return { toDelete: gapGroup.slice(), toKeep: [] };

  const totalDur = last.end - first.start;
  if (totalDur < AUTO_GAP_THRESHOLD) {
    // 未達 trim 門檻 → 整段刪除
    return { toDelete: gapGroup.slice(), toKeep: [] };
  }

  // 套用 trim：保留前 SILENCE_KEEP_SECS 秒，刪除其後
  const keepUntil = first.start + SILENCE_KEEP_SECS;
  const splitPos = gapGroup.findIndex(idx => words[idx] && words[idx].start >= keepUntil);
  const cutAt = splitPos > 0 ? splitPos : 0;
  return {
    toKeep: gapGroup.slice(0, cutAt),
    toDelete: gapGroup.slice(cutAt),
  };
}

module.exports = function convertAiToIndices(phrases, words) {
  const selected = new Set();
  const reasons = {};
  const protectedGapKeep = new Set(); // 被 trim 保留的 gap indices（gap-filling 時不可覆蓋）

  for (const phrase of phrases) {
    // ── 處理被刪除的 phrase ──
    if (phrase.aiDelete) {
      // 1. 所有字詞 indices
      for (const wi of (phrase.wordIndices || [])) {
        selected.add(wi);
      }
      // 2. phrase 內部的短 gap（<0.3s，屬於同一 phrase 的停頓）
      for (const gi of (phrase.gapIndices || [])) {
        selected.add(gi);
      }
      // 3. phrase 後面緊跟的 gap（刪除 phrase 後的死寂也一起刪）
      //    若該 gap 達到 trim 門檻，保留前 0.5s
      const gapGroup = collectGapGroup(phrase, words);
      if (gapGroup.length > 0) {
        const { toDelete, toKeep } = splitGapForTrim(gapGroup, words);
        toDelete.forEach(idx => selected.add(idx));
        toKeep.forEach(idx => protectedGapKeep.add(idx));
      }

      // 記錄刪除原因（供 compare_transcriptions.js 分析用）
      const wis = phrase.wordIndices || [];
      if (wis.length > 0) {
        const start = wis[0];
        const end   = wis[wis.length - 1];
        const cat   = phrase.deleteCategory || 'repeat';
        const reason = phrase.deleteReason || `AI:${cat}`;
        reasons[`${start}-${end}`] = reason;
      }
    }

    // ── 處理字詞手術 / 規則 G（保留 phrase 內刪除特定字元）──
    // 僅在 phrase 未整句刪除時處理 wordDeleteIdx
    if (!phrase.aiDelete && Array.isArray(phrase.wordDeleteIdx) && phrase.wordDeleteIdx.length > 0) {
      const wis = phrase.wordIndices || [];
      // 規則 G 設定的 wordDeleteReason 已包含完整原因（如 'intra_phrase_repeat: ...'）
      // 舊版 word_surgery 沒有設定 reason，fallback 到 'AI:word_surgery'
      const reason = phrase.wordDeleteReason || 'AI:word_surgery';
      for (const localIdx of phrase.wordDeleteIdx) {
        if (typeof localIdx !== 'number' || localIdx < 0 || localIdx >= wis.length) continue;
        const globalIdx = wis[localIdx];
        selected.add(globalIdx);
        reasons[String(globalIdx)] = reason;
      }
    }

    // ── 處理 gap 刪除（過長停頓修剪）──
    if (phrase.gapDelete) {
      const gapGroup = collectGapGroup(phrase, words);
      if (gapGroup.length > 0) {
        const { toDelete, toKeep } = splitGapForTrim(gapGroup, words);
        toDelete.forEach(idx => {
          selected.add(idx);
          const key = `${idx}`;
          if (!reasons[key]) {
            reasons[key] = phrase.gapDeleteReason || 'AI:pause';
          }
        });
        toKeep.forEach(idx => protectedGapKeep.add(idx));
      }
    }
  }

  // ── 後處理：填充連續刪除 phrase 之間的 gap ──
  // 若一個 gap word 的前後兩側文字都已被刪除，這個 gap 也應刪除
  // （避免留下孤立的 gap 在兩個刪除段落之間）
  // 注意：被 trim 保留的 gap indices (protectedGapKeep) 不能覆蓋
  if (words && words.length > 0) {
    for (let i = 0; i < words.length; i++) {
      if (!words[i].isGap) continue;
      if (selected.has(i)) continue; // 已被加入，跳過
      if (protectedGapKeep.has(i)) continue; // 屬於 trim 保留區段，跳過

      // 找前後最近的文字 word
      let prevText = -1, nextText = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (!words[j].isGap) { prevText = j; break; }
      }
      for (let j = i + 1; j < words.length; j++) {
        if (!words[j].isGap) { nextText = j; break; }
      }

      const prevDeleted = prevText === -1 || selected.has(prevText);
      const nextDeleted = nextText === -1 || selected.has(nextText);

      if (prevDeleted && nextDeleted) {
        selected.add(i);
      }
    }
  }

  const indices = [...selected].sort((a, b) => a - b);
  return { indices, reasons };
};
