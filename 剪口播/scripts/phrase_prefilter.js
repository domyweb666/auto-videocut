#!/usr/bin/env node
/**
 * phrase_prefilter.js — Phrase 層級規則前置過濾 + 候選重複對抽取
 *
 * 輸入：polished.json（ai_polish.js 的輸出，phrase 陣列）
 * 輸出：cut_input.json {
 *   phrases,          // 完整 phrase 陣列（不動原始內容）
 *   ruleDeletions,    // 規則引擎確定刪除的 phrase（高 precision）
 *   gapDeletions,     // 長靜音標記（gapAfter > threshold）
 *   candidatePairs,   // 待 AI 判斷的語意重複候選對
 *   config,           // 本次使用的參數（供 debug 與策略師參考）
 * }
 *
 * 用法：
 *   node phrase_prefilter.js <polished.json> <cut_input.json>
 *     [--similarity 0.30]   bigram 相似度門檻（預設 0.30）
 *     [--lcs-ratio 0.35]    LCS 比例門檻（預設 0.35）
 *     [--window 60]         候選對搜索窗口（預設 60 句）
 *     [--max-pairs 200]     每支影片候選對上限（預設 200）
 *     [--silence 1.2]       長靜音閾值（秒，預設 1.2）
 *     [--take-sim 0.55]     Take grouping bigram 門檻（預設 0.55）
 *     [--min-text-len 4]    最短文字長度才列入候選（預設 4 字）
 */

const fs   = require('fs');
const path = require('path');
const {
  bigramSimilarity,
  lcsRatio: computeLcsRatio,
  loadTrainingConfig,
  loadProtectedWords,
} = require('./rule_utils');

// ── 解析 CLI 參數 ──
const argv = process.argv.slice(2);
const inputFile  = argv[0];
const outputFile = argv[1];

if (!inputFile || !outputFile) {
  console.error('用法: node phrase_prefilter.js <polished.json> <cut_input.json> [options]');
  process.exit(1);
}

const cliArgs = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    cliArgs[key] = val;
  }
}

const trainConfig = loadTrainingConfig(__dirname);
const PROTECTED_WORDS = loadProtectedWords(__dirname);

// 參數（CLI > training_config.json > 預設值）
const SILENCE_THRESHOLD = parseFloat(cliArgs['silence'] ?? trainConfig.silence?.threshold ?? 1.85);
const TAKE_SIM          = parseFloat(cliArgs['take-sim'] ?? trainConfig.take_group?.similarity ?? 0.55);
const TAKE_WINDOW       = parseInt(cliArgs['take-window'] ?? trainConfig.take_group?.window ?? 10, 10);
const TAKE_MIN_LEN      = parseInt(cliArgs['take-min-len'] ?? trainConfig.take_group?.min_len ?? 6, 10);
const TAKE_MAX_SIZE     = parseInt(cliArgs['take-max-size'] ?? trainConfig.take_group?.max_size ?? 8, 10);
const TAKE_PREFIX_LEN   = parseInt(cliArgs['take-prefix-len'] ?? trainConfig.take_group?.prefix_len ?? 5, 10);
const REPEAT_PREFIX_LEN = parseInt(cliArgs['repeat-prefix'] ?? trainConfig.repeat?.prefix_len ?? 5, 10);
const STUTTER_PATTERNS  = trainConfig.stutter_patterns ?? [
  '那個那個', '就是就是', '然後然後', '這個這個', '所以所以',
  '那个那个', '然后然后', '这个这个',
];

// 候選對參數
// 2026-05-07：放鬆閾值（0.30→0.27、0.35→0.30），讓更多重複候選對進到 AI 判決
const PAIR_SIM_THRESHOLD = parseFloat(cliArgs['similarity'] ?? trainConfig.candidate_pair?.similarity ?? 0.27);
const PAIR_LCS_THRESHOLD = parseFloat(cliArgs['lcs-ratio']  ?? trainConfig.candidate_pair?.lcs_ratio  ?? 0.30);
const PAIR_WINDOW        = parseInt(cliArgs['window']        ?? trainConfig.candidate_pair?.window     ?? 60, 10);
const PAIR_MAX           = parseInt(cliArgs['max-pairs']     ?? trainConfig.candidate_pair?.max_pairs  ?? 200, 10);
const MIN_TEXT_LEN       = parseInt(cliArgs['min-text-len']  ?? trainConfig.candidate_pair?.min_text_len ?? 4, 10);

// ── 實驗 A：載入 outline（--outline-file）──
let outline = null;  // { units, phraseUnit }
const OUTLINE_FILE = cliArgs['outline-file'];
if (OUTLINE_FILE && fs.existsSync(OUTLINE_FILE)) {
  try {
    outline = JSON.parse(fs.readFileSync(OUTLINE_FILE, 'utf8'));
    log(`Outline 載入：${outline.units?.length ?? 0} 個 thought-units`);
  } catch (e) {
    log(`⚠️ outline 載入失敗: ${e.message}`);
    outline = null;
  }
}

// ── 實驗 C：載入 subtitles_words.json（--words-file）──
let wordsData = null;
const WORDS_FILE = cliArgs['words-file'];
if (WORDS_FILE && fs.existsSync(WORDS_FILE)) {
  try {
    wordsData = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8'));
    log(`Words 載入：${wordsData.length} 個 tokens`);
  } catch (e) {
    log(`⚠️ words 載入失敗: ${e.message}`);
    wordsData = null;
  }
}

// 音訊特徵計算（Experiment C）
function computeAudioFeatures(phrase, words) {
  if (!words || !Array.isArray(phrase.wordIndices) || phrase.wordIndices.length < 2) return null;
  const duration = (phrase.endTime || 0) - (phrase.startTime || 0);
  if (duration <= 0) return null;

  const pwList = phrase.wordIndices.map(i => words[i]).filter(w => w && !w.isGap);
  if (pwList.length < 2) return null;

  const charCount = pwList.reduce((s, w) => s + (w.text || '').length, 0);
  const speakingRate = Math.round(charCount / duration * 10) / 10;  // 字/秒

  // 詞間停頓率
  let pauseTime = 0;
  for (let i = 1; i < pwList.length; i++) {
    const gap = pwList[i].start - pwList[i - 1].end;
    if (gap > 0.05) pauseTime += gap;
  }
  const pauseRatio = Math.round(pauseTime / duration * 100);  // 0–100%

  return { speakingRate, pauseRatio };
}

// 取得 thought-unit 資訊
function getThoughtUnit(phraseIdx) {
  if (!outline) return null;
  const unitId = outline.phraseUnit?.[phraseIdx];
  if (unitId == null) return null;
  const unit = outline.units?.find(u => u.id === unitId);
  if (!unit) return null;
  return { id: unit.id, topic: unit.topic, importance: unit.importance };
}

// 實驗 B：take 品質分數（文字長度 + 語速合理性作為代理）
function takePhraseScore(phraseIdx) {
  const p = phrases[phraseIdx];
  if (!p) return 0;
  const textLen = getText(p).length;
  const duration = (p.endTime || 0) - (p.startTime || 0);
  // 語速正常（2–8字/秒）的 take 加分
  const charRate = duration > 0 ? textLen / duration : 0;
  const rateBonus = (charRate >= 2 && charRate <= 8) ? 3 : 0;
  return textLen + rateBonus;
}

function log(msg) { process.stderr.write(`[prefilter] ${msg}\n`); }

// ── 主程式 ──
const phrases = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

const ruleDeletions = [];   // { phraseIdx, rule, reason }
const gapDeletions  = [];   // { phraseIdx, gapAfter, reason }
const deletedSet    = new Set(); // phrase index 集合，用於後續排除

// helper：phrase 的文字（使用 displayText，fallback text）
function getText(p) { return (p.displayText || p.text || '').replace(/[，。！？、：；,.!?:;]/g, '').trim(); }
function getDisplay(p) { return (p.displayText || p.text || '').trim(); }

// ── 規則 A：長靜音標記（gapAfter > threshold）──
let gapCount = 0;
for (let i = 0; i < phrases.length; i++) {
  const p = phrases[i];
  if (typeof p.gapAfter === 'number' && p.gapAfter >= SILENCE_THRESHOLD) {
    gapDeletions.push({ phraseIdx: i, gapAfter: p.gapAfter, reason: `靜音 ${p.gapAfter.toFixed(1)}s` });
    gapCount++;
  }
}
log(`規則 A 靜音: ${gapCount} 個 gapDeletion`);

// ── 規則 A2：Whisper 幻覺片語（subtitles_words.json 已標 _hallucination 的 word）──
// 對策：phrase 內任一個非 gap 字被標記為 _hallucination，整個 phrase 列為必刪
let hallCount = 0;
if (wordsData) {
  for (let i = 0; i < phrases.length; i++) {
    if (deletedSet.has(i)) continue;
    const p = phrases[i];
    const wIdx = p.wordIndices || [];
    const hit = wIdx.some(idx => wordsData[idx] && wordsData[idx]._hallucination);
    if (hit) {
      ruleDeletions.push({ phraseIdx: i, rule: 'whisper_hallucination', reason: 'Whisper 幻覺（中國頻道結尾語）' });
      deletedSet.add(i);
      hallCount++;
    }
  }
}
log(`規則 A2 Whisper 幻覺: ${hallCount} 個`);

// ── 規則 B：相鄰前 N 字相同（兩個短 phrase，預設刪前面那個）──
// 2026-05-07：講者重錄習慣是「一句話講 2-3 次，最後一次最完整」。
// 即使後面那次比前面短，也代表是更新的版本——一律刪前面，保留後面。
let adjRepeatCount = 0;
for (let i = 0; i < phrases.length - 1; i++) {
  if (deletedSet.has(i)) continue;
  const a = getText(phrases[i]);
  const b = getText(phrases[i + 1]);
  if (a.length < REPEAT_PREFIX_LEN || b.length < REPEAT_PREFIX_LEN) continue;
  if (a.slice(0, REPEAT_PREFIX_LEN) === b.slice(0, REPEAT_PREFIX_LEN)) {
    const delIdx = i; // 留後刪前
    const reason = `相鄰重複: 前${REPEAT_PREFIX_LEN}字「${a.slice(0, REPEAT_PREFIX_LEN)}」相同（留後刪前）`;
    ruleDeletions.push({ phraseIdx: delIdx, rule: 'adjacent_repeat', reason });
    deletedSet.add(delIdx);
    adjRepeatCount++;
  }
}
log(`規則 B 相鄰重複: ${adjRepeatCount} 個`);

// ── 規則 C：Stutter 偵測（displayText 內含「XYZXYZ」型重複模式）──
let stutterCount = 0;
for (let i = 0; i < phrases.length; i++) {
  if (deletedSet.has(i)) continue;
  const disp = getDisplay(phrases[i]);
  for (const pat of STUTTER_PATTERNS) {
    if (disp.includes(pat)) {
      // 整個 phrase 通常就是 stutter，標記整句
      ruleDeletions.push({ phraseIdx: i, rule: 'stutter', reason: `卡頓詞: 「${pat}」` });
      deletedSet.add(i);
      stutterCount++;
      break;
    }
  }
}
log(`規則 C Stutter: ${stutterCount} 個`);

// ── 規則 G：Intra-phrase 字元級重複（NG 重錄沒切乾淨的整段重複）──
// 偵測 phrase.text 內 prefix ≥6 字的立即重複（A A ...），刪除第 2 次起的出現
// 以 word-level 刪除（phrase.wordDeleteIdx），不整句刪
const INTRA_MIN_PREFIX = trainConfig.intra_phrase_repeat?.min_prefix ?? 6;
let intraRepeatCount = 0;
let intraRepeatWords = 0;
for (let i = 0; i < phrases.length; i++) {
  if (deletedSet.has(i)) continue;  // 整句已被刪，跳過
  const ph = phrases[i];
  const text = (ph.text || '').trim();
  const n = text.length;
  if (n < INTRA_MIN_PREFIX * 2) continue;

  // 嘗試最長到 n/2 的 prefix，逐步縮短找立即重複
  let hit = null;
  for (let len = Math.floor(n / 2); len >= INTRA_MIN_PREFIX; len--) {
    const prefix = text.slice(0, len);
    if (text.slice(len, len + len) === prefix) {
      hit = { prefix, prefixLen: len, deleteStart: len, deleteEnd: len + len };
      break;
    }
  }
  if (!hit) continue;

  // 把字元範圍 [deleteStart, deleteEnd) 映射到 wordIndices 的 local 位置
  const wis = ph.wordIndices || [];
  if (wis.length === 0 || !wordsData) continue;
  let cumLen = 0;
  const localIdxToDelete = [];
  let mappingOk = true;
  for (let k = 0; k < wis.length; k++) {
    const w = wordsData[wis[k]];
    if (!w) { mappingOk = false; break; }
    const wText = (w.text || '');
    const wordStart = cumLen;
    const wordEnd = cumLen + wText.length;
    // 只有完全落在 [deleteStart, deleteEnd) 的 word 才加入刪除
    if (wordStart >= hit.deleteStart && wordEnd <= hit.deleteEnd) {
      localIdxToDelete.push(k);
    }
    cumLen += wText.length;
  }
  // 健全性檢查：text 長度應該等於 word 文字串接長度
  if (!mappingOk || cumLen !== n) continue;
  if (localIdxToDelete.length === 0) continue;

  ph.wordDeleteIdx = localIdxToDelete;
  ph.wordDeleteReason = `intra_phrase_repeat: 「${hit.prefix.slice(0, 10)}${hit.prefix.length > 10 ? '...' : ''}」重複 2 次，刪後半段`;
  intraRepeatCount++;
  intraRepeatWords += localIdxToDelete.length;
}
log(`規則 G Intra-phrase 重複: ${intraRepeatCount} 個 phrase / ${intraRepeatWords} 個 word`);

// ── 規則 D：Take grouping（鏈式相似，保留最後）──
let takeCount = 0;
{
  const groupId = new Array(phrases.length).fill(-1);
  let gid = 0;
  for (let i = 0; i < phrases.length; i++) {
    const a = getText(phrases[i]);
    if (a.length < TAKE_MIN_LEN) continue;
    if (deletedSet.has(i)) continue;
    if (groupId[i] !== -1) continue;

    const chain = [i];
    groupId[i] = gid;

    for (let j = i + 1; j < Math.min(i + 1 + TAKE_WINDOW, phrases.length); j++) {
      if (chain.length >= TAKE_MAX_SIZE) break;
      if (deletedSet.has(j)) continue;
      const b = getText(phrases[j]);
      if (b.length < TAKE_MIN_LEN) continue;

      const last = chain[chain.length - 1];
      const lastText = getText(phrases[last]);
      const sim = bigramSimilarity(lastText, b);
      const prefixMatch = lastText.length >= TAKE_PREFIX_LEN &&
                          b.length >= TAKE_PREFIX_LEN &&
                          lastText.slice(0, TAKE_PREFIX_LEN) === b.slice(0, TAKE_PREFIX_LEN);
      const threshold = prefixMatch ? Math.max(TAKE_SIM - 0.15, 0.35) : TAKE_SIM;

      if (sim >= threshold) {
        chain.push(j);
        groupId[j] = gid;
      }
    }

    if (chain.length >= 2) {
      // 2026-05-07：使用者明確意圖「留後刪前」。
      // 計算鏈內首尾相似度，若 ≥ 0.6 → 無條件保留最後（即使前面文字較長）；
      // 否則退回品質分數策略（避免誤殺風格不同的相似句）。
      const firstText = getText(phrases[chain[0]]);
      const lastText  = getText(phrases[chain[chain.length - 1]]);
      const headTailSim = bigramSimilarity(firstText, lastText);

      let keep;
      if (headTailSim >= 0.6) {
        keep = chain[chain.length - 1];
      } else {
        const scored = chain.map(ci => ({ idx: ci, score: takePhraseScore(ci) }));
        scored.sort((a, b) => b.score !== a.score ? b.score - a.score : b.idx - a.idx);
        keep = scored[0].idx;
      }

      const keepIsLast = keep === chain[chain.length - 1];
      for (const ci of chain) {
        if (ci === keep) continue;
        if (deletedSet.has(ci)) continue;
        const keepNote = keepIsLast ? '保留最後' : `保留品質最佳(idx=${keep})`;
        ruleDeletions.push({
          phraseIdx: ci,
          rule: 'take_group',
          reason: `重複Take(${chain.length}次): 「${getText(phrases[ci]).slice(0, 15)}...」→ ${keepNote}`,
        });
        deletedSet.add(ci);
        takeCount++;
      }
    }
    gid++;
  }
}
log(`規則 D Take grouping: ${takeCount} 個`);

// ── 規則 F：話語標記開頭（discourse-marker opener）──
// 若 phrase 以話語標記字開頭、且 phrase 本身很短（無標點字數 ≤ DISCOURSE_MAX_LEN）→ 整句刪。
// 較長的 phrase 不在此處理，交給下游 word-surgery 決策。
// 優先級低於保留連接詞（PROTECTED_WORDS 為前綴者一律跳過）。
// 首句 (startTime < 3s) 通常是真正招呼，不刪。
const DISCOURSE_OPENERS = trainConfig.discourse_openers ?? [
  // 非語言雜音（最高信心，無爭議）
  '咳', '嗝', '嗯', '呃',
  // 純招呼/嘆詞（不會出現在論點句）
  '嗨', '哈囉', '欸', '喔', '唉',
];
const DISCOURSE_MAX_LEN = parseInt(cliArgs['discourse-max-len'] ?? trainConfig.discourse?.max_len ?? 6, 10);
const DISCOURSE_FIRST_GRACE = parseFloat(cliArgs['discourse-first-grace'] ?? trainConfig.discourse?.first_grace ?? 3);
let discourseCount = 0;
for (let i = 0; i < phrases.length; i++) {
  if (deletedSet.has(i)) continue;
  const text = getText(phrases[i]);
  if (text.length === 0 || text.length > DISCOURSE_MAX_LEN) continue;
  if ((phrases[i].startTime ?? 0) < DISCOURSE_FIRST_GRACE) continue;

  // 保留連接詞優先
  if (PROTECTED_WORDS.some(w => w && text.startsWith(w))) continue;

  const matched = DISCOURSE_OPENERS.find(w => w && text.startsWith(w));
  if (!matched) continue;

  ruleDeletions.push({
    phraseIdx: i,
    rule: 'discourse_opener',
    reason: `話語標記開頭: 「${matched}...」(${text.length}字短句)`,
  });
  deletedSet.add(i);
  discourseCount++;
}
log(`規則 F 話語標記: ${discourseCount} 個`);

// ── 候選對抽取 ──
// 在 rule 未觸發的 phrase 之間找語意相似對，給 AI 判斷
const candidatePairs = [];
let pairId = 1;

for (let i = 0; i < phrases.length; i++) {
  if (deletedSet.has(i)) continue;
  const textI = getText(phrases[i]);
  if (textI.length < MIN_TEXT_LEN) continue;

  const windowEnd = Math.min(i + 1 + PAIR_WINDOW, phrases.length);
  for (let j = i + 2; j < windowEnd; j++) {  // j=i+2：跳過相鄰對（已由規則 B 處理）
    if (deletedSet.has(j)) continue;
    const textJ = getText(phrases[j]);
    if (textJ.length < MIN_TEXT_LEN) continue;

    const sim     = bigramSimilarity(textI, textJ);
    const lcsR    = computeLcsRatio(textI, textJ);

    if (sim >= PAIR_SIM_THRESHOLD || lcsR >= PAIR_LCS_THRESHOLD) {
      // 附上 ±1 context + thought-unit + 音訊特徵（實驗 A & C）
      const earlier = {
        phraseIdx: i,
        displayText: getDisplay(phrases[i]),
        prevText: i > 0 ? getDisplay(phrases[i - 1]).slice(0, 40) : null,
        nextText: i < phrases.length - 1 ? getDisplay(phrases[i + 1]).slice(0, 40) : null,
        startTime: phrases[i].startTime,
        thoughtUnit: getThoughtUnit(i),
        audioFeatures: computeAudioFeatures(phrases[i], wordsData),
      };
      const later = {
        phraseIdx: j,
        displayText: getDisplay(phrases[j]),
        prevText: j > 0 ? getDisplay(phrases[j - 1]).slice(0, 40) : null,
        nextText: j < phrases.length - 1 ? getDisplay(phrases[j + 1]).slice(0, 40) : null,
        startTime: phrases[j].startTime,
        thoughtUnit: getThoughtUnit(j),
        audioFeatures: computeAudioFeatures(phrases[j], wordsData),
      };
      candidatePairs.push({
        id: `P${pairId++}`,
        earlier,
        later,
        similarity: Math.round(sim * 1000) / 1000,
        lcsRatio:   Math.round(lcsR * 1000) / 1000,
        timeGap:    Math.round((phrases[j].startTime - phrases[i].startTime) * 10) / 10,
        phraseGap:  j - i,
      });
    }
  }
}

// 若超過上限，按相似度排序取 top N
if (candidatePairs.length > PAIR_MAX) {
  candidatePairs.sort((a, b) => b.similarity - a.similarity);
  candidatePairs.length = PAIR_MAX;
  // 重新編號
  candidatePairs.forEach((p, idx) => { p.id = `P${idx + 1}`; });
}

log(`候選對: ${candidatePairs.length} 對（門檻 sim≥${PAIR_SIM_THRESHOLD} OR lcs≥${PAIR_LCS_THRESHOLD}，窗口 ${PAIR_WINDOW}）`);

// ── 輸出 ──
const usedConfig = {
  silence_threshold: SILENCE_THRESHOLD,
  take_similarity:   TAKE_SIM,
  take_window:       TAKE_WINDOW,
  pair_similarity:   PAIR_SIM_THRESHOLD,
  pair_lcs_ratio:    PAIR_LCS_THRESHOLD,
  pair_window:       PAIR_WINDOW,
  pair_max:          PAIR_MAX,
  repeat_prefix_len: REPEAT_PREFIX_LEN,
};

const output = {
  phrases,
  ruleDeletions,
  gapDeletions,
  candidatePairs,
  config: usedConfig,
  stats: {
    totalPhrases:    phrases.length,
    ruleDeleted:     ruleDeletions.length,
    gapMarked:       gapDeletions.length,
    candidatePairs:  candidatePairs.length,
  },
};

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
log(`✅ 寫出 ${outputFile}（${phrases.length} phrases, ${ruleDeletions.length} rule deletions, ${candidatePairs.length} candidate pairs）`);
