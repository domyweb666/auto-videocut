#!/usr/bin/env node
/*
 * export_timeline.js — 非破壞性時間軸匯出（EDL CMX3600 + FCPXML 1.9）
 *
 * 為什麼（借鑑 arkiv）：mp4 匯出是破壞性的——剪壞一刀就要回審核頁重匯出重轉檔。
 * EDL/FCPXML 只是「引用原片＋剪點」的文字檔，DaVinci Resolve / Premiere 匯入後
 * 直接重建整條時間軸，每一刀都能在 NLE 裡微調，零重編碼、生成毫秒級。
 * 剪映路線已有 export_jianying_draft.py（pyJianYingDraft）；本檔補上業界標準格式。
 *
 * 資料流：delete_segments（refined 或原始）→ MERGE_GAP 合併（與 ffmpeg 落刀同一套）
 *        → 補集＝保留段 → 幀對齊 → .edl + .fcpxml
 *
 * 用法（CLI）:
 *   node export_timeline.js <原片> <delete_segments.json> <輸出基底路徑不含副檔名> [--title 名稱]
 * 輸出: <基底>.edl + <基底>.fcpxml；stdout 最後一行 JSON {ok, edl, fcpxml, segments}
 *
 * 模組: { buildKeeps, secToTc, toEDL, toFCPXML, exportTimeline }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

/** 刪除段補集＝保留段，夾在 [0, duration]（與 training_server 剪映路徑同邏輯） */
function buildKeeps(mergedDeletes, duration) {
  const keeps = [];
  let cur = 0;
  for (const s of mergedDeletes) {
    if (cur >= duration - 0.01) break;
    if (s.start > cur + 0.01) keeps.push({ start: cur, end: Math.min(s.start, duration) });
    cur = Math.max(cur, s.end);
  }
  if (duration > cur + 0.01) keeps.push({ start: cur, end: duration });
  for (const k of keeps) k.end = Math.min(k.end, duration);
  return keeps;
}

/** 秒 → SMPTE NDF 時碼（以整數 fps 記幀；29.97 用 30 基底，EDL 慣例） */
function secToTc(sec, fps) {
  const f = Math.max(1, Math.round(fps));
  let frames = Math.round(sec * f);
  const ff = frames % f; frames = (frames - ff) / f;
  const ss = frames % 60; frames = (frames - ss) / 60;
  const mm = frames % 60;
  const hh = (frames - mm) / 60;
  const p = n => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** CMX3600 EDL：單一來源（reel AX），track B＝視訊+音訊 1，record 從 00:00:00:00 連續排 */
function toEDL(keeps, { fps, title, clipName }) {
  const f = Math.max(1, Math.round(fps));
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  let recCursor = 0; // 以幀累計，避免浮點漂移
  keeps.forEach((k, i) => {
    const sIn = Math.round(k.start * f);
    const sOut = Math.round(k.end * f);
    const durF = Math.max(sOut - sIn, 1);
    const num = String(i + 1).padStart(3, '0');
    const tc = fr => secToTc(fr / f, f);
    lines.push(`${num}  AX       B     C        ${tc(sIn)} ${tc(sOut)} ${tc(recCursor)} ${tc(recCursor + durF)}`);
    lines.push(`* FROM CLIP NAME: ${clipName}`);
    lines.push('');
    recCursor += durF;
  });
  return lines.join('\r\n'); // EDL 慣例 CRLF（老派 NLE 挑行尾）
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** FCPXML 1.9：resources（format＋asset 引用原片）＋單 spine 的 asset-clip 序列，時間全部幀對齊有理數 */
function toFCPXML(keeps, { fpsNum, fpsDen, width, height, videoPath, title, durationSec }) {
  const rat = frames => `${frames * fpsDen}/${fpsNum}s`;
  const toFrames = sec => Math.round(sec * fpsNum / fpsDen);
  const assetDurF = toFrames(durationSec);
  const name = xmlEsc(path.basename(videoPath));
  const src = xmlEsc(pathToFileURL(videoPath).href);
  let cursor = 0;
  const clips = keeps.map(k => {
    const sIn = toFrames(k.start);
    const durF = Math.max(toFrames(k.end) - sIn, 1);
    const el = `        <asset-clip ref="r2" name="${name}" offset="${rat(cursor)}" start="${rat(sIn)}" duration="${rat(durF)}" format="r1" audioRole="dialogue"/>`;
    cursor += durF;
    return el;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat_${width}x${height}" frameDuration="${fpsDen}/${fpsNum}s" width="${width}" height="${height}"/>
    <asset id="r2" name="${name}" start="0s" duration="${rat(assetDurF)}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2">
      <media-rep kind="original-media" src="${src}"/>
    </asset>
  </resources>
  <library>
    <event name="${xmlEsc(title)}">
      <project name="${xmlEsc(title)}">
        <sequence format="r1" duration="${rat(cursor)}" tcStart="0s" tcFormat="NDF">
          <spine>
${clips.join('\n')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/** 讀刪除檔（陣列或 {segments}）→ 合併 → 保留段；探測原片參數；寫 <outBase>.edl/.fcpxml */
function exportTimeline(videoPath, deleteFile, outBase, opts = {}) {
  const { mergeDeleteSegments } = require('./merge_delete_segments');
  const raw = JSON.parse(fs.readFileSync(deleteFile, 'utf8'));
  const deletes = Array.isArray(raw) ? raw : (raw.segments || raw.deleteList || []);
  const merged = mergeDeleteSegments(deletes);

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-show_entries', 'format=duration',
    '-of', 'json', 'file:' + videoPath], { encoding: 'utf8' }));
  const vs = (probe.streams && probe.streams[0]) || {};
  const duration = parseFloat(probe.format.duration);
  const fr = String(vs.r_frame_rate || '30/1').split('/');
  const fpsNum = +fr[0] || 30, fpsDen = +fr[1] || 1;
  const fps = fpsNum / fpsDen;

  const keeps = buildKeeps(merged, duration);
  if (!keeps.length) throw new Error('保留段為空（刪除清單蓋滿全片？）');
  const title = opts.title || path.basename(outBase);
  const clipName = path.basename(videoPath);

  const edlPath = outBase + '.edl';
  const fcpPath = outBase + '.fcpxml';
  fs.writeFileSync(edlPath, toEDL(keeps, { fps, title, clipName }), 'utf8');
  fs.writeFileSync(fcpPath, toFCPXML(keeps, {
    fpsNum, fpsDen,
    width: vs.width || 1920, height: vs.height || 1080,
    videoPath, title, durationSec: duration,
  }), 'utf8');
  return { ok: true, edl: edlPath, fcpxml: fcpPath, segments: keeps.length };
}

module.exports = { buildKeeps, secToTc, toEDL, toFCPXML, exportTimeline };

if (require.main === module) {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--title');
  const title = ti >= 0 ? args.splice(ti, 2)[1] : '';
  const [videoPath, deleteFile, outBase] = args;
  if (!videoPath || !deleteFile || !outBase) {
    console.error('用法: node export_timeline.js <原片> <delete_segments.json> <輸出基底> [--title 名稱]');
    process.exit(1);
  }
  try {
    const r = exportTimeline(videoPath, deleteFile, outBase, { title: title || undefined });
    console.error(`🎞️ 時間軸匯出：${r.segments} 段 → ${r.edl} / ${r.fcpxml}`);
    console.log(JSON.stringify(r));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}
