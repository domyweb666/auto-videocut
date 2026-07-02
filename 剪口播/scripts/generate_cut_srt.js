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
const { isWordKept, loadSilences } = require(path.join(__dirname, 'kept_words.js'));

const args = process.argv.slice(2);
let mapArg = null;
const mi = args.indexOf('--map');
if (mi >= 0) { mapArg = args[mi + 1]; args.splice(mi, 2); }
let silencesArg = null;
const si = args.indexOf('--silences');
if (si >= 0) { silencesArg = args[si + 1]; args.splice(si, 2); }
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

// ── 篩選保留的文字並重映射時間 ──
// start/end 各自用「該時間點之前被刪的累積量」映射，
// 字內若有被刪的停頓，end 會被自然拉近，字幕不會多停留。
const keptWords = [];
for (const w of words) {
  if (w.isGap) continue;
  if (!isWordKept(w, deleteSegments, silences)) continue;   // 發音區主體被刪才丟

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

// ── 分句：跟文稿一樣「照標點斷」——優先句末（。！？），長句才在逗號斷；不硬切固定字數、不斷在意群中間 ──
const SENT_END = /[。！？!?…]["」』）)]?$/;    // 句末標點
const CLAUSE_END = /[，、；：,;:]["」』）)]?$/;  // 子句標點
const SOFT_MAX = 18;   // 累積到這長度且遇逗號才斷（螢幕可讀）
const HARD_MAX = 34;   // 極長且無標點時，在字邊界強制斷（罕見）
const BIG_GAP = 0.8;   // 明顯停頓也視為斷點

const cues = [];
let cur = null;
for (let i = 0; i < keptWords.length; i++) {
  const w = keptWords[i];
  if (cur && (w.start - cur.end) >= BIG_GAP) { cues.push(cur); cur = null; } // 大停頓先斷
  if (!cur) cur = { text: w.text, start: w.start, end: w.end };
  else { cur.text += w.text; cur.end = w.end; }
  const t = w.text, len = cur.text.length;
  if ((SENT_END.test(t) && len >= 4) || (CLAUSE_END.test(t) && len >= SOFT_MAX) || len >= HARD_MAX) {
    cues.push(cur); cur = null;
  }
}
if (cur) cues.push(cur);

// ── 合併太短的殘句（<0.5s 或 <2字）到前一句，但不讓前句超過 HARD_MAX ──
const mergedCues = [];
for (const cue of cues) {
  const prev = mergedCues[mergedCues.length - 1];
  if (prev && (cue.end - cue.start < 0.5 || cue.text.length < 2) && (prev.text.length + cue.text.length) <= HARD_MAX) {
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
