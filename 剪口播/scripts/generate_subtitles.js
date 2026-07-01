#!/usr/bin/env node
/**
 * 從轉錄結果生成字級別字幕
 * 支援格式：Whisper (whisper_result.json) / 火山引擎 (volcengine_result.json)
 *
 * 用法: node generate_subtitles.js <result.json> [delete_segments.json]
 * 输出: subtitles_words.json
 */

const fs = require('fs');
const path = require('path');

// OpenCC 簡繁轉換（cn → tw，只轉字不換詞）
// 刻意用 'tw' 而非 'twp'：忠實跟隨使用者實際說的話，只把簡體字換成繁體字。
// twp 會「自作主張」把詞彙換成台灣標準詞（视频→影片），但它是硬套詞表、不看語意，會誤傷——
// 實測把使用者說的「抄寫對象」改成「抄寫物件」（意思錯了）。故不用 twp。
// 註：「视频/软件」這類是不同的詞、不同發音，講台灣話 ASR 本來就轉「影片/軟體」，不需 twp 強換。
let toTrad;
try {
  const opencc = require(path.join(__dirname, 'node_modules/opencc-js'));
  const converter = opencc.Converter({ from: 'cn', to: 'tw' });
  toTrad = converter;
  console.log('✅ OpenCC 已啟用（簡體→繁體 tw，忠實不換詞）');
} catch (e) {
  toTrad = s => s; // fallback: no conversion
  console.warn('⚠️ OpenCC 未安裝，跳過繁體轉換');
}

const resultFile = process.argv[2] || (() => {
  // 自動偵測：優先用 Google STT，其次 Whisper
  if (fs.existsSync('google_result.json')) return 'google_result.json';
  if (fs.existsSync('whisper_result.json')) return 'whisper_result.json';
  if (fs.existsSync('volcengine_result.json')) return 'volcengine_result.json';
  return 'google_result.json';
})();
const deleteFile = process.argv[3];

if (!fs.existsSync(resultFile)) {
  console.error('❌ 找不到文件:', resultFile);
  process.exit(1);
}

const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));

// 自動偵測格式
const isGoogleSTT = result.source === 'google_stt';
const isWhisper = !isGoogleSTT && Array.isArray(result.segments);
const isVolcengine = !isGoogleSTT && Array.isArray(result.utterances);
console.log('轉錄格式:', isGoogleSTT ? 'Google STT (zh-TW)' : isWhisper ? 'Whisper' : isVolcengine ? '火山引擎' : '未知');

// 提取所有字
const allWords = [];

if (isGoogleSTT) {
  // Google STT 格式：words[].word / start / end（秒，已在 python 腳本轉好）
  // OpenAI Whisper 也用此格式（_actual_source = 'openai_whisper'），需要 OpenCC
  const needConvert = result._actual_source === 'openai_whisper' || result._actual_source === 'faster_whisper' || result._actual_source === 'funasr';
  if (needConvert) console.log('🔄 Whisper 輸出，啟用簡繁轉換');
  for (const w of (result.words || [])) {
    const text = needConvert ? toTrad((w.word || '').trim()) : (w.word || '').trim();
    if (!text) continue;
    // confidence：本機 faster-whisper 會帶每字把握度（P1/P2 唸糊用），其他來源沒有 → undefined（JSON 自動略過）
    allWords.push({ text, start: w.start, end: w.end, confidence: w.confidence });
  }
} else if (isWhisper) {
  // Whisper 格式：segments[].words[].word / start / end（秒）
  for (const segment of result.segments) {
    if (segment.words) {
      for (const word of segment.words) {
        const text = toTrad((word.word || '').trim());
        if (!text) continue;
        allWords.push({
          text,
          start: word.start,
          end: word.end
        });
      }
    }
  }
} else if (isVolcengine) {
  // 火山引擎格式：utterances[].words[].text / start_time / end_time（毫秒）
  // 新版 Seed Speech（bigmodel）：字級 words[] 不含標點，標點只在整句 utterance.text。
  // → 把整句的標點對位貼回對應字尾，並套 OpenCC 轉繁體（與舊 pipeline 帶標點字流一致）
  const PUNCT = /[，。！？、；：,.!?;:…「」『』（）()]/;
  for (const utterance of result.utterances) {
    if (!utterance.words) continue;
    const ut = utterance.text || '';
    let pos = 0;
    for (const word of utterance.words) {
      const raw = (word.text || '').trim();
      if (!raw) continue;
      let trailing = '';
      const idx = ut.indexOf(raw, pos);
      if (idx >= 0) {
        pos = idx + raw.length;
        while (pos < ut.length && PUNCT.test(ut[pos])) { trailing += ut[pos]; pos++; }
      }
      const text = toTrad(raw + trailing);
      if (!text) continue;
      allWords.push({
        text,
        start: word.start_time / 1000,
        end: word.end_time / 1000
      });
    }
  }
} else {
  console.error('❌ 無法識別的 JSON 格式（需要 segments 或 utterances 欄位）');
  process.exit(1);
}

console.log('原始字数:', allWords.length);

// 如果有删除片段，映射时间
let outputWords = allWords;

if (deleteFile && fs.existsSync(deleteFile)) {
  const deleteSegments = JSON.parse(fs.readFileSync(deleteFile, 'utf8'));
  console.log('删除片段数:', deleteSegments.length);

  function getDeletedTimeBefore(time) {
    let deleted = 0;
    for (const seg of deleteSegments) {
      if (seg.end <= time) {
        deleted += seg.end - seg.start;
      } else if (seg.start < time) {
        deleted += time - seg.start;
      }
    }
    return deleted;
  }

  function isDeleted(start, end) {
    for (const seg of deleteSegments) {
      if (start < seg.end && end > seg.start) return true;
    }
    return false;
  }

  outputWords = [];
  for (const word of allWords) {
    if (!isDeleted(word.start, word.end)) {
      const deletedBefore = getDeletedTimeBefore(word.start);
      outputWords.push({
        text: word.text,
        start: Math.round((word.start - deletedBefore) * 100) / 100,
        end: Math.round((word.end - deletedBefore) * 100) / 100,
        confidence: word.confidence
      });
    }
  }
  console.log('映射后字数:', outputWords.length);
}

// 添加空白标记（>0.5秒的静音按1秒拆分，便于精细控制）
const wordsWithGaps = [];
let lastEnd = 0;

for (const word of outputWords) {
  const gapDuration = word.start - lastEnd;

  if (gapDuration > 0.1) {
    // 如果静音 >0.5秒，按1秒拆分
    if (gapDuration > 0.5) {
      let gapStart = lastEnd;
      while (gapStart < word.start) {
        const gapEnd = Math.min(gapStart + 1, word.start);
        wordsWithGaps.push({
          text: '',
          start: Math.round(gapStart * 100) / 100,
          end: Math.round(gapEnd * 100) / 100,
          isGap: true
        });
        gapStart = gapEnd;
      }
    } else {
      // <1秒的静音保持原样
      wordsWithGaps.push({
        text: '',
        start: Math.round(lastEnd * 100) / 100,
        end: Math.round(word.start * 100) / 100,
        isGap: true
      });
    }
  }

  wordsWithGaps.push({
    text: word.text,
    start: word.start,
    end: word.end,
    isGap: false,
    confidence: word.confidence
  });
  lastEnd = word.end;
}

const gaps = wordsWithGaps.filter(w => w.isGap);
console.log('总元素数:', wordsWithGaps.length);
console.log('空白段数:', gaps.length);

// 標記 Whisper 訓練資料污染（中國頻道結尾語）
// 對策：把字詞串成連續字串，掃 blacklist 片語匹配。匹配到的整個字串範圍內的 word 都打 _hallucination=true
// 只標記不刪除——後續 ai_polish/ai_cut 會把它們判為 aiDelete
const blacklistPath = path.join(__dirname, 'hallucination_blacklist.json');
if (fs.existsSync(blacklistPath)) {
  const { phrases = [] } = JSON.parse(fs.readFileSync(blacklistPath, 'utf8'));
  const wordIdx = []; // 第 i 個非 gap 字在 wordsWithGaps 的索引
  let joined = '';
  for (let i = 0; i < wordsWithGaps.length; i++) {
    if (wordsWithGaps[i].isGap) continue;
    const t = wordsWithGaps[i].text;
    for (let k = 0; k < t.length; k++) wordIdx.push(i);
    joined += t;
  }
  let hallCount = 0;
  for (const phrase of phrases) {
    if (!phrase || phrase.length < 5) continue;
    let from = 0;
    while (true) {
      const pos = joined.indexOf(phrase, from);
      if (pos < 0) break;
      const startIdx = wordIdx[pos];
      const endIdx = wordIdx[Math.min(pos + phrase.length - 1, wordIdx.length - 1)];
      for (let i = startIdx; i <= endIdx; i++) {
        if (!wordsWithGaps[i].isGap) {
          wordsWithGaps[i]._hallucination = true;
          hallCount++;
        }
      }
      from = pos + phrase.length;
    }
  }
  if (hallCount > 0) console.log(`⚠️ 標記 Whisper 幻覺字詞 ${hallCount} 個`);
}

fs.writeFileSync('subtitles_words.json', JSON.stringify(wordsWithGaps, null, 2));
console.log('✅ 已保存 subtitles_words.json');
