#!/usr/bin/env node
/**
 * 純規則自動標記（不需要 AI，用於批量訓練）
 *
 * 實現 SKILL.md 步驟 4.4-4.5 的確定性規則：
 * 1. 靜音 ≥ 閾值
 * 2. 重複句（相鄰句子前 5 字相同）
 * 3. 隔一句重複（中間是殘句）
 * 4. 卡頓詞（那個那個、就是就是）
 * 5. 連續語氣詞
 * 6. 句內重複（A+中間+A）
 * 7. 殘句偵測（話說一半 + 靜音 + 重說）
 * 8. 連接詞保護
 *
 * 用法: node auto_select_rules.js <subtitles_words.json> [output.json]
 * 輸出: auto_selected.json (帶 reasons 格式)
 */

const fs = require('fs');
const path = require('path');

const wordsFile = process.argv[2];
const outputFile = process.argv[3] || 'auto_selected.json';

if (!wordsFile) {
  console.error('用法: node auto_select_rules.js <subtitles_words.json> [output.json]');
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));

// ── 讀取 training_config.json（可被訓練自動更新） ──
const configPath = path.join(__dirname, '..', 'training_config.json');
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : {};

const SILENCE_THRESHOLD = config.silence?.threshold ?? 1.0;
const SENTENCE_GAP = config.silence?.sentence_gap ?? 0.5;
const REPEAT_PREFIX_LEN = config.repeat?.prefix_len ?? 5;

const FILLER_WORDS = config.filler_words ??
  ['嗯', '啊', '哎', '诶', '呃', '額', '唉', '哦', '噢', '呀', '欸'];
const FILLER_EXCEPTIONS = config.filler_exceptions ?? [];

const STUTTER_PATTERNS = config.stutter_patterns ??
  ['那個那個', '就是就是', '然後然後', '這個這個', '所以所以',
   '那个那个', '就是就是', '然后然后', '这个这个', '所以所以'];

const INCOMPLETE_MAX_CHARS = config.incomplete_sentence?.max_chars ?? 10;
const INCOMPLETE_MIN_OVERLAP = config.incomplete_sentence?.min_overlap ?? 2;
const INTRA_MIN_LEN = config.intra_repeat?.min_len ?? 2;
const INTRA_MAX_LEN = config.intra_repeat?.max_len ?? 4;
const INTRA_MAX_GAP = config.intra_repeat?.max_gap ?? 4;

console.error(`📋 Config: silence≥${SILENCE_THRESHOLD}s, prefix=${REPEAT_PREFIX_LEN}, fillers=${FILLER_WORDS.length}`);

// 讀取連接詞保護清單
const PROTECTED_WORDS = [];
const connFile = path.join(__dirname, '..', '用户习惯', '10-保留連接詞.md');
if (fs.existsSync(connFile)) {
  const content = fs.readFileSync(connFile, 'utf8');
  const match = content.match(/```\r?\n([\s\S]*?)```/);
  if (match) {
    match[1].split(/[、，\r?\n]/).forEach(w => {
      const trimmed = w.trim().replace(/\r$/, '');
      if (trimmed) PROTECTED_WORDS.push(trimmed);
    });
  }
}

// ── 分句 ──
function buildSentences() {
  const sentences = [];
  let curr = { text: '', startIdx: -1, endIdx: -1, wordIndices: [] };

  words.forEach((w, i) => {
    const isLongGap = w.isGap && (w.end - w.start) >= SENTENCE_GAP;
    if (isLongGap) {
      if (curr.text.length > 0) sentences.push({ ...curr });
      curr = { text: '', startIdx: -1, endIdx: -1, wordIndices: [] };
    } else if (!w.isGap) {
      if (curr.startIdx === -1) curr.startIdx = i;
      curr.text += w.text;
      curr.endIdx = i;
      curr.wordIndices.push(i);
    }
  });
  if (curr.text.length > 0) sentences.push(curr);
  return sentences;
}

// ── 標記結果 ──
const selected = new Set();
const reasons = {}; // "startIdx-endIdx" or "idx" → reason string

function markRange(startIdx, endIdx, reason) {
  for (let i = startIdx; i <= endIdx; i++) {
    // 保護連接詞
    if (!words[i].isGap && isProtected(i)) continue;
    selected.add(i);
  }
  reasons[`${startIdx}-${endIdx}`] = reason;
}

function markSingle(idx, reason) {
  if (!words[idx].isGap && isProtected(idx)) return;
  selected.add(idx);
  reasons[`${idx}`] = reason;
}

function isProtected(idx) {
  if (words[idx].isGap) return false;
  const text = words[idx].text;
  // 單字保護
  for (const pw of PROTECTED_WORDS) {
    if (pw.length === 1 && text === pw) return true;
  }
  // 多字保護：檢查從此 idx 開始的連續文字是否構成保護詞
  let combined = '';
  for (let j = idx; j < Math.min(idx + 10, words.length); j++) {
    if (words[j].isGap) continue;
    combined += words[j].text;
    for (const pw of PROTECTED_WORDS) {
      if (combined === pw) return true;
    }
    if (combined.length > 10) break;
  }
  return false;
}

// ── 規則 1: 靜音 ≥ 閾值 ──
let silenceCount = 0;
words.forEach((w, i) => {
  if (w.isGap && (w.end - w.start) >= SILENCE_THRESHOLD) {
    markSingle(i, `靜音 ${(w.end - w.start).toFixed(1)}s`);
    silenceCount++;
  }
});

// ── 分句後的規則 ──
const sentences = buildSentences();

// ── 規則 2: 重複句（相鄰句子前 N 字相同）──
let repeatCount = 0;
for (let si = 0; si < sentences.length - 1; si++) {
  const curr = sentences[si];
  const next = sentences[si + 1];

  if (curr.text.length >= REPEAT_PREFIX_LEN &&
      next.text.length >= REPEAT_PREFIX_LEN &&
      curr.text.slice(0, REPEAT_PREFIX_LEN) === next.text.slice(0, REPEAT_PREFIX_LEN)) {
    // 刪較短的整句
    const shorter = curr.text.length <= next.text.length ? curr : next;
    markRange(shorter.startIdx, shorter.endIdx, `重複句: "${shorter.text.slice(0, 15)}..."`);
    // 也標記兩句之間的靜音
    const between = { start: Math.min(curr.endIdx, next.startIdx), end: Math.max(curr.endIdx, next.startIdx) };
    for (let i = between.start; i <= between.end; i++) {
      if (words[i].isGap) selected.add(i);
    }
    repeatCount++;
  }
}

// ── 規則 3: 隔一句重複（中間是殘句）──
let skipRepeatCount = 0;
for (let si = 0; si < sentences.length - 2; si++) {
  const curr = sentences[si];
  const mid = sentences[si + 1];
  const next = sentences[si + 2];

  if (mid.text.length <= 5 &&
      curr.text.length >= REPEAT_PREFIX_LEN &&
      next.text.length >= REPEAT_PREFIX_LEN &&
      curr.text.slice(0, REPEAT_PREFIX_LEN) === next.text.slice(0, REPEAT_PREFIX_LEN)) {
    // 刪前句 + 殘句
    markRange(curr.startIdx, curr.endIdx, `隔句重複: "${curr.text.slice(0, 15)}..."`);
    markRange(mid.startIdx, mid.endIdx, `隔句殘句: "${mid.text}"`);
    // 標記中間的靜音
    for (let i = curr.endIdx; i <= next.startIdx; i++) {
      if (words[i].isGap) selected.add(i);
    }
    skipRepeatCount++;
  }
}

// ── 規則 4: 卡頓詞 ──
let stutterCount = 0;
for (const sent of sentences) {
  for (const pattern of STUTTER_PATTERNS) {
    const halfLen = pattern.length / 2;
    const idx = sent.text.indexOf(pattern);
    if (idx !== -1) {
      // 找到卡頓位置，標記前半部分
      let charCount = 0;
      for (const wi of sent.wordIndices) {
        if (charCount >= idx && charCount < idx + halfLen) {
          markSingle(wi, `卡頓詞: "${pattern}"`);
        }
        charCount += words[wi].text.length;
        if (charCount >= idx + halfLen) break;
      }
      stutterCount++;
    }
  }
}

// ── 規則 5: 連續語氣詞 ──
let fillerCount = 0;
for (let i = 0; i < words.length - 1; i++) {
  if (words[i].isGap || words[i + 1].isGap) continue;

  const isFiller1 = FILLER_WORDS.includes(words[i].text) && !FILLER_EXCEPTIONS.includes(words[i].text);
  const isFiller2 = FILLER_WORDS.includes(words[i + 1].text) && !FILLER_EXCEPTIONS.includes(words[i + 1].text);

  if (isFiller1 && isFiller2) {
    markSingle(i, '連續語氣詞');
    markSingle(i + 1, '連續語氣詞');
    fillerCount++;
  }
}

// ── 規則 6: 句內重複（A + 中間 + A）──
let intraRepeatCount = 0;
for (const sent of sentences) {
  const text = sent.text;
  // 搜尋重複片段（長度和間隔從 config 讀取）
  for (let len = INTRA_MIN_LEN; len <= INTRA_MAX_LEN; len++) {
    for (let pos = 0; pos < text.length - len * 2; pos++) {
      const fragment = text.slice(pos, pos + len);
      const searchStart = pos + len;
      const searchEnd = Math.min(pos + len + INTRA_MAX_GAP, text.length - len);
      for (let pos2 = searchStart; pos2 <= searchEnd; pos2++) {
        if (text.slice(pos2, pos2 + len) === fragment) {
          // 找到 A+中間+A，標記前面的 A+中間
          let charCount = 0;
          for (const wi of sent.wordIndices) {
            if (charCount >= pos && charCount < pos2) {
              markSingle(wi, `句內重複: "${fragment}"`);
            }
            charCount += words[wi].text.length;
            if (charCount >= pos2) break;
          }
          intraRepeatCount++;
          break; // 只處理第一個匹配
        }
      }
    }
  }
}

// ── 規則 7: 殘句偵測 ──
let incompleteCount = 0;
for (let si = 0; si < sentences.length - 1; si++) {
  const curr = sentences[si];
  const next = sentences[si + 1];

  // 殘句特徵：短句 + 後有更長的句子 + 後句開頭與前句有重疊
  if (curr.text.length < INCOMPLETE_MAX_CHARS && next.text.length > curr.text.length) {
    // 檢查是否有重疊（前句是後句的前綴）
    const overlapLen = Math.min(curr.text.length, 3);
    if (overlapLen >= INCOMPLETE_MIN_OVERLAP && next.text.startsWith(curr.text.slice(0, overlapLen))) {
      markRange(curr.startIdx, curr.endIdx, `殘句: "${curr.text}"`);
      // 標記中間靜音
      for (let i = curr.endIdx + 1; i < next.startIdx; i++) {
        if (words[i].isGap) selected.add(i);
      }
      incompleteCount++;
    }
  }
}

// ── 輸出 ──
const indices = [...selected].sort((a, b) => a - b);

const output = {
  indices,
  reasons
};

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

console.error(`📊 自動標記結果:`);
console.error(`   靜音 ≥${SILENCE_THRESHOLD}s: ${silenceCount}`);
console.error(`   重複句: ${repeatCount}`);
console.error(`   隔句重複: ${skipRepeatCount}`);
console.error(`   卡頓詞: ${stutterCount}`);
console.error(`   連續語氣詞: ${fillerCount}`);
console.error(`   句內重複: ${intraRepeatCount}`);
console.error(`   殘句: ${incompleteCount}`);
console.error(`   總計: ${indices.length} 個元素`);
console.error(`✅ 已保存: ${outputFile}`);
