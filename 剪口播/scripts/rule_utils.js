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

// ── 短單元立即重複偵測（2–5 字 AB AB 型卡頓）──
// 補「stutter_patterns 寫死清單」與「intra_phrase_repeat ≥6 字」之間的空窗：
// 「我覺得我覺得」「可以可以」「然後就然後就」這類清單外的短卡頓。
// 刪前留後（核心原則：後說的更完整）。
// 回傳 [{ start, end, unit, copies, deleteStart, deleteEnd }]，字元索引，deleteEnd 不含。
//
// 白名單擋合法重疊：中文動詞重疊（討論討論、休息休息）、笑聲（哈哈）、
// 逐一式（一個一個、一步一步 → skipPattern）。單字疊詞（謝謝、慢慢）因 minLen=2
// 天然不會被掃到（單位最短 2 字），無需列入。
const DEFAULT_REDUP_WHITELIST = [
  // 動詞重疊 VV（V 為雙字動詞）：V+V 是合法口語
  '討論', '研究', '考慮', '休息', '認識', '了解', '瞭解', '介紹', '練習',
  '學習', '放鬆', '商量', '溝通', '思考', '感受', '體驗', '嘗試',
  // 笑聲/狀聲（刻意的，不是卡頓）
  '哈哈', '呵呵', '嘿嘿', '嘻嘻', '嗚嗚',
  // 口語慣用疊用
  '等等', '好好', '慢慢', '常常', '剛剛', '偷偷', '悄悄', '輕輕', '漸漸',
];

function findShortStutterRepeats(text, opts = {}) {
  const minLen = opts.minLen ?? 2;
  const maxLen = opts.maxLen ?? 5;
  const whitelist = new Set(opts.whitelist ?? DEFAULT_REDUP_WHITELIST);
  // 逐一式量詞結構：一個一個、一步一步、兩天兩天、每次每次
  const skipPattern = opts.skipPattern ?? /^[一兩三每].$/;

  const hits = [];
  let p = 0;
  while (p < text.length) {
    let found = null;
    const maxTry = Math.min(maxLen, Math.floor((text.length - p) / 2));
    for (let len = maxTry; len >= minLen; len--) {
      const unit = text.slice(p, p + len);
      if (text.slice(p + len, p + 2 * len) !== unit) continue;
      if (whitelist.has(unit)) continue;
      if (skipPattern.test(unit)) continue;
      found = { unit, len };
      break; // 取最長單位，避免「就是說就是說」被切成「就是」誤配
    }
    if (!found) { p++; continue; }

    // 數連續副本數（≥2），刪前 (copies-1) 個保留最後一個
    let copies = 2;
    while (p + (copies + 1) * found.len <= text.length &&
           text.slice(p + copies * found.len, p + (copies + 1) * found.len) === found.unit) {
      copies++;
    }
    hits.push({
      start: p,
      end: p + copies * found.len,
      unit: found.unit,
      copies,
      deleteStart: p,
      deleteEnd: p + (copies - 1) * found.len,
    });
    p += copies * found.len;
  }
  return hits;
}

// ── 句內隔字重複偵測（A + 中間 + A，口誤重說）──
// 「我覺得呃我覺得」→ 刪前面的 A+中間，留後面的 A。
// 關鍵守門：中間必須是「遲疑雜音/口頭禪」（呃/嗯/就是/那個…），不能是內容詞——
// 「定位一個白板藍海戰略一個白板」是列舉句型（每本書一個白板），中間是內容詞，不是口誤。
// 回傳 [{ fragment, deleteStart, deleteEnd }]，字元索引，deleteEnd 不含（刪 A+中間，保留後面的 A）。
const DEFAULT_MIDDLE_FILLER_CHARS = '嗯啊呃欸哦噢唉哎呀誒喔';
const DEFAULT_MIDDLE_FILLER_WORDS = ['就是', '那個', '這個', '然後', '所以', '就', '那', '這'];

function findGappedRepeats(text, opts = {}) {
  const minLen = opts.minLen ?? 2;
  const maxLen = opts.maxLen ?? 4;
  const maxGap = opts.maxGap ?? 4;
  const commonSkip = opts.commonSkip instanceof Set ? opts.commonSkip : new Set(opts.commonSkip ?? []);
  const fillerChars = opts.middleFillerChars ?? DEFAULT_MIDDLE_FILLER_CHARS;
  const fillerWords = new Set(opts.middleFillerWords ?? DEFAULT_MIDDLE_FILLER_WORDS);
  const fillerCharRe = new RegExp(`[${fillerChars}]`, 'g');
  // 中間只能是遲疑雜音字 + 至多一個口頭禪詞
  const isFillerMiddle = (mid) => {
    const rest = mid.replace(fillerCharRe, '');
    return rest === '' || fillerWords.has(rest);
  };

  const hits = [];
  let scanFrom = 0;
  for (let pos = 0; pos < text.length - minLen * 2; pos++) {
    if (pos < scanFrom) continue;
    let hit = null;
    for (let len = Math.min(maxLen, Math.floor((text.length - 1) / 2)); len >= minLen; len--) {  // 長單位優先
      if (pos + len * 2 + 1 > text.length) continue;
      const fragment = text.slice(pos, pos + len);
      if (commonSkip.has(fragment)) continue;
      const searchStart = pos + len + 1;  // gap ≥1（gap=0 是立即重複的範圍）
      const searchEnd = Math.min(pos + len + maxGap, text.length - len);
      for (let pos2 = searchStart; pos2 <= searchEnd; pos2++) {
        if (text.slice(pos2, pos2 + len) !== fragment) continue;
        if (!isFillerMiddle(text.slice(pos + len, pos2))) continue;  // 中間是內容詞 → 列舉/排比，不是口誤
        hit = { fragment, deleteStart: pos, deleteEnd: pos2 };
        break;
      }
      if (hit) break;
    }
    if (hit) {
      hits.push(hit);
      scanFrom = hit.deleteEnd;  // 後面的 A 保留，從它開始繼續掃
    }
  }
  return hits;
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
  const connFile = path.join(scriptDir, '..', '用戶習慣', '10-保留連接詞.md');
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
  findShortStutterRepeats,
  DEFAULT_REDUP_WHITELIST,
  findGappedRepeats,
  loadTrainingConfig,
  loadProtectedWords,
};
