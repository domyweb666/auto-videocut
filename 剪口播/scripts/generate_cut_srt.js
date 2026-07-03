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
// 目標每行 ~16 字（14–18），單行優先；斷在意群邊界、優先標點；不把行末掛在虛詞/連接詞/數字上；
// 長句在最近的次佳邊界斷，不硬塞成文字牆（原本 HARD_MAX 34＋「湊滿 18 才斷逗號」會斷在意群中間）。
const SENT_END = /[。！？!?…]/;                       // 句末
const CLAUSE   = /[，、；：,;:]/;                      // 子句停頓（天然斷點）
const NO_END = new Set((
  '的地得了著嗎呢吧啊喔呀哦嘛' +                       // 結構/語助詞
  '和與及而但就把被向從對為跟也還並且或因所讓使將給由在於之以' + // 連詞/介詞（屬下一句）
  '這那它每'                                           // 指示詞（多半修飾後文）
).split(''));
const DIGIT   = /[0-9０-９]/;
const TARGET   = 16;  // 目標行長（到這長度就想辦法斷）
const MAXLEN   = 22;  // 硬上限
const MINLEN   = 4;   // 句末標點要斷的最小長度（避免碎成一兩字）
const MIN_HEAD = 6;   // 回頭斷在逗號時，前段至少要這麼長才值得（否則寧可斷在目標處）
const BIG_GAP  = 0.8; // 明顯停頓也視為斷點

const lastCh = s => (s ? s[s.length - 1] : '');
const cLen = buf => buf.reduce((n, w) => n + (w.text || '').length, 0);
const mkCue = buf => ({ text: buf.map(w => w.text).join(''), start: buf[0].start, end: buf[buf.length - 1].end });
// 字尾能不能當行末：標點可以、一般內容字可以；虛詞/數字不行（會掛在下一句頭上）
const safeEnd = ch => SENT_END.test(ch) || CLAUSE.test(ch) || (!NO_END.has(ch) && !DIGIT.test(ch));

const cues = [];
let buf = [], lastClause = -1, lastSafe = -1;   // lastClause/lastSafe＝可斷位置（buf 內 word 數）
function recalc() { lastClause = -1; lastSafe = -1; for (let k = 0; k < buf.length; k++) { const c = lastCh(buf[k].text); if (CLAUSE.test(c)) lastClause = k + 1; else if (safeEnd(c)) lastSafe = k + 1; } }
function flushAll() { if (buf.length) { cues.push(mkCue(buf)); buf = []; lastClause = lastSafe = -1; } }
function flushAt(cut) { if (cut > 0) cues.push(mkCue(buf.slice(0, cut))); buf = buf.slice(cut); recalc(); }

for (let i = 0; i < keptWords.length; i++) {
  const w = keptWords[i];
  if (buf.length && (w.start - buf[buf.length - 1].end) >= BIG_GAP) flushAll(); // 大停頓先斷
  buf.push(w);
  const c = lastCh(w.text), len = cLen(buf);
  if (CLAUSE.test(c)) lastClause = buf.length; else if (safeEnd(c)) lastSafe = buf.length;

  if (SENT_END.test(c) && len >= MINLEN) { flushAll(); continue; }   // 句末：整句 ≤ 目標就完整一條
  if (len < TARGET) continue;                                        // 還沒到目標：先累積（讓整句/整意群留在一起）
  // 到目標長度：優先回到最近的逗號斷（斷得乾淨），其次在當前非虛詞邊界斷，都不行才拖到上限硬斷
  if (lastClause > 0 && cLen(buf.slice(0, lastClause)) >= MIN_HEAD) { flushAt(lastClause); }
  else if (safeEnd(c)) { flushAll(); }
  else if (len >= MAXLEN) { flushAt(lastSafe > 0 ? lastSafe : buf.length - 1); }
}
flushAll();

// 合併過短殘片（<2 字或 <0.4s）到前句，但不讓前句超過 MAXLEN
const mergedCues = [];
for (const cue of cues) {
  const prev = mergedCues[mergedCues.length - 1];
  if (prev && (cue.text.length < 2 || (cue.end - cue.start) < 0.4) && (prev.text.length + cue.text.length) <= MAXLEN) {
    prev.text += cue.text;
    prev.end = cue.end;
  } else {
    mergedCues.push({ ...cue });
  }
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
mergedCues.forEach((cue, i) => {
  srt += `${i + 1}\n`;
  srt += `${formatTime(cue.start)} --> ${formatTime(cue.end)}\n`;
  srt += `${cue.text}\n\n`;
});

fs.writeFileSync(outputFile, srt, 'utf8');
console.error(`✅ 已產出 SRT: ${outputFile} (${mergedCues.length} 條字幕)`);
