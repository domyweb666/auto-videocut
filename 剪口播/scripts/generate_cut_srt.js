#!/usr/bin/env node
/**
 * 生成剪輯後影片的 SRT 字幕
 *
 * 從原始 subtitles_words.json + delete_segments.json
 * 計算保留文字的新時間戳，輸出標準 SRT 格式
 *
 * 用法: node generate_cut_srt.js <subtitles_words.json> <delete_segments.json> [output.srt]
 *       [--map <timeline_map.json>] [--silences <silences.json>]
 *
 * 字的去留判斷走 kept_words.js（發音區被刪 >50% 才丟）；--silences 未指定時
 * 自動找 <words所在資料夾>/../2_分析/silences.json，找不到退回整字跨度判斷。
 *
 * 時間軸：cut_video.sh 匯出時會在成品旁落地 <成品名>.timeline_map.json（理想→成品實測分段映射，
 * 消除 frame 進位/VFR 造成的每段 +6~20ms 累積漂移）。本腳本自動找 <output去.srt>.timeline_map.json，
 * 也可 --map 顯式指定；找不到就退回理想時間軸（舊行為，片尾可能漂移）。
 */

const fs = require('fs');
const path = require('path');
const { mergeDeleteSegments } = require(path.join(__dirname, 'merge_delete_segments.js'));
const { isWordKept, keptWordsByIndex, loadSilences } = require(path.join(__dirname, 'kept_words.js'));

const args = process.argv.slice(2);
let mapArg = null;
const mi = args.indexOf('--map');
if (mi >= 0) { mapArg = args[mi + 1]; args.splice(mi, 2); }
let silencesArg = null;
const si = args.indexOf('--silences');
if (si >= 0) { silencesArg = args[si + 1]; args.splice(si, 2); }
// --delete-indices <file>：審核頁確認的字級刪除 index（JSON 陣列）。有給就用它決定「哪些字保留」，
// 與審核頁文稿逐字一致；沒給退回 kept_words.js 的發音區 >50% 判斷（向下相容）。
let deleteIdxArg = null;
const di = args.indexOf('--delete-indices');
if (di >= 0) { deleteIdxArg = args[di + 1]; args.splice(di, 2); }
// --llm-segment [--llm-model <m>]：讓 Claude 依意群斷行（機械斷句抓不到語意邊界時）。
// 逐字驗證＝原稿才採用，不符自動退回機械斷句。CLI 預設關；由 server 依 config 決定是否帶。
let llmSegment = false, llmModel = 'sonnet';
const ls = args.indexOf('--llm-segment');
if (ls >= 0) { llmSegment = true; args.splice(ls, 1); }
const lm = args.indexOf('--llm-model');
if (lm >= 0) { llmModel = args[lm + 1]; args.splice(lm, 2); }
const wordsFile = args[0];
const deleteFile = args[1];
const outputFile = args[2] || 'output_cut.srt';

if (!wordsFile || !deleteFile) {
  console.error('用法: node generate_cut_srt.js <subtitles_words.json> <delete_segments.json> [output.srt]');
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
// MERGE_GAP 合併後的最終刪除清單——必須與 cut_video.sh 實際落刀一致：
// 兩刪除段間 ≤0.2s 的短保留區會被一併剪掉，不合併的話那些字仍留在字幕裡，
// 且其後每條字幕的時間全部漂移
const deleteSegments = mergeDeleteSegments(JSON.parse(fs.readFileSync(deleteFile, 'utf8')));

// ── timeline_map：成品實測時間軸（有就用，沒有退回理想時間軸）──
let timelineMap = null;
{
  const mapPath = mapArg || (outputFile.replace(/\.srt$/i, '') + '.timeline_map.json');
  try {
    if (fs.existsSync(mapPath)) {
      const m = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      if (m && Array.isArray(m.segments) && m.segments.length) {
        timelineMap = m.segments;
        console.error(`🧭 套用實測時間軸映射: ${mapPath}（理想 ${m.idealDuration}s → 實測 ${m.actualDuration}s）`);
      }
    }
  } catch (e) { console.error(`⚠️ timeline_map 解析失敗，退回理想時間軸: ${e.message}`); }
  if (!timelineMap) console.error('ℹ️ 無 timeline_map，使用理想時間軸（段數多時片尾字幕可能漂移）');
}

// 用映射把原片時間換算成成品時間：
// 段內 → dstStart + 段內偏移（夾在 dstEnd 內）；刪除縫隙 → 下一保留段起點；頭尾外 → 夾邊界
function mapTime(t) {
  for (const s of timelineMap) {
    if (t < s.srcStart) return s.dstStart;
    if (t < s.srcEnd) return Math.min(s.dstStart + (t - s.srcStart), s.dstEnd);
  }
  return timelineMap[timelineMap.length - 1].dstEnd;
}

// ── 時間映射函數（複用 generate_subtitles.js 邏輯）──
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

// 字的去留判斷改走 kept_words.js（單一事實來源，與 TXT / verify_export / 刀口原子化同源）：
// 發音區（字跨度扣掉音訊實測靜音）被刪 >50% 才丟——STT 會把停頓吸進字的 end 裡，
// 停頓壓平刪的是字尾靜音，字本身有講出來，不能把字幕文字跟著丟掉。
// 無 silences 資料時退回整字跨度算（舊行為）。
const silences = loadSilences(silencesArg || path.join(path.dirname(wordsFile), '..', '2_分析', 'silences.json'));
if (silences) console.error(`🔇 發音區判斷使用音訊實測靜音（${silences.length} 段）`);

// 審核頁字級刪除 index（有給就以它為準）
let deletedSet = null;
if (deleteIdxArg) {
  try {
    const raw = JSON.parse(fs.readFileSync(deleteIdxArg, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.deletedIndices || raw.indices || []);
    deletedSet = new Set(arr);
    console.error(`🎯 文字面依審核頁字級選集（刪 ${deletedSet.size} 個 index），與審核頁文稿逐字一致`);
  } catch (e) { console.error(`⚠️ delete-indices 解析失敗，退回發音區判斷: ${e.message}`); }
}

// ── 篩選保留的文字並重映射時間 ──
// 文字面：有 index 選集就照它（審核頁真相）；否則退回發音區 >50% 判斷。
// 時間面一律走 timeline_map / 累積刪除量映射（字內被刪的停頓會把 end 自然拉近，字幕不多停留）。
const srcKept = deletedSet ? keptWordsByIndex(words, deletedSet)
                           : words.filter(w => !w.isGap && isWordKept(w, deleteSegments, silences));
const keptWords = [];
for (const w of srcKept) {
  const newStart = timelineMap ? mapTime(w.start) : w.start - getDeletedTimeBefore(w.start);
  let newEnd = timelineMap ? mapTime(w.end) : w.end - getDeletedTimeBefore(w.end);
  if (newEnd <= newStart) newEnd = newStart + 0.05;       // 防呆
  keptWords.push({
    text: w.text,
    start: Math.round(newStart * 1000) / 1000,
    end: Math.round(newEnd * 1000) / 1000
  });
}

console.error(`📝 保留字數: ${keptWords.length}/${words.filter(w => !w.isGap).length}`);

// ── 斷句：橫式長片字幕（照 domi-subtitle-format）──
// 只斷在「真正的標點」上：句末（。！？）一定斷、逗號（子句夠長就斷、每個逗號都斷＝行短好讀），
// 頓號「、」是清單分隔不斷。沒標點的長串撐到 MAXLEN 才在「最近一個標點」硬斷（不硬切內容字，
// 免得把詞切兩半、逗號被擠到下一行行首）。行末標點最後在輸出時去掉（字幕不顯示，斷行即停頓）。
const SENT_END = /[。！？!?…]/;                       // 句末
const CLAUSE   = /[，；：,;:]/;                        // 子句停頓（斷點）；頓號「、」是清單分隔，不斷
const PUNCT    = /[，。！？、；：,.!?;:]/;             // 任何標點（MAXLEN 硬斷時回退到最近標點）
const TRAIL_PUNCT = /[，。！？、；：,.!?;:]+$/;         // 行末標點 → 去掉
const NO_END = new Set((
  '的地得了著嗎呢吧啊喔呀哦嘛' +                       // 結構/語助詞
  '和與及而但就把被向從對為跟也還並且或因所讓使將給由在於之以' + // 連詞/介詞（屬下一句）
  '這那它每'                                           // 指示詞（多半修飾後文）
).split(''));
const MINLEN     = 4;  // 句末最小斷長（避免碎成一兩字）
const CLAUSE_MIN = 4;  // 逗號斷點的最小子句長
const MAXLEN     = 18; // 無標點長串硬上限（頓號清單容得下）
const MAXHEAD_MIN = 5; // MAXLEN 硬斷時，用最近標點當斷點的最小前段長
const BIG_GAP    = 0.8;

const lastCh = s => (s ? s[s.length - 1] : '');
const cLen = buf => buf.reduce((n, w) => n + (w.text || '').length, 0);
const mkCue = buf => ({ text: buf.map(w => w.text).join(''), start: buf[0].start, end: buf[buf.length - 1].end });

const cues = [];
let buf = [], lastPunct = -1;   // lastPunct＝最近一個標點後的位置（buf 內 word 數）
function recalc() { lastPunct = -1; for (let k = 0; k < buf.length; k++) if (PUNCT.test(lastCh(buf[k].text))) lastPunct = k + 1; }
function flushAll() { if (buf.length) { cues.push(mkCue(buf)); buf = []; lastPunct = -1; } }
function flushAt(cut) { if (cut > 0) cues.push(mkCue(buf.slice(0, cut))); buf = buf.slice(cut); recalc(); }

for (let i = 0; i < keptWords.length; i++) {
  const w = keptWords[i];
  if (buf.length && (w.start - buf[buf.length - 1].end) >= BIG_GAP) flushAll(); // 大停頓先斷
  buf.push(w);
  const c = lastCh(w.text), len = cLen(buf);
  if (PUNCT.test(c)) lastPunct = buf.length;
  if (SENT_END.test(c) && len >= MINLEN) { flushAll(); continue; }
  else if (CLAUSE.test(c) && len >= CLAUSE_MIN) { flushAll(); continue; }
  else if (len >= MAXLEN) {
    // 撐太長：當前字若本身是標點（多半是頓號）→ 直接斷在它後面（保住整個詞，不切「快樂」）；
    // 否則回退到最近的標點斷；真的整段無標點才在當前字前硬斷。
    if (PUNCT.test(c)) { flushAll(); continue; }
    let cut = (lastPunct > 0 && cLen(buf.slice(0, lastPunct)) >= MAXHEAD_MIN) ? lastPunct : buf.length - 1;
    if (cut <= 0) cut = buf.length - 1;
    // 無標點硬斷時避免行末掛虛詞（skill 規則）：往前挪到非虛詞字尾
    if (lastPunct <= 0) while (cut > 1 && NO_END.has(lastCh(buf[cut - 1].text))) cut--;
    flushAt(cut);
  }
}
flushAll();

// ── 合併過短殘片：往前併，但不跨句末（「否定。」後面的「啊」不該黏回上一句）；
//    黏不回去就往後併到下一句開頭（如句首「啊」→「啊雖然…」）。──
const stripTrail = t => t.replace(TRAIL_PUNCT, '');
const isShort = cue => stripTrail(cue.text).length < 2 || (cue.end - cue.start) < 0.4;
const endsSent = t => SENT_END.test(lastCh(t));
let mergedCues = [];
let pend = null;
for (let cue of cues) {
  if (pend) { cue = { text: pend.text + cue.text, start: pend.start, end: cue.end }; pend = null; }
  const prev = mergedCues[mergedCues.length - 1];
  if (prev && isShort(cue) && !endsSent(prev.text) && (prev.text.length + cue.text.length) <= MAXLEN) {
    prev.text += cue.text; prev.end = cue.end;                 // 往前併（前句非句末）
  } else if (isShort(cue)) {
    pend = cue;                                                // 黏不回去 → 往後併到下一句
  } else {
    mergedCues.push({ ...cue });
  }
}
if (pend) {
  const prev = mergedCues[mergedCues.length - 1];
  if (prev && (prev.text.length + pend.text.length) <= MAXLEN) { prev.text += pend.text; prev.end = pend.end; }
  else mergedCues.push(pend);
}

// ── LLM 斷行覆蓋（opt-in）：機械斷句永遠先算好當保底；啟用且 Claude 逐字驗證通過才取代 ──
// Claude 只斷行不改字（驗證：去換行後＝原逐字稿，不符作廢）。時間戳逐字元對回。
if (llmSegment) {
  try {
    const { segmentByLLM } = require('./subtitle_segment_llm');
    const llmCues = segmentByLLM(keptWords, { model: llmModel });
    if (llmCues && llmCues.length) {
      mergedCues = llmCues.map(c => ({ text: c.text, start: c.start, end: c.end }));
      console.error(`🤖 字幕斷行改用 Claude 意群斷句（${llmModel}，${mergedCues.length} 行，逐字驗證通過）`);
    } else {
      console.error('ℹ️ LLM 斷句未通過驗證/未啟用，維持機械斷句');
    }
  } catch (e) { console.error('⚠️ LLM 斷句失敗，維持機械斷句: ' + (e.message || '').split('\n')[0]); }
}

// ── 格式化 SRT ──
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.min(999, Math.floor((seconds % 1) * 1000));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

let srt = '';
let cueNo = 0;
mergedCues.forEach((cue) => {
  const line = cue.text.replace(TRAIL_PUNCT, '');   // 去行末標點（字幕不顯示）；頓號清單的中間頓號保留
  if (!line) return;                                 // 純標點行（罕見）→ 跳過
  cueNo++;
  srt += `${cueNo}\n`;
  srt += `${formatTime(cue.start)} --> ${formatTime(cue.end)}\n`;
  srt += `${line}\n\n`;
});

fs.writeFileSync(outputFile, srt, 'utf8');
console.error(`✅ 已產出 SRT: ${outputFile} (${cueNo} 條字幕)`);
