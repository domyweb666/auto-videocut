/**
 * rule_utils.js — 純函式工具庫，給 auto_select_rules.js / phrase_prefilter.js 共用
 *
 * 不依賴 global state（words、config）；所有函式接收參數、回傳值。
 */

// ── bigram 相似度（Dice coefficient）──
function charSet(text) {
  const bigrams = new Set();
  for (let i = 0; i < text.length - 1; i++) {
    bigrams.add(text.slice(i, i + 2));
  }
  return bigrams;
}

function bigramSimilarity(a, b) {
  const setA = charSet(a);
  const setB = charSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

// ── 最長共同子字串長度（O(m·n)，純字元級）──
function longestCommonSubstring(a, b) {
  let maxLen = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let len = 0;
      while (i + len < a.length && j + len < b.length && a[i + len] === b[j + len]) {
        len++;
      }
      if (len > maxLen) maxLen = len;
    }
  }
  return maxLen;
}

function lcsRatio(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  return longestCommonSubstring(a, b) / Math.min(a.length, b.length);
}

// ── 連續 gap 合併 ──
// words: [{text, start, end, isGap: bool}, ...]
// 回傳 [{startIdx, endIdx, duration}, ...]，每個 run 是連續 gap 的合併區段
function findGapRuns(words) {
  const runs = [];
  let i = 0;
  while (i < words.length) {
    if (words[i].isGap) {
      const start = i;
      let totalDur = 0;
      while (i < words.length && words[i].isGap) {
        totalDur += words[i].end - words[i].start;
        i++;
      }
      runs.push({ startIdx: start, endIdx: i - 1, duration: totalDur });
    } else {
      i++;
    }
  }
  return runs;
}

// ── 讀取 training_config.json 與保留連接詞 ──
function loadTrainingConfig(scriptDir) {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(scriptDir, '..', 'training_config.json');
  return fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
}

function loadProtectedWords(scriptDir) {
  const fs = require('fs');
  const path = require('path');
  const out = [];
  const connFile = path.join(scriptDir, '..', '用户习惯', '10-保留連接詞.md');
  if (fs.existsSync(connFile)) {
    const content = fs.readFileSync(connFile, 'utf8');
    const match = content.match(/```\r?\n([\s\S]*?)```/);
    if (match) {
      match[1].split(/[、，\r?\n]/).forEach(w => {
        const trimmed = w.trim().replace(/\r$/, '');
        if (trimmed) out.push(trimmed);
      });
    }
  }
  return out;
}

module.exports = {
  charSet,
  bigramSimilarity,
  longestCommonSubstring,
  lcsRatio,
  findGapRuns,
  loadTrainingConfig,
  loadProtectedWords,
};
