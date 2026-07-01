#!/usr/bin/env node
/*
 * verify_export.js — 匯出後成品驗證層（口播專屬）
 *
 * 借鑑 video-autopilot-kit/delivery_qa.py 的「匯出後自動 QA」模式，
 * 但檢查項目換成適合「字級轉錄 + ffmpeg 切段」口播 pipeline 的缺陷型態。
 * 不檢查它那套 CapCut 視覺合成缺陷（頻閃 / 圖片黑邊），那些對口播不適用。
 *
 * 檢查（fail = 擋下；warn = 標記但不擋）：
 *   1. 時長對帳   [FAIL] keepSegs 預計時長 vs ffprobe 實際，落差 > 容忍值 = concat/編碼 bug
 *   2. 殘留長靜音 [WARN] silencedetect 掃成品，>1.5s 死空氣 = 漏剪 or 邊界留太多
 *   3. 音畫漂移   [WARN] video 流時長 vs audio 流時長落差過大 = 剪接點 A/V drift
 *   段數資訊      [INFO] 預計保留段數（成品本身無法回推，僅供對照）
 *
 * 用法：
 *   node verify_export.js --output <cut.mp4> [--input <原片>] [--delete <delete_segments.json>]
 *                         [--json] [--quiet] [--strict]
 *
 * 退出碼：0 = 通過（含 warn）；2 = 有 FAIL；3 = --strict 下有 warn；1 = 參數/執行錯誤
 *
 * 架構守護者：一旦我被修改，請同步更新 testing.md 的測試分層說明。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mergeDeleteSegments } = require(path.join(__dirname, 'merge_delete_segments.js'));

// ── 參數 ──
const TOL_DURATION = 0.5;   // 時長對帳容忍秒數
const AV_DRIFT_TOL = 0.30;  // 音畫漂移容忍秒數
const SILENCE_NOISE = '-30dB';
const SILENCE_MIN = 1.5;    // 殘留長靜音門檻（秒），對齊 delivery_qa.detect_long_pauses
const EDGE_SKIP = 1.2;      // 頭尾各排除秒數（開頭/結尾靜音通常是刻意留白）

// ── CLI 解析 ──
function parseArgs(argv) {
  const o = { json: false, quiet: false, strict: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--output' || a === '-o') o.output = argv[++i];
    else if (a === '--input' || a === '-i') o.input = argv[++i];
    else if (a === '--delete' || a === '-d') o.delete = argv[++i];
    else if (!o.output) o.output = a; // 位置參數兜底
  }
  return o;
}

// ── ffprobe / ffmpeg 封裝（spawnSync，免 shell 轉義，跨平台）──
function ffprobe(args) {
  const r = spawnSync('ffprobe', args, { encoding: 'utf8' });
  if (r.error) throw new Error(`ffprobe 無法執行（PATH 裡有嗎？）: ${r.error.message}`);
  return (r.stdout || '').trim();
}

// 回傳 number 或 null（N/A / 解析失敗 → null，呼叫端自行降級）
function probeDuration(file, stream /* 'v:0' | 'a:0' | undefined */) {
  try {
    const sel = stream ? ['-select_streams', stream, '-show_entries', 'stream=duration']
                       : ['-show_entries', 'format=duration'];
    const out = ffprobe(['-v', 'error', ...sel, '-of', 'csv=p=0', `file:${file}`]);
    const n = parseFloat(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function hasStream(file, type /* 'v' | 'a' */) {
  try {
    const out = ffprobe(['-v', 'error', '-select_streams', type,
      '-show_entries', 'stream=index', '-of', 'csv=p=0', `file:${file}`]);
    return out.length > 0;
  } catch {
    return false;
  }
}

// silencedetect → 回傳 [{start, end, dur}]
function detectSilence(file, totalDur) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', `file:${file}`,
    '-af', `silencedetect=noise=${SILENCE_NOISE}:d=${SILENCE_MIN}`,
    '-f', 'null', '-',
  ], { encoding: 'utf8' });
  if (r.error) throw new Error(`ffmpeg 無法執行: ${r.error.message}`);
  const log = r.stderr || '';
  const out = [];
  let curStart = null;
  for (const line of log.split('\n')) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { curStart = parseFloat(m[1]); continue; }
    m = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (m && curStart !== null) {
      const end = parseFloat(m[1]);
      out.push({ start: curStart, end, dur: end - curStart });
      curStart = null;
    }
  }
  // 若靜音延伸到結尾，ffmpeg 不一定吐 silence_end，補上
  if (curStart !== null && Number.isFinite(totalDur)) {
    out.push({ start: curStart, end: totalDur, dur: totalDur - curStart });
  }
  // 排除頭尾刻意留白
  return out.filter(s => {
    const inHead = s.end <= EDGE_SKIP;
    const inTail = Number.isFinite(totalDur) && s.start >= totalDur - EDGE_SKIP;
    return !inHead && !inTail;
  });
}

// 合併刪除段後計總刪除時長——合併規則統一走 merge_delete_segments.js（與 cut_video.sh 同源）
function mergedDeletedTime(segs) {
  const merged = mergeDeleteSegments(segs);
  const total = merged.reduce((s, x) => s + (x.end - x.start), 0);
  return { total, mergedCount: merged.length };
}

// ── 主流程 ──
function main() {
  const opt = parseArgs(process.argv);
  const checks = [];
  const add = (level, name, ok, msg, extra) =>
    checks.push({ level, name, ok, msg, ...(extra || {}) });

  if (!opt.output) {
    fail('缺少 --output <成品檔>');
  }
  if (!fs.existsSync(opt.output)) {
    add('fail', '成品存在', false, `找不到成品檔: ${opt.output}`);
    return report(opt, checks);
  }

  const actualDur = probeDuration(opt.output);
  const isVideo = hasStream(opt.output, 'v');
  const isAudio = hasStream(opt.output, 'a');

  // 1. 時長對帳（需要原片 + 刪除列表）──────────────────
  if (opt.input && opt.delete && fs.existsSync(opt.input) && fs.existsSync(opt.delete)) {
    const origDur = probeDuration(opt.input);
    let delSegs;
    try {
      const raw = JSON.parse(fs.readFileSync(opt.delete, 'utf8'));
      // 兼容 [{start,end}] 或 {segments:[...]} / {deleteList:[...]}
      delSegs = Array.isArray(raw) ? raw : (raw.segments || raw.deleteList || []);
    } catch (e) {
      delSegs = null;
      add('warn', '時長對帳', true, `刪除列表解析失敗，跳過: ${e.message}`);
    }
    if (delSegs && Number.isFinite(origDur) && Number.isFinite(actualDur)) {
      const { total: delTotal, mergedCount } = mergedDeletedTime(delSegs);
      const expected = origDur - delTotal;
      const diff = actualDur - expected;
      const ok = Math.abs(diff) <= TOL_DURATION;
      add(ok ? 'pass' : 'fail', '時長對帳', ok,
        `預計 ${expected.toFixed(2)}s／實際 ${actualDur.toFixed(2)}s／落差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}s（容忍 ±${TOL_DURATION}s）`,
        { expected, actual: actualDur, diff });
      add('info', '保留段數', true, `預計保留 ${mergedCount + 1} 段（成品本身無法回推，僅供對照）`);
    } else if (delSegs) {
      add('warn', '時長對帳', true, '原片或成品時長讀取失敗（N/A），跳過');
    }
  } else {
    add('info', '時長對帳', true, '未提供 --input / --delete，跳過此項');
  }

  // 2. 殘留長靜音 ────────────────────────────────────
  if (isAudio) {
    try {
      const sil = detectSilence(opt.output, actualDur);
      if (sil.length === 0) {
        add('pass', '殘留長靜音', true, `無 >${SILENCE_MIN}s 死空氣`);
      } else {
        const list = sil.map(s => `${s.start.toFixed(2)}~${s.end.toFixed(2)}(${s.dur.toFixed(1)}s)`).join(', ');
        add('warn', '殘留長靜音', false,
          `發現 ${sil.length} 段 >${SILENCE_MIN}s 靜音: ${list}`,
          { intervals: sil });
      }
    } catch (e) {
      add('warn', '殘留長靜音', true, `偵測失敗，跳過: ${e.message}`);
    }
  } else {
    add('info', '殘留長靜音', true, '成品無音軌，跳過');
  }

  // 3. 音畫漂移 ──────────────────────────────────────
  if (isVideo && isAudio) {
    const vDur = probeDuration(opt.output, 'v:0');
    const aDur = probeDuration(opt.output, 'a:0');
    if (Number.isFinite(vDur) && Number.isFinite(aDur)) {
      const drift = Math.abs(vDur - aDur);
      const ok = drift <= AV_DRIFT_TOL;
      add(ok ? 'pass' : 'warn', '音畫漂移', ok,
        `video ${vDur.toFixed(2)}s／audio ${aDur.toFixed(2)}s／差 ${drift.toFixed(2)}s（容忍 ${AV_DRIFT_TOL}s）`,
        { drift });
    } else {
      add('info', '音畫漂移', true, '流時長為 N/A（部分容器不寫入），跳過');
    }
  } else if (!isVideo) {
    add('info', '音畫漂移', true, '純音訊成品，跳過');
  }

  return report(opt, checks);
}

// ── 輸出與退出碼 ──
function report(opt, checks) {
  const hasFail = checks.some(c => c.level === 'fail');
  const hasWarn = checks.some(c => c.level === 'warn');

  if (opt.json) {
    process.stdout.write(JSON.stringify({
      ok: !hasFail && !(opt.strict && hasWarn),
      hasFail, hasWarn, checks,
    }, null, 2) + '\n');
  } else if (!opt.quiet) {
    const icon = { pass: '✅', fail: '❌', warn: '⚠️ ', info: 'ℹ️ ' };
    console.log('\n──── 匯出後驗證 verify_export ────');
    for (const c of checks) {
      console.log(`${icon[c.level] || '  '} ${c.name}：${c.msg}`);
    }
    console.log('──────────────────────────────');
    if (hasFail) console.log('結果：❌ 有 FAIL，成品可能有 bug，建議重剪或人工確認');
    else if (hasWarn) console.log('結果：⚠️  通過但有警示，請在審核介面複查標記處');
    else console.log('結果：✅ 全數通過');
  }

  if (hasFail) process.exitCode = 2;
  else if (opt.strict && hasWarn) process.exitCode = 3;
  else process.exitCode = 0;
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  console.error('用法: node verify_export.js --output <cut.mp4> [--input <原片>] [--delete <delete_segments.json>] [--json] [--quiet] [--strict]');
  process.exit(1);
}

main();
