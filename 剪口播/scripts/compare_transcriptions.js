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

// ── 拆成字元級序列 ──
function flattenToChars(wordSeq) {
  const chars = [];
  for (const w of wordSeq) {
    for (const ch of w.text) chars.push({ ch, wordIdx: w.idx });
  }
  return chars;
}

const origChars = flattenToChars(origTexts);
const editChars = flattenToChars(editTexts);

console.error(`📊 原始轉錄: ${origWords.length} 個元素 (文字 ${origTexts.length} 個詞 / ${origChars.length} 字, 靜音 ${origWords.length - origTexts.length})`);
console.error(`📊 剪後轉錄: ${editedWords.length} 個元素 (文字 ${editTexts.length} 個詞 / ${editChars.length} 字, 靜音 ${editedWords.length - editTexts.length})`);
console.error(`🤖 AI 標記: ${autoSelected.size} 個`);

// ── 字元級 LCS 對齊 ──
function charLCSAlign(origCh, editCh) {
  const m = origCh.length, n = editCh.length;

  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origCh[i - 1].ch === editCh[j - 1].ch) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const matchedOrigCharIdx = new Set();
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (origCh[i - 1].ch === editCh[j - 1].ch) { matchedOrigCharIdx.add(i - 1); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
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
    if (counts.matched / counts.total > 0.5) keptWordIndices.add(parseInt(wIdx));
  }

  const lcsLen = matchedOrigCharIdx.size;
  console.error(`🔗 字元 LCS: ${lcsLen}/${m} 字元匹配 (${(lcsLen / m * 100).toFixed(1)}%)`);
  return keptWordIndices;
}

// ── 執行 LCS 對齊 ──
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

// 靜音分類：結合鄰居狀態 + 時長判斷
// 計算剪後版的靜音時長分佈，用穩健統計量（P95）取代 max
// 避免單一極長靜音（如 16s）使閾值過高導致所有 gap 都被歸為「保留」
const editGapRuns = [];
{
  let runDur = 0;
  for (let i = 0; i < editedWords.length; i++) {
    if (editedWords[i].isGap) {
      runDur += editedWords[i].end - editedWords[i].start;
    } else {
      if (runDur > 0) editGapRuns.push(runDur);
      runDur = 0;
    }
  }
  if (runDur > 0) editGapRuns.push(runDur);
}
editGapRuns.sort((a, b) => a - b);
const editMaxGapRaw = editGapRuns.length > 0 ? editGapRuns[editGapRuns.length - 1] : 0;
// 使用 P95 作為穩健上限（避免極端 outlier 影響閾值）
const p95Idx = Math.floor(editGapRuns.length * 0.95);
const editP95Gap = editGapRuns.length > 0 ? editGapRuns[Math.min(p95Idx, editGapRuns.length - 1)] : 0;
// 使用 min(max, P95 * 1.5) 確保閾值不被極端 outlier 拉高
// P95 代表使用者編輯後的「正常」最長靜音，超過 P95*1.5 的原始靜音幾乎一定被刪除
const editMaxGap = (editP95Gap > 0) ? Math.min(editMaxGapRaw, editP95Gap * 1.5) : editMaxGapRaw;
console.error(`🔇 剪後靜音: max=${editMaxGapRaw.toFixed(2)}s P95=${editP95Gap.toFixed(2)}s → 使用=${editMaxGap.toFixed(2)}s`);

// 合併原始版連續 gap 成 run，超過剪後最大值的 = 被刪除
const gapRunMap = new Map(); // idx → { deleted: bool }
{
  let i = 0;
  while (i < origWords.length) {
    if (origWords[i].isGap) {
      const runStart = i;
      let runDur = 0;
      while (i < origWords.length && origWords[i].isGap) {
        runDur += origWords[i].end - origWords[i].start;
        i++;
      }
      // 如果 run 的總時長超過剪後版最大靜音 → 使用者必然刪除了這段
      // 使用 1.5x 容差（Whisper 可能有些時長誤差）
      const exceedsEdit = editMaxGap > 0 && runDur > editMaxGap * 1.5;
      for (let j = runStart; j < i; j++) {
        gapRunMap.set(j, { runDur, exceedsEdit });
      }
    } else {
      i++;
    }
  }
}

for (let i = 0; i < origWords.length; i++) {
  if (!origWords[i].isGap) continue;

  const runInfo = gapRunMap.get(i);

  // 方法 1: 超過剪後最大靜音 → 被刪除
  if (runInfo && runInfo.exceedsEdit) {
    userDeleted.add(i);
    continue;
  }

  // 方法 2: 前後文字都被刪除 → 被刪除
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

// （不做後處理 — LCS 的 kept/deleted 判定直接使用）

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
  const r = entry.reason || '';
  // 靜音相關
  if (r === 'AI:pause') return 'silence';
  if (r.includes('靜音')) return 'silence';
  // 規則 G：phrase 內字元級重複（intra_phrase_repeat）— 必須在 word_surgery 之前
  if (r.includes('intra_phrase_repeat')) return 'intra_phrase_repeat';
  // AI 字詞手術（word-level surgery）— 必須在 ai_pair 判斷之前
  if (r.startsWith('AI:word_surgery') || r.includes('word_surgery')) return 'word_surgery';
  // AI pair（語意重複 / 重說對）
  if (r.startsWith('AI:') || r.startsWith('AI: ')) return 'ai_pair';
  // 規則引擎：Take 重複
  if (r.includes('重複Take') || r.includes('take_group')) return 'take_group';
  // 規則引擎：卡頓
  if (r.includes('卡頓')) return 'stutter';
  // 規則引擎：相鄰重複
  if (r.includes('相鄰重複') || r.includes('adjacent_repeat')) return 'adjacent_repeat';
  // 規則引擎：話語標記開頭
  if (r.includes('話語標記') || r.includes('discourse_opener')) return 'discourse_opener';
  // 其他規則
  if (r.includes('殘句')) return 'incomplete_sentence';
  if (r.includes('語氣詞')) return 'filler_word';
  if (r.includes('句內重複')) return 'intra_repeat';
  if (r.includes('重說') || r.includes('糾正')) return 'self_correction';
  if (r.includes('連續語氣')) return 'consecutive_filler';
  if (r.includes('語意重複') || r.includes('重複')) return 'repeated_sentence';
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

  // 過濾版指標：忽略 1-2 字文字碎片（LCS 跨句洩漏產生的雜訊）
  // 只計算 ≥3 字的文字詞 + 靜音
  accuracy_filtered: (() => {
    const isSignificant = (e) => e.isGap || (e.text && e.text !== '[靜音]' && e.text.length >= 3);
    const fTP = truePositives.filter(isSignificant).length;
    const fFP = falsePositives.filter(isSignificant).length;
    const fFN = falseNegatives.filter(isSignificant).length;
    const p = fTP / (fTP + fFP) || 0;
    const r = fTP / (fTP + fFN) || 0;
    return { precision: p, recall: r, f1: 2 * p * r / (p + r) || 0, tp: fTP, fp: fFP, fn: fFN };
  })(),

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
console.error(`📊 原始 F1: TP=${truePositives.length} FP=${falsePositives.length} FN=${falseNegatives.length} → F1=${(report.accuracy.f1 * 100).toFixed(1)}%`);
const af = report.accuracy_filtered;
console.error(`📊 過濾 F1: TP=${af.tp} FP=${af.fp} FN=${af.fn} → F1=${(af.f1 * 100).toFixed(1)}% (忽略 1-2 字碎片)`);
console.error(`🔇 靜音: 使用者保留最長 ${maxKeptSilence.toFixed(2)}s`);
