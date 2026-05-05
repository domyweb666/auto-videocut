/**
 * 把 Claude 回傳的「保留版本純文字」對齊回 subtitles_words.json 的字級索引。
 *
 * 設計前提：Claude 只能刪、不能改寫。所以 keptText（去標點後）應為原文字流的子序列。
 * 演算法：兩指針貪婪匹配，遇失配時跳過原文字（視為被 Claude 刪除）。
 */

// 中英文標點與空白（用 unicode 範圍涵蓋常見中文標點 U+3000-303F、U+FF00-FFEF 全形）
const PUNCT_RE = /[\s\p{P}　-〿＀-￯]+/gu;

function stripPunct(s) {
  return s.replace(PUNCT_RE, '');
}

/**
 * 由 polished.json + 原始 words 建出「字 → wordIdx」的扁平映射。
 * 因為 phrases[].wordIndices 對應的 word.text 可能是多字（數字/英文），
 * 所以要逐字展開。
 */
function buildFlatChars(phrases, words) {
  const flat = []; // [{ ch, wordIdx }]
  for (const p of phrases) {
    for (const wi of p.wordIndices) {
      const w = words[wi];
      if (!w || !w.text) continue;
      const cleanText = stripPunct(w.text);
      for (const ch of cleanText) {
        flat.push({ ch, wordIdx: wi });
      }
    }
  }
  return flat;
}

/**
 * 主對齊函數
 * @param {string} keptText  Claude 回傳的保留版本（含標點/空白）
 * @param {Array}  phrases   polished.json 內容
 * @param {Array}  words     subtitles_words.json 內容
 * @returns {{
 *   keptWordIndices: Set<number>,
 *   deletedWordIndices: number[],
 *   warnings: string[],
 *   stats: { origChars, keptChars, matched, skipped }
 * }}
 */
function alignKeptText(keptText, phrases, words) {
  const flat   = buildFlatChars(phrases, words);
  const target = stripPunct(keptText);

  const warnings = [];          // 真正的對齊失敗（Claude 違反約束）
  const deletionRuns = [];      // 連續刪除段落（資訊統計，非警告）
  const keptWordIndices = new Set();

  let i = 0; // pointer into flat
  let j = 0; // pointer into target
  let runStart = -1;
  const RUN_RECORD_THRESHOLD = 30; // 紀錄 ≥30 字的連續刪除（純統計）

  while (i < flat.length && j < target.length) {
    if (flat[i].ch === target[j]) {
      if (runStart >= 0 && i - runStart >= RUN_RECORD_THRESHOLD) {
        deletionRuns.push({ from: runStart, to: i, length: i - runStart });
      }
      runStart = -1;
      keptWordIndices.add(flat[i].wordIdx);
      i++;
      j++;
    } else {
      if (runStart < 0) runStart = i;
      i++;
    }
  }
  // 收尾：如果 target 已耗盡但 flat 還有字，那是尾段全刪
  if (runStart >= 0 && i - runStart >= RUN_RECORD_THRESHOLD) {
    deletionRuns.push({ from: runStart, to: i, length: i - runStart });
  }

  // 真正的警告：target 沒消化完 → Claude 加了原文沒有的字
  if (j < target.length) {
    warnings.push(
      `❌ target 剩餘 ${target.length - j} 字未對齊（從 "${target.slice(j, j + 30)}"...）：` +
      `Claude 違反「只刪不寫」約束，新增了原文沒有的字。下游剪輯結果可能對不上。`
    );
  }

  // 收集所有非 gap 的原始 wordIdx，反推刪除集合
  const allTextWordIndices = new Set();
  for (const p of phrases) {
    for (const wi of p.wordIndices) {
      allTextWordIndices.add(wi);
    }
  }

  const deletedWordIndices = [];
  for (const wi of allTextWordIndices) {
    if (!keptWordIndices.has(wi)) deletedWordIndices.push(wi);
  }
  deletedWordIndices.sort((a, b) => a - b);

  return {
    keptWordIndices,
    deletedWordIndices,
    warnings,
    deletionRuns,
    stats: {
      origChars:    flat.length,
      keptChars:    target.length,
      matched:      keptWordIndices.size,
      skipped:      flat.length - keptWordIndices.size,
      bigRunsCount: deletionRuns.length
    }
  };
}

module.exports = { alignKeptText, stripPunct, buildFlatChars };
