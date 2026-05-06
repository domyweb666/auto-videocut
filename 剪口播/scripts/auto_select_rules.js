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
const {
  charSet: _charSet,
  bigramSimilarity: _bigramSimilarity,
  longestCommonSubstring: _longestCommonSubstring,
  findGapRuns: _findGapRuns,
  loadTrainingConfig,
  loadProtectedWords,
} = require('./rule_utils');

const wordsFile = process.argv[2];
const outputFile = process.argv[3] || 'auto_selected.json';

if (!wordsFile) {
  console.error('用法: node auto_select_rules.js <subtitles_words.json> [output.json]');
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));

// ── 讀取 training_config.json（可被訓練自動更新） ──
const config = loadTrainingConfig(__dirname);

const SILENCE_THRESHOLD = config.silence?.threshold ?? 1.2;
const SENTENCE_GAP = config.silence?.sentence_gap ?? 0.5;
const REPEAT_PREFIX_LEN = config.repeat?.prefix_len ?? 5;
const REPEAT_MIN_SIM    = config.repeat?.min_similarity ?? 0.0; // 0 = no sim guard (backward compat)

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
// 規則 6b: 長片段立即重複（5+ 字、0 間隔、多副本只留最後）
const PHRASE_REPEAT_ENABLED = config.phrase_repeat?.enabled ?? true;
const PHRASE_REPEAT_MIN     = config.phrase_repeat?.min_len ?? 5;
const PHRASE_REPEAT_MAX     = config.phrase_repeat?.max_len ?? 20;

console.error(`📋 Config: silence≥${SILENCE_THRESHOLD}s, prefix=${REPEAT_PREFIX_LEN}, fillers=${FILLER_WORDS.length}`);

// 讀取連接詞保護清單
const PROTECTED_WORDS = loadProtectedWords(__dirname);

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

// ── 規則 1: 靜音 ≥ 閾值（合併連續 gap 後判斷） ──
// Whisper 會把長靜音拆成多個 1.0s gap，需要合併後計算真實時長
const SILENCE_CONTEXT_ENABLED = config.silence?.context_aware ?? true;
const SILENCE_CONTEXT_THRESHOLD = config.silence?.context_threshold ?? 0.3;
let silenceCount = 0;

// 合併連續 gap 並計算總時長（委派給 rule_utils）
const gapRuns = _findGapRuns(words);

for (const run of gapRuns) {
  if (run.duration >= SILENCE_THRESHOLD) {
    for (let i = run.startIdx; i <= run.endIdx; i++) {
      markSingle(i, `靜音 ${run.duration.toFixed(1)}s`);
    }
    silenceCount++;
  }
}

// ── 分句後的規則 ──
const sentences = buildSentences();

// ── 規則 2: 重複句（相鄰句子前 N 字相同）──
let repeatCount = 0;
for (let si = 0; si < sentences.length - 1; si++) {
  const curr = sentences[si];
  const next = sentences[si + 1];

  if (curr.text.length >= REPEAT_PREFIX_LEN &&
      next.text.length >= REPEAT_PREFIX_LEN &&
      curr.text.slice(0, REPEAT_PREFIX_LEN) === next.text.slice(0, REPEAT_PREFIX_LEN) &&
      _bigramSimilarity(curr.text, next.text) >= REPEAT_MIN_SIM) {
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

// ── 規則 5b: 口語贅詞（獨立刪除）──
// 「就是說」等多字口語贅詞，使用者系統性刪除
// 與 Rule 5 不同：不需要連續出現，單獨就可刪
const VERBAL_FILLERS = config.verbal_fillers ?? ['就是說'];
let verbalFillerCount = 0;
if (VERBAL_FILLERS.length > 0) {
  for (let i = 0; i < words.length; i++) {
    if (words[i].isGap || selected.has(i)) continue;
    if (VERBAL_FILLERS.includes(words[i].text)) {
      markSingle(i, '口語贅詞: "' + words[i].text + '"');
      verbalFillerCount++;
    }
  }
}

// ── 規則 6: 句內重複（A + 中間 + A）──
// 偵測口誤重說：「我覺得我覺得」→ 刪前面的「我覺得」
// 排除常見詞在句中自然出現兩次的情況（如「什麼該舍棄什麼該採用」）
let intraRepeatCount = 0;
const INTRA_COMMON_WORDS = new Set(config.intra_repeat?.common_skip || [
  '什麼', '這個', '那個', '就是', '一個', '不是', '可以', '因為',
  '所以', '但是', '而且', '還是', '如果', '然後', '已經', '或者',
  '需要', '沒有', '他們', '我們', '你們', '這些', '那些', '自己',
  '其實', '比較', '應該', '可能', '一樣', '知道', '覺得', '開始',
  '寫作', '文章', '作文', '讀者'
]);

for (const sent of sentences) {
  const text = sent.text;
  // 搜尋重複片段（長度和間隔從 config 讀取）
  for (let len = INTRA_MIN_LEN; len <= INTRA_MAX_LEN; len++) {
    for (let pos = 0; pos < text.length - len * 2; pos++) {
      const fragment = text.slice(pos, pos + len);
      // 跳過常見詞（在句中自然出現兩次不是口誤）
      if (INTRA_COMMON_WORDS.has(fragment)) continue;
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

// ── 規則 6b: 長片段立即逐字重複（≥5 字、0 間隔、多副本只留最後）──
// 來源：style_extraction.md 規則 1（False Start）+ 規則 2（立即逐字重複）
// 補 Rule 6 的盲區：Rule 6 max_len=4 抓不到「那在經過粗簡階段那在經過粗簡階段」這類長片段
// 演算法：每個位置貪婪找最長的「立即逐字重複」，計算連續副本數，刪前 (n-1) 個保留最後一個
let phraseRepeatCount = 0;
if (PHRASE_REPEAT_ENABLED) {
  for (const sent of sentences) {
    const text = sent.text;
    let p = 0;
    while (p < text.length) {
      // 找從 p 開始最長的立即逐字重複片段（從 MAX 往下試取最長）
      let bestLen = 0;
      const maxTry = Math.min(PHRASE_REPEAT_MAX, Math.floor((text.length - p) / 2));
      for (let len = maxTry; len >= PHRASE_REPEAT_MIN; len--) {
        if (text.slice(p, p + len) === text.slice(p + len, p + 2 * len)) {
          bestLen = len;
          break;
        }
      }
      if (bestLen === 0) { p++; continue; }

      // 計算連續副本數
      let copies = 2;
      while (p + (copies + 1) * bestLen <= text.length &&
             text.slice(p + copies * bestLen, p + (copies + 1) * bestLen) === text.slice(p, p + bestLen)) {
        copies++;
      }

      // 標記前 (copies-1) 個副本（保留最後一個完整版）
      const fragment = text.slice(p, p + bestLen);
      const endMarkPos = p + (copies - 1) * bestLen;
      let charCount = 0;
      for (const wi of sent.wordIndices) {
        const wordLen = words[wi].text.length;
        if (charCount >= p && charCount < endMarkPos) {
          markSingle(wi, `長片段重複: "${fragment}" × ${copies}`);
        }
        charCount += wordLen;
        if (charCount >= endMarkPos) break;
      }
      phraseRepeatCount++;
      p = p + copies * bestLen;  // 跳過所有已處理的副本
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

// ── 規則 8: 語意重複偵測（字元重疊相似度）──
// 不只比前綴，而是比整句的字元重疊率
// 使用者刪重複重說時，前綴不一定完全一樣（如「這個不一致語言的認知」vs「所謂不一致語言就是」）
let semanticRepeatCount = 0;

// 委派給 rule_utils（保持本地名稱以最小化變更）
const charSet = _charSet;
const bigramSimilarity = _bigramSimilarity;
const longestCommonSubstring = _longestCommonSubstring;

// 語意重複偵測閾值（可透過 config 調整）
const SEM_SIMILARITY_THRESHOLD = config.semantic_repeat?.similarity ?? 0.45;
const SEM_LCS_RATIO = config.semantic_repeat?.lcs_ratio ?? 0.4;
const SEM_MIN_SENTENCE_LEN = config.semantic_repeat?.min_len ?? 6;
const SEM_SEARCH_WINDOW = config.semantic_repeat?.window ?? 5; // 往後看幾句

for (let si = 0; si < sentences.length; si++) {
  const curr = sentences[si];
  if (curr.text.length < SEM_MIN_SENTENCE_LEN) continue;
  // 已被其他規則標記的跳過
  if (selected.has(curr.startIdx)) continue;

  // 搜尋後面 window 句內的語意重複
  for (let sj = si + 1; sj < Math.min(si + 1 + SEM_SEARCH_WINDOW, sentences.length); sj++) {
    const next = sentences[sj];
    if (next.text.length < SEM_MIN_SENTENCE_LEN) continue;

    // 已被前綴規則抓到的跳過
    if (curr.text.length >= REPEAT_PREFIX_LEN &&
        next.text.length >= REPEAT_PREFIX_LEN &&
        curr.text.slice(0, REPEAT_PREFIX_LEN) === next.text.slice(0, REPEAT_PREFIX_LEN)) continue;

    const sim = bigramSimilarity(curr.text, next.text);
    const lcsLen = longestCommonSubstring(curr.text, next.text);
    const lcsRatio = lcsLen / Math.min(curr.text.length, next.text.length);

    if (sim >= SEM_SIMILARITY_THRESHOLD && lcsRatio >= SEM_LCS_RATIO) {
      // 刪較短的（若等長刪前面的）
      const toDelete = curr.text.length <= next.text.length ? curr : next;
      markRange(toDelete.startIdx, toDelete.endIdx,
        `語意重複(${(sim * 100).toFixed(0)}%): "${toDelete.text.slice(0, 15)}..." ↔ "${(toDelete === curr ? next : curr).text.slice(0, 15)}..."`);
      // 標記被刪句與保留句之間的靜音
      const gapStart = Math.min(curr.endIdx, next.startIdx);
      const gapEnd = Math.max(curr.endIdx, next.startIdx);
      for (let i = gapStart; i <= gapEnd; i++) {
        if (words[i].isGap) selected.add(i);
      }
      semanticRepeatCount++;
      break; // 一句只匹配一次
    }
  }
}

// ── 規則 9: (已移除 - 靜音改為上下文感知，在所有規則之後統一處理) ──
let gapDensityCount = 0;

// ── 規則 10: 寬窗口全文重複偵測 ──
// 比 Rule 8 的窗口更大，用來抓距離較遠的重複 take
let wideRepeatCount = 0;
const WIDE_REPEAT_ENABLED = config.wide_repeat?.enabled ?? false;
const WIDE_REPEAT_MIN_LEN = config.wide_repeat?.min_len ?? 10;
const WIDE_REPEAT_SIM = config.wide_repeat?.similarity ?? 0.5;
const WIDE_REPEAT_WINDOW = config.wide_repeat?.window ?? 20;

if (WIDE_REPEAT_ENABLED) {
  for (let si = 0; si < sentences.length; si++) {
    const curr = sentences[si];
    if (curr.text.length < WIDE_REPEAT_MIN_LEN) continue;
    if (selected.has(curr.startIdx)) continue;

    for (let sj = si + 1; sj < Math.min(si + 1 + WIDE_REPEAT_WINDOW, sentences.length); sj++) {
      const next = sentences[sj];
      if (next.text.length < WIDE_REPEAT_MIN_LEN) continue;
      if (selected.has(next.startIdx)) continue;

      // 跳過已被 Rule 2 或 Rule 8 處理的
      if (curr.text.length >= REPEAT_PREFIX_LEN &&
          next.text.length >= REPEAT_PREFIX_LEN &&
          curr.text.slice(0, REPEAT_PREFIX_LEN) === next.text.slice(0, REPEAT_PREFIX_LEN)) continue;

      const sim = bigramSimilarity(curr.text, next.text);
      if (sim >= WIDE_REPEAT_SIM) {
        // 刪較短的（若等長刪前面的）
        const toDelete = curr.text.length <= next.text.length ? curr : next;
        if (!selected.has(toDelete.startIdx)) {
          markRange(toDelete.startIdx, toDelete.endIdx,
            `寬窗重複(${(sim * 100).toFixed(0)}%): "${toDelete.text.slice(0, 15)}..."`);
          // 標記被刪句與保留句之間的靜音
          const gapStart = Math.min(curr.endIdx, next.startIdx);
          const gapEnd = Math.max(curr.endIdx, next.startIdx);
          for (let gi = gapStart; gi <= gapEnd; gi++) {
            if (words[gi].isGap) selected.add(gi);
          }
          wideRepeatCount++;
          break;
        }
      }
    }
  }
}

// ── 規則 11: 咳嗽/雜音偵測 ──
let coughCount = 0;
const COUGH_ENABLED = config.cough_detection?.enabled ?? false;
const COUGH_WORDS = config.cough_detection?.words ?? ['咳', '咳咳', '咳咳咳', '嗯哼'];

if (COUGH_ENABLED) {
  for (let i = 0; i < words.length; i++) {
    if (words[i].isGap) continue;
    if (COUGH_WORDS.includes(words[i].text)) {
      markSingle(i, `咳嗽/雜音: "${words[i].text}"`);
      // 也標記相鄰的靜音
      if (i > 0 && words[i - 1].isGap) markSingle(i - 1, '咳嗽前靜音');
      if (i < words.length - 1 && words[i + 1].isGap) markSingle(i + 1, '咳嗽後靜音');
      coughCount++;
    }
  }
}

// ── 規則 14: 放棄句首偵測 ──
// 說了連接詞開頭但沒說完就重說的模式，如：
//   「那這樣就會...」[靜音] → 「那這個概念的意思是...」
//   「所以...」[靜音] → 「所以我們可以...」
// 短句（≤ N 字）以連接詞開頭 + 後面有靜音 → 標記為放棄的句首
let abandonedStartCount = 0;
const ABANDONED_ENABLED = config.abandoned_start?.enabled ?? true;
const ABANDONED_MAX_CHARS = config.abandoned_start?.max_chars ?? 8;
const ABANDONED_CONNECTORS = config.abandoned_start?.connectors || [
  '那', '那麼', '那個', '那這', '所以', '但是', '但', '然後', '而且', '可是',
  '就是說', '因為', '如果', '不過', '而'
];

if (ABANDONED_ENABLED) {
  for (let si = 0; si < sentences.length; si++) {
    const sent = sentences[si];
    if (sent.text.length > ABANDONED_MAX_CHARS) continue;
    if (sent.text.length < 2) continue;
    if (selected.has(sent.startIdx)) continue;

    // 檢查是否以連接詞開頭
    const startsWithConnector = ABANDONED_CONNECTORS.some(c => sent.text.startsWith(c));
    if (!startsWithConnector) continue;

    // 檢查後面是否有靜音 + 更長的句子
    if (si + 1 < sentences.length) {
      const next = sentences[si + 1];
      if (next.text.length > sent.text.length) {
        // 檢查兩句之間有靜音
        let hasGap = false;
        for (let i = sent.endIdx + 1; i < next.startIdx; i++) {
          if (words[i].isGap) { hasGap = true; break; }
        }
        if (hasGap) {
          markRange(sent.startIdx, sent.endIdx, `放棄句首: "${sent.text}"`);
          // 標記中間靜音
          for (let i = sent.endIdx + 1; i < next.startIdx; i++) {
            if (words[i].isGap) selected.add(i);
          }
          abandonedStartCount++;
        }
      }
    }
  }
}

// ── 規則 12: 短句兩側靜音刪除 ──
// 短句（<= N 字）如果被長靜音包圍，可能是多餘的口頭禪或試音
let shortSentenceCount = 0;
const SHORT_SENT_ENABLED = config.short_sentence?.enabled ?? false;
const SHORT_SENT_MAX_LEN = config.short_sentence?.max_len ?? 3;
const SHORT_SENT_MIN_GAP = config.short_sentence?.min_gap ?? 0.8;

if (SHORT_SENT_ENABLED) {
  for (const sent of sentences) {
    if (sent.text.length > SHORT_SENT_MAX_LEN) continue;
    if (selected.has(sent.startIdx)) continue;

    // 檢查前後是否有長靜音
    let prevGap = 0, nextGap = 0;
    for (let j = sent.startIdx - 1; j >= 0; j--) {
      if (words[j].isGap) { prevGap = words[j].end - words[j].start; break; }
      break;
    }
    for (let j = sent.endIdx + 1; j < words.length; j++) {
      if (words[j].isGap) { nextGap = words[j].end - words[j].start; break; }
      break;
    }

    if (prevGap >= SHORT_SENT_MIN_GAP && nextGap >= SHORT_SENT_MIN_GAP) {
      markRange(sent.startIdx, sent.endIdx, `短句刪除: "${sent.text}"`);
      shortSentenceCount++;
    }
  }
}

// ── 規則 13: Take 分組（保留最後一次） ──
// 將相似句子分組，只保留每組的最後一句（模擬使用者「重唸取最後」行為）
// 注意：使用直接鄰接鏈而非 Union-Find，避免傳遞性導致不相關句子被歸為同組
let takeGroupCount = 0;
const TAKE_GROUP_ENABLED = config.take_group?.enabled ?? true;
const TAKE_GROUP_SIM = config.take_group?.similarity ?? 0.55;
const TAKE_GROUP_WINDOW = config.take_group?.window ?? 10;
const TAKE_GROUP_MIN_LEN = config.take_group?.min_len ?? 6;
const TAKE_GROUP_MAX_SIZE = config.take_group?.max_size ?? 8;
const TAKE_PREFIX_LEN = config.take_group?.prefix_len ?? 5;

if (TAKE_GROUP_ENABLED) {
  // 使用鏈式分組：只有直接相似的相鄰句子才會被歸為同組
  // 避免 Union-Find 的傳遞性問題（A~B, B~C → A~C 但 A 和 C 可能完全不同）
  const groupId = new Array(sentences.length).fill(-1);
  let currentGroup = 0;

  for (let si = 0; si < sentences.length; si++) {
    if (sentences[si].text.length < TAKE_GROUP_MIN_LEN) continue;
    if (groupId[si] !== -1) continue; // 已分組

    // 從 si 開始，向後找直接相似的句子建立鏈
    const chain = [si];
    groupId[si] = currentGroup;

    for (let sj = si + 1; sj < Math.min(si + 1 + TAKE_GROUP_WINDOW, sentences.length); sj++) {
      if (sentences[sj].text.length < TAKE_GROUP_MIN_LEN) continue;
      if (chain.length >= TAKE_GROUP_MAX_SIZE) break;

      // 必須與鏈中最後一個成員相似（直接鏈接，非傳遞）
      const lastInChain = chain[chain.length - 1];
      const sim = bigramSimilarity(sentences[lastInChain].text, sentences[sj].text);
      const prefixMatch = sentences[lastInChain].text.length >= TAKE_PREFIX_LEN &&
                          sentences[sj].text.length >= TAKE_PREFIX_LEN &&
                          sentences[lastInChain].text.slice(0, TAKE_PREFIX_LEN) === sentences[sj].text.slice(0, TAKE_PREFIX_LEN);

      // prefix match no longer lowers threshold — common 5-char Chinese openers
      // (那所以我、那我覺得、然後就是) caused many false take-group pairings.
      // Use uniform threshold regardless of prefix match.
      const effectiveThreshold = TAKE_GROUP_SIM;
      if (sim >= effectiveThreshold) {
        chain.push(sj);
        groupId[sj] = currentGroup;
      }
    }

    // 只有 2+ 成員的鏈才處理
    if (chain.length >= 2) {
      const toKeep = chain[chain.length - 1];
      for (const si2 of chain) {
        if (si2 === toKeep) continue;
        if (selected.has(sentences[si2].startIdx)) continue;
        markRange(sentences[si2].startIdx, sentences[si2].endIdx,
          `重複Take(${chain.length}次): "${sentences[si2].text.slice(0, 15)}..." → 保留第${chain.length}次`);
        takeGroupCount++;
      }
    }

    currentGroup++;
  }
}

// ══════════════════════════════════════
// 最終: 上下文感知靜音標記（三級）
// 在所有內容規則之後，根據前後文狀態用不同閾值標記靜音
//   Level 1: 兩側內容都被刪 → 最寬鬆閾值（tier_between）
//   Level 2: 單側內容被刪   → 中等閾值（tier_adjacent）
//   Level 3: 獨立靜音       → 已由 Rule 1 處理（SILENCE_THRESHOLD）
// ══════════════════════════════════════
let contextSilenceCount = 0;
const TIER_BETWEEN = config.silence?.tier_between ?? 0.3;    // 兩側都被刪：0.3s 就刪
const TIER_ADJACENT = config.silence?.tier_adjacent ?? 0.8;  // 單側被刪：0.8s 就刪

if (SILENCE_CONTEXT_ENABLED) {
  for (let i = 0; i < words.length; i++) {
    if (!words[i].isGap) continue;
    if (selected.has(i)) continue;
    const dur = words[i].end - words[i].start;

    // 找前後最近的非 gap 元素
    let prevTextIdx = -1, nextTextIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (!words[j].isGap) { prevTextIdx = j; break; }
    }
    for (let j = i + 1; j < words.length; j++) {
      if (!words[j].isGap) { nextTextIdx = j; break; }
    }

    const prevDeleted = prevTextIdx === -1 || selected.has(prevTextIdx);
    const nextDeleted = nextTextIdx === -1 || selected.has(nextTextIdx);

    // Level 1: 兩側都被刪 → 最低閾值
    if (prevDeleted && nextDeleted && dur >= TIER_BETWEEN) {
      markSingle(i, `上下文靜音(兩側刪) ${dur.toFixed(1)}s`);
      contextSilenceCount++;
    }
    // Level 2: 單側被刪 → 中等閾值
    else if ((prevDeleted || nextDeleted) && dur >= TIER_ADJACENT) {
      markSingle(i, `上下文靜音(鄰刪) ${dur.toFixed(1)}s`);
      contextSilenceCount++;
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
console.error(`   靜音(上下文): ${contextSilenceCount}`);
console.error(`   重複句: ${repeatCount}`);
console.error(`   隔句重複: ${skipRepeatCount}`);
console.error(`   卡頓詞: ${stutterCount}`);
console.error(`   連續語氣詞: ${fillerCount}`);
console.error(`   口語贅詞: ${verbalFillerCount}`);
console.error(`   句內重複: ${intraRepeatCount}`);
if (PHRASE_REPEAT_ENABLED) console.error(`   長片段重複: ${phraseRepeatCount}`);
console.error(`   殘句: ${incompleteCount}`);
console.error(`   語意重複: ${semanticRepeatCount}`);
console.error(`   Take分組: ${takeGroupCount}`);
if (WIDE_REPEAT_ENABLED) console.error(`   寬窗重複: ${wideRepeatCount}`);
if (COUGH_ENABLED) console.error(`   咳嗽/雜音: ${coughCount}`);
if (SHORT_SENT_ENABLED) console.error(`   短句刪除: ${shortSentenceCount}`);
console.error(`   總計: ${indices.length} 個元素`);
console.error(`✅ 已保存: ${outputFile}`);
