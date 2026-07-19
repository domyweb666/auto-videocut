#!/usr/bin/env node
/**
 * 根據刪除列表剪輯影片（匹配碼率重編碼，幀級精確）— cut_video.sh 的 Node 移植版
 *
 * 為什麼移植：.sh 版在 Windows 依賴 Git Bash，桌面 app 打包後不能假設使用者有 bash；
 * Node 版跨平台（Windows/macOS/Linux）行為一致。介面與 .sh 版完全相同：
 *   argv:  node cut_video.js <input.mp4> <delete_segments.json> [output.mp4]
 *   stdout: PROGRESS=N/TOTAL（多段路徑，training_server.js 解析）
 *   stderr: ffmpeg -stats 的 time=（單趟路徑，training_server.js 解析）
 *   env:   CUT_LOSSLESS / CUT_RESOLUTION / CUT_CODEC / CUT_FPS / CUT_BITRATE_MODE /
 *          CUT_AUDIO_ONLY / CUT_EXPORT_GIF / CUT_FADE_DUR / CUT_SINGLE_PASS(_THRESHOLD)
 *   落地:  <output>.timeline_map.json、<delete>.final.json
 *
 * 原理（同 .sh 版）：每個保留片段用混合 seek（input -ss 快跳 + output -ss 精調）獨立提取，
 * 分批並行，最後 concat demuxer 拼接；段數多時改單趟 trim/atrim filter（避免 AAC 接點累積）。
 */
'use strict';

const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;

function die(msg) { console.error(msg); process.exit(1); }

// ffprobe 單值查詢
function probe(args) {
  try {
    return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' }).trim();
  } catch (_) { return ''; }
}

function main() {
  const INPUT = process.argv[2];
  const DELETE_JSON = process.argv[3];
  const OUTPUT = process.argv[4] || 'output_cut.mp4';
  const PARALLEL = 4;

  if (!INPUT || !DELETE_JSON) die('❌ 用法: node cut_video.js <input.mp4> <delete_segments.json> [output.mp4]');
  if (!fs.existsSync(INPUT)) die('❌ 找不到輸入文件: ' + INPUT);
  if (!fs.existsSync(DELETE_JSON)) die('❌ 找不到刪除列表: ' + DELETE_JSON);

  // ── MERGE_GAP 合併：單一事實來源 merge_delete_segments.js ──
  const FINAL_JSON = DELETE_JSON.replace(/\.json$/, '') + '.final.json';
  const mergeRun = spawnSync('node', [path.join(SCRIPT_DIR, 'merge_delete_segments.js'), DELETE_JSON, FINAL_JSON], { stdio: 'inherit' });
  if (mergeRun.status !== 0 || !fs.existsSync(FINAL_JSON)) die('❌ 產生最終刪除清單失敗: ' + FINAL_JSON);

  // ── 原片參數偵測 ──
  const DURATION = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', 'file:' + INPUT])) || 0;
  let bitrateRaw = probe(['-show_entries', 'stream=bit_rate', '-select_streams', 'v:0', '-of', 'csv=p=0', 'file:' + INPUT]);
  const PROFILE = probe(['-show_entries', 'stream=profile', '-select_streams', 'v:0', '-of', 'csv=p=0', 'file:' + INPUT]);
  const PIX_FMT = probe(['-show_entries', 'stream=pix_fmt', '-select_streams', 'v:0', '-of', 'csv=p=0', 'file:' + INPUT]) || 'yuv420p';

  // 偵測原片 fps（解決剪接點定格：所有片段強制成同一 CFR）
  const fpsRaw = probe(['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', 'file:' + INPUT]);
  let INPUT_FPS = '30';
  if (fpsRaw && fpsRaw !== 'N/A') {
    if (fpsRaw.includes('/')) {
      const [a, b] = fpsRaw.split('/').map(Number);
      if (b) INPUT_FPS = (a / b).toFixed(3);
    } else INPUT_FPS = fpsRaw;
  }

  // mkv/mov 等格式 stream bitrate 可能為 N/A，改用 container bitrate；再不行預設 5000kbps
  if (!bitrateRaw || bitrateRaw === 'N/A') bitrateRaw = probe(['-show_entries', 'format=bit_rate', '-of', 'csv=p=0', 'file:' + INPUT]);
  const BITRATE = (!bitrateRaw || bitrateRaw === 'N/A') ? 5000000 : parseInt(bitrateRaw, 10);

  let BITRATE_K = Math.floor(BITRATE / 1000);
  const mode = process.env.CUT_BITRATE_MODE || 'recommended';
  if (mode === 'high') { BITRATE_K = Math.floor(BITRATE_K * 15 / 10); console.log('📊 碼率: 更高（原片 ×1.5）'); }
  else if (mode === 'low') { BITRATE_K = Math.floor(BITRATE_K * 6 / 10); console.log('📊 碼率: 更低（原片 ×0.6，省空間）'); }
  const MAXRATE_K = Math.floor(BITRATE_K * 13 / 10);
  const BUFSIZE_K = BITRATE_K * 2;

  console.log(`📹 影片時長: ${DURATION}s`);
  console.log(`📊 原片參數: ${BITRATE_K}kbps, profile=${PROFILE}, pix_fmt=${PIX_FMT}`);
  console.log('⚙️ 匹配碼率重編碼（-ss/-to 逐段提取，無 trim filter）');

  // 臨時目錄（放輸出檔同層，Windows 相容）
  const OUTPUT_DIR = path.dirname(path.resolve(OUTPUT));
  const TMP_DIR = path.join(OUTPUT_DIR, '_tmp_cut_' + process.pid);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const cleanup = () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  // 映射 profile
  const profLc = String(PROFILE).toLowerCase();
  const X264_PROFILE = (profLc === 'high' || profLc === 'main' || profLc === 'baseline') ? profLc : 'high';

  // ── 偵測硬體編碼器（優先 NVENC > QSV > AMF > 軟編碼）──
  let encodersList = '';
  try { encodersList = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }); } catch (_) {}
  const hasEnc = (name) => encodersList.includes(name);

  let ENCODER = 'libx264';
  let ENCODER_ARGS = ['-profile:v', X264_PROFILE];
  let ENCODER_LABEL = 'x264 (軟編碼)';
  if (process.platform === 'darwin' && hasEnc('h264_videotoolbox')) {
    ENCODER = 'h264_videotoolbox'; ENCODER_ARGS = ['-q:v', '60']; ENCODER_LABEL = 'VideoToolbox (macOS)';
  } else if (hasEnc('h264_nvenc')) {
    ENCODER = 'h264_nvenc'; ENCODER_ARGS = ['-preset', 'p4', '-cq', '20', '-profile:v', X264_PROFILE]; ENCODER_LABEL = 'NVENC (NVIDIA)';
  } else if (process.platform === 'win32' && hasEnc('h264_qsv')) {
    ENCODER = 'h264_qsv'; ENCODER_ARGS = ['-global_quality', '20', '-profile:v', X264_PROFILE]; ENCODER_LABEL = 'QSV (Intel)';
  } else if (process.platform === 'win32' && hasEnc('h264_amf')) {
    ENCODER = 'h264_amf'; ENCODER_ARGS = ['-quality', 'balanced', '-profile:v', X264_PROFILE]; ENCODER_LABEL = 'AMF (AMD)';
  } else if (process.platform === 'linux' && hasEnc('h264_vaapi')) {
    ENCODER = 'h264_vaapi'; ENCODER_ARGS = ['-qp', '20']; ENCODER_LABEL = 'VAAPI (Linux)';
  }

  // ── 匯出選項 ──
  let SCALE_FILTER = '';        // 不含 -vf 前綴，只存 filter 字串
  let FPS_ARGS = [];
  let AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '128k'];
  let FADE_DUR = process.env.CUT_FADE_DUR !== undefined ? parseFloat(process.env.CUT_FADE_DUR) || 0 : 0.03;
  const LOSSLESS = process.env.CUT_LOSSLESS === '1';

  if (LOSSLESS) {
    console.log('💎 無損模式：影片 libx264 CRF 17（忽略解析度/codec）；音訊：單段 copy／多段改走單趟 256k AAC 保口型同步');
    ENCODER = 'libx264';
    ENCODER_ARGS = ['-crf', '17', '-preset', 'slow', '-profile:v', X264_PROFILE];
    ENCODER_LABEL = 'libx264 CRF 17 (近無損)';
    FPS_ARGS = ['-r', INPUT_FPS, '-fps_mode', 'cfr']; // lossless 也要 CFR
    AUDIO_ARGS = ['-c:a', 'copy'];
    FADE_DUR = 0; // copy 串流無法套 afade
  } else {
    const RES_MAP = {
      '4320': ['7680:4320', '8K (7680×4320)'], '2160': ['3840:2160', '4K (3840×2160)'],
      '1440': ['2560:1440', '2K (2560×1440)'], '1080': ['1920:1080', '1080P'],
      '720': ['1280:720', '720P'], '480': ['854:480', '480P'],
    };
    const res = RES_MAP[process.env.CUT_RESOLUTION || ''];
    if (res) {
      const [wh, label] = res;
      SCALE_FILTER = `scale=${wh}:force_original_aspect_ratio=decrease,pad=${wh}:-1:-1:color=black`;
      console.log('📐 解析度: ' + label);
    }

    const codec = process.env.CUT_CODEC || '';
    if (codec === 'h265') {
      console.log('🔄 切換到 H.265/HEVC 編碼器...');
      if (hasEnc('hevc_nvenc')) { ENCODER = 'hevc_nvenc'; ENCODER_ARGS = ['-preset', 'p4', '-cq', '22']; ENCODER_LABEL = 'HEVC NVENC (GPU)'; }
      else if (hasEnc('hevc_qsv')) { ENCODER = 'hevc_qsv'; ENCODER_ARGS = ['-global_quality', '22']; ENCODER_LABEL = 'HEVC QSV (Intel)'; }
      else if (hasEnc('hevc_amf')) { ENCODER = 'hevc_amf'; ENCODER_ARGS = ['-quality', 'quality']; ENCODER_LABEL = 'HEVC AMF (AMD)'; }
      else { ENCODER = 'libx265'; ENCODER_ARGS = ['-crf', '22', '-preset', 'medium']; ENCODER_LABEL = 'libx265 (軟編碼)'; }
    } else if (codec === 'av1') {
      console.log('🔄 切換到 AV1 編碼器...');
      if (hasEnc('av1_nvenc')) { ENCODER = 'av1_nvenc'; ENCODER_ARGS = ['-preset', 'p4', '-cq', '30']; ENCODER_LABEL = 'AV1 NVENC (RTX 40+)'; }
      else if (hasEnc('av1_qsv')) { ENCODER = 'av1_qsv'; ENCODER_ARGS = ['-global_quality', '30']; ENCODER_LABEL = 'AV1 QSV (Intel Arc / 13th+)'; }
      else if (hasEnc('av1_amf')) { ENCODER = 'av1_amf'; ENCODER_ARGS = ['-quality', 'quality']; ENCODER_LABEL = 'AV1 AMF (RX 7000+)'; }
      else if (hasEnc('libsvtav1')) { ENCODER = 'libsvtav1'; ENCODER_ARGS = ['-crf', '30', '-preset', '6']; ENCODER_LABEL = 'SVT-AV1 (軟編碼)'; }
      else if (hasEnc('libaom-av1')) { ENCODER = 'libaom-av1'; ENCODER_ARGS = ['-crf', '30', '-b:v', '0', '-cpu-used', '4']; ENCODER_LABEL = 'libaom-av1 (軟編碼, 慢)'; }
      else {
        console.log('⚠️ 此系統無可用 AV1 編碼器，fallback 到 H.265');
        if (hasEnc('hevc_nvenc')) { ENCODER = 'hevc_nvenc'; ENCODER_ARGS = ['-preset', 'p4', '-cq', '22']; ENCODER_LABEL = 'HEVC NVENC (AV1 fallback)'; }
        else { ENCODER = 'libx265'; ENCODER_ARGS = ['-crf', '22', '-preset', 'medium']; ENCODER_LABEL = 'libx265 (AV1 fallback)'; }
      }
    }

    if (process.env.CUT_FPS) {
      FPS_ARGS = ['-r', process.env.CUT_FPS, '-fps_mode', 'cfr'];
      console.log(`🎬 幀率: ${process.env.CUT_FPS}fps (CFR 強制)`);
    } else {
      FPS_ARGS = ['-r', INPUT_FPS, '-fps_mode', 'cfr'];
      console.log(`🎬 幀率: ${INPUT_FPS}fps (跟隨原片，CFR 強制以避免剪接點定格)`);
    }
  }

  console.log('🎯 編碼器: ' + ENCODER_LABEL);
  if (FADE_DUR > 0) console.log(`🔊 切點淡入淡出: ${FADE_DUR}s（消除接點爆音）`);

  // ── 計算保留片段（讀 FINAL_JSON，已排序＋合併）──
  const mergedSegs = JSON.parse(fs.readFileSync(FINAL_JSON, 'utf8'));
  const keepSegs = [];
  let cursor = 0;
  for (const del of mergedSegs) {
    if (del.start > cursor) keepSegs.push({ start: cursor, end: del.start });
    cursor = del.end;
  }
  if (cursor < DURATION) keepSegs.push({ start: cursor, end: DURATION });
  const deletedTime = mergedSegs.reduce((a, s) => a + (s.end - s.start), 0);

  console.error('保留片段數: ' + keepSegs.length);
  console.error('刪除片段數: ' + mergedSegs.length);
  console.error('刪除總時長: ' + deletedTime.toFixed(2) + 's');
  console.error('預計輸出時長: ' + (DURATION - deletedTime).toFixed(2) + 's');

  const segInfos = keepSegs.map((seg, i) => ({
    i, start: seg.start, end: seg.end,
    out: path.join(TMP_DIR, 'seg_' + String(i).padStart(5, '0') + '.mp4'),
  }));
  // concat.txt 與 seg 檔同在 TMP_DIR：只寫檔名（concat demuxer 以 concat.txt 所在夾為基準）
  fs.writeFileSync(path.join(TMP_DIR, 'concat.txt'), segInfos.map(s => `file 'seg_${String(s.i).padStart(5, '0')}.mp4'`).join('\n'));
  fs.writeFileSync(path.join(TMP_DIR, 'segments.json'), JSON.stringify(segInfos));

  const TOTAL_SEGS = keepSegs.length;
  if (!TOTAL_SEGS) die('❌ 計算保留片段失敗');

  // ── 單趟濾鏡 vs 多段提取＋concat ──
  const THRESHOLD = parseInt(process.env.CUT_SINGLE_PASS_THRESHOLD || '12', 10);
  let USE_SINGLE_PASS = TOTAL_SEGS > THRESHOLD;
  if (LOSSLESS && TOTAL_SEGS > 1) USE_SINGLE_PASS = true; // 無損多段一律單趟保口型（2026-07-02 拍板）
  if (process.env.CUT_SINGLE_PASS === '1') USE_SINGLE_PASS = true;
  if (process.env.CUT_SINGLE_PASS === '0') USE_SINGLE_PASS = false;

  // faststart flags（mp4/mov 家族）
  const outExt = path.extname(OUTPUT).slice(1).toLowerCase();
  const MOVFLAGS = ['mp4', 'mov', 'm4v'].includes(outExt) ? ['-movflags', '+faststart'] : [];

  // ── 時間軸映射 ──
  const MAP_FILE = OUTPUT.replace(/\.[^.]+$/, '') + '.timeline_map.json';
  function writeTimelineMap(mapMode, actualDur) {
    try { fs.rmSync(MAP_FILE, { force: true }); } catch (_) {} // 先清舊映射（見 .sh 版說明）
    if (mapMode === 'packets') {
      try {
        const csv = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', 'file:' + INPUT], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        fs.writeFileSync(path.join(TMP_DIR, 'vpkts.csv'), csv);
      } catch (_) {}
    }
    const r = spawnSync('node', [path.join(SCRIPT_DIR, 'build_timeline_map.js'), path.join(TMP_DIR, 'segments.json'), mapMode, String(actualDur), MAP_FILE, TMP_DIR, INPUT_FPS], { stdio: 'inherit' });
    if (r.status !== 0) console.log('⚠️ timeline_map 生成失敗（SRT 將退回理想時間軸）');
  }

  // ffmpeg 執行（stderr inherit → -stats 的 time= 透傳給呼叫端解析）
  function runFfmpeg(args) {
    const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    return r.status === 0;
  }

  const afterCut = () => {
    // ── GIF 匯出（240P, 15fps；兩步法調色板）──
    if (process.env.CUT_EXPORT_GIF === '1') {
      const gifOut = OUTPUT.replace(/\.[^.]+$/, '') + '.gif';
      console.log('🎞️ 產生 GIF: ' + gifOut);
      const palette = path.join(TMP_DIR, 'palette.png');
      const ok = runFfmpeg(['-y', '-v', 'error', '-i', 'file:' + OUTPUT, '-vf', 'fps=15,scale=240:-1:flags=lanczos,palettegen', palette])
        && runFfmpeg(['-y', '-v', 'error', '-i', 'file:' + OUTPUT, '-i', palette, '-lavfi', 'fps=15,scale=240:-1:flags=lanczos [v]; [v][1:v] paletteuse', '-loop', '0', 'file:' + gifOut]);
      console.log(ok ? '✅ GIF: ' + gifOut : '⚠️ GIF 生成失敗');
    }
    // ── 音訊匯出（MP3）：從最終視訊抽音訊並刪除中繼視訊 ──
    if (process.env.CUT_AUDIO_ONLY === '1') {
      const mp3Out = OUTPUT.replace(/\.[^.]+$/, '') + '.mp3';
      console.log('🎵 抽取音訊為 MP3: ' + mp3Out);
      if (runFfmpeg(['-y', '-v', 'error', '-i', 'file:' + OUTPUT, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', 'file:' + mp3Out])) {
        try { fs.rmSync(OUTPUT, { force: true }); } catch (_) {}
        console.log(`✅ 音訊檔: ${mp3Out}（已刪除中繼視訊）`);
      } else {
        console.log('⚠️ MP3 轉換失敗，保留原視訊 ' + OUTPUT);
      }
    }
  };

  if (USE_SINGLE_PASS) {
    console.log(`🎛️ 單趟濾鏡切割（${TOTAL_SEGS} 段，trim/atrim+concat 一次重編碼，避免多段 concat 音訊破裂）`);
    // trim/atrim+concat（不用 select 巨型 between()——段數多會撐爆 ffmpeg 運算式解析器）
    const parts = []; const labels = [];
    segInfos.forEach((s, i) => {
      parts.push(`[0:v]trim=${s.start.toFixed(3)}:${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(`[0:a]atrim=${s.start.toFixed(3)}:${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    });
    parts.push(labels.join('') + `concat=n=${segInfos.length}:v=1:a=1[vc][a]`);
    parts.push('[vc]' + (SCALE_FILTER || 'null') + '[v]');
    const filtFile = path.join(TMP_DIR, 'filt.txt');
    fs.writeFileSync(filtFile, parts.join(';'));

    let ok;
    if (LOSSLESS) {
      console.log(`💎 無損單趟：影片 ${ENCODER_LABEL}、音訊 256k AAC 一次重編（保口型同步）`);
      ok = runFfmpeg(['-y', '-v', 'error', '-stats', '-i', 'file:' + INPUT, '-filter_complex_script', filtFile,
        '-map', '[v]', '-map', '[a]', '-c:v', ENCODER, ...ENCODER_ARGS, '-pix_fmt', PIX_FMT, ...FPS_ARGS,
        '-c:a', 'aac', '-b:a', '256k', ...MOVFLAGS, 'file:' + OUTPUT]);
    } else {
      ok = runFfmpeg(['-y', '-v', 'error', '-stats', '-i', 'file:' + INPUT, '-filter_complex_script', filtFile,
        '-map', '[v]', '-map', '[a]', '-c:v', ENCODER, ...ENCODER_ARGS,
        '-b:v', BITRATE_K + 'k', '-maxrate', MAXRATE_K + 'k', '-bufsize', BUFSIZE_K + 'k',
        '-pix_fmt', PIX_FMT, ...FPS_ARGS, ...AUDIO_ARGS, ...MOVFLAGS, 'file:' + OUTPUT]);
    }
    if (!ok) die('❌ 單趟切割失敗');
    console.log('');
    console.log('✅ 已保存: ' + OUTPUT);
    const newDur = probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', 'file:' + OUTPUT]);
    console.log(`📹 新時長: ${newDur}s`);
    writeTimelineMap('packets', newDur);
    afterCut();
    return;
  }

  // ── 多段提取＋concat 路徑 ──
  console.log(`✂️ 提取 ${TOTAL_SEGS} 個片段（並行度 ${PARALLEL}）...`);
  console.log(LOSSLESS
    ? `   編碼: ${ENCODER} ${ENCODER_ARGS.join(' ')} -pix_fmt ${PIX_FMT} (CRF-based, audio=copy)`
    : `   編碼: ${ENCODER} ${ENCODER_ARGS.join(' ')} -b:v ${BITRATE_K}k -pix_fmt ${PIX_FMT}`);

  const segArgs = segInfos.map((s) => {
    // 切點淡入淡出（無損 copy 模式已在上面把 FADE_DUR 歸零）
    const afChain = [];
    if (!LOSSLESS && FADE_DUR > 0.001) {
      const segDur = s.end - s.start;
      const fd = Math.min(FADE_DUR, segDur / 2);
      if (fd > 0.001) {
        afChain.push('afade=t=in:st=0:d=' + fd.toFixed(3));
        afChain.push('afade=t=out:st=' + Math.max(0, segDur - fd).toFixed(3) + ':d=' + fd.toFixed(3));
      }
    }
    // 混合跳轉：input seek 快跳到 start-PAD（前一個 keyframe），output seek 精準微調（幀準且影音對齊）
    const PAD = 1.0;
    const seekPre = Math.max(0, s.start - PAD);
    const fineOff = s.start - seekPre;
    const segLen = s.end - s.start;
    const args = ['-y', '-v', 'error',
      '-ss', seekPre.toFixed(3), '-accurate_seek', '-i', 'file:' + INPUT,
      '-ss', fineOff.toFixed(3), '-t', segLen.toFixed(3),
      '-c:v', ENCODER, ...ENCODER_ARGS];
    if (!LOSSLESS) args.push('-b:v', BITRATE_K + 'k', '-maxrate', MAXRATE_K + 'k', '-bufsize', BUFSIZE_K + 'k');
    args.push('-pix_fmt', PIX_FMT);
    if (SCALE_FILTER) args.push('-vf', SCALE_FILTER);
    args.push(...FPS_ARGS, ...AUDIO_ARGS);
    if (afChain.length) args.push('-af', afChain.join(','));
    args.push('-avoid_negative_ts', 'make_zero', 'file:' + s.out);
    return args;
  });

  // 並行池（同 .sh 的 4 路並行；-v error 無 stats，stderr 直通供錯誤顯示）
  let done = 0; let failed = false;
  const runPool = async () => {
    let next = 0;
    const worker = async () => {
      while (next < segArgs.length && !failed) {
        const idx = next++;
        const ok = await new Promise((resolve) => {
          const c = spawn('ffmpeg', segArgs[idx], { stdio: ['ignore', 'inherit', 'inherit'] });
          c.on('error', () => resolve(false));
          c.on('close', (code) => resolve(code === 0));
        });
        if (!ok) { failed = true; return; }
        done++;
        console.log(`PROGRESS=${done}/${TOTAL_SEGS}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, segArgs.length) }, worker));
  };

  runPool().then(() => {
    console.log(`PROGRESS=${TOTAL_SEGS}/${TOTAL_SEGS}`);
    if (failed) die('❌ 部分片段編碼失敗');
    console.log(`   ✅ 全部 ${TOTAL_SEGS} 個片段提取完成`);

    console.log('🔗 拼接...');
    const ok = runFfmpeg(['-y', '-v', 'error', '-stats', '-f', 'concat', '-safe', '0',
      '-i', path.join(TMP_DIR, 'concat.txt'), '-c', 'copy', ...MOVFLAGS, 'file:' + OUTPUT]);
    if (!ok) die('❌ 拼接失敗');

    console.log('');
    console.log('✅ 已保存: ' + OUTPUT);
    const newDur = probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', 'file:' + OUTPUT]);
    let newBr = probe(['-show_entries', 'stream=bit_rate', '-select_streams', 'v:0', '-of', 'csv=p=0', 'file:' + OUTPUT]);
    if (!newBr || newBr === 'N/A') newBr = probe(['-show_entries', 'format=bit_rate', '-of', 'csv=p=0', 'file:' + OUTPUT]);
    const newBrK = (newBr && newBr !== 'N/A') ? Math.floor(parseInt(newBr, 10) / 1000) : '?';
    console.log(`📹 新時長: ${newDur}s`);
    console.log(`📊 原始碼率: ${BITRATE_K}kbps → 輸出碼率: ${newBrK}kbps`);
    writeTimelineMap('segfiles', newDur);
    afterCut();
  });
}

main();
