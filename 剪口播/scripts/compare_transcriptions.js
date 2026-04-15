#!/usr/bin/env node
/**
 * 雙音檔轉錄比對：比對原始轉錄 vs 剪後轉錄，找出使用者刪除的內容
 *
 * 演算法：LCS（最長公共子序列）對齊兩份 Whisper 逐字稿
 * - 原始逐字稿中不在 LCS 的 = 使用者刪掉的
 * - 輸出格式與 compare_with_srt.js 完全相容
 *
 * 用法: node compare_transcriptions.js <subtitles_words.json> <edited_words.json> <auto_selected.json>
 * 輸出: diff_report.json (stdout)
 */

const fs = require('fs');
const path = require('path');

const origFile = process.argv[2];
const editedFile = process.argv[3];
const autoSelectedFile = process.argv[4];

if (!origFile || !editedFile || !autoSelectedFile) {
  console.error('用法: node compare_transcriptions.js <subtitles_words.json> <edited_words.json> <auto_selected.json>');
  process.exit(1);
}

// ── 讀取檔案 ──
const origWords = JSON.parse(fs.readFileSync(origFile, 'utf8'));
const editedWords = JSON.parse(fs.readFileSync(editedFile, 'utf8'));

const rawSelected = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
const autoSelected = new Set(Array.isArray(rawSelected) ? rawSelected : (rawSelected.indices || []));

// 讀取 auto_selected 的 reasons
let autoReasons = {};
if (!Array.isArray(rawSelected) && rawSelected.reasons) {
  for (const [key, reason] of Object.entries(rawSelected.reasons)) {
    if (key.includes('-')) {
      const [start, end] = key.split('-').map(Number);
      for (let i = start; i <= end; i++) autoReasons[i] = reason;
    } else {
      autoReasons[key] = reason;
    }
  }
}

// ── 提取文字序列（排除 gap）──
const origTexts = [];  // { idx, text }
for (let i = 0; i < origWords.length; i++) {
  if (!origWords[i].isGap) {
    origTexts.push({ idx: i, text: origWords[i].text });
  }
}

const editTexts = [];
for (let i = 0; i < editedWords.length; i++) {
  if (!editedWords[i].isGap) {
    editTexts.push({ idx: i, text: editedWords[i].text });
  }
}

// ── 拆成字元級序列（解決 Whisper tokenization 不一致問題）──
// 例如原始 ["我們","今天"] → chars: [{ch:"我",wordIdx:0},{ch:"們",wordIdx:0},{ch:"今",wordIdx:1},{ch:"天",wordIdx:1}]
function flattenToChars(wordSeq) {
  const chars = [];
  for (const w of wordSeq) {
    for (const ch of w.text) {
      chars.push({ ch, wordIdx: w.idx });
    }
  }
  return chars;
}

const origChars = flattenToChars(origTexts);
const editChars = flattenToChars(editTexts);

console.error(`📊 原始轉錄: ${origWords.length} 個元素 (文字 ${origTexts.length} 個詞 / ${origChars.length} 字, 靜音 ${origWords.length - origTexts.length})`);
console.error(`📊 剪後轉錄: ${editedWords.length} 個元素 (文字 ${editTexts.length} 個詞 / ${editChars.length} 字, 靜音 ${editedWords.length - editTexts.length})`);
console.error(`🤖 AI 標記: ${autoSelected.size} 個`);

// ── 字元級 LCS 對齊 ──
// 回傳原始序列中被保留的 word index Set
function charLCSAlign(origCh, editCh) {
  const m = origCh.length;
  const n = editCh.length;

  // 對於大序列用貪心（>8000 字元）
  if (m > 8000 || n > 8000) {
    return greedyCharAlign(origCh, editCh);
  }

  // 標準 LCS DP（字元級）
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) {
    dp[i] = new Uint32Array(n + 1);
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origCh[i - 1].ch === editCh[j - 1].ch) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯：找出原始字元中哪些被匹配
  const matchedOrigCharIdx = new Set();
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (origCh[i - 1].ch === editCh[j - 1].ch) {
      matchedOrigCharIdx.add(i - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  // 映射回 word index：一個 word 如果 >50% 的字元被匹配，視為保留
  const wordCharCount = {};  // wordIdx → { total, matched }
  for (let ci = 0; ci < origCh.length; ci++) {
    const wIdx = origCh[ci].wordIdx;
    if (!wordCharCount[wIdx]) wordCharCount[wIdx] = { total: 0, matched: 0 };
    wordCharCount[wIdx].total++;
    if (matchedOrigCharIdx.has(ci)) wordCharCount[wIdx].matched++;
  }

  const keptWordIndices = new Set();
  for (const [wIdx, counts] of Object.entries(wordCharCount)) {
    if (counts.matched / counts.total > 0.5) {
      keptWordIndices.add(parseInt(wIdx));
    }
  }

  const lcsLen = matchedOrigCharIdx.size;
  console.error(`🔗 字元 LCS: ${lcsLen}/${m} 字元匹配 (${(lcsLen / m * 100).toFixed(1)}%)`);
  console.error(`🔗 詞級保留: ${keptWordIndices.size}/${Object.keys(wordCharCount).length} 個詞`);
  return keptWordIndices;
}

// 貪心字元匹配（大序列 fallback）
function greedyCharAlign(origCh, editCh) {
  const matchedOrigCharIdx = new Set();
  let ep = 0;

  for (let oi = 0; oi < origCh.length; oi++) {
    if (ep < editCh.length && origCh[oi].ch === editCh[ep].ch) {
      matchedOrigCharIdx.add(oi);
      ep++;
    }
  }

  // 映射回 word index
  const wordCharCount = {};
  for (let ci = 0; ci < origCh.length; ci++) {
    const wIdx = origCh[ci].wordIdx;
    if (!wordCharCount[wIdx]) wordCharCount[wIdx] = { total: 0, matched: 0 };
    wordCharCount[wIdx].total++;
    if (matchedOrigCharIdx.has(ci)) wordCharCount[wIdx].matched++;
  }

  const keptWordIndices = new Set();
  for (const [wIdx, counts] of Object.entries(wordCharCount)) {
    if (counts.matched / counts.total > 0.5) {
      keptWordIndices.add(parseInt(wIdx));
    }
  }

  console.error(`🔗 貪心字元匹配: ${matchedOrigCharIdx.size}/${origCh.length} 字元 (${(matchedOrigCharIdx.size / origCh.length * 100).toFixed(1)}%)`);
  return keptWordIndices;
}

// ── 執行對齊（字元級）──
const keptTextIndices = charLCSAlign(origChars, editChars);

// 建立完整的 kept/deleted 集合
const userKept = new Set();
const userDeleted = new Set();

// 文字：由 LCS 結果決定
for (const tw of origTexts) {
  if (keptTextIndices.has(tw.idx)) {
    userKept.add(tw.idx);
  } else {
    userDeleted.add(tw.idx);
  }
}

// 靜音：如果前後文字都被刪除，靜音也算被刪除
for (let i = 0; i < origWords.length; i++) {
  if (!origWords[i].isGap) continue;

  let prevIdx = -1;
  for (let j = i - 1; j >= 0; j--) {
    if (!origWords[j].isGap) { prevIdx = j; break; }
  }
  let nextIdx = -1;
  for (let j = i + 1; j < origWords.length; j++) {
    if (!origWords[j].isGap) { nextIdx = j; break; }
  }

  const prevDeleted = prevIdx === -1 || userDeleted.has(prevIdx);
  const nextDeleted = nextIdx === -1 || userDeleted.has(nextIdx);

  if (prevDeleted && nextDeleted) {
    userDeleted.add(i);
  } else {
    userKept.add(i);
  }
}

console.error(`👤 使用者: 保留 ${userKept.size} / 刪除 ${userDeleted.size}`);

// ── 計算差異 ──
const falsePositives = [];
const falseNegatives = [];
const truePositives = [];

for (let i = 0; i < origWords.length; i++) {
  const aiMarked = autoSelected.has(i);
  const userDel = userDeleted.has(i);
  const reason = autoReasons[i] || (origWords[i].isGap ? '靜音' : '');

  const entry = {
    idx: i,
    text: origWords[i].text || '[靜音]',
    start: origWords[i].start,
    end: origWords[i].end,
    isGap: origWords[i].isGap,
    reason
  };

  if (aiMarked && !userDel) {
    falsePositives.push(entry);
  } else if (!aiMarked && userDel) {
    falseNegatives.push(entry);
  } else if (aiMarked && userDel) {
    truePositives.push(entry);
  }
}

// ── 分類統計 ──
function classifyEntry(entry) {
  if (entry.isGap) return 'silence';
  if (entry.reason) {
    const r = entry.reason;
    if (r.includes('靜音')) return 'silence';
    if (r.includes('重複句') || r.includes('重複')) return 'repeated_sentence';
    if (r.includes('殘句')) return 'incomplete_sentence';
    if (r.includes('卡頓')) return 'stutter';
    if (r.includes('語氣詞')) return 'filler_word';
    if (r.includes('句內重複')) return 'intra_repeat';
    if (r.includes('重說') || r.includes('糾正')) return 'self_correction';
    if (r.includes('連續語氣')) return 'consecutive_filler';
    if (r.includes('語意重複')) return 'semantic_redundancy';
  }
  return 'unclassified';
}

const categoryStats = {};
function addToCategory(category, type) {
  if (!categoryStats[category]) {
    categoryStats[category] = { tp: 0, fp: 0, fn: 0, tn: 0 };
  }
  categoryStats[category][type]++;
}

truePositives.forEach(e => addToCategory(classifyEntry(e), 'tp'));
falsePositives.forEach(e => addToCategory(classifyEntry(e), 'fp'));

for (const entry of falseNegatives) {
  if (entry.isGap) {
    addToCategory('silence', 'fn');
  } else {
    addToCategory('unclassified', 'fn');
  }
}

// ── 靜音閾值分析 ──
const silenceAnalysis = { kept: [], deleted: [] };
for (let i = 0; i < origWords.length; i++) {
  if (!origWords[i].isGap) continue;
  const dur = origWords[i].end - origWords[i].start;
  if (dur < 0.1) continue;
  if (userKept.has(i)) {
    silenceAnalysis.kept.push(dur);
  } else {
    silenceAnalysis.deleted.push(dur);
  }
}

const maxKeptSilence = silenceAnalysis.kept.length > 0
  ? silenceAnalysis.kept.reduce((a, b) => a > b ? a : b, 0)
  : 0;

// ── 輸出報告 ──
const matchRate = origTexts.length > 0
  ? (keptTextIndices.size / origTexts.length * 100).toFixed(1)
  : '0.0';

const report = {
  timestamp: new Date().toISOString(),
  source: 'audio_comparison',
  matchRate: parseFloat(matchRate),

  aiCount: autoSelected.size,
  userCount: userDeleted.size,
  falsePositives,
  falseNegatives,

  truePositiveCount: truePositives.length,
  accuracy: {
    precision: truePositives.length / (truePositives.length + falsePositives.length) || 0,
    recall: truePositives.length / (truePositives.length + falseNegatives.length) || 0,
  },

  categoryStats,

  silenceAnalysis: {
    maxKeptDuration: parseFloat(maxKeptSilence.toFixed(3)),
    keptCount: silenceAnalysis.kept.length,
    deletedCount: silenceAnalysis.deleted.length,
    distribution: (() => {
      const buckets = {};
      const allSilences = [
        ...silenceAnalysis.kept.map(d => ({ dur: d, kept: true })),
        ...silenceAnalysis.deleted.map(d => ({ dur: d, kept: false }))
      ];
      for (const s of allSilences) {
        const bucket = (Math.floor(s.dur / 0.2) * 0.2).toFixed(1);
        if (!buckets[bucket]) buckets[bucket] = { kept: 0, deleted: 0 };
        if (s.kept) buckets[bucket].kept++;
        else buckets[bucket].deleted++;
      }
      return buckets;
    })()
  }
};

report.accuracy.f1 = 2 * report.accuracy.precision * report.accuracy.recall /
  (report.accuracy.precision + report.accuracy.recall) || 0;

console.log(JSON.stringify(report, null, 2));

console.error('---');
console.error(`📊 結果: TP=${truePositives.length} FP=${falsePositives.length} FN=${falseNegatives.length}`);
console.error(`   精確率: ${(report.accuracy.precision * 100).toFixed(1)}%`);
console.error(`   召回率: ${(report.accuracy.recall * 100).toFixed(1)}%`);
console.error(`   F1: ${(report.accuracy.f1 * 100).toFixed(1)}%`);
console.error(`🔇 靜音: 使用者保留最長 ${maxKeptSilence.toFixed(2)}s`);
