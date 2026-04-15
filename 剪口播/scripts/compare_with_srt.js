#!/usr/bin/env node
/**
 * SRT 對照分析：比對 AI 自動標記 vs 使用者手動剪輯的 SRT
 *
 * 演算法：
 * 1. 解析 SRT 文字（使用者保留的內容）
 * 2. 貪心前向匹配：SRT 文字是原始轉錄的子序列
 * 3. 產出 diff_report.json（與 review.html 的格式相容）
 *
 * 用法: node compare_with_srt.js <subtitles_words.json> <auto_selected.json> <user.srt>
 * 輸出: diff_report.json (stdout)
 */

const fs = require('fs');
const path = require('path');

const wordsFile = process.argv[2];
const autoSelectedFile = process.argv[3];
const srtFile = process.argv[4];

if (!wordsFile || !autoSelectedFile || !srtFile) {
  console.error('用法: node compare_with_srt.js <subtitles_words.json> <auto_selected.json> <user.srt>');
  process.exit(1);
}

// ── 解析 SRT ──
function parseSRT(content) {
  // 統一換行
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = content.split('\n\n').filter(b => b.trim());
  const cues = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    // lines[0] = sequence number
    // lines[1] = timestamp
    // lines[2+] = text
    const text = lines.slice(2).join('').trim();
    if (text) cues.push(text);
  }
  return cues;
}

// ── 讀取檔案 ──
const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));

const rawSelected = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
const autoSelected = new Set(Array.isArray(rawSelected) ? rawSelected : (rawSelected.indices || []));

// 讀取 auto_selected 的 reasons（如果有）
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

const srtContent = fs.readFileSync(srtFile, 'utf8');
const srtCues = parseSRT(srtContent);
const srtText = srtCues.join('');

console.error(`📄 SRT 字幕: ${srtCues.length} 條, ${srtText.length} 字`);
console.error(`📊 字幕元素: ${words.length} 個 (文字 ${words.filter(w => !w.isGap).length}, 靜音 ${words.filter(w => w.isGap).length})`);
console.error(`🤖 AI 標記: ${autoSelected.size} 個`);

// ── 貪心前向匹配：找出使用者保留了哪些字 ──
// SRT 文字是原始轉錄文字的子序列（使用者只刪不加）

const userKept = new Set();   // 使用者保留的 word idx
const userDeleted = new Set(); // 使用者刪除的 word idx

let srtPointer = 0;

// 先建立原始文字序列（只含非 gap 的字）
const textWords = [];
for (let i = 0; i < words.length; i++) {
  if (!words[i].isGap) {
    textWords.push({ idx: i, text: words[i].text });
  }
}

// 貪心匹配
for (const tw of textWords) {
  if (srtPointer < srtText.length && tw.text === srtText[srtPointer]) {
    userKept.add(tw.idx);
    srtPointer++;
  } else {
    userDeleted.add(tw.idx);
  }
}

// 靜音的處理：如果前後的文字都被刪除，靜音也算被刪除
for (let i = 0; i < words.length; i++) {
  if (!words[i].isGap) continue;

  // 找前一個非 gap
  let prevIdx = -1;
  for (let j = i - 1; j >= 0; j--) {
    if (!words[j].isGap) { prevIdx = j; break; }
  }
  // 找後一個非 gap
  let nextIdx = -1;
  for (let j = i + 1; j < words.length; j++) {
    if (!words[j].isGap) { nextIdx = j; break; }
  }

  const prevDeleted = prevIdx === -1 || userDeleted.has(prevIdx);
  const nextDeleted = nextIdx === -1 || userDeleted.has(nextIdx);

  if (prevDeleted && nextDeleted) {
    userDeleted.add(i);
  } else {
    userKept.add(i);
  }
}

const matchRate = (srtPointer / srtText.length * 100).toFixed(1);
console.error(`✅ 匹配率: ${matchRate}% (${srtPointer}/${srtText.length} 字)`);
console.error(`👤 使用者: 保留 ${userKept.size} / 刪除 ${userDeleted.size}`);

// ── 計算差異 ──
const falsePositives = []; // AI 標了但使用者保留（AI 過度刪除）
const falseNegatives = []; // AI 沒標但使用者刪了（AI 漏標）
const truePositives = [];  // AI 標了，使用者也刪了
const trueNegatives = [];  // AI 沒標，使用者也保留

for (let i = 0; i < words.length; i++) {
  const aiMarked = autoSelected.has(i);
  const userDel = userDeleted.has(i);
  const reason = autoReasons[i] || (words[i].isGap ? '靜音' : '');

  const entry = {
    idx: i,
    text: words[i].text || '[靜音]',
    start: words[i].start,
    end: words[i].end,
    isGap: words[i].isGap,
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

// ── 分類統計（按規則類別） ──
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
falseNegatives.forEach(e => addToCategory('unclassified', 'fn')); // FN 沒有 AI reason

// 對 FN 嘗試根據上下文分類
for (const entry of falseNegatives) {
  // 靜音
  if (entry.isGap) {
    addToCategory('silence', 'fn');
    continue;
  }
  // 其他：標為 unclassified（需要 AI 分析才能判斷）
  // 已在上面加過 unclassified
}

// ── 靜音閾值分析 ──
const silenceAnalysis = { kept: [], deleted: [] };
for (let i = 0; i < words.length; i++) {
  if (!words[i].isGap) continue;
  const dur = words[i].end - words[i].start;
  if (dur < 0.3) continue; // 忽略極短靜音
  if (userKept.has(i)) {
    silenceAnalysis.kept.push(dur);
  } else {
    silenceAnalysis.deleted.push(dur);
  }
}

// 找出使用者保留的最長靜音（作為閾值參考）
const maxKeptSilence = silenceAnalysis.kept.length > 0
  ? Math.max(...silenceAnalysis.kept)
  : 0;

// ── 輸出報告 ──
const report = {
  timestamp: new Date().toISOString(),
  source: 'srt_comparison',
  srtFile: path.basename(srtFile),
  matchRate: parseFloat(matchRate),

  // 與 review.html diff_report 相容
  aiCount: autoSelected.size,
  userCount: userDeleted.size,
  falsePositives: falsePositives,
  falseNegatives: falseNegatives,

  // 擴展統計
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
    // 靜音時長分佈（每 0.2s 一個 bucket）
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

// 輸出到 stdout
console.log(JSON.stringify(report, null, 2));

// 摘要到 stderr
console.error('---');
console.error(`📊 結果: TP=${truePositives.length} FP=${falsePositives.length} FN=${falseNegatives.length}`);
console.error(`   精確率: ${(report.accuracy.precision * 100).toFixed(1)}%`);
console.error(`   召回率: ${(report.accuracy.recall * 100).toFixed(1)}%`);
console.error(`   F1: ${(report.accuracy.f1 * 100).toFixed(1)}%`);
console.error(`🔇 靜音: 使用者保留最長 ${maxKeptSilence.toFixed(2)}s`);
