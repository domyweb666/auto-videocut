#!/usr/bin/env node
/**
 * 批量訓練可視化儀表板
 *
 * 功能：
 * 1. 掃描目錄找 video+SRT 配對
 * 2. 管理訓練清單（增刪）
 * 3. 啟動批量訓練並即時顯示進度
 * 4. 可視化訓練結果（各規則精確率/召回率、靜音分佈圖、影片對比表）
 *
 * 用法: node training_server.js [port]
 * 預設: port=8900
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const buildReviewHtml = require('./generate_review');
const { parseAutoSelected } = buildReviewHtml;
const buildReviewDoc = require('./generate_review_doc'); // 純白文稿版審核頁（取代深色版，舊版保留備援）
const convertAiToIndices = require('./convert_ai_to_indices'); // 句級 sentences.json → 字級 {indices,reasons}

// 把 AI 句級結果（sentences.json）轉成審核頁吃的字級 auto_selected.json 並寫檔。
// 8900 流程的 AI 判斷寫在句級 sentences.json，但審核頁 / 匯出讀字級 auto_selected.json，
// 缺這一步會導致「AI 跑了但審核頁零標記」。回傳 {indices, reasons}，失敗回 null。
function writeAutoSelectedFromSentences(workDir) {
  try {
    const sentPath = path.join(workDir, '1_轉錄', 'sentences.json');
    const subsPath = path.join(workDir, '1_轉錄', 'subtitles_words.json');
    if (!fs.existsSync(sentPath) || !fs.existsSync(subsPath)) return null;
    const phrases = JSON.parse(fs.readFileSync(sentPath, 'utf8'));
    if (!Array.isArray(phrases) || !phrases.some(s => s && s.aiDelete)) return null; // AI 沒標任何刪除 → 不寫
    const words = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
    const { indices, reasons } = convertAiToIndices(phrases, words);
    const analysisDir = path.join(workDir, '2_分析');
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, 'auto_selected.json'),
                     JSON.stringify({ indices, reasons }, null, 2), 'utf8');
    return { indices, reasons };
  } catch (e) {
    console.error('⚠️ writeAutoSelectedFromSentences 失敗:', e.message);
    return null;
  }
}

// 估算匯出時 pause_flatten 會扣掉的靜音秒數（給審核頁「剪後」顯示真正的匯出長度）。
// 缺 silences.json 就現場用 detect_silences 補產（匯出時本來也要）。pause_flatten 關閉或無音檔 → 回 0。
function estimateSilenceRemovalSec(workDir) {
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'training_config.json'), 'utf8')); } catch (_) {}
    const PF = cfg.pause_flatten || {};
    if (PF.enabled === false) return 0;
    const target = PF.target_sec ?? 0.3, floor = PF.floor_sec ?? 0.2;
    const silPath = path.join(workDir, '2_分析', 'silences.json');
    const audioPath = path.join(workDir, '1_轉錄', 'audio.mp3');
    if (!fs.existsSync(silPath) && fs.existsSync(audioPath)) {
      try {
        fs.mkdirSync(path.join(workDir, '2_分析'), { recursive: true });
        require('child_process').execFileSync('node', [path.join(SCRIPT_DIR, 'detect_silences.js'), audioPath, silPath], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
      } catch (_) {}
    }
    if (!fs.existsSync(silPath)) return 0;
    let raw = JSON.parse(fs.readFileSync(silPath, 'utf8'));
    raw = Array.isArray(raw) ? raw : (raw.silences || []);
    let removed = 0;
    for (const s of raw) { const len = s.end - s.start; if (len >= floor && len > target) removed += (len - target); }
    return removed;
  } catch (_) { return 0; }
}

// 純白簡潔版剪輯頁（取代舊深色 CUT_HTML；無影片預覽，丟檔→處理→審核）
const CUT_DOC_HTML = `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>剪輯影片</title>
<style>
  body{margin:0;background:#f3f2ee;color:#2c2c2a;font-family:-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;}
  .wrap{max-width:560px;margin:48px auto;padding:0 16px;}
  h1{font-size:20px;font-weight:600;margin:0 0 4px;}
  .sub{font-size:13px;color:#888;margin:0 0 22px;}
  .card{background:#fff;border:1px solid #e3e1d9;border-radius:12px;padding:24px 26px;}
  label{display:block;font-size:13px;color:#5f5e5a;margin:0 0 6px;}
  .row{display:flex;gap:8px;margin-bottom:18px;}
  input[type=text],textarea{width:100%;box-sizing:border-box;background:#fff;border:1px solid #d3d1c7;border-radius:8px;padding:10px 12px;font-size:14px;color:#2c2c2a;font-family:inherit;}
  textarea{resize:vertical;min-height:84px;margin-bottom:18px;}
  button{border-radius:8px;font-size:14px;padding:10px 16px;cursor:pointer;border:1px solid #d3d1c7;background:#fff;color:#444441;}
  button:hover{background:#f1efe8;}
  .btn-go{width:100%;background:#2c2c2a;color:#fff;border:none;font-weight:600;padding:12px;}
  .btn-go:disabled{opacity:.5;cursor:not-allowed;}
  #progress{margin-top:22px;display:none;}
  .pbar{height:8px;background:#eee;border-radius:4px;overflow:hidden;}
  .pfill{height:100%;background:#2c2c2a;width:0%;transition:width .3s;}
  .pstep{font-size:13px;color:#5f5e5a;margin:10px 0 0;}
  .plog{font-size:12px;color:#9a988f;margin-top:6px;white-space:pre-wrap;max-height:120px;overflow:auto;line-height:1.6;}
  #done{display:none;margin-top:22px;text-align:center;}
  .btn-review{background:#185FA5;color:#fff;border:none;padding:12px 28px;font-weight:600;font-size:15px;}
  .err{color:#A32D2D;font-size:13px;margin-top:14px;white-space:pre-wrap;}
</style></head><body>
<div class="wrap">
  <h1>剪輯影片</h1>
  <p class="sub">丟影片、貼講稿（選填），按開始。中間機器全包，跑完去審核。</p>
  <div class="card">
    <label>影片路徑</label>
    <div class="row">
      <input type="text" id="videoInput" placeholder="貼上影片路徑，或點瀏覽">
      <button onclick="browse()" style="white-space:nowrap;">瀏覽</button>
    </div>
    <label>參考文稿（選填，講稿/大綱即可）— 有貼的話，審核時會標出疑似聽錯的字</label>
    <textarea id="refInput" placeholder="貼上這支影片的講稿或大綱；留空則直接辨識"></textarea>
    <button class="btn-go" id="goBtn" onclick="start()">開始處理</button>
    <div id="progress">
      <div class="pbar"><div class="pfill" id="pfill"></div></div>
      <p class="pstep" id="pstep">準備中…</p>
      <div class="plog" id="plog"></div>
    </div>
    <div id="done"><button id="rerunBtn" onclick="rerunAI()" style="margin-right:8px;">🔄 重新 AI 分析</button><button class="btn-review" onclick="openReview()">前往審核 →</button></div>
    <div class="err" id="err"></div>
  </div>
</div>
<script>
var baseName='';
function browse(){fetch('/api/native-browse').then(function(r){return r.json()}).then(function(d){if(d.path)document.getElementById('videoInput').value=d.path}).catch(function(e){alert('browse failed: '+e.message)});}
function fail(m){document.getElementById('err').textContent='✗ '+m;document.getElementById('goBtn').disabled=false;}
function start(){
  var vp=document.getElementById('videoInput').value.trim();
  if(!vp){alert('請先選影片');return;}
  baseName=vp.split(/[\\\\/]/).pop().replace(/\\.[^.]+$/,'');
  document.getElementById('err').textContent='';
  document.getElementById('done').style.display='none';
  document.getElementById('goBtn').disabled=true;
  document.getElementById('progress').style.display='block';
  fetch('/api/process-video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoPath:vp,referenceText:document.getElementById('refInput').value})})
    .then(function(r){return r.json()}).then(function(d){if(d.error){fail(d.error);return;}poll();}).catch(function(e){fail(e.message)});
}
function poll(){
  fetch('/api/cut-status').then(function(r){return r.json()}).then(function(s){
    document.getElementById('pfill').style.width=(s.progress||0)+'%';
    document.getElementById('pstep').textContent=(s.step||'')+' '+(s.progress||0)+'%';
    if(s.log&&s.log.length)document.getElementById('plog').textContent=s.log.slice(-4).join('\\n');
    if(s.error){fail(s.error);return;}
    if(s.running===false){document.getElementById('pstep').textContent='完成 100%';document.getElementById('pfill').style.width='100%';document.getElementById('done').style.display='block';document.getElementById('goBtn').disabled=false;return;}
    setTimeout(poll,1000);
  }).catch(function(){setTimeout(poll,1500);});
}
function rerunAI(){
  if(!confirm('重新完整跑一次 AI 分析？會覆蓋目前這支的 AI 刪除標記（重新從頭判斷）。字幕與音檔不會重轉。'))return;
  document.getElementById('done').style.display='none';
  document.getElementById('err').textContent='';
  document.getElementById('goBtn').disabled=true;
  document.getElementById('progress').style.display='block';
  document.getElementById('pstep').textContent='重新 AI 分析中…';
  fetch('/api/rerun-ai',{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error){fail(d.error);return;}poll();}).catch(function(e){fail(e.message)});
}
function openReview(){if(baseName)window.open('/review/'+encodeURIComponent(baseName),'_blank');}
</script></body></html>`;
const { getAvailableEncoders } = require('./encoder_utils');

// ── 匯出後驗證：呼叫 verify_export.js，回傳解析後結果（永不 throw，驗證問題不阻斷匯出）──
function runVerify(outputFile, inputFile, deleteSegmentsPath, tag = '') {
  try {
    const verifyScript = path.join(__dirname, 'verify_export.js');
    if (!fs.existsSync(verifyScript)) return null;
    let stdout;
    try {
      stdout = execSync(
        `node "${verifyScript}" --output "${outputFile}" --input "${inputFile}" --delete "${deleteSegmentsPath}" --json`,
        { encoding: 'utf8' }
      );
    } catch (e) {
      // verify_export 在有 FAIL 時退出碼 2，execSync 會 throw，但 stdout 仍含完整 JSON
      stdout = e.stdout;
    }
    const result = JSON.parse(stdout);
    const fails = result.checks.filter(c => c.level === 'fail');
    const warns = result.checks.filter(c => c.level === 'warn');
    if (fails.length)      console.error(`❌ ${tag}匯出驗證 FAIL：${fails.map(c => `${c.name} — ${c.msg}`).join('; ')}`);
    else if (warns.length) console.warn (`⚠️ ${tag}匯出驗證警示：${warns.map(c => `${c.name} — ${c.msg}`).join('; ')}`);
    else                   console.log  (`✅ ${tag}匯出驗證全數通過`);
    return result;
  } catch (err) {
    console.error(`⚠️ ${tag}匯出驗證無法執行（不影響匯出）：${err.message}`);
    return null;
  }
}

const PORT = process.argv[2] || 8900;
const SCRIPT_DIR = __dirname;

// ── 苦工層精修 orchestration（停頓壓平/切點吸附/咳嗽/音訊分句）共用工具 ──
// 8900 是唯一服務器（剪輯 + 審核 + 訓練）；舊的 8899 review_server 已退役移除。
// 慢步驟（RMS 序列 / 音訊靜音 / 咳嗽 ML）非阻塞、結果快取；refine 本身快、同步。
// 設計分流：原始 delete_segments=內容訊號；refined=苦工(落刀/SRT/verify)。任何步驟失敗皆降級用原始切點，不擋出片。
function prepareArtifacts(workDir, subsPath, audioPath, analysisDir, cb) {
  const art = {
    rms: path.join(analysisDir, 'audio_rms.json'),
    sil: path.join(analysisDir, 'silences.json'),
    cough: path.join(analysisDir, 'cough_ml.json'),
    ok: false,
  };
  try { fs.mkdirSync(analysisDir, { recursive: true }); } catch (_) {}
  if (!audioPath || !fs.existsSync(audioPath) || !fs.existsSync(subsPath)) { cb(art); return; }
  art.ok = true;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'training_config.json'), 'utf8')); } catch (_) {}
  const coughEnabled = (cfg.cough_ml || {}).enabled !== false;
  const steps = [];
  if (!fs.existsSync(art.rms))
    steps.push(['python', [path.join(SCRIPT_DIR, 'extract_audio_features.py'), audioPath, subsPath, path.join(analysisDir, 'audio_features.json'), '--dump-series', art.rms]]);
  if (!fs.existsSync(art.sil))
    steps.push(['node', [path.join(SCRIPT_DIR, 'detect_silences.js'), audioPath, art.sil]]);
  if (coughEnabled && !fs.existsSync(art.cough))
    steps.push(['python', [path.join(SCRIPT_DIR, 'detect_coughs_ml.py'), audioPath, art.cough, '--thr', '0.2']]);
  const { execFile } = require('child_process');
  let i = 0;
  const next = () => {
    if (i >= steps.length) { cb(art); return; }
    const [c, a] = steps[i++];
    execFile(c, a, { maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) console.warn('[8900 精修] 步驟失敗(略過):', (err.message || '').split('\n')[0]);
      next();
    });
  };
  next();
}

// 用 art（rms/silences/cough）把「內容刪除段」精修成 refined 檔。同步、快。回傳路徑或 null（降級）。
function buildRefined(subsPath, contentSegments, art, workDir, outBase) {
  try {
    if (!art.ok) return null;
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'training_config.json'), 'utf8')); } catch (_) {}
    const minConf = (cfg.cough_ml || {}).min_confidence ?? 0.55;
    const coughPad = (cfg.cough_ml || {}).pad_sec ?? 0.08; // 外擴，避免切點吸附把咳嗽邊緣留下
    let content = (contentSegments || []).map(s => ({ start: s.start, end: s.end }));
    if (art.cough && fs.existsSync(art.cough)) {
      try {
        const coughs = JSON.parse(fs.readFileSync(art.cough, 'utf8'))
          .filter(c => (c.confidence ?? 0) >= minConf)
          .map(c => ({ start: Math.max(0, c.start - coughPad), end: c.end + coughPad }));
        if (coughs.length) {
          content = [...content, ...coughs].sort((a, b) => a.start - b.start);
          console.log(`🤧 [8900] ML 咳嗽併入 ${coughs.length} 段（conf ≥ ${minConf}）`);
        }
      } catch (_) {}
    }
    const { execFileSync } = require('child_process');
    const contentFile = path.join(workDir, outBase.replace(/\.refined\.json$/, '.content.json'));
    fs.writeFileSync(contentFile, JSON.stringify(content, null, 2));
    const refined = path.join(workDir, outBase);
    execFileSync('node', [path.join(SCRIPT_DIR, 'refine_segments.js'), subsPath, contentFile, art.rms, art.sil, refined], { stdio: 'pipe' });
    return fs.existsSync(refined) ? refined : null;
  } catch (e) {
    console.warn('[8900 精修] refine 失敗，用原始切點:', (e.message || '').split('\n')[0]);
    return null;
  }
}

const REVIEW_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
};

/**
 * 由 videoName（不含副檔名）反查它的原始影片路徑與 cut_work 目錄。
 * 先看 cutState（最近一次處理的影片），再從 batchState.items 找。
 */
function findVideoForName(videoName) {
  if (cutState.videoPath) {
    const bn = path.basename(cutState.videoPath).replace(/\.[^/.]+$/, '');
    if (bn === videoName) {
      return { videoPath: cutState.videoPath, workDir: cutState.workDir };
    }
  }
  for (const item of (batchState && batchState.items) || []) {
    const bn = path.basename(item.videoPath).replace(/\.[^/.]+$/, '');
    if (bn === videoName) {
      return {
        videoPath: item.videoPath,
        workDir: path.join(process.cwd(), 'cut_work', bn),
      };
    }
  }
  // fallback：cut_work/<name>/ 存在但 batch 已被清掉，至少能服務字幕/AI
  const fallbackWork = path.join(process.cwd(), 'cut_work', videoName);
  if (fs.existsSync(fallbackWork)) {
    return { videoPath: null, workDir: fallbackWork };
  }
  return null;
}

/** 用 stream + Range 回傳檔案（影片拖動需要）*/
function serveFileWithRange(req, res, filePath, contentType) {
  const stat = fs.statSync(filePath);
  if (req.headers.range) {
    const range = req.headers.range.replace('bytes=', '').split('-');
    const start = parseInt(range[0], 10);
    const end = range[1] ? parseInt(range[1], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// 剪輯狀態
let cutState = {
  running: false,
  step: '',
  videoPath: null,
  workDir: null,
  subtitlesPath: null,
  autoSelectedPath: null,
  outputPath: null,
  log: [],
  error: null
};

// 匯出進度狀態（審核頁匯出改成非同步，讓前端輪詢百分比）
let exportState = { running: false, progress: 0, step: '', videoName: '', result: null, error: null };

function startCutProcess(videoPath, referenceText) {
  const baseName = path.basename(videoPath).replace(/\.[^/.]+$/, '');
  const workDir = path.join(process.cwd(), 'cut_work', baseName);
  const transcribeDir = path.join(workDir, '1_轉錄');
  const analysisDir = path.join(workDir, '2_分析');
  fs.mkdirSync(transcribeDir, { recursive: true });
  fs.mkdirSync(analysisDir, { recursive: true });

  // 前台貼的參考文稿 → 存成 reference.txt，後面 flag_against_reference.js 用它標「疑似聽錯」高亮
  if (referenceText && referenceText.trim()) {
    fs.writeFileSync(path.join(transcribeDir, 'reference.txt'), referenceText.trim(), 'utf8');
  }

  cutState = {
    running: true,
    step: '提取音頻',
    progress: 0,
    startTime: Date.now(),
    videoPath,
    workDir,
    subtitlesPath: path.join(transcribeDir, 'subtitles_words.json'),
    sentencesPath: path.join(transcribeDir, 'sentences.json'),
    autoSelectedPath: path.join(analysisDir, 'auto_selected.json'),
    outputPath: null,
    outputPathB: null,
    log: [],
    error: null
  };

  // 非同步執行（不阻塞事件迴圈，進度條才能即時更新）
  const { execFile } = require('child_process');
  const runCmd = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    if (opts.stdio === 'inherit') {
      if (child.stdout) child.stdout.pipe(process.stdout);
      if (child.stderr) child.stderr.pipe(process.stderr);
    }
  });

  (async () => {
    try {
      // Step 1: 提取音頻 (0-10%)
      cutState.step = '提取音頻';
      cutState.progress = 2;
      cutState.log.push('🎵 提取音頻...');
      const audioPath = path.join(transcribeDir, 'audio.mp3');
      if (!fs.existsSync(audioPath)) {
        // -ac 1 單聲道：openai/whisper 設定為單聲道，立體聲來源會被誤讀成兩倍長 → 轉錄全錯
        await runCmd('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'libmp3lame', '-q:a', '2', audioPath]);
      }
      cutState.progress = 10;

      // Step 2+3: BytePlus Seed Speech 一次出文字+字級時間碼 (10-65%)
      // --ddc off：要逐字原稿（含口水詞+時間碼），刪除全交給後面可審核的 pipeline 階段。
      // DDC(語義順滑)只刪口水詞、不刪重複句，實測 5 分鐘僅刪 1 個「嗯」，開了反而讓贅字失去時間碼、剪不掉。
      cutState.step = '語音轉錄';
      cutState.progress = 12;
      cutState.log.push('🎙️ BytePlus Seed Speech 轉錄（逐字，DDC off）...');
      if (!fs.existsSync(cutState.subtitlesPath)) {
        await runCmd('python', [path.join(SCRIPT_DIR, 'byteplus_transcribe.py'), 'audio.mp3', cutState.subtitlesPath, '--ddc', 'off'], {
          cwd: transcribeDir,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          timeout: 900000
        });
      }

      // Step 3.1: 套用常犯辨識錯字修正表（回饋迴路，不用講稿也生效）
      const corrTable = path.join(SCRIPT_DIR, '..', '用户习惯', '錯字修正表.json');
      if (fs.existsSync(corrTable)) {
        try {
          await runCmd('node', [path.join(SCRIPT_DIR, 'apply_corrections.js'), cutState.subtitlesPath, corrTable], {
            cwd: transcribeDir,
            env: { ...process.env },
            timeout: 60000
          });
        } catch (e) {
          cutState.log.push('⚠️ 套用錯字表失敗: ' + e.message);
        }
      }

      // Step 3.2: 有講稿就標出疑似聽錯（辨識 vs 講稿同音字）→ 審核介面黃底高亮，防「說 a 變 b 沒人發現」
      const refDoc = path.join(transcribeDir, 'reference.txt');
      if (fs.existsSync(refDoc)) {
        cutState.log.push('🔎 比對講稿，標記疑似聽錯...');
        try {
          await runCmd('node', [path.join(SCRIPT_DIR, 'flag_against_reference.js'), cutState.subtitlesPath, refDoc], {
            cwd: transcribeDir,
            env: { ...process.env },
            timeout: 120000
          });
        } catch (e) {
          cutState.log.push('⚠️ 講稿比對失敗（略過高亮）: ' + e.message);
        }
      }
      cutState.progress = 63;

      // Step 3.5: 抽聲學特徵（重複句「留講得圓滿那句」用，非無腦留後句）— 失敗不阻斷，退回留後句
      cutState.log.push('🔊 抽取聲學特徵（篤定度選 take）...');
      try {
        const featFile = path.join(transcribeDir, 'audio_features.json');
        if (!fs.existsSync(featFile)) {
          await runCmd('python', [path.join(SCRIPT_DIR, 'extract_audio_features.py'), 'audio.mp3', 'subtitles_words.json', 'audio_features.json'], {
            cwd: transcribeDir,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            timeout: 300000
          });
        }
      } catch (featErr) {
        cutState.log.push('⚠️ 聲學特徵抽取失敗（退回留後句）: ' + featErr.message);
      }
      cutState.progress = 65;

      // Step 4: AI 智慧分析（兩階段：潤飾 + 剪輯, 65-95%）
      cutState.step = 'AI 標記';
      cutState.progress = 68;
      const polishedPath = cutState.sentencesPath.replace(/\.json$/, '.polished.json');

      // 已有完整 AI 結果 → 直接跳過整段 AI 階段，**保留使用者已剪過的編輯**
      // 判斷標準：sentences.json 存在 + 至少有一個 aiDelete=true 的句子（代表 AI 真的跑過）
      let skipAI = false;
      if (fs.existsSync(cutState.sentencesPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(cutState.sentencesPath, 'utf8'));
          if (Array.isArray(existing) && existing.some(s => s.aiDelete === true)) {
            skipAI = true;
            const delCount = existing.filter(s => s.aiDelete).length;
            cutState.log.push(`♻️ 偵測到先前 AI 分析結果（${delCount} 句已標記），跳過 AI 重跑保留編輯`);
            cutState.log.push('  → 若想完整重跑 AI，請按介面上的「🔄 重新 AI 分析」按鈕');
            cutState.progress = 95;
          }
        } catch (_) { /* 解析失敗就視為沒有，照常跑 AI */ }
      }
      if (skipAI) { /* 跳過整段 AI block */ } else
      try {
        // 4a: 潤飾（加標點）— 用 haiku 省 token，純機械任務不需要 sonnet
        cutState.step = 'AI 標點';
        cutState.progress = 68;
        cutState.log.push('🖊️ [1/5] Claude AI 加標點中（haiku）...');
        await runCmd('node', [path.join(SCRIPT_DIR, 'ai_polish.js'), '--model', 'haiku', cutState.subtitlesPath, polishedPath], {
          timeout: 600000
        });
        cutState.progress = 75;

        // 4b: 剪輯判斷
        const serverConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '..', 'training_config.json'), 'utf8')); } catch(_) { return {}; } })();
        const usePairMode = serverConfig.use_pair_mode ?? false;
        if (usePairMode) {
          const cutInputPath  = polishedPath.replace(/\.json$/, '_cut_input.json');
          const outlinePath   = polishedPath.replace(/\.json$/, '_outline.json');

          // 4b-0: 意圖層（實驗 A）— 整集大綱
          cutState.step = 'AI 大綱';
          cutState.progress = 76;
          cutState.log.push('🗺️ [2/5] Claude 整集大綱分析中（Sonnet）...');
          try {
            await runCmd('node', [path.join(SCRIPT_DIR, 'ai_outline.js'), polishedPath, outlinePath], { timeout: 180000 });
            cutState.progress = 80;
          } catch (outlineErr) {
            cutState.log.push('⚠️ 意圖層分析失敗（繼續執行）: ' + outlineErr.message);
          }

          // 4b-1: 規則前置過濾（不算 AI step，吞在「AI 候選對」階段內顯示）
          cutState.step = 'AI 候選對';
          cutState.progress = 81;
          cutState.log.push('🔍 [3/5a] 規則前置過濾（adjacent_repeat / take_group / silence / 幻覺）...');
          const prefilterArgs = [path.join(SCRIPT_DIR, 'phrase_prefilter.js'), polishedPath, cutInputPath];
          if (fs.existsSync(outlinePath))              prefilterArgs.push('--outline-file', outlinePath);
          if (cutState.subtitlesPath && fs.existsSync(cutState.subtitlesPath))
                                                       prefilterArgs.push('--words-file', cutState.subtitlesPath);
          const featFile1 = path.join(transcribeDir, 'audio_features.json');
          if (fs.existsSync(featFile1))                prefilterArgs.push('--audio-features', featFile1);
          await runCmd('node', prefilterArgs, { timeout: 120000 });
          cutState.progress = 83;

          // 4b-2: AI 候選對判斷
          cutState.log.push('✂️ [3/5b] Claude 候選對 AI 判斷中（Sonnet）...');
          const pairsArgs = [path.join(SCRIPT_DIR, 'ai_cut_pairs.js'), cutInputPath, cutState.sentencesPath];
          if (fs.existsSync(outlinePath)) pairsArgs.push('--outline-file', outlinePath);
          await runCmd('node', pairsArgs, { timeout: 600000 });
          cutState.progress = 86;

          // 4b-3: 整稿潤稿 reviewer（Sonnet 看完整粗剪稿）
          cutState.step = 'AI 潤稿';
          cutState.progress = 87;
          cutState.log.push('🪄 [4/5] Claude reviewer 整稿潤稿中（Sonnet）...');
          try {
            const reviewerArgs = [
              path.join(SCRIPT_DIR, 'ai_polish_review.js'),
              '--pass', 'review',
              '--model', 'sonnet',
              cutState.sentencesPath,
            ];
            if (fs.existsSync(outlinePath)) reviewerArgs.push('--outline-file', outlinePath);
            await runCmd('node', reviewerArgs, { timeout: 600000 });
            cutState.progress = 90;
          } catch (revErr) {
            cutState.log.push('⚠️ reviewer 失敗（不阻塞，繼續）: ' + revErr.message);
          }

          // 4b-4: 整稿審核 audit（Sonnet 嚴格二讀）
          cutState.step = 'AI 二讀';
          cutState.progress = 91;
          cutState.log.push('🔍 [5/5] Claude audit 嚴格二讀中（Sonnet）...');
          try {
            const auditArgs = [
              path.join(SCRIPT_DIR, 'ai_polish_review.js'),
              '--pass', 'audit',
              '--model', 'sonnet',
              cutState.sentencesPath,
            ];
            if (fs.existsSync(outlinePath)) auditArgs.push('--outline-file', outlinePath);
            await runCmd('node', auditArgs, { timeout: 600000 });
            cutState.progress = 93;
          } catch (audErr) {
            cutState.log.push('⚠️ audit 失敗（不阻塞，繼續）: ' + audErr.message);
          }

          // 4b-5: 句中雜音清理（嗯/呃/欸這類）— 極快、無 AI、保守
          cutState.log.push('📐 [後處理] 句中 filler 清理...');
          try {
            await runCmd('node', [path.join(SCRIPT_DIR, 'inline_filler_trim.js'),
                                  cutState.sentencesPath, cutState.subtitlesPath],
                         { timeout: 30000 });
          } catch (fillerErr) {
            cutState.log.push('⚠️ inline filler 失敗（不阻塞）: ' + fillerErr.message);
          }
        } else {
          cutState.log.push('✂️ [2/2] Claude AI 剪輯判斷中（重錄/語氣詞/停頓）...');
          await runCmd('node', [path.join(SCRIPT_DIR, 'ai_cut.js'), polishedPath, cutState.sentencesPath], { timeout: 600000 });
        }

        // 驗證 AI 分析結果
        if (fs.existsSync(cutState.sentencesPath)) {
          const sentData = JSON.parse(fs.readFileSync(cutState.sentencesPath, 'utf8'));
          const hasAI = sentData.some(s => s.displayText || s.aiDelete);
          if (hasAI) {
            cutState.log.push('✅ AI 分析完成（兩階段）');
          } else {
            cutState.log.push('⚠️ AI 分析完成但未生效（缺少標點和刪除標記），可嘗試「重新 AI 分析」');
          }
        } else {
          cutState.log.push('⚠️ AI 分析未產生輸出');
        }
        cutState.progress = 95;
      } catch (aiErr) {
        cutState.log.push('⚠️ AI 分析失敗: ' + aiErr.message);
        cutState.log.push('💡 可在頁面上點擊「重新 AI 分析」按鈕重試');
      }

      // 句級 sentences.json → 字級 2_分析/auto_selected.json（審核頁與匯出實際讀這個）
      const autoRes = writeAutoSelectedFromSentences(workDir);
      if (autoRes) {
        cutState.log.push(`🏷️ 已產出刪除標記 ${autoRes.indices.length} 字 / ${Object.keys(autoRes.reasons).length} 段（auto_selected.json）`);
      } else {
        cutState.log.push('⚠️ 未產出 auto_selected.json（AI 無刪除標記或缺檔），審核頁將無預選');
      }

      // 背景備妥苦工件（靜音/RMS/咳嗽 ML）→ 審核完匯出時 buildRefined 就吃得到；咳嗽偵測較慢故不阻塞「完成」。
      // idempotent：prepareArtifacts 會跳過已存在的檔。缺了也只是匯出時降級不套咳嗽/吸附，不影響審核。
      cutState.log.push('🔧 背景偵測靜音/咳嗽（匯出時會用到，不影響現在審核）...');
      try {
        prepareArtifacts(workDir, cutState.subtitlesPath, path.join(transcribeDir, 'audio.mp3'), analysisDir, (art) => {
          if (art && art.ok) console.log(`🔧 [${baseName}] 苦工件就緒（silences/rms/cough）`);
        });
      } catch (_) {}

      cutState.step = '完成';
      cutState.progress = 100;
      cutState.log.push('✅ 處理完成，請審核刪除標記');
      cutState.running = false;
    } catch (err) {
      cutState.error = err.message;
      cutState.step = '失敗';
      cutState.log.push('❌ ' + err.message);
      cutState.running = false;
    }
  })();
}

// ── 批次處理佇列 ──
const BATCH_QUEUE_FILE = path.join(SCRIPT_DIR, 'batch_queue.json');

let batchState = {
  running: false,
  currentIndex: -1,
  items: [],       // { id, videoPath, status, startedAt, completedAt, error }
  log: [],
};

// 持久化佇列
function saveBatchQueue() {
  try { fs.writeFileSync(BATCH_QUEUE_FILE, JSON.stringify(batchState, null, 2)); } catch (_) {}
}

// 恢復佇列（重新啟動伺服器時讀取）
try {
  if (fs.existsSync(BATCH_QUEUE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(BATCH_QUEUE_FILE, 'utf8'));
    if (saved.items && Array.isArray(saved.items)) {
      // 重置 running 狀態（重啟後還原成 pending / error）
      saved.items.forEach(item => { if (item.status === 'running') item.status = 'interrupted'; });
      batchState.items = saved.items;
      batchState.log   = (saved.log || []).slice(-50);
    }
  }
} catch (_) {}

// 批次工作函式
async function runBatchWorker() {
  batchState.running = true;
  batchState.log.push(`[${new Date().toLocaleTimeString()}] 批次處理啟動（${batchState.items.filter(i => i.status === 'pending').length} 個待處理）`);
  saveBatchQueue();

  for (let i = 0; i < batchState.items.length; i++) {
    if (!batchState.running) break;
    const item = batchState.items[i];
    if (item.status !== 'pending') continue;

    batchState.currentIndex = i;
    item.status = 'running';
    item.startedAt = new Date().toISOString();
    batchState.log.push(`[${new Date().toLocaleTimeString()}] 開始處理: ${path.basename(item.videoPath)}`);
    saveBatchQueue();

    // 等待任何正在進行的 cutState 完成
    while (cutState.running) {
      await new Promise(r => setTimeout(r, 2000));
    }

    // 啟動處理
    startCutProcess(item.videoPath);

    // 輪詢等待完成（最多 90 分鐘）
    const deadline = Date.now() + 90 * 60 * 1000;
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!cutState.running || Date.now() > deadline) {
          clearInterval(check);
          resolve();
        }
      }, 3000);
    });

    item.completedAt = new Date().toISOString();
    if (cutState.error) {
      item.status = 'error';
      item.error  = cutState.error;
      batchState.log.push(`[${new Date().toLocaleTimeString()}] ❌ 失敗: ${path.basename(item.videoPath)} — ${cutState.error}`);
    } else {
      item.status = 'done';
      batchState.log.push(`[${new Date().toLocaleTimeString()}] ✅ 完成: ${path.basename(item.videoPath)}`);
    }
    saveBatchQueue();
  }

  batchState.running = false;
  batchState.currentIndex = -1;
  batchState.log.push(`[${new Date().toLocaleTimeString()}] 批次處理結束`);
  saveBatchQueue();
}

// 訓練狀態
let trainingState = {
  running: false,
  progress: 0,
  total: 0,
  currentVideo: '',
  log: [],
  results: null
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ────────────────────────────────────────────────
  // 批次審核相關路由（獨立區塊，便於後續維護）
  // ────────────────────────────────────────────────

  // GET /api/native-browse — 跳出 Windows 原生選檔視窗，回傳選到的影片路徑
  if (req.method === 'GET' && req.url === '/api/native-browse') {
    const { execFile } = require('child_process');
    // 指定初始目錄到本機的 cut_work（挑片的地方），讓對話框直接開在本機快速路徑，
    // 避免預設去枚舉「最近/網路位置」而卡十幾二十秒。找不到就退回 cwd。
    // 註：不設 AutoUpgradeEnabled=$false，保留現代 Explorer 風格對話框（速度靠 InitialDirectory）。
    let initDir = path.join(process.cwd(), 'cut_work');
    if (!fs.existsSync(initDir)) initDir = process.cwd();
    const initDirPs = initDir.replace(/'/g, "''"); // PS 單引號字串內的單引號要 double
    const ps = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.OpenFileDialog; $f.Title='Select video'; $f.InitialDirectory='" + initDirPs + "'; $f.RestoreDirectory=$true; $f.Filter='Video|*.mp4;*.mov;*.mkv;*.avi;*.flv;*.webm;*.m4v|All files|*.*'; if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Out.Write($f.FileName) }";
    execFile('powershell', ['-STA', '-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ path: (stdout || '').trim() }));
    });
    return;
  }

  // GET /api/encoders — 編碼器偵測（給 review.html 的匯出面板用）
  if (req.method === 'GET' && req.url === '/api/encoders') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getAvailableEncoders()));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /review/<videoName> — 動態產生並回傳該影片的 review.html
  if (req.method === 'GET' && req.url.startsWith('/review/')) {
    try {
      const videoName = decodeURIComponent(req.url.replace('/review/', '').split('?')[0]);
      if (!videoName) {
        res.writeHead(400); res.end('缺少影片名稱'); return;
      }
      const ctx = findVideoForName(videoName);
      if (!ctx) {
        res.writeHead(404); res.end('找不到影片：' + videoName); return;
      }
      const subsPath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
      const autoPath = path.join(ctx.workDir, '2_分析', 'auto_selected.json');
      if (!fs.existsSync(subsPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('該影片尚未產出字幕檔（subtitles_words.json）');
        return;
      }
      const words = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
      // auto_selected.json 不存在 → 從句級 sentences.json 即時補產（修「AI 跑了但審核頁零標記」）
      if (!fs.existsSync(autoPath)) {
        writeAutoSelectedFromSentences(ctx.workDir);
      }
      let autoSelected = [], autoReasons = {};
      if (fs.existsSync(autoPath)) {
        const raw = JSON.parse(fs.readFileSync(autoPath, 'utf8'));
        const parsed = parseAutoSelected(raw);
        autoSelected = parsed.autoSelected;
        autoReasons = parsed.autoReasons;
      }
      const enc = encodeURIComponent(videoName);
      const html = buildReviewDoc(words, autoSelected, autoReasons, {
        cutApiPath: `/api/cut/${enc}`,
        silenceRemovalSec: estimateSilenceRemovalSec(ctx.workDir),
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('產生審核頁失敗：' + err.message);
    }
    return;
  }

  // GET /review-asset/<videoName>/<resource> — 服務影片 / 字幕 / AI 預選
  if (req.method === 'GET' && req.url.startsWith('/review-asset/')) {
    try {
      const parts = req.url.replace('/review-asset/', '').split('/');
      const videoName = decodeURIComponent(parts[0] || '');
      const resource  = (parts[1] || '').split('?')[0];
      const ctx = findVideoForName(videoName);
      if (!ctx) { res.writeHead(404); res.end('影片未註冊'); return; }

      let filePath, contentType;
      if (resource === 'video') {
        if (!ctx.videoPath || !fs.existsSync(ctx.videoPath)) {
          res.writeHead(404); res.end('找不到原始影片檔'); return;
        }
        filePath = ctx.videoPath;
        contentType = REVIEW_MIME[path.extname(filePath).toLowerCase()] || 'video/mp4';
      } else if (resource === 'subtitles') {
        filePath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
        contentType = 'application/json';
      } else if (resource === 'auto-selected') {
        filePath = path.join(ctx.workDir, '2_分析', 'auto_selected.json');
        contentType = 'application/json';
      } else {
        res.writeHead(404); res.end('未知資源類型'); return;
      }

      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('檔案不存在：' + path.basename(filePath)); return;
      }
      serveFileWithRange(req, res, filePath, contentType);
    } catch (err) {
      res.writeHead(500); res.end('asset 服務失敗：' + err.message);
    }
    return;
  }

  // POST /api/cut/<videoName> — 對指定影片執行剪輯
  if (req.method === 'POST' && req.url.startsWith('/api/cut/')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const videoName = decodeURIComponent(req.url.replace('/api/cut/', '').split('?')[0]);
        const ctx = findVideoForName(videoName);
        if (!ctx) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '影片未註冊：' + videoName }));
          return;
        }
        if (!ctx.videoPath || !fs.existsSync(ctx.videoPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到原始影片檔' }));
          return;
        }

        const parsed = JSON.parse(body || '{}');
        let deleteList, exportOptions;
        if (Array.isArray(parsed)) {
          deleteList = parsed; exportOptions = {};
        } else {
          deleteList = parsed.deleteList || parsed.segments || [];
          exportOptions = parsed.exportOptions || {};
        }

        // 將 delete_segments.json 寫進該影片的工作目錄
        const deleteSegmentsPath = path.join(ctx.workDir, 'delete_segments.json');
        fs.writeFileSync(deleteSegmentsPath, JSON.stringify(deleteList, null, 2));
        console.log(`📝 [${videoName}] 保存 ${deleteList.length} 個刪除片段`);

        // ── 套用苦工層精修（停頓壓平/切點吸附/咳嗽）→ 與初始自動剪同一套，讓「審核後匯出」也吃到 pause_flatten ──
        // 重點：pause_flatten 只信「音訊實測靜音」(silences.json)，缺檔就現場用 detect_silences.js 補產；
        // 絕不退回 STT gap 亂壓（STT 字間隔看不到真實停頓，會誤砍一大段）。任何一步失敗 → 降級用原始切點，不擋出片。
        const _subsPath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
        const _audioPath = path.join(ctx.workDir, '1_轉錄', 'audio.mp3');
        const _analysisDir = path.join(ctx.workDir, '2_分析');
        const _art = {
          rms: path.join(_analysisDir, 'audio_rms.json'),
          sil: path.join(_analysisDir, 'silences.json'),
          cough: path.join(_analysisDir, 'cough_ml.json'),
          ok: fs.existsSync(_audioPath) && fs.existsSync(_subsPath),
        };
        let cutDeleteFile = deleteSegmentsPath;
        if (_art.ok) {
          try {
            fs.mkdirSync(_analysisDir, { recursive: true });
            if (!fs.existsSync(_art.sil))
              require('child_process').execFileSync('node', [path.join(SCRIPT_DIR, 'detect_silences.js'), _audioPath, _art.sil], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
          } catch (e) { console.warn(`[${videoName}] detect_silences 失敗，匯出不套停頓壓平:`, (e.message || '').split('\n')[0]); }
          // 只有拿到「非空的音訊實測靜音」才套精修；否則維持原始切點（不讓 refine 內部退回 STT gap）
          let hasAudioSil = false;
          try { const _s = JSON.parse(fs.readFileSync(_art.sil, 'utf8')); hasAudioSil = (Array.isArray(_s) ? _s : (_s.silences || [])).length > 0; } catch (_) {}
          if (hasAudioSil) {
            const _refined = buildRefined(_subsPath, deleteList, _art, ctx.workDir, 'delete_segments.refined.json');
            if (_refined) { cutDeleteFile = _refined; console.log(`✨ [${videoName}] 已套用停頓壓平/切點吸附/咳嗽（匯出用 refined）`); }
          } else {
            console.log(`ℹ️ [${videoName}] 無音訊實測靜音，匯出維持原始切點（不套停頓壓平）`);
          }
        }

        const container = (exportOptions.container || 'mp4').toLowerCase();
        const mainExt = exportOptions.audioOnly ? 'mp3' : container;
        const baseName = path.basename(ctx.videoPath).replace(/\.[^/.]+$/, '');
        // 輸出資料夾：使用者指定且存在則用之，否則預設影片工作目錄
        let outDir = ctx.workDir;
        if (exportOptions.outputDir && typeof exportOptions.outputDir === 'string') {
          const od = exportOptions.outputDir.trim();
          try { if (od && fs.existsSync(od) && fs.statSync(od).isDirectory()) outDir = od; } catch (_) {}
        }
        const shellOutputFile = path.join(outDir, `${baseName}_cut.${container}`);
        const finalOutputFile = path.join(outDir, `${baseName}_cut.${mainExt}`);

        const env = {
          ...process.env,
          CUT_CODEC: exportOptions.codec || '',
          CUT_RESOLUTION: exportOptions.resolution || '',
          CUT_BITRATE_MODE: exportOptions.bitrate || 'recommended',
          CUT_FPS: exportOptions.fps || '',
          CUT_CONTAINER: container,
          CUT_AUDIO_ONLY: exportOptions.audioOnly ? '1' : '0',
          CUT_EXPORT_GIF: exportOptions.gif ? '1' : '0',
          CUT_LOSSLESS: exportOptions.lossless ? '1' : '0',  // 原畫質：影片 CRF17 近無損 + 音訊複製(真無損)
        };
        console.log(`🎬 [${videoName}] 匯出 → ${outDir}`, { container, audioOnly: env.CUT_AUDIO_ONLY === '1', lossless: env.CUT_LOSSLESS === '1' });

        const scriptPath = path.join(SCRIPT_DIR, 'cut_video.sh');
        // Windows 用 Git Bash 全路徑，避免 PATH 上的 bash 解析成 WSL bash（吃不了 C:/ 路徑會直接失敗）
        const bashBin = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';

        // ── 非同步落刀：串流 stdout 解析 PROGRESS=N/TOTAL → exportState.progress，前端輪詢 /api/export-status ──
        exportState = { running: true, progress: 2, step: '準備', videoName, result: null, error: null };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        const child = spawn(bashBin, [
          scriptPath.replace(/\\/g, '/'),
          ctx.videoPath.replace(/\\/g, '/'),
          cutDeleteFile.replace(/\\/g, '/'),   // refined（含停頓壓平）或降級回原始切點
          shellOutputFile.replace(/\\/g, '/'),
        ], { cwd: outDir, env });
        exportState.step = '剪輯中';
        let cutErr = '';
        // 開跑前就算好預估輸出長度（原片長 − refined 刪除總長），供單趟路徑用 ffmpeg time= 換算百分比。
        // 不靠 stdout 的「预计输出时长」——那行 pipe 下 block-buffered，會到結束才 flush。
        let expDur = 0;
        try {
          const origDur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${ctx.videoPath}"`).toString().trim()) || 0;
          let delSum = 0;
          try { const _dl = JSON.parse(fs.readFileSync(cutDeleteFile, 'utf8')); const _arr = Array.isArray(_dl) ? _dl : (_dl.segments || _dl.deleteList || []); for (const s of _arr) delSum += Math.max(0, (s.end - s.start)); } catch (_) {}
          expDur = Math.max(0, origDur - delSum);
        } catch (_) {}
        child.stdout.on('data', chunk => {
          const text = chunk.toString();
          process.stdout.write(text);
          for (const ln of text.split(/[\r\n]+/)) {
            const m = ln.match(/PROGRESS=(\d+)\/(\d+)/); // 多段平行路徑
            if (m && +m[2] > 0) { exportState.progress = Math.min(92, 5 + Math.floor((+m[1] / +m[2]) * 85)); exportState.step = `剪輯片段 ${m[1]}/${m[2]}`; }
          }
        });
        child.stderr.on('data', c => {
          const text = c.toString();
          cutErr += text; process.stderr.write(c);
          // 單趟重編碼路徑：ffmpeg 進度(time=)寫在 stderr，用「预计输出时长」換算百分比
          if (expDur > 0) {
            const t = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
            if (t && t.length) {
              const last = t[t.length - 1].match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
              const sec = (+last[1]) * 3600 + (+last[2]) * 60 + parseFloat(last[3]);
              exportState.progress = Math.min(92, 5 + Math.floor((sec / expDur) * 85));
              exportState.step = '編碼中';
            }
          }
        });
        child.on('error', e => { exportState.error = 'cut_video.sh 啟動失敗：' + e.message; exportState.running = false; exportState.progress = 100; });
        child.on('close', code => {
          try {
            if (code !== 0) { exportState.error = (cutErr.slice(-300) || ('exit ' + code)); exportState.running = false; exportState.progress = 100; return; }
            const outputFile = fs.existsSync(finalOutputFile) ? finalOutputFile : shellOutputFile;
            exportState.step = '產字幕/驗證'; exportState.progress = 94;
            // 自動產出 SRT 字幕（音訊匯出模式不產 SRT）
            let srtFile = null;
            if (!exportOptions.audioOnly) {
              try {
                const srtScript = path.join(SCRIPT_DIR, 'generate_cut_srt.js');
                const subtitlesPath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
                srtFile = outputFile.replace(/\.[^/.]+$/, '.srt');
                if (fs.existsSync(srtScript) && fs.existsSync(subtitlesPath))
                  execSync(`node "${srtScript}" "${subtitlesPath}" "${cutDeleteFile}" "${srtFile}"`, { stdio: 'pipe' });
              } catch (srtErr) { console.error(`⚠️ [${videoName}] SRT 失敗:`, srtErr.message); srtFile = null; }
            }
            const originalDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${ctx.videoPath}"`).toString().trim());
            const newDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${outputFile}"`).toString().trim());
            const deletedDuration = originalDuration - newDuration;
            const verify = runVerify(outputFile, ctx.videoPath, cutDeleteFile, `[${videoName}] `);
            exportState.result = {
              output: outputFile, srt: srtFile,
              originalDuration: originalDuration.toFixed(2), newDuration: newDuration.toFixed(2),
              deletedDuration: deletedDuration.toFixed(2),
              savedPercent: ((deletedDuration / originalDuration) * 100).toFixed(1),
              verify,
            };
            exportState.step = '完成'; exportState.progress = 100; exportState.running = false;
            console.log(`✅ [${videoName}] 匯出完成 → ${outputFile}`);
          } catch (e) {
            exportState.error = e.message; exportState.running = false; exportState.progress = 100;
          }
        });
      } catch (err) {
        console.error('❌ /api/cut/<name> 失敗:', err.message);
        exportState = { running: false, progress: 100, step: '', videoName: '', result: null, error: err.message };
        if (!res.headersSent) { // 若已回 {ok:true}（非同步落刀階段）就不再重複回應
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      }
    });
    return;
  }

  // GET /api/export-status — 審核頁匯出進度輪詢
  if (req.method === 'GET' && req.url === '/api/export-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(exportState));
    return;
  }

  // GET /api/native-browse-folder — 跳出 Windows 原生選資料夾視窗，回傳選到的資料夾
  if (req.method === 'GET' && req.url === '/api/native-browse-folder') {
    const { execFile } = require('child_process');
    let initDir = path.join(process.cwd(), 'output');
    if (!fs.existsSync(initDir)) initDir = process.cwd();
    const initDirPs = initDir.replace(/'/g, "''");
    const ps = "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description='選擇匯出資料夾'; $f.SelectedPath='" + initDirPs + "'; if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Out.Write($f.SelectedPath) }";
    execFile('powershell', ['-STA', '-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ path: (stdout || '').trim() }));
    });
    return;
  }

  // POST /api/diff-report/<videoName> — 把學習報告寫進該影片資料夾（接住前端 fire-and-forget）
  if (req.method === 'POST' && req.url.startsWith('/api/diff-report/')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const videoName = decodeURIComponent(req.url.replace('/api/diff-report/', '').split('?')[0]);
        const ctx = findVideoForName(videoName);
        if (ctx) {
          const reportPath = path.join(ctx.workDir, '2_分析', 'diff_report.json');
          fs.mkdirSync(path.dirname(reportPath), { recursive: true });
          fs.writeFileSync(reportPath, body);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── API: 掃描目錄 ──
  if (req.method === 'POST' && req.url === '/api/scan') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { directory } = JSON.parse(body);
        const pairs = scanDirectory(directory);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pairs }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── API: 啟動訓練 ──
  if (req.method === 'POST' && req.url === '/api/train') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { videos, options } = JSON.parse(body);
        if (trainingState.running) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '訓練進行中' }));
          return;
        }
        startTraining(videos, options || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '訓練已啟動' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── API: 訓練狀態 ──
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(trainingState));
    return;
  }

  // ── API: 讀取結果 ──
  if (req.method === 'GET' && req.url === '/api/results') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(trainingState.results || null));
    return;
  }

  // ── API: 批量學習建議 ──
  if (req.method === 'GET' && req.url === '/api/batch-suggestions') {
    try {
      const tmpDir = path.join(process.cwd(), 'training_output');
      const configPath = path.join(SCRIPT_DIR, '..', 'training_config.json');
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
      // 清除 require cache 以載入最新版
      delete require.cache[require.resolve(path.join(SCRIPT_DIR, 'generate_suggestions.js'))];
      const { generateBatchSuggestions } = require(path.join(SCRIPT_DIR, 'generate_suggestions.js'));

      // 收集所有 diff_report
      const diffReports = [];
      if (fs.existsSync(tmpDir)) {
        const subdirs = fs.readdirSync(tmpDir).filter(d => {
          return fs.statSync(path.join(tmpDir, d)).isDirectory() && d !== 'node_modules';
        });
        for (const dir of subdirs) {
          const diffPath = path.join(tmpDir, dir, '2_分析', 'diff_report.json');
          if (fs.existsSync(diffPath)) {
            const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
            diff._videoName = dir;
            diffReports.push(diff);
          }
        }
      }
      if (diffReports.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '尚無訓練數據，請先完成訓練' }));
        return;
      }
      const suggestions = generateBatchSuggestions(diffReports, config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suggestions, videoCount: diffReports.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: Autoresearch 自動優化 ──
  if (req.method === 'POST' && req.url === '/api/autoresearch') {
    if (trainingState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '訓練進行中，請稍候' }));
      return;
    }
    // 標記為執行中
    trainingState.running = true;
    trainingState.step = '自動優化';
    trainingState.log = ['🔬 啟動 Autoresearch v2...'];
    trainingState.startTime = Date.now();
    trainingState.endTime = null;
    trainingState.results = null;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '自動優化已啟動' }));

    // 非同步執行
    const arProcess = spawn('node', [path.join(SCRIPT_DIR, 'autoresearch.js')], {
      cwd: SCRIPT_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    arProcess.stdout.on('data', data => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        trainingState.log.push(line);
        // 更新進度文字
        if (line.includes('Phase')) trainingState.step = line.trim();
      }
    });
    arProcess.stderr.on('data', data => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) trainingState.log.push(line);
    });

    arProcess.on('close', code => {
      trainingState.running = false;
      trainingState.endTime = Date.now();
      if (code === 0) {
        trainingState.log.push('✅ 自動優化完成！');
        // 讀取報告
        const reportPath = path.join(SCRIPT_DIR, 'training_output', 'autoresearch_report.json');
        try {
          const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
          trainingState.step = `完成: F1 ${(report.baseline.f1*100).toFixed(1)}% → ${(report.final.f1*100).toFixed(1)}%`;
          trainingState.results = { autoresearch: report };
        } catch(e) {
          trainingState.step = '完成';
        }
      } else {
        trainingState.log.push('❌ 自動優化失敗 (exit code: ' + code + ')');
        trainingState.step = '失敗';
      }
    });
    return;
  }

  // ── API: 生成剪輯 Skills ──
  if (req.method === 'POST' && req.url === '/api/generate-skills') {
    if (trainingState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '正在執行其他任務，請稍候' }));
      return;
    }
    trainingState.running = true;
    trainingState.step = '生成剪輯 Skills';
    trainingState.log = ['📊 開始分析訓練數據，生成個人剪輯風格說明書...'];
    trainingState.startTime = Date.now();
    trainingState.endTime = null;
    trainingState.results = null;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '生成剪輯 Skills 已啟動' }));

    const gsProcess = spawn('node', [path.join(SCRIPT_DIR, 'generate_editing_skills.js'), '--force'], {
      cwd: SCRIPT_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    gsProcess.stdout.on('data', data => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) trainingState.log.push(line);
    });
    gsProcess.stderr.on('data', data => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) trainingState.log.push(line);
    });
    gsProcess.on('close', code => {
      trainingState.running = false;
      trainingState.endTime = Date.now();
      if (code === 0) {
        trainingState.log.push('✅ editing_skills.md 已生成！');
        trainingState.step = '生成完成';
        // 讀取生成的內容做摘要
        const skillsPath = path.join(SCRIPT_DIR, '..', 'editing_skills.md');
        try {
          const content = fs.readFileSync(skillsPath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());
          trainingState.results = { skills: { generated: true, lines: lines.length, preview: lines.slice(0, 5).join('\n') } };
        } catch (e) {
          trainingState.results = { skills: { generated: true } };
        }
      } else {
        trainingState.log.push('❌ 生成失敗 (exit code: ' + code + ')');
        trainingState.step = '失敗';
      }
    });
    return;
  }

  // ── API: AI 評估 ──
  if (req.method === 'POST' && req.url === '/api/ai-evaluate') {
    if (trainingState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '正在執行其他任務，請稍候' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let reqData = {};
      try { reqData = JSON.parse(body); } catch (e) {}
      const forceFlag       = reqData.force       ? ['--force']                               : [];
      const videoFlag       = reqData.video       ? ['--video', reqData.video]                : [];
      const sampleFlag      = reqData.sample      ? ['--sample', String(reqData.sample)]      : [];
      const concurrencyFlag = reqData.concurrency ? ['--concurrency', String(reqData.concurrency)] : [];

      trainingState.running = true;
      trainingState.step = 'AI 評估中';
      trainingState.log = ['🤖 開始 AI 評估（使用 editing_skills.md）...'];
      trainingState.startTime = Date.now();
      trainingState.endTime = null;
      trainingState.results = null;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'AI 評估已啟動' }));

      const aeProcess = spawn('node', [
        path.join(SCRIPT_DIR, 'ai_evaluate_training.js'),
        ...forceFlag,
        ...videoFlag,
        ...sampleFlag,
        ...concurrencyFlag
      ], {
        cwd: SCRIPT_DIR,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      aeProcess.stdout.on('data', data => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          trainingState.log.push(line);
          if (line.includes('[') && line.includes('/')) trainingState.step = '評估中: ' + line.trim();
        }
      });
      aeProcess.stderr.on('data', data => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) trainingState.log.push(line);
      });
      aeProcess.on('close', code => {
        trainingState.running = false;
        trainingState.endTime = Date.now();
        if (code === 0) {
          trainingState.log.push('✅ AI 評估完成！');
          const reportPath = path.join(SCRIPT_DIR, 'training_output', 'ai_evaluation_report.json');
          try {
            const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            trainingState.step = `AI 評估完成: F1 ${(report.overall.f1 * 100).toFixed(1)}%`;
            trainingState.results = { aiEval: report };
          } catch (e) {
            trainingState.step = '評估完成';
          }
        } else {
          trainingState.log.push('❌ AI 評估失敗 (exit code: ' + code + ')');
          trainingState.step = '失敗';
        }
      });
    });
    return;
  }

  // ── API: AI 評估狀態 + 讀取報告 ──
  if (req.method === 'GET' && req.url === '/api/ai-evaluate-status') {
    const reportPath = path.join(SCRIPT_DIR, 'training_output', 'ai_evaluation_report.json');
    const skillsPath = path.join(SCRIPT_DIR, '..', 'editing_skills.md');
    const arReportPath = path.join(SCRIPT_DIR, 'training_output', 'autoresearch_report.json');

    let aiReport = null, arReport = null, skillsInfo = null;
    try { aiReport = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (e) {}
    try { arReport = JSON.parse(fs.readFileSync(arReportPath, 'utf8')); } catch (e) {}
    try {
      if (fs.existsSync(skillsPath)) {
        const content = fs.readFileSync(skillsPath, 'utf8');
        const lines = content.split('\n');
        const headings = lines.filter(l => l.startsWith('#')).slice(0, 8);
        skillsInfo = {
          exists: true,
          mtime: fs.statSync(skillsPath).mtimeMs,
          lines: lines.length,
          headings
        };
      } else {
        skillsInfo = { exists: false };
      }
    } catch (e) { skillsInfo = { exists: false }; }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: trainingState.running && (trainingState.step || '').includes('評估'),
      aiReport,
      arReport: arReport ? { f1: arReport.final.f1, precision: arReport.final.precision, recall: arReport.final.recall, fp: arReport.final.fp, fn: arReport.final.fn, _perVideo: arReport.perVideo || [] } : null,
      skillsInfo
    }));
    return;
  }

  // ── API: 讀取 editing_skills.md 內容 ──
  if (req.method === 'GET' && req.url === '/api/skills-content') {
    const skillsPath = path.join(SCRIPT_DIR, '..', 'editing_skills.md');
    if (fs.existsSync(skillsPath)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync(skillsPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '尚未生成 editing_skills.md' }));
    }
    return;
  }

  // ── API: Skills Autoresearch ──
  if (req.method === 'POST' && req.url === '/api/skills-autoresearch') {
    if (trainingState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '正在執行其他任務，請稍候' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let reqData = {};
      try { reqData = JSON.parse(body); } catch (e) {}

      // 全自動模式：使用者只需設定 target；其他參數固定
      const isResume   = !!reqData.resume;
      const target     = reqData.target    || 0.90;
      const sample     = reqData.sample    || 8;
      const concur     = reqData.concurrency || 3;
      const fullEval   = reqData.fullEval !== false;
      const evalModel  = reqData.evalModel  || 'sonnet';  // 評估與執行階段都用 Sonnet（省 token）
      const execModel  = reqData.execModel  || 'sonnet';  // 執行階段：Sonnet alias
      const MAX_ITER_FIXED = 30;  // 固定上限，自動切換策略下不外露給使用者

      // 若是接續，先讀取上次 status 用於 UI 顯示
      let resumeInfo = null;
      if (isResume) {
        try {
          const sp = path.join(SCRIPT_DIR, 'training_output', 'skills_autoresearch_status.json');
          if (fs.existsSync(sp)) {
            const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
            if (s && !s.finishedAt) resumeInfo = s;
          }
        } catch (e) {}
      }

      trainingState.running   = true;
      trainingState.step      = isResume
        ? `接續 Skills 優化（目標 F1: ${(target * 100).toFixed(0)}%，已跑 ${resumeInfo ? resumeInfo.iter : '?'} 輪）`
        : `Skills 自動優化中（目標 F1: ${(target * 100).toFixed(0)}%）`;
      trainingState.log       = isResume
        ? [`📂 接續上次 Skills Autoresearch（已跑 ${resumeInfo ? resumeInfo.iter : '?'} 輪，最佳 F1: ${resumeInfo ? (resumeInfo.bestF1*100).toFixed(2) : '?'}%）`]
        : [`🚀 Skills Autoresearch 啟動（全自動，目標 F1: ${(target * 100).toFixed(0)}%，評估: ${evalModel}，執行: ${execModel}）`];
      trainingState.startTime = Date.now();
      trainingState.endTime   = null;
      trainingState.results   = null;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: isResume ? 'Skills Autoresearch 已接續' : 'Skills Autoresearch 已啟動（全自動雙策略）',
        resumed: isResume,
      }));

      const saArgs = [
        path.join(SCRIPT_DIR, 'ai_skills_autoresearch.js'),
        '--max-iter',   String(MAX_ITER_FIXED),
        '--target',     String(target),
        '--strategy',   'auto',
        '--sample',     String(sample),
        '--concurrency', String(concur),
        '--eval-model', evalModel,
        '--exec-model', execModel,
      ];
      if (isResume) saArgs.push('--resume');
      if (!fullEval) saArgs.push('--no-full-eval');

      const saProcess = spawn('node', saArgs, {
        cwd: SCRIPT_DIR,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      saProcess.stdout.on('data', data => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          trainingState.log.push(line);
          if (line.includes('第') && line.includes('輪')) trainingState.step = line.trim().slice(0, 40);
        }
      });
      saProcess.stderr.on('data', data => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) trainingState.log.push(line);
      });
      saProcess.on('close', code => {
        trainingState.running = false;
        trainingState.endTime = Date.now();
        const reportPath = path.join(SCRIPT_DIR, 'training_output', 'skills_autoresearch_report.json');
        try {
          const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
          const improved = ((report.bestF1 - report.startF1) * 100).toFixed(2);
          trainingState.step = `完成: F1 ${(report.startF1*100).toFixed(1)}% → ${(report.bestF1*100).toFixed(1)}% (+${improved}pp)`;
          trainingState.results = { skillsAr: report };
        } catch (e) {
          trainingState.step = code === 0 ? '完成' : '失敗';
        }
        if (code !== 0) trainingState.log.push('❌ Skills 自動優化失敗 (exit code: ' + code + ')');
        else trainingState.log.push('✅ Skills Autoresearch 完成！');
      });
    });
    return;
  }

  // ── API: Skills Autoresearch 狀態 ──
  if (req.method === 'GET' && req.url === '/api/skills-autoresearch-status') {
    const reportPath = path.join(SCRIPT_DIR, 'training_output', 'skills_autoresearch_report.json');
    const statusPath = path.join(SCRIPT_DIR, 'training_output', 'skills_autoresearch_status.json');
    let saReport = null, saStatus = null;
    try { saReport = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (e) {}
    try { saStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ report: saReport, status: saStatus }));
    return;
  }

  // ── API: Skills Autoresearch 是否有可接續任務（前端載入時用） ──
  if (req.method === 'GET' && req.url === '/api/skills-autoresearch-resumable') {
    const statusPath = path.join(SCRIPT_DIR, 'training_output', 'skills_autoresearch_status.json');
    let resumable = null;
    try {
      if (!trainingState.running && fs.existsSync(statusPath)) {
        const s = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        if (s && !s.finishedAt && (s.iter || 0) > 0
            && (s.status === 'running' || s.status === 'paused-quota' || s.status === 'starting')) {
          resumable = {
            iter:            s.iter,
            maxIter:         s.maxIter,
            bestF1:          s.bestF1,
            currentF1:       s.currentF1,
            startF1:         s.startF1,
            targetF1:        s.targetF1,
            currentStrategy: s.currentStrategy,
            status:          s.status,
            startedAt:       s.startedAt,
            pausedAt:        s.pausedAt,
            quotaPauseCount: s.quotaPauseCount || 0,
            message:         s.message,
          };
        }
      }
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ resumable }));
    return;
  }

  // ── API: 套用批量建議 ──
  if (req.method === 'POST' && req.url === '/api/apply-batch-suggestions') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { suggestions } = JSON.parse(body);
        const configPath = path.join(SCRIPT_DIR, '..', 'training_config.json');
        const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
        const applied = [];
        const skipped = [];

        for (const s of suggestions) {
          if (!s.checked) continue;
          const change = s.change;
          if (!change) { skipped.push({ id: s.id, reason: '需手動處理' }); continue; }

          if (change.path === 'silence.threshold') {
            if (!config.silence) config.silence = {};
            const old = config.silence.threshold;
            config.silence.threshold = change.to;
            applied.push({ id: s.id, desc: `silence.threshold: ${old} → ${change.to}` });
          } else if (change.path === 'filler_exceptions' && change.action === 'add') {
            if (!config.filler_exceptions) config.filler_exceptions = [];
            if (!config.filler_exceptions.includes(change.value)) {
              config.filler_exceptions.push(change.value);
              applied.push({ id: s.id, desc: `filler_exceptions: +「${change.value}」` });
            } else {
              skipped.push({ id: s.id, reason: `「${change.value}」已存在` });
            }
          } else if (change.path === 'delete_patterns' && change.action === 'add') {
            if (!config.delete_patterns) config.delete_patterns = [];
            if (!config.delete_patterns.includes(change.value)) {
              config.delete_patterns.push(change.value);
              applied.push({ id: s.id, desc: `delete_patterns: +「${change.value}」` });
            } else {
              skipped.push({ id: s.id, reason: `「${change.value}」已存在` });
            }
          } else if (change.action === 'add_to_md') {
            const mdFile = path.join(SCRIPT_DIR, '..', 'rules', 'user_habits', change.file || '10-保留連接詞.md');
            try {
              const existing = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
              if (!existing.includes(change.value)) {
                fs.appendFileSync(mdFile, `\n- ${change.value}`);
                applied.push({ id: s.id, desc: `保護詞 +「${change.value}」` });
              } else {
                skipped.push({ id: s.id, reason: `「${change.value}」已存在` });
              }
            } catch (e) {
              skipped.push({ id: s.id, reason: `.md 更新失敗: ${e.message}` });
            }
          } else {
            skipped.push({ id: s.id, reason: '不支援的變更類型' });
          }
        }

        if (applied.length > 0) {
          config._updated = new Date().toISOString();
          config._source = 'batch_approval';
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          const histPath = path.join(SCRIPT_DIR, '..', 'feedback_history.jsonl');
          fs.appendFileSync(histPath, JSON.stringify({
            timestamp: config._updated, source: 'batch_training_review',
            applied: applied.map(a => a.desc), skipped: skipped.map(s => s.reason)
          }) + '\n');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ applied, skipped }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── 首頁：直接給剪輯影片頁（不再用雙卡片選擇頁；訓練頁仍可從 /train 進） ──
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CUT_DOC_HTML);
    return;
  }

  // ── API: 瀏覽檔案系統 ──
  if (req.method === 'GET' && req.url.startsWith('/api/browse')) {
    const urlObj = new URL(req.url, 'http://localhost');
    let dirPath = urlObj.searchParams.get('path') || '';
    const filter = urlObj.searchParams.get('filter') || 'video'; // video | all

    try {
      // 如果沒有路徑，列出磁碟
      if (!dirPath) {
        const drives = [];
        // Windows: 檢查常見磁碟代號
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
          const dp = letter + ':\\';
          try { if (fs.existsSync(dp) && fs.statSync(dp).isDirectory()) drives.push({ name: dp, path: dp, type: 'drive' }); } catch(e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ current: '', items: drives }));
        return;
      }

      // 正規化路徑
      dirPath = path.resolve(dirPath);
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '目錄不存在: ' + dirPath }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = [];
      const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.ts'];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // 隱藏檔案
        const fullPath = path.join(dirPath, entry.name);
        try {
          if (entry.isDirectory()) {
            items.push({ name: entry.name, path: fullPath, type: 'dir' });
          } else if (filter !== 'folder' && (filter === 'all' || videoExts.some(ext => entry.name.toLowerCase().endsWith(ext)))) {
            const stat = fs.statSync(fullPath);
            items.push({ name: entry.name, path: fullPath, type: 'file', size: stat.size });
          }
        } catch(e) {} // 跳過無權限的
      }

      // 排序：資料夾在前，檔案在後
      items.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });

      const parent = path.dirname(dirPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ current: dirPath, parent: parent !== dirPath ? parent : '', items }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── 剪輯介面 ──
  if (req.url === '/cut' || req.url === '/cut.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CUT_DOC_HTML);
    return;
  }

  // ── API: 批次佇列 ──
  if (req.url.startsWith('/api/batch')) {
    const batchUrl = req.url.split('?')[0];

    // GET /api/batch — 取得佇列狀態
    if (req.method === 'GET' && batchUrl === '/api/batch') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batchState));
      return;
    }

    // POST /api/batch/add — 加入影片到佇列
    if (req.method === 'POST' && batchUrl === '/api/batch/add') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { videoPaths } = JSON.parse(body);
          if (!Array.isArray(videoPaths) || videoPaths.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '請提供 videoPaths 陣列' }));
            return;
          }
          let added = 0;
          for (const vp of videoPaths) {
            if (!vp || typeof vp !== 'string') continue;
            // 避免重複加入相同路徑（且尚未完成）
            const dup = batchState.items.find(i => i.videoPath === vp && i.status !== 'done' && i.status !== 'error');
            if (dup) continue;
            batchState.items.push({
              id: Date.now() + '-' + added,
              videoPath: vp,
              status: fs.existsSync(vp) ? 'pending' : 'error',
              error: fs.existsSync(vp) ? null : '檔案不存在',
              startedAt: null,
              completedAt: null,
            });
            added++;
          }
          saveBatchQueue();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ added, total: batchState.items.length }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /api/batch/remove — 移除佇列項目（by id）
    if (req.method === 'POST' && batchUrl === '/api/batch/remove') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          const before = batchState.items.length;
          batchState.items = batchState.items.filter(i => i.id !== id);
          saveBatchQueue();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ removed: before - batchState.items.length }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /api/batch/clear — 清除已完成 / 錯誤項目
    if (req.method === 'POST' && batchUrl === '/api/batch/clear') {
      req.resume();
      batchState.items = batchState.items.filter(i => i.status === 'pending' || i.status === 'running');
      saveBatchQueue();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ remaining: batchState.items.length }));
      return;
    }

    // POST /api/batch/start — 啟動批次工作
    if (req.method === 'POST' && batchUrl === '/api/batch/start') {
      req.resume();
      if (batchState.running) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '批次已在執行中' }));
        return;
      }
      const pendingCount = batchState.items.filter(i => i.status === 'pending').length;
      if (pendingCount === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '沒有待處理項目' }));
        return;
      }
      runBatchWorker(); // 非同步，不等待
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `批次啟動，${pendingCount} 個待處理` }));
      return;
    }

    // POST /api/batch/stop — 停止批次（完成當前影片後停止）
    if (req.method === 'POST' && batchUrl === '/api/batch/stop') {
      req.resume();
      batchState.running = false;
      saveBatchQueue();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '已要求停止，當前影片完成後停止' }));
      return;
    }
  }

  // ── API: 剪輯 - 提取音頻+轉錄+標記 ──
  if (req.method === 'POST' && req.url === '/api/process-video') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { videoPath, referenceText } = JSON.parse(body);
        if (!videoPath || !fs.existsSync(videoPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '找不到影片: ' + videoPath }));
          return;
        }
        if (cutState.running) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '剪輯進行中' }));
          return;
        }
        startCutProcess(videoPath, referenceText);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '處理已啟動' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── API: 剪輯狀態 ──
  if (req.method === 'GET' && req.url === '/api/cut-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cutState));
    return;
  }

  // ── API: 各層刪除分布（compare_layers）──
  if (req.method === 'GET' && req.url === '/api/compare-layers') {
    try {
      if (!cutState.sentencesPath || !fs.existsSync(cutState.sentencesPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sentences.json 尚未產生' }));
        return;
      }
      const cl = require('./compare_layers');
      const analysisDir = path.join(cutState.workDir, '2_分析');
      const result = cl.analyze(cutState.sentencesPath, analysisDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: SRT 反向對齊 ──
  if (req.method === 'POST' && req.url === '/api/srt-reverse-align') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { srtContent, outputDir } = JSON.parse(body);
        if (!cutState.subtitlesPath || !fs.existsSync(cutState.subtitlesPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '請先載入並處理影片（需要 subtitles_words.json）' }));
          return;
        }
        if (!srtContent || !srtContent.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '請提供 SRT 內容' }));
          return;
        }
        // 寫入臨時 SRT 檔
        const tmpSrt = path.join(cutState.workDir, '_reverse_input.srt');
        fs.writeFileSync(tmpSrt, srtContent, 'utf8');

        const { execFileSync: efsR } = require('child_process');
        const scriptR = path.join(SCRIPT_DIR, 'srt_reverse_align.js');
        const outDirR = (outputDir && fs.existsSync(path.dirname(outputDir))) ? outputDir : cutState.workDir;
        const stdout = efsR('node', [scriptR, tmpSrt, cutState.subtitlesPath, outDirR], {
          encoding: 'utf8', cwd: SCRIPT_DIR,
        });
        const idxFile  = path.join(outDirR, 'delete_indices.json');
        const segsFile = path.join(outDirR, 'delete_segments.json');
        const indices  = fs.existsSync(idxFile)  ? JSON.parse(fs.readFileSync(idxFile,  'utf8')) : [];
        const segments = fs.existsSync(segsFile) ? JSON.parse(fs.readFileSync(segsFile, 'utf8')) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deleteIndices: indices, deleteSegments: segments, log: stdout }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── API: GPU 編碼器偵測（非同步） ──
  // ── API: 保護詞讀取 / 寫入 ──
  const PROTECTED_WORDS_FILE = path.join(SCRIPT_DIR, '..', '用户习惯', '10-保留連接詞.md');
  if (req.method === 'GET' && req.url === '/api/protected-words') {
    try {
      const md = fs.readFileSync(PROTECTED_WORDS_FILE, 'utf8');
      const m = md.match(/```\r?\n([\s\S]*?)```/);
      const words = m
        ? m[1].split(/[、，\r?\n]/).map(w => w.trim().replace(/\r$/, '')).filter(Boolean)
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ words }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ words: [], error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/protected-words') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { words } = JSON.parse(body);
        if (!Array.isArray(words)) throw new Error('words must be array');
        const md = fs.readFileSync(PROTECTED_WORDS_FILE, 'utf8');
        // 替換 code block 中的內容，保留其餘說明文字
        const newBlock = '```\n' + words.join('、\n') + '\n```';
        const updated = md.replace(/```[\s\S]*?```/, newBlock);
        fs.writeFileSync(PROTECTED_WORDS_FILE, updated, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: words.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/gpu-info') {
    const { execFile: efGpu } = require('child_process');
    const detectGpu = (output) => {
      if (output.includes('h264_nvenc')) return 'NVENC (NVIDIA GPU)';
      if (output.includes('h264_qsv')) return 'QSV (Intel GPU)';
      if (output.includes('h264_amf')) return 'AMF (AMD GPU)';
      if (output.includes('h264_videotoolbox')) return 'VideoToolbox (macOS)';
      return 'x264 (\u8EDF\u7DE8\u78BC)';
    };
    efGpu('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '') + (err && err.stdout || '') + (err && err.stderr || '');
      const gpu = detectGpu(output);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ encoder: gpu }));
    });
    return;
  }

  // ── API: 音波圖資料（每 0.1s 一個 RMS dB 值）──
  if (req.method === 'GET' && req.url.startsWith('/api/waveform?')) {
    const wfParams = new URL(req.url, 'http://localhost');
    const wfPath = wfParams.searchParams.get('path');
    if (!wfPath || !fs.existsSync(wfPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file not found' }));
      return;
    }
    const { execFile: efWf } = require('child_process');
    // 用 ffmpeg astats 每 0.1s 輸出一行 RMS，解析後回傳陣列
    const ffmpegArgs = [
      '-i', wfPath,
      '-af', 'aresample=8000,astats=metadata=1:reset=1:length=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-'
    ];
    efWf('ffmpeg', ffmpegArgs, { encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      // astats 輸出在 stderr（metadata print to file=-）與 stdout 混合
      const output = stdout + stderr;
      const vals = [];
      for (const line of output.split('\n')) {
        const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if (m) {
          const db = parseFloat(m[1]);
          // dB → 0..1 linear amplitude（-60dB = 0, 0dB = 1）
          vals.push(Math.max(0, Math.min(1, (db + 60) / 60)));
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ values: vals, interval: 0.1 }));
    });
    return;
  }

  // ── API: 提供影片串流（支援 Range） ──
  if (req.method === 'GET' && req.url.startsWith('/api/video?')) {
    const urlParams = new URL(req.url, 'http://localhost');
    const filePath = urlParams.searchParams.get('path');
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  // ── API: 取得字幕數據 ──
  if (req.method === 'GET' && req.url === '/api/cut-subtitles') {
    if (cutState.subtitlesPath && fs.existsSync(cutState.subtitlesPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(cutState.subtitlesPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '尚無字幕數據' }));
    }
    return;
  }

  // ── API: 取得 AI 標記 ──
  if (req.method === 'GET' && req.url === '/api/cut-autoselected') {
    if (cutState.autoSelectedPath && fs.existsSync(cutState.autoSelectedPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(cutState.autoSelectedPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '尚無標記數據' }));
    }
    return;
  }

  // ── API: 重新執行 AI 分析（/api/rerun-ai 用目前 cutState；/api/rerun-ai/<name> 針對指定影片重建 cutState，供審核頁重跑）──
  if (req.method === 'POST' && (req.url === '/api/rerun-ai' || req.url.startsWith('/api/rerun-ai/'))) {
    if (req.url.startsWith('/api/rerun-ai/')) {
      if (cutState.running) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '正在處理中' })); return; }
      const nm = decodeURIComponent(req.url.replace('/api/rerun-ai/', '').split('?')[0]);
      const ctx = nm && findVideoForName(nm);
      if (!ctx) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '找不到影片：' + nm })); return; }
      const _td = path.join(ctx.workDir, '1_轉錄');
      cutState = {
        running: false, step: '', progress: 0, startTime: Date.now(),
        videoPath: ctx.videoPath, workDir: ctx.workDir,
        subtitlesPath: path.join(_td, 'subtitles_words.json'),
        sentencesPath: path.join(_td, 'sentences.json'),
        autoSelectedPath: path.join(ctx.workDir, '2_分析', 'auto_selected.json'),
        outputPath: null, outputPathB: null, log: [], error: null,
      };
    }
    if (!cutState.subtitlesPath || !fs.existsSync(cutState.subtitlesPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '無字幕檔案，請先處理影片' }));
      return;
    }
    if (cutState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '正在處理中' }));
      return;
    }

    // 刪除舊的 sentences.json 強制重新生成
    if (cutState.sentencesPath && fs.existsSync(cutState.sentencesPath)) {
      fs.unlinkSync(cutState.sentencesPath);
    }

    cutState.running = true;
    cutState.step = 'AI 標記';
    cutState.progress = 68;
    cutState.log.push('🔄 重新執行 AI 分析...');

    const { execFile } = require('child_process');
    const runAI = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

    (async () => {
      try {
        const polishedPath = cutState.sentencesPath.replace(/\.json$/, '.polished.json');

        // 4a: 潤飾 — 用 haiku 省 token
        cutState.log.push('🖊️ [1/2] 重新潤飾（加標點，haiku）...');
        await runAI('node', [path.join(SCRIPT_DIR, 'ai_polish.js'), '--model', 'haiku', cutState.subtitlesPath, polishedPath], {
          timeout: 600000
        });

        // 4b: 剪輯判斷
        const rerunConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '..', 'training_config.json'), 'utf8')); } catch(_) { return {}; } })();
        const rerunPairMode = rerunConfig.use_pair_mode ?? false;
        if (rerunPairMode) {
          const cutInputPath2 = polishedPath.replace(/\.json$/, '_cut_input.json');
          const outlinePath2  = polishedPath.replace(/\.json$/, '_outline.json');

          // 意圖層（重跑）
          cutState.log.push('🗺️ [2a/4] 重新整集大綱分析...');
          try {
            await runAI('node', [path.join(SCRIPT_DIR, 'ai_outline.js'), polishedPath, outlinePath2], { timeout: 180000 });
          } catch (e) {
            cutState.log.push('⚠️ 意圖層失敗（繼續）: ' + e.message);
          }

          cutState.log.push('🔍 [2b/4] 規則前置過濾...');
          const preArgs2 = [path.join(SCRIPT_DIR, 'phrase_prefilter.js'), polishedPath, cutInputPath2];
          if (fs.existsSync(outlinePath2))               preArgs2.push('--outline-file', outlinePath2);
          if (cutState.subtitlesPath && fs.existsSync(cutState.subtitlesPath))
                                                         preArgs2.push('--words-file', cutState.subtitlesPath);
          const featFile2 = cutState.subtitlesPath && path.join(path.dirname(cutState.subtitlesPath), 'audio_features.json');
          if (featFile2 && fs.existsSync(featFile2))     preArgs2.push('--audio-features', featFile2);
          await runAI('node', preArgs2, { timeout: 120000 });

          cutState.log.push('✂️ [2c/6] 重新候選對判斷...');
          const pairsArgs2 = [path.join(SCRIPT_DIR, 'ai_cut_pairs.js'), cutInputPath2, cutState.sentencesPath];
          if (fs.existsSync(outlinePath2)) pairsArgs2.push('--outline-file', outlinePath2);
          await runAI('node', pairsArgs2, {
            timeout: 600000
          });

          // 整稿潤稿 reviewer
          cutState.log.push('🪄 [2d/6] reviewer 整稿潤稿（Sonnet）...');
          try {
            const revArgs2 = [path.join(SCRIPT_DIR, 'ai_polish_review.js'),
                              '--pass', 'review', '--model', 'sonnet',
                              cutState.sentencesPath];
            if (fs.existsSync(outlinePath2)) revArgs2.push('--outline-file', outlinePath2);
            await runAI('node', revArgs2, { timeout: 600000 });
          } catch (e) { cutState.log.push('⚠️ reviewer 失敗（繼續）: ' + e.message); }

          // 整稿審核 audit
          cutState.log.push('🔍 [2e/6] audit 嚴格二讀（Sonnet）...');
          try {
            const audArgs2 = [path.join(SCRIPT_DIR, 'ai_polish_review.js'),
                              '--pass', 'audit', '--model', 'sonnet',
                              cutState.sentencesPath];
            if (fs.existsSync(outlinePath2)) audArgs2.push('--outline-file', outlinePath2);
            await runAI('node', audArgs2, { timeout: 600000 });
          } catch (e) { cutState.log.push('⚠️ audit 失敗（繼續）: ' + e.message); }

          // 字詞手術暫停（P=11% 無提升）
          // cutState.log.push('⏭️  [2f/6] 字詞手術已暫停');
        } else {
        cutState.log.push('✂️ [2/2] 重新剪輯判斷...');
        await runAI('node', [path.join(SCRIPT_DIR, 'ai_cut.js'), polishedPath, cutState.sentencesPath], {
          timeout: 600000
        });
        } // end else (rerunPairMode)

        // 驗證結果
        if (fs.existsSync(cutState.sentencesPath)) {
          try {
            const sentData = JSON.parse(fs.readFileSync(cutState.sentencesPath, 'utf8'));
            const hasAI = Array.isArray(sentData) && sentData.some(s => s.displayText || s.aiDelete);
            if (hasAI) {
              cutState.log.push('✅ AI 重新分析完成（兩階段）');
            } else {
              cutState.log.push('⚠️ AI 重新分析完成但仍未生效');
            }
          } catch (parseErr) {
            cutState.log.push('⚠️ sentences.json 解析失敗: ' + parseErr.message);
          }
        }
        // 重跑後刷新字級 auto_selected.json（否則審核頁仍讀到重跑前的舊標記）
        try {
          const _autoPath = path.join(cutState.workDir, '2_分析', 'auto_selected.json');
          if (fs.existsSync(_autoPath)) fs.unlinkSync(_autoPath);
          const _r = writeAutoSelectedFromSentences(cutState.workDir);
          cutState.log.push(_r ? `🏷️ 已刷新刪除標記 ${_r.indices.length} 字 / ${Object.keys(_r.reasons).length} 段` : 'ℹ️ 重跑後無 AI 刪除標記');
        } catch (_) {}
        cutState.progress = 100;
        cutState.step = '完成';
        cutState.running = false;
      } catch (err) {
        cutState.log.push('❌ AI 重新分析失敗: ' + err.message);
        cutState.progress = 100;
        cutState.step = '完成';
        cutState.running = false;
      }
    })();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── API: 取得 AI 斷句結果 ──
  if (req.method === 'GET' && req.url === '/api/cut-sentences') {
    if (cutState.sentencesPath && fs.existsSync(cutState.sentencesPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(cutState.sentencesPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no_sentences' }));
    }
    return;
  }

  // ── API: 執行剪輯 ──
  if (req.method === 'POST' && req.url === '/api/execute-cut') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { deleteIndices, resolution, codec, fps, quality, bitrate, container, exportSrt, outputDir, outputFilename, manualFeedback, abMode, abIndices } = JSON.parse(body);

        // 儲存手動回饋
        if (manualFeedback && cutState.autoSelectedPath) {
          try {
            const analysisDir = path.dirname(cutState.autoSelectedPath);
            fs.mkdirSync(analysisDir, { recursive: true });
            const fbPath = path.join(analysisDir, 'manual_feedback.json');
            fs.writeFileSync(fbPath, JSON.stringify(manualFeedback, null, 2));
            const fpN = manualFeedback.falsePositives?.length || 0;
            const fnN = manualFeedback.falseNegatives?.length || 0;
            console.log(`[feedback] 已儲存手動回饋: FP=${fpN} FN=${fnN} → ${fbPath}`);
            // 同步追加到全域累積 JSONL（供 ai_cut_pairs.js few-shot 使用）
            if (fpN > 0 || fnN > 0) {
              const corrFile = path.join(SCRIPT_DIR, 'training_output', 'user_corrections.jsonl');
              const corrDir = path.dirname(corrFile);
              if (!fs.existsSync(corrDir)) fs.mkdirSync(corrDir, { recursive: true });
              const line = JSON.stringify({
                timestamp: manualFeedback.timestamp || new Date().toISOString(),
                videoName: manualFeedback.videoName || '',
                falsePositives: (manualFeedback.falsePositives || []).slice(0, 20),
                falseNegatives: (manualFeedback.falseNegatives || []).slice(0, 20),
              });
              fs.appendFileSync(corrFile, line + '\n', 'utf8');
              console.log(`[feedback] 已追加到全域 JSONL: ${corrFile}`);
            }
          } catch(e) { console.warn('[feedback] 儲存失敗:', e.message); }
        }
        if (!cutState.subtitlesPath || !cutState.videoPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '請先處理影片' }));
          return;
        }
        if (!fs.existsSync(cutState.subtitlesPath)) {
          const reason = cutState.error ? `語音轉錄失敗：${cutState.error.split('\n')[0]}` : '語音轉錄尚未完成，請重新處理影片';
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: reason }));
          return;
        }
        if (cutState.running) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '正在處理中，請稍候' }));
          return;
        }
        const words = JSON.parse(fs.readFileSync(cutState.subtitlesPath, 'utf8'));
        const deleteSet = new Set(deleteIndices);
        // 擴展 gap：向後擴展到連續 gap 區段末尾（不向前，避免破壞 trim 保留段）
        for (const idx of [...deleteSet]) {
          if (words[idx] && words[idx].isGap) {
            let k = idx + 1;
            while (k < words.length && words[k].isGap) { deleteSet.add(k); k++; }
          }
        }
        // 合併連續刪除區間
        const segments = [];
        let segStart = null;
        for (let i = 0; i < words.length; i++) {
          if (deleteSet.has(i)) {
            if (segStart === null) segStart = words[i].start;
          } else {
            if (segStart !== null) {
              segments.push({ start: segStart, end: words[i - 1].end });
              segStart = null;
            }
          }
        }
        if (segStart !== null) segments.push({ start: segStart, end: words[words.length - 1].end });

        const deleteFile = path.join(cutState.workDir, 'delete_segments.json');
        fs.writeFileSync(deleteFile, JSON.stringify(segments, null, 2));

        const baseName = path.basename(cutState.videoPath).replace(/\\.[^/.]+$/, '');
        const outDir = (outputDir && fs.existsSync(outputDir)) ? outputDir : cutState.workDir;
        const ext = (container && ['mp4','mkv','mov'].includes(container.toLowerCase())) ? container.toLowerCase() : 'mp4';
        const safeFilename = outputFilename
          ? (/\.(mp4|mkv|mov)$/i.test(outputFilename) ? outputFilename : outputFilename + '.' + ext)
          : baseName + '_cut.' + ext;
        const outputFile = path.join(outDir, safeFilename);

        // 用 cut_video.sh 剪輯（帶匯出選項）— 非同步，不阻塞
        const scriptPath = path.join(SCRIPT_DIR, 'cut_video.sh').replace(/\\/g, '/');
        const inputPathUnix = cutState.videoPath.replace(/\\/g, '/');
        const deleteFileUnix = deleteFile.replace(/\\/g, '/');
        const outputFileUnix = outputFile.replace(/\\/g, '/');

        const { spawn } = require('child_process');
        const env = { ...process.env };
        if (quality === 'lossless') {
          env.CUT_LOSSLESS = '1';
          // 無損模式下，解析度/編碼器/fps 參數都強制忽略（避免 stream copy 與 scale 衝突）
        } else {
          if (resolution && resolution !== 'original') env.CUT_RESOLUTION = resolution;
          if (codec === 'h265' || codec === 'av1') env.CUT_CODEC = codec;
          if (fps && fps !== 'original') env.CUT_FPS = fps;
          if (bitrate && bitrate !== 'recommended') env.CUT_BITRATE_MODE = bitrate;
        }
        if (container && container !== 'mp4') env.CUT_CONTAINER = container;

        cutState.running = true;
        cutState.step = '剪輯中';
        cutState.progress = 50;
        cutState.log.push('✂️ 開始剪輯影片...');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '剪輯已開始' }));

        // ── 苦工層精修 orchestration（停頓壓平/切點吸附/咳嗽/音訊分句）→ 完成後才落刀 ──
        // 非阻塞：慢步驟(RMS/靜音/咳嗽ML)用 execFile 串接，伺服器與進度輪詢不凍結；失敗降級用原始切點。
        cutState.step = '準備中（靜音/咳嗽偵測）';
        const _analysisDir = path.join(cutState.workDir, '2_分析');
        const _audioPath = path.join(cutState.workDir, '1_轉錄', 'audio.mp3');
        prepareArtifacts(cutState.workDir, cutState.subtitlesPath, _audioPath, _analysisDir, (art) => {
        let cutDeleteFile = deleteFile;
        const _refinedA = buildRefined(cutState.subtitlesPath, segments, art, cutState.workDir, 'delete_segments.refined.json');
        if (_refinedA) { cutDeleteFile = _refinedA; cutState.log.push('✨ 已套用停頓壓平/切點吸附/咳嗽（落刀用 refined）'); }
        const cutDeleteFileUnix = cutDeleteFile.replace(/\\/g, '/');
        cutState.step = '剪輯中';

        // 非同步剪輯（Windows 用 Git Bash，避免 WSL bash）
        const bashPath = process.platform === 'win32'
          ? 'C:\\Program Files\\Git\\bin\\bash.exe'
          : 'bash';
        const child = spawn(bashPath, [scriptPath, inputPathUnix, cutDeleteFileUnix, outputFileUnix], {
          cwd: cutState.workDir,
          env,
        });

        // 串流 stdout：解析 PROGRESS=N/TOTAL 即時更新 cutState.progress（50% → 90%）
        let cutStdout = '';
        let cutStderr = '';
        child.stdout.on('data', chunk => {
          const text = chunk.toString();
          cutStdout += text;
          const lines = text.split(/\r?\n/);
          for (const ln of lines) {
            const m = ln.match(/PROGRESS=(\d+)\/(\d+)/);
            if (m) {
              const done = parseInt(m[1], 10);
              const total = parseInt(m[2], 10);
              if (total > 0) {
                cutState.progress = Math.min(89, 50 + Math.floor((done / total) * 40));
                cutState.step = `剪輯片段 ${done}/${total}`;
              }
            }
          }
        });
        child.stderr.on('data', chunk => { cutStderr += chunk.toString(); });

        child.on('close', code => {
          if (code !== 0) {
            cutState.log.push('❌ 剪輯失敗（exit=' + code + '）: ' + (cutStderr.slice(-300) || cutStdout.slice(-300)));
            cutState.step = '完成';
            cutState.running = false;
            cutState.error = cutStderr.slice(-200) || ('exit code ' + code);
            cutState.progress = 100;
            return;
          }
          cutState.outputPath = outputFile;
          cutState.log.push('✅ 剪輯完成: ' + outputFile);
          cutState.progress = 90;

          // ── 匯出後自動驗證（verify_export，advisory：不影響已完成的匯出）──
          // 用實際落刀的 cutDeleteFile（refined），verify 才對得上輸出
          const verify = runVerify(outputFile, cutState.videoPath, cutDeleteFile);
          cutState.verify = verify;
          if (verify) {
            const fails = verify.checks.filter(c => c.level === 'fail');
            const warns = verify.checks.filter(c => c.level === 'warn');
            if (fails.length)      cutState.log.push('❌ 匯出驗證 FAIL：' + fails.map(c => `${c.name} — ${c.msg}`).join('; '));
            else if (warns.length) cutState.log.push('⚠️ 匯出驗證警示：' + warns.map(c => `${c.name} — ${c.msg}`).join('; '));
            else                   cutState.log.push('✅ 匯出驗證全數通過');
          }

          // SRT 字幕匯出
          if (exportSrt) {
            const srtOutput = outputFile.replace(/\.(mp4|mkv|mov)$/i, '.srt');
            try {
              const { execFileSync: efs } = require('child_process');
              efs('node', [
                path.join(SCRIPT_DIR, 'generate_cut_srt.js'),
                cutState.subtitlesPath,
                cutDeleteFile,
                srtOutput
              ], { cwd: cutState.workDir });
              cutState.log.push('✅ SRT 字幕已生成');
              cutState.outputSrt = srtOutput;
            } catch (srtErr) {
              cutState.log.push('⚠️ SRT 生成失敗: ' + srtErr.message);
            }
          }

          // ── A/B 對比模式：A 完成後再跑 B 版 ──
          if (abMode && Array.isArray(abIndices) && abIndices.length > 0) {
            cutState.log.push('🔀 開始匯出 B 版（AI 建議）...');
            cutState.step = 'B版剪輯中';
            cutState.progress = 92;

            // 計算 B 版刪除區間
            const deleteSetB = new Set(abIndices);
            for (const idx of [...deleteSetB]) {
              if (words[idx] && words[idx].isGap) {
                let k = idx + 1;
                while (k < words.length && words[k].isGap) { deleteSetB.add(k); k++; }
              }
            }
            const segmentsB = [];
            let segStartB = null;
            for (let i = 0; i < words.length; i++) {
              if (deleteSetB.has(i)) {
                if (segStartB === null) segStartB = words[i].start;
              } else {
                if (segStartB !== null) {
                  segmentsB.push({ start: segStartB, end: words[i - 1].end });
                  segStartB = null;
                }
              }
            }
            if (segStartB !== null) segmentsB.push({ start: segStartB, end: words[words.length - 1].end });

            const deleteFileB = path.join(cutState.workDir, 'delete_segments_B.json');
            fs.writeFileSync(deleteFileB, JSON.stringify(segmentsB, null, 2));
            // B 版同樣套精修（art 已備好，refine 快、同步），A/B 才是同條件對比
            let cutDeleteFileB = deleteFileB;
            const _refinedB = buildRefined(cutState.subtitlesPath, segmentsB, art, cutState.workDir, 'delete_segments_B.refined.json');
            if (_refinedB) cutDeleteFileB = _refinedB;

            const outputFileB = outputFile.replace(/\.(mp4|mkv|mov)$/i, (m) => '_B' + m);
            const deleteFileBUnix = cutDeleteFileB.replace(/\\/g, '/');
            const outputFileBUnix = outputFileB.replace(/\\/g, '/');

            const childB = spawn(bashPath, [scriptPath, inputPathUnix, deleteFileBUnix, outputFileBUnix], {
              cwd: cutState.workDir,
              env,
            });
            childB.stdout.on('data', chunk => {
              const text = chunk.toString();
              process.stdout.write(text);
              const m = text.match(/PROGRESS=(\d+)\/(\d+)/g);
              if (m && m.length) {
                const last = m[m.length - 1].match(/PROGRESS=(\d+)\/(\d+)/);
                const done = parseInt(last[1], 10);
                const total = parseInt(last[2], 10);
                if (total > 0) {
                  cutState.progress = Math.min(99, 92 + Math.floor((done / total) * 7));
                  cutState.step = `B 版剪輯片段 ${done}/${total}`;
                }
              }
            });
            childB.stderr.on('data', c => process.stderr.write(c));
            childB.on('close', codeB => {
              if (codeB !== 0) {
                cutState.log.push('⚠️ B 版剪輯失敗（exit=' + codeB + '）');
              } else {
                cutState.log.push('✅ B 版剪輯完成: ' + outputFileB);
                cutState.outputPathB = outputFileB;
              }
              cutState.step = '完成';
              cutState.progress = 100;
              cutState.running = false;
            });
          } else {
            cutState.step = '完成';
            cutState.progress = 100;
            cutState.running = false;
          }
        });
        }); // ── end prepareArtifacts orchestration callback ──
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ── 掃描目錄找配對（遞迴掃子目錄） ──
// 模式 1（音檔比對）: 同資料夾內 .mkv（原始）+ .mp4（剪後成品）
// 模式 2（SRT 比對）: 同名 video + .srt
function scanDirectory(dir) {
  if (!fs.existsSync(dir)) return [];
  const pairs = [];

  const files = fs.readdirSync(dir);
  const mkvFiles = files.filter(f => /\.mkv$/i.test(f));
  const mp4Files = files.filter(f => /\.mp4$/i.test(f));
  const srtFiles = files.filter(f => /\.srt$/i.test(f));

  // 優先嘗試音檔比對模式：.mkv（原始）+ .mp4（剪後）
  if (mkvFiles.length === 1 && mp4Files.length === 1) {
    const editedName = mp4Files[0].replace(/\.mp4$/i, '');
    pairs.push({
      original: path.join(dir, mkvFiles[0]),
      edited: path.join(dir, mp4Files[0]),
      name: editedName,
      mode: 'audio'
    });
  } else if (mkvFiles.length === 1 && mp4Files.length > 1) {
    // 多個 mp4 但只有一個 mkv：mkv 是原始，最大的非 mkv 同名 mp4 是成品
    // 排除與 mkv 同名的 mp4
    const mkvBase = mkvFiles[0].replace(/\.mkv$/i, '');
    const candidates = mp4Files.filter(f => f.replace(/\.mp4$/i, '') !== mkvBase);
    if (candidates.length === 1) {
      const editedName = candidates[0].replace(/\.mp4$/i, '');
      pairs.push({
        original: path.join(dir, mkvFiles[0]),
        edited: path.join(dir, candidates[0]),
        name: editedName,
        mode: 'audio'
      });
    }
  }

  // Fallback：SRT 比對模式
  if (pairs.length === 0) {
    const allVideos = files.filter(f => /\.(mp4|mkv|mov|avi)$/i.test(f));
    for (const video of allVideos) {
      const baseName = video.replace(/\.[^/.]+$/, '');
      const matchingSrt = srtFiles.find(s => s.replace(/\.srt$/i, '') === baseName);
      if (matchingSrt) {
        pairs.push({
          video: path.join(dir, video),
          srt: path.join(dir, matchingSrt),
          name: baseName,
          mode: 'srt'
        });
      }
    }
  }

  // 遞迴掃子目錄
  for (const entry of files) {
    const fullPath = path.join(dir, entry);
    try {
      if (fs.statSync(fullPath).isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
        pairs.push(...scanDirectory(fullPath));
      }
    } catch (e) { /* 忽略無法讀取的目錄 */ }
  }

  return pairs;
}

// ── 啟動訓練（子程序） ──
function startTraining(videos, options) {
  trainingState = {
    running: true,
    progress: 0,
    total: videos.length,
    currentVideo: '',
    stepIndex: 0,       // 0=未開始, 1=提取音頻, 2=轉錄, 3=生成字幕, 4=規則標記, 5=對照SRT
    log: [],
    results: null,
    startTime: Date.now()
  };

  // 建立臨時 manifest（放在 cwd 下，避免 batch_train.js 再建一層 training_output）
  const tmpDir = path.join(process.cwd(), 'training_output');
  const manifestPath = path.join(process.cwd(), 'training_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ videos, options }, null, 2));

  const child = spawn('node', [path.join(SCRIPT_DIR, 'batch_train.js'), manifestPath], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });

  let currentIdx = 0;

  child.stdout.on('data', data => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      trainingState.log.push(line);
      // 解析影片進度 [N/M]
      const match = line.match(/\[(\d+)\/(\d+)\]/);
      if (match) {
        currentIdx = parseInt(match[1]);
        trainingState.progress = currentIdx;
        trainingState.total = parseInt(match[2]);
        trainingState.stepIndex = 0; // 新影片，重設步驟
      }
      // 解析影片名
      if (line.includes('═══') && line.includes('═══')) {
        const nameMatch = line.match(/═══.*?\]\s*(.+?)\s*═══/);
        if (nameMatch) trainingState.currentVideo = nameMatch[1];
      }
      // 解析步驟
      if (line.includes('提取音頻') || line.includes('提取音频') || line.includes('提取原始音頻') || line.includes('提取剪後音頻')) trainingState.stepIndex = 1;
      else if (line.includes('STT 轉錄') || line.includes('STT 转录') || line.includes('Whisper') || line.includes('OpenAI')) trainingState.stepIndex = 2;
      else if (line.includes('生成字幕') || line.includes('生成原始字幕') || line.includes('生成剪後字幕')) trainingState.stepIndex = 3;
      else if (line.includes('規則自動標記') || line.includes('规则自动标记')) trainingState.stepIndex = 4;
      else if (line.includes('對照 SRT') || line.includes('对照 SRT') || line.includes('音檔比對')) trainingState.stepIndex = 5;
      // 完成或失敗
      if (line.match(/[✅❌].*完成|[✅❌].*失敗/)) trainingState.stepIndex = 5;
    }
  });

  child.stderr.on('data', data => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      trainingState.log.push(line);
    }
  });

  child.on('close', code => {
    trainingState.running = false;
    trainingState.progress = trainingState.total;
    trainingState.endTime = Date.now();

    // 讀取結果
    try {
      const reportPath = path.join(tmpDir, 'training_report.md');
      const updatesPath = path.join(tmpDir, 'rule_updates.json');

      const results = { report: null, updates: null, diffReports: [] };

      if (fs.existsSync(reportPath)) {
        results.report = fs.readFileSync(reportPath, 'utf8');
      }
      if (fs.existsSync(updatesPath)) {
        results.updates = JSON.parse(fs.readFileSync(updatesPath, 'utf8'));
      }

      // 讀取各影片的 diff_report
      const outputDirs = fs.readdirSync(tmpDir).filter(d => {
        return fs.statSync(path.join(tmpDir, d)).isDirectory() && d !== 'node_modules';
      });
      for (const dir of outputDirs) {
        const diffPath = path.join(tmpDir, dir, '2_分析', 'diff_report.json');
        if (fs.existsSync(diffPath)) {
          const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
          diff._videoName = dir;
          results.diffReports.push(diff);
        }
      }

      trainingState.results = results;
    } catch (err) {
      trainingState.log.push('讀取結果失敗: ' + err.message);
    }
  });
}

// ── Dashboard HTML ──
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>批量訓練儀表板</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
      background: #1a1a1a;
      color: #e0e0e0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      background: #252525;
      padding: 12px 20px;
      border-bottom: 1px solid #333;
      display: flex;
      align-items: center;
      gap: 16px;
      flex-shrink: 0;
    }
    .header h1 { font-size: 16px; font-weight: 600; }
    .header .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: #333;
      color: #888;
    }
    .header .badge.running { background: #1b5e20; color: #81c784; }
    .header .badge.done { background: #0d47a1; color: #64b5f6; }

    .main { display: flex; flex: 1; overflow: hidden; }

    /* ── 左側面板：檔案管理 ── */
    .left-panel {
      width: 380px;
      border-right: 1px solid #333;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .panel-header {
      padding: 10px 16px;
      background: #222;
      border-bottom: 1px solid #333;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .add-pair-section {
      padding: 10px 16px;
      border-bottom: 1px solid #2a2a2a;
    }
    .add-pair-row {
      margin-bottom: 6px;
    }
    .add-pair-row label {
      display: block;
      font-size: 11px;
      color: #888;
      margin-bottom: 3px;
      font-weight: 500;
    }
    .add-pair-row input {
      width: 100%;
      padding: 6px 10px;
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #444;
      border-radius: 6px;
      font-size: 12px;
    }
    .add-pair-row input:focus { outline: none; border-color: #9C27B0; }
    .add-pair-btns {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .scan-toggle {
      padding: 6px 16px;
      font-size: 11px;
      color: #666;
      cursor: pointer;
      border-bottom: 1px solid #2a2a2a;
      user-select: none;
    }
    .scan-toggle:hover { color: #aaa; }
    .scan-bar {
      padding: 8px 16px;
      display: none;
      gap: 8px;
      border-bottom: 1px solid #2a2a2a;
    }
    .scan-bar.open { display: flex; }
    .scan-bar input {
      flex: 1;
      padding: 6px 10px;
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #444;
      border-radius: 6px;
      font-size: 12px;
    }
    .scan-bar input:focus { outline: none; border-color: #9C27B0; }

    .file-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .file-item {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      margin-bottom: 4px;
      background: #252525;
      border-radius: 6px;
      font-size: 13px;
      gap: 8px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .file-item:hover { background: #2d2d2d; }
    .file-item.checked { background: #1a2e1a; border: 1px solid #2e7d32; }
    .file-item .check { width: 18px; height: 18px; border: 2px solid #555; border-radius: 4px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    .file-item.checked .check { border-color: #4caf50; background: #4caf50; }
    .file-item.checked .check::after { content: '\\2713'; color: white; font-size: 12px; }
    .file-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-item .paths { flex: 1; overflow: hidden; min-width: 0; }
    .file-item .paths .pair-name { font-size: 13px; font-weight: 500; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-item .paths .pair-path { font-size: 10px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-item .paths .pair-path .tag { color: #9C27B0; font-weight: 600; margin-right: 3px; }
    .file-item .remove { opacity: 0; color: #f44336; cursor: pointer; font-size: 16px; flex-shrink: 0; }
    .file-item:hover .remove { opacity: 1; }

    .train-bar {
      padding: 10px 12px;
      border-top: 1px solid #333;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .train-bar-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .train-bar-label {
      font-size: 10px;
      color: #555;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      padding: 4px 0 2px;
      border-top: 1px solid #2a2a2a;
      margin-top: 1px;
    }

    /* ── 右側面板：結果 ── */
    .right-panel {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }

    /* ── 進度條 ── */
    .progress-section {
      margin-bottom: 20px;
      display: none;
    }
    .progress-section.show { display: block; }
    .progress-bar-bg {
      height: 8px;
      background: #333;
      border-radius: 4px;
      overflow: hidden;
      margin: 8px 0;
    }
    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #9C27B0, #E040FB);
      border-radius: 4px;
      transition: width 0.3s;
    }
    .progress-text { font-size: 13px; color: #aaa; }

    /* ── 步驟進度條 (Stepper) ── */
    .stepper {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      margin: 14px 0 8px;
      padding: 0 20px;
    }
    .step {
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
      flex: 1;
      max-width: 120px;
    }
    .step-circle {
      width: 32px; height: 32px; border-radius: 50%;
      background: #333; border: 2px solid #444;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; z-index: 1; transition: all 0.3s;
    }
    .step.done .step-circle { background: #7B1FA2; border-color: #9C27B0; }
    .step.active .step-circle {
      background: #9C27B0; border-color: #CE93D8;
      box-shadow: 0 0 10px rgba(156,39,176,0.5);
      animation: pulse-step 1.5s ease-in-out infinite;
    }
    @keyframes pulse-step {
      0%, 100% { box-shadow: 0 0 6px rgba(156,39,176,0.3); }
      50% { box-shadow: 0 0 16px rgba(156,39,176,0.7); }
    }
    .step-label {
      font-size: 10px; color: #666; margin-top: 6px;
      text-align: center; white-space: nowrap;
    }
    .step.done .step-label, .step.active .step-label { color: #CE93D8; }
    .step-line {
      flex: 1; height: 2px; background: #333;
      margin: 0 -4px; margin-bottom: 20px;
      transition: background 0.3s;
    }
    .step-line.done { background: #7B1FA2; }
    .progress-log {
      background: #111;
      border-radius: 6px;
      padding: 10px;
      max-height: 150px;
      overflow-y: auto;
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 11px;
      color: #888;
      margin-top: 8px;
      line-height: 1.5;
    }

    /* ── 結果區 ── */
    .results-section { display: none; }
    .results-section.show { display: block; }

    .stat-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: #252525;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .stat-card .value {
      font-size: 28px;
      font-weight: 700;
      color: #fff;
      line-height: 1.2;
    }
    .stat-card .label {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }
    .stat-card.good .value { color: #4caf50; }
    .stat-card.warn .value { color: #ff9800; }
    .stat-card.bad .value { color: #f44336; }
    .stat-card .explain {
      font-size: 11px;
      color: #666;
      margin-top: 6px;
      line-height: 1.4;
    }

    .section-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #333;
    }

    /* ── 規則表現條形圖 ── */
    .rule-chart { margin-bottom: 24px; }
    .rule-row {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
      gap: 12px;
    }
    .rule-name {
      width: 120px;
      font-size: 13px;
      text-align: right;
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rule-bars { flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .bar-row { display: flex; align-items: center; gap: 6px; }
    .bar-label { width: 24px; font-size: 10px; color: #888; text-align: right; flex-shrink: 0; }
    .bar-bg { flex: 1; height: 14px; background: #2a2a2a; border-radius: 3px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s; display: flex; align-items: center; padding-left: 6px; font-size: 10px; color: rgba(255,255,255,0.9); }
    .bar-fill.precision { background: linear-gradient(90deg, #1565c0, #42a5f5); }
    .bar-fill.recall { background: linear-gradient(90deg, #2e7d32, #66bb6a); }
    .rule-meta { width: 80px; font-size: 11px; color: #666; flex-shrink: 0; text-align: right; }
    .confidence-badge {
      display: inline-block;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      margin-left: 4px;
    }
    .confidence-badge.high { background: #1b5e20; color: #81c784; }
    .confidence-badge.medium { background: #4e342e; color: #ffb74d; }
    .confidence-badge.low { background: #b71c1c22; color: #ef5350; }

    /* ── 靜音分佈直方圖 ── */
    .histogram { margin-bottom: 24px; }
    .hist-container {
      display: flex;
      align-items: flex-end;
      gap: 2px;
      height: 140px;
      padding: 0 4px;
      border-bottom: 1px solid #444;
    }
    .hist-bar-group {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0;
      height: 100%;
      justify-content: flex-end;
    }
    .hist-stack { display: flex; flex-direction: column-reverse; width: 100%; }
    .hist-bar {
      width: 100%;
      min-height: 1px;
      transition: height 0.5s;
    }
    .hist-bar.kept { background: #2e7d32; }
    .hist-bar.deleted { background: #c62828; }
    .hist-labels {
      display: flex;
      gap: 2px;
      padding: 4px 4px 0;
    }
    .hist-label {
      flex: 1;
      text-align: center;
      font-size: 10px;
      color: #666;
    }
    .hist-legend {
      display: flex;
      gap: 16px;
      justify-content: center;
      margin-top: 8px;
      font-size: 11px;
      color: #888;
    }
    .hist-legend span::before {
      content: '';
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 2px;
      margin-right: 4px;
      vertical-align: middle;
    }
    .hist-legend .kept::before { background: #2e7d32; }
    .hist-legend .deleted::before { background: #c62828; }

    /* ── 影片對比表 ── */
    .video-table { margin-bottom: 24px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      padding: 8px 12px;
      background: #252525;
      border-bottom: 2px solid #333;
      font-weight: 600;
      color: #aaa;
      font-size: 12px;
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid #2a2a2a;
    }
    tr:hover td { background: #222; }
    .val-good { color: #4caf50; }
    .val-warn { color: #ff9800; }
    .val-bad { color: #f44336; }

    /* ── 建議區 ── */
    .suggestions { margin-bottom: 24px; }
    .suggestion-card {
      background: #252525;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 8px;
      border-left: 3px solid #9C27B0;
    }
    .suggestion-card .title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .suggestion-card .detail { font-size: 12px; color: #aaa; }
    .suggestion-card .evidence { font-size: 11px; color: #666; margin-top: 4px; }

    /* ── 規則審核表格 ── */
    .review-section { margin-bottom: 32px; }
    .review-toolbar {
      display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap;
    }
    .review-toolbar .sel-count { font-size: 12px; color: #888; }
    .review-table {
      width: 100%; border-collapse: collapse; font-size: 13px;
    }
    .review-table th {
      background: #252525; padding: 8px 10px; text-align: left;
      font-size: 11px; color: #888; font-weight: 500;
      border-bottom: 1px solid #333; white-space: nowrap;
    }
    .review-table th:last-child { text-align: center; width: 50px; }
    .review-table td {
      padding: 10px; border-bottom: 1px solid #2a2a2a;
      vertical-align: top;
    }
    .review-table tr:hover td { background: #1e1e1e; }
    .review-table tr.sev-high td:first-child { border-left: 3px solid #f44336; }
    .review-table tr.sev-medium td:first-child { border-left: 3px solid #ff9800; }
    .review-table tr.sev-low td:first-child { border-left: 3px solid #4caf50; }
    .rv-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 4px; font-size: 11px;
      background: #2a2a2a; color: #ccc; margin-bottom: 4px;
    }
    .rv-diff { font-size: 12px; line-height: 1.7; }
    .rv-diff .lbl { font-size: 10px; color: #666; }
    .rv-diff .ai { color: #f44336; }
    .rv-diff .srt { color: #4caf50; }
    .rv-sugg { color: #CE93D8; font-size: 12px; font-weight: 500; }
    .rv-detail { font-size: 10px; color: #666; font-family: monospace; margin-top: 3px; }
    .rv-ex-toggle {
      font-size: 11px; color: #9C27B0; cursor: pointer;
      display: inline-block; margin-top: 4px; user-select: none;
    }
    .rv-ex-toggle:hover { color: #CE93D8; }
    .rv-ex-list { display: none; margin-top: 6px; }
    .rv-ex-list.open { display: block; }
    .rv-ex-item {
      display: flex; gap: 6px; font-size: 11px; padding: 3px 0;
      border-bottom: 1px solid #2a2a2a; color: #888;
    }
    .rv-ex-item:last-child { border-bottom: none; }
    .rv-ex-item .at { color: #666; min-width: 55px; }
    .rv-ex-item .ai { color: #f44336; min-width: 60px; }
    .rv-ex-item .srt { color: #4caf50; min-width: 70px; }
    .rv-check {
      width: 20px; height: 20px; border: 2px solid #555; border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.15s; user-select: none; margin: 0 auto;
    }
    .rv-check.on { background: #7B1FA2; border-color: #9C27B0; }
    .rv-check.on::after { content: '\\2713'; color: #fff; font-size: 13px; font-weight: bold; }
    .rv-check.dim { border-color: #333; cursor: default; opacity: 0.35; }
    .rv-result {
      display: none; margin: 12px 0; padding: 12px 16px; border-radius: 6px;
      font-size: 13px;
    }
    .rv-result.ok { background: #1a2e1a; border: 1px solid #2e7d32; color: #a5d6a7; display: block; }
    .rv-result.err { background: #2c1a1a; border: 1px solid #7d2020; color: #ef9a9a; display: block; }
    .rv-result ul { padding-left: 18px; margin-top: 6px; }
    .rv-result li { font-size: 12px; }

    /* ── 空狀態 ── */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #555;
    }
    .empty-state .icon { font-size: 48px; margin-bottom: 12px; }
    .empty-state .text { font-size: 14px; }

    /* ── 按鈕 ── */
    button {
      padding: 6px 14px;
      background: #3a3a3a;
      color: #e0e0e0;
      border: 1px solid #444;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.15s;
    }
    button:hover { background: #4a4a4a; }
    button.primary { background: #9C27B0; border-color: #9C27B0; color: white; }
    button.primary:hover { background: #7B1FA2; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    select {
      padding: 6px 10px;
      background: #333;
      color: white;
      border: 1px solid #444;
      border-radius: 6px;
      font-size: 13px;
    }
  </style>
</head>
<body>

<div class="header">
  <h1>批量訓練儀表板</h1>
  <span class="badge" id="statusBadge">就緒</span>
  <span style="margin-left:auto; font-size:12px; color:#666;" id="timerText"></span>
</div>

<div class="main">
  <!-- 左側：檔案管理 -->
  <div class="left-panel">
    <div class="panel-header">訓練清單</div>
    <div class="add-pair-section">
      <div class="add-pair-row">
        <label>原始影片 (A)</label>
        <input type="text" id="originalInput" placeholder="貼上原始影片路徑...">
      </div>
      <div class="add-pair-row">
        <label>對照影片 (B)</label>
        <input type="text" id="editedInput" placeholder="貼上剪後影片路徑...">
      </div>
      <div class="add-pair-btns">
        <button class="primary" onclick="addPair()" style="flex:1">＋ 新增配對</button>
      </div>
    </div>
    <div class="scan-toggle" onclick="toggleScanBar()">📂 或掃描目錄自動配對...</div>
    <div class="scan-bar" id="scanBar">
      <input type="text" id="scanDirInput" placeholder="輸入影片目錄路徑...">
      <button onclick="doScan()">掃描</button>
    </div>
    <div class="file-list" id="fileList">
      <div class="empty-state">
        <div class="icon">&#128193;</div>
        <div class="text">手動新增原始影片 (A) 與對照影片 (B)<br>或掃描目錄自動配對</div>
      </div>
    </div>
    <div class="train-bar" style="display:none">
      <!-- 訓練層已退役（2026-06-30）：整塊下架，函式保留不破壞。直接剪走 /cut -->
      <!-- Row 0: 轉錄引擎 -->
      <div class="train-bar-row">
        <select id="transcriber" style="flex:1; background:#2a2a2a; color:#ddd; border:1px solid #444; border-radius:6px; padding:7px 10px; font-size:13px;">
          <option value="openai">OpenAI Whisper API</option>
          <option value="google">Google STT</option>
          <option value="whisper">Whisper 本機 (免費)</option>
        </select>
      </div>
      <!-- Row 1: 訓練 -->
      <div class="train-bar-row">
        <button class="primary" id="trainBtn" onclick="startTraining()" style="flex:1; padding:9px 12px; font-size:14px; font-weight:bold;">
          ▶ 開始訓練
        </button>
        <button id="optimizeBtn" onclick="startAutoresearch()" style="flex:0.7; background:#7d3c98; color:white; border:none; border-radius:6px; padding:9px 10px; cursor:pointer; font-size:13px; font-weight:bold;" title="AI 自動分析訓練差異並優化規則">
          🔬 自動優化
        </button>
      </div>
      <!-- Row 2: Skills -->
      <div class="train-bar-label">Skills 管理</div>
      <div class="train-bar-row">
        <button id="genSkillsBtn" onclick="startGenerateSkills()" style="flex:1; background:#1a6ea8; color:white; border:none; border-radius:6px; padding:8px 10px; cursor:pointer; font-size:13px; font-weight:bold;" title="分析訓練數據，生成個人剪輯風格說明書">
          📚 生成 Skills
        </button>
        <button id="skillsArBtn" onclick="startSkillsAutoresearch()" style="flex:1; background:#c0392b; color:white; border:none; border-radius:6px; padding:8px 10px; cursor:pointer; font-size:13px; font-weight:bold;" title="全自動雙策略迭代優化直到 F1 ≥ 目標">
          🔄 Skills 優化
        </button>
      </div>
      <!-- Row 3: 評估 -->
      <div class="train-bar-label">AI 評估</div>
      <div class="train-bar-row">
        <button id="aiEvalBtn" onclick="startAiEvaluate({sample:8})" style="flex:1; background:#1e8449; color:white; border:none; border-radius:6px; padding:8px 10px; cursor:pointer; font-size:13px; font-weight:bold;" title="抽樣 8 支影片快速評估（約 15-20 分鐘）">
          🧪 快速評估
        </button>
        <button id="aiEvalAllBtn" onclick="startAiEvaluate({})" style="flex:1; background:#145a32; color:white; border:none; border-radius:6px; padding:8px 10px; cursor:pointer; font-size:13px;" title="對全部影片完整評估（約 1-2 小時）">
          📊 全部評估
        </button>
      </div>
    </div>
  </div>

  <!-- 右側：結果 -->
  <div class="right-panel">
    <!-- 進度 -->
    <div class="progress-section" id="progressSection">
      <div class="section-title">訓練進度</div>
      <div class="progress-text">
        <span id="progressText">準備中...</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar" id="progressBar" style="width:0%"></div>
      </div>

      <!-- 步驟進度條 -->
      <div class="stepper" id="stepper">
        <div class="step" id="step1"><div class="step-circle">🎵</div><div class="step-label">提取音頻</div></div>
        <div class="step-line" id="line1"></div>
        <div class="step" id="step2"><div class="step-circle">🎙️</div><div class="step-label">語音轉錄</div></div>
        <div class="step-line" id="line2"></div>
        <div class="step" id="step3"><div class="step-circle">📝</div><div class="step-label">生成字幕</div></div>
        <div class="step-line" id="line3"></div>
        <div class="step" id="step4"><div class="step-circle">🤖</div><div class="step-label">規則標記</div></div>
        <div class="step-line" id="line4"></div>
        <div class="step" id="step5"><div class="step-circle">📊</div><div class="step-label" id="step5label">比對分析</div></div>
      </div>

      <div class="progress-log" id="progressLog"></div>
    </div>

    <!-- 結果 -->
    <div class="results-section" id="resultsSection">
      <!-- 總覽卡片 -->
      <div class="stat-cards" id="statCards"></div>

      <!-- 規則表現 -->
      <div class="rule-chart">
        <div class="section-title">各規則表現</div>
        <div id="ruleChart"></div>
      </div>

      <!-- 靜音分佈 -->
      <div class="histogram">
        <div class="section-title">靜音時長分佈</div>
        <div class="hist-container" id="histContainer"></div>
        <div class="hist-labels" id="histLabels"></div>
        <div class="hist-legend">
          <span class="kept">使用者保留</span>
          <span class="deleted">使用者刪除</span>
        </div>
      </div>

      <!-- 建議 -->
      <div class="suggestions">
        <div class="section-title">規則調整建議</div>
        <div id="suggestions"></div>
      </div>

      <!-- 規則審核 -->
      <div class="review-section">
        <div class="section-title">
          🧠 規則審核
          <span style="font-size:11px; color:#666; font-weight:400; margin-left:8px;">根據批量訓練結果，勾選同意更新的項目</span>
        </div>
        <div class="review-toolbar" id="rvToolbar" style="display:none">
          <button class="primary" id="rvApplyBtn" onclick="rvApply()">✅ 套用選中</button>
          <button onclick="rvSelectAll(true)">全選</button>
          <button onclick="rvSelectAll(false)">全不選</button>
          <span class="sel-count" id="rvSelCount">已選 0 項</span>
        </div>
        <div id="rvLoadBtn">
          <button onclick="rvLoad()" style="font-size:13px;">載入建議</button>
        </div>
        <div id="rvResult" class="rv-result"></div>
        <div id="rvTable"></div>
      </div>

      <!-- 影片對比 -->
      <div class="video-table">
        <div class="section-title">各影片表現</div>
        <table id="videoTable">
          <thead>
            <tr><th>影片</th><th title="原始轉錄文字在剪後影片中保留的比例">匹配率</th><th title="AI 標記的內容中，有多少是你真的會刪的（越高=誤標越少）">精確率</th><th title="你實際刪除的內容中，AI 抓到了多少（越高=漏標越少）">召回率</th><th title="精確率和召回率的綜合分數">F1</th><th title="False Positive 誤標：AI 標了但你沒刪的">FP</th><th title="False Negative 漏標：你刪了但 AI 沒標的">FN</th></tr>
          </thead>
          <tbody id="videoTableBody"></tbody>
        </table>
        <div style="font-size:11px; color:#555; margin-top:8px; line-height:1.6; padding:0 4px;">
          <b>FP（誤標）</b>= AI 標記要刪，但你其實沒刪 → 精確率低的原因<br>
          <b>FN（漏標）</b>= 你刪了，但 AI 沒標到 → 召回率低的原因<br>
          <b>F1</b> = 精確率 × 召回率 的調和平均，越高表示 AI 越接近你的剪法
        </div>
      </div>

      <!-- AI Skills 比較區 -->
      <div class="video-table" id="aiSkillsSection" style="display:none">
        <div class="section-title">🤖 AI + Skills 評估結果
          <span style="font-size:11px; color:#666; font-weight:400; margin-left:8px;">Claude AI 使用 editing_skills.md 的準確率</span>
        </div>
        <!-- 比較表 -->
        <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:12px;">
          <thead>
            <tr style="background:#2a2a2a;">
              <th style="padding:6px 10px; text-align:left;">指標</th>
              <th style="padding:6px 10px; text-align:center;">規則引擎</th>
              <th style="padding:6px 10px; text-align:center;">AI + Skills</th>
              <th style="padding:6px 10px; text-align:center;">差異</th>
            </tr>
          </thead>
          <tbody id="aiCompareBody"></tbody>
        </table>
        <!-- AI 各影片表 -->
        <div style="font-size:12px; color:#888; margin-bottom:6px;">各影片 AI F1（由低到高）</div>
        <table id="aiVideoTable" style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#222;">
              <th style="padding:4px 8px; text-align:left;">影片</th>
              <th style="padding:4px 8px; text-align:center;">AI F1</th>
              <th style="padding:4px 8px; text-align:center;">規則 F1</th>
              <th style="padding:4px 8px; text-align:center;">差異</th>
              <th style="padding:4px 8px; text-align:center;">FP</th>
              <th style="padding:4px 8px; text-align:center;">FN</th>
            </tr>
          </thead>
          <tbody id="aiVideoTableBody"></tbody>
        </table>
        <div style="margin-top:10px; font-size:11px; color:#555; line-height:1.6;">
          AI 評估需時較長（每支影片 ~2-5 分鐘），建議先用少量影片測試效果。
        </div>
      </div>

      <!-- editing_skills.md 預覽 -->
      <div class="video-table" id="skillsPreviewSection" style="display:none">
        <div class="section-title" style="display:flex; align-items:center; gap:12px;">
          📚 editing_skills.md 內容
          <span id="skillsMetaInfo" style="font-size:11px; color:#666; font-weight:400;"></span>
          <button onclick="loadSkillsContent()" style="font-size:11px; padding:3px 10px; margin-left:auto;">重新讀取</button>
        </div>
        <pre id="skillsContent" style="background:#111; color:#ccc; padding:12px; border-radius:6px; font-size:12px; max-height:300px; overflow:auto; white-space:pre-wrap; font-family:monospace;"></pre>
      </div>
    </div>

    <!-- 空狀態 -->
    <div class="empty-state" id="emptyState">
      <div class="icon">&#128202;</div>
      <div class="text">新增影片配對後開始訓練<br>結果將在此處顯示</div>
    </div>
  </div>
</div>

<script>
  const RULE_NAMES = {
    silence: '靜音段',
    repeated_sentence: '重複句',
    incomplete_sentence: '殘句',
    stutter: '卡頓詞',
    filler_word: '語氣詞',
    intra_repeat: '句內重複',
    self_correction: '重說糾正',
    consecutive_filler: '連續語氣詞',
    semantic_redundancy: '語意重複',
    unclassified: '未分類'
  };

  let pairs = [];
  let checkedSet = new Set();
  let pollTimer = null;

  // ── 手動新增配對 ──
  function addPair() {
    const origInput = document.getElementById('originalInput');
    const editInput = document.getElementById('editedInput');
    const origPath = origInput.value.trim();
    const editPath = editInput.value.trim();

    if (!origPath) { origInput.focus(); return; }
    if (!editPath) { editInput.focus(); return; }

    // 從對照影片路徑提取名稱
    const name = editPath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');

    // 檢查是否重複
    if (pairs.some(p => p.original === origPath && p.edited === editPath)) {
      alert('此配對已存在');
      return;
    }

    pairs.push({
      original: origPath,
      edited: editPath,
      name: name,
      mode: 'audio'
    });
    checkedSet.add(pairs.length - 1);

    origInput.value = '';
    editInput.value = '';
    origInput.focus();
    renderFileList();
  }

  // ── 掃描目錄展開/收合 ──
  function toggleScanBar() {
    const bar = document.getElementById('scanBar');
    bar.classList.toggle('open');
  }

  // ── 掃描目錄（累積模式：可重複貼入不同資料夾） ──
  async function doScan() {
    const input = document.getElementById('scanDirInput');
    const dir = input.value.trim();
    if (!dir) return;

    const btn = document.querySelector('.scan-bar button');
    btn.textContent = '掃描中...';
    btn.disabled = true;

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: dir })
      });
      const data = await res.json();
      if (data.error) { alert('錯誤: ' + data.error); return; }

      const newPairs = data.pairs || [];
      if (newPairs.length === 0) {
        alert('在此目錄找不到影片配對\\n\\n目錄: ' + dir + '\\n\\n支援：\\n1. 同資料夾 .mkv（原始）+ .mp4（剪後）\\n2. 同名影片 + .srt 字幕');
        return;
      }

      // 累積加入（避免重複）
      let added = 0;
      for (const p of newPairs) {
        const key = p.original || p.video;
        if (!pairs.some(x => (x.original || x.video) === key)) {
          pairs.push(p);
          checkedSet.add(pairs.length - 1);
          added++;
        }
      }

      input.value = '';
      renderFileList();
      showScanResult('✅ 新增 ' + added + ' 個配對（共 ' + pairs.length + ' 個）');
    } catch (err) {
      alert('掃描失敗: ' + err.message);
    } finally {
      btn.textContent = '掃描';
      btn.disabled = false;
    }
  }

  function showScanResult(msg) {
    let el = document.getElementById('scanResult');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scanResult';
      el.style.cssText = 'padding:6px 16px; font-size:12px; color:#4caf50; background:#1a2e1a; border-bottom:1px solid #2a2a2a;';
      document.querySelector('.scan-bar').after(el);
    }
    el.textContent = msg;
    setTimeout(() => { if(el) el.textContent = ''; }, 4000);
  }

  function renderFileList() {
    const list = document.getElementById('fileList');
    if (pairs.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="icon">&#128193;</div><div class="text">手動新增原始影片 (A) 與對照影片 (B)<br>或掃描目錄自動配對</div></div>';
      return;
    }
    list.innerHTML = pairs.map((p, i) => {
      const checked = checkedSet.has(i) ? 'checked' : '';
      const origName = (p.original || p.video || '').split(/[\\/]/).pop();
      const editName = (p.edited || p.srt || '').split(/[\\/]/).pop();
      return '<div class="file-item ' + checked + '" onclick="togglePair(' + i + ')">' +
        '<div class="check"></div>' +
        '<div class="paths">' +
          '<div class="pair-name">' + escRv(p.name) + '</div>' +
          '<div class="pair-path"><span class="tag">A</span>' + escRv(origName) + '</div>' +
          '<div class="pair-path"><span class="tag">B</span>' + escRv(editName) + '</div>' +
        '</div>' +
        '<div class="remove" onclick="event.stopPropagation(); removePair(' + i + ')">&#10005;</div>' +
        '</div>';
    }).join('');
    document.getElementById('trainBtn').textContent = '開始訓練 (' + checkedSet.size + ' 支)';
  }

  function togglePair(i) {
    if (checkedSet.has(i)) checkedSet.delete(i);
    else checkedSet.add(i);
    renderFileList();
  }

  function removePair(i) {
    pairs.splice(i, 1);
    const newSet = new Set();
    for (const x of checkedSet) {
      if (x < i) newSet.add(x);
      else if (x > i) newSet.add(x - 1);
    }
    checkedSet = newSet;
    renderFileList();
  }

  // ── 開始訓練 ──
  async function startTraining() {
    const selected = [...checkedSet].map(i => pairs[i]).filter(Boolean);
    if (selected.length === 0) { alert('請選擇至少一支影片'); return; }

    const videos = selected.map(p => {
      if (p.mode === 'audio') {
        return { original: p.original, edited: p.edited, name: p.name };
      } else {
        return { video: p.video, srt: p.srt, name: p.name };
      }
    });
    const transcriber = document.getElementById('transcriber').value;

    document.getElementById('trainBtn').disabled = true;
    document.getElementById('progressSection').classList.add('show');
    document.getElementById('resultsSection').classList.remove('show');
    document.getElementById('emptyState').style.display = 'none';

    try {
      await fetch('/api/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos, options: { transcriber } })
      });
      startPolling();
    } catch (err) {
      alert('啟動失敗: ' + err.message);
      document.getElementById('trainBtn').disabled = false;
    }
  }

  // ── 自動優化 ──
  async function startAutoresearch() {
    if (!confirm('啟動自動優化？\\n\\n將自動分析所有訓練影片的錯誤模式，搜索最佳參數，約需 5-10 分鐘。')) return;

    document.getElementById('optimizeBtn').disabled = true;
    document.getElementById('trainBtn').disabled = true;
    document.getElementById('progressSection').classList.add('show');
    document.getElementById('resultsSection').classList.remove('show');
    document.getElementById('emptyState').style.display = 'none';

    try {
      const res = await fetch('/api/autoresearch', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        startPolling();
      } else {
        alert('啟動失敗: ' + (data.error || '未知錯誤'));
        document.getElementById('optimizeBtn').disabled = false;
        document.getElementById('trainBtn').disabled = false;
      }
    } catch (err) {
      alert('啟動失敗: ' + err.message);
      document.getElementById('optimizeBtn').disabled = false;
      document.getElementById('trainBtn').disabled = false;
    }
  }

  // ── 生成 Skills ──
  async function startGenerateSkills() {
    if (!confirm('生成個人剪輯風格說明書 (editing_skills.md)？\\n\\n將分析所有訓練影片的 FP/FN 模式，由 Claude AI 提煉成結構化風格說明書，約需 1-2 分鐘。')) return;

    document.getElementById('genSkillsBtn').disabled = true;
    document.getElementById('trainBtn').disabled = true;
    document.getElementById('progressSection').classList.add('show');
    document.getElementById('resultsSection').classList.remove('show');
    document.getElementById('emptyState').style.display = 'none';

    try {
      const res = await fetch('/api/generate-skills', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        startPolling();
      } else {
        alert('啟動失敗: ' + (data.error || '未知錯誤'));
        document.getElementById('genSkillsBtn').disabled = false;
        document.getElementById('trainBtn').disabled = false;
      }
    } catch (err) {
      alert('啟動失敗: ' + err.message);
      document.getElementById('genSkillsBtn').disabled = false;
      document.getElementById('trainBtn').disabled = false;
    }
  }

  // ── AI 評估 ──
  async function startAiEvaluate(opts) {
    opts = opts || {};
    const isSample = opts.sample > 0;
    const desc = opts.video ? \`對「\${opts.video}」\` : isSample ? \`抽樣 \${opts.sample} 支代表性影片\` : '對全部訓練影片';
    const timeEst = opts.video ? '2-5 分鐘' : isSample ? '約 15-20 分鐘' : '約 1-3 小時';
    if (!confirm(\`\${desc}執行 AI 評估？\\n\\n預估時間：\${timeEst}\\n並行數：3（同時處理 3 支影片）\`)) return;

    document.getElementById('aiEvalBtn').disabled = true;
    const allBtn = document.getElementById('aiEvalAllBtn');
    if (allBtn) allBtn.disabled = true;
    document.getElementById('trainBtn').disabled = true;
    document.getElementById('progressSection').classList.add('show');
    document.getElementById('resultsSection').classList.remove('show');
    document.getElementById('emptyState').style.display = 'none';

    try {
      const body = { force: !!opts.force, concurrency: 3 };
      if (opts.video)  body.video  = opts.video;
      if (opts.sample) body.sample = opts.sample;
      const res = await fetch('/api/ai-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        startPolling();
      } else {
        alert('啟動失敗: ' + (data.error || '未知錯誤'));
        document.getElementById('aiEvalBtn').disabled = false;
        if (allBtn) allBtn.disabled = false;
        document.getElementById('trainBtn').disabled = false;
      }
    } catch (err) {
      alert('啟動失敗: ' + err.message);
      document.getElementById('aiEvalBtn').disabled = false;
      if (allBtn) allBtn.disabled = false;
      document.getElementById('trainBtn').disabled = false;
    }
  }

  // ── Skills Autoresearch（全自動雙策略） ──
  async function startSkillsAutoresearch() {
    const targetInput = prompt('設定目標 F1（0-100，預設 90）:\\n\\n系統會全自動跑：\\n• 自動切換修改 editing_skills.md / ai_sentencize_prompt.md\\n• 進步則保留、退步則回退\\n• 兩策略卡住才停止\\n• 達標後自動跑完整評估', '90');
    if (targetInput === null) return;
    const target = Math.max(0.5, Math.min(1.0, parseFloat(targetInput) / 100 || 0.90));

    if (!confirm(\`啟動全自動 Skills 優化？\\n\\n目標 F1：\${(target*100).toFixed(0)}%\\n模式：雙策略自動切換（skills + prompt）\\n每輪快速評估：8 支影片，3 支並行\\n\\n可在背景執行（關掉頁面也會繼續），你去做其他事情。\`)) return;

    document.getElementById('skillsArBtn').disabled = true;
    document.getElementById('trainBtn').disabled = true;
    document.getElementById('progressSection').classList.add('show');
    document.getElementById('resultsSection').classList.remove('show');
    document.getElementById('emptyState').style.display = 'none';

    try {
      const res = await fetch('/api/skills-autoresearch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, sample: 8, concurrency: 3, fullEval: true })
      });
      const data = await res.json();
      if (res.ok) {
        startPolling();
      } else {
        alert('啟動失敗: ' + (data.error || '未知錯誤'));
        document.getElementById('skillsArBtn').disabled = false;
        document.getElementById('trainBtn').disabled = false;
      }
    } catch (err) {
      alert('啟動失敗: ' + err.message);
      document.getElementById('skillsArBtn').disabled = false;
      document.getElementById('trainBtn').disabled = false;
    }
  }

  // ── 接續上次未完成的 Skills Autoresearch ──
  async function resumeSkillsAutoresearch() {
    dismissResumeBanner();
    document.getElementById('skillsArBtn').disabled = true;
    document.getElementById('trainBtn').disabled = true;
    document.getElementById('progressSection').classList.add('show');
    document.getElementById('resultsSection').classList.remove('show');
    document.getElementById('emptyState').style.display = 'none';
    try {
      const res = await fetch('/api/skills-autoresearch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume: true })
      });
      const data = await res.json();
      if (res.ok) {
        startPolling();
      } else {
        alert('接續失敗: ' + (data.error || '未知錯誤'));
        document.getElementById('skillsArBtn').disabled = false;
        document.getElementById('trainBtn').disabled = false;
      }
    } catch (err) {
      alert('接續失敗: ' + err.message);
      document.getElementById('skillsArBtn').disabled = false;
      document.getElementById('trainBtn').disabled = false;
    }
  }

  function dismissResumeBanner() {
    const b = document.getElementById('resumeBanner');
    if (b) b.remove();
  }

  function showResumeBanner(r) {
    dismissResumeBanner();
    const banner = document.createElement('div');
    banner.id = 'resumeBanner';
    banner.style.cssText = 'position:fixed; top:12px; right:12px; z-index:9999; background:linear-gradient(135deg,#e67e22,#c0392b); color:white; padding:12px 16px; border-radius:10px; box-shadow:0 6px 20px rgba(0,0,0,0.3); font-size:13px; max-width:380px; line-height:1.5;';
    const isPaused = r.status === 'paused-quota';
    const head = isPaused ? '⏸ 上次因額度暫停' : '🔁 上次優化未完成';
    const stratIcon = r.currentStrategy === 'prompt' ? '📝 prompt' : '🔧 skills';
    const bestPct = ((r.bestF1 || 0) * 100).toFixed(2);
    const targetPct = ((r.targetF1 || 0.9) * 100).toFixed(0);
    const startedAgo = r.startedAt ? Math.round((Date.now() - new Date(r.startedAt).getTime()) / 60000) : 0;
    banner.innerHTML =
      '<div style="font-weight:bold; font-size:14px; margin-bottom:6px;">' + head + '</div>' +
      '<div style="margin-bottom:4px;">已跑 <b>' + r.iter + '/' + (r.maxIter || 30) + '</b> 輪 · 最佳 F1 <b>' + bestPct + '%</b> / 目標 ' + targetPct + '%</div>' +
      '<div style="margin-bottom:4px; opacity:.9;">當前策略：' + stratIcon + ' · 開始於 ' + startedAgo + ' 分鐘前</div>' +
      (r.quotaPauseCount > 0 ? '<div style="margin-bottom:8px; opacity:.9;">期間暫停 ' + r.quotaPauseCount + ' 次（額度回復）</div>' : '<div style="margin-bottom:8px;"></div>') +
      '<div style="display:flex; gap:6px;">' +
        '<button onclick="resumeSkillsAutoresearch()" style="flex:1; background:white; color:#c0392b; border:none; padding:8px 12px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:13px;">📂 接續上次優化</button>' +
        '<button onclick="dismissResumeBanner()" style="background:rgba(0,0,0,0.25); color:white; border:none; padding:8px 12px; border-radius:6px; cursor:pointer; font-size:13px;">略過</button>' +
      '</div>';
    document.body.appendChild(banner);
  }

  // ── 渲染 Skills Autoresearch 結果 ──
  function renderSkillsArResults(report) {
    document.getElementById('resultsSection').classList.add('show');
    const improved = report.bestF1 - report.startF1;
    const cardClass = v => v >= 0.9 ? 'good' : v >= 0.7 ? 'warn' : 'bad';
    // 相容新舊欄位：history（新）/ iterHistory（舊）
    const history = report.history || report.iterHistory || [];

    document.getElementById('statCards').innerHTML =
      \`<div class="stat-card"><div class="value">\${report.iter || history.length}</div><div class="label">執行輪次</div></div>\` +
      \`<div class="stat-card"><div class="value">\${(report.startF1*100).toFixed(1)}%</div><div class="label">起始 F1</div></div>\` +
      \`<div class="stat-card \${cardClass(report.bestF1)}"><div class="value">\${(report.bestF1*100).toFixed(1)}%</div><div class="label">最終 F1</div><div class="explain">改善 \${improved >= 0 ? '+' : ''}\${(improved*100).toFixed(2)}pp</div></div>\` +
      \`<div class="stat-card \${report.reachedTarget ? 'good' : 'warn'}"><div class="value">\${report.reachedTarget ? '✅ 達標' : '⚠️ 未達標'}</div><div class="label">目標 \${(report.targetF1*100).toFixed(0)}%</div></div>\` +
      (report.fullBestF1 != null
        ? \`<div class="stat-card \${cardClass(report.fullBestF1)}"><div class="value">\${(report.fullBestF1*100).toFixed(1)}%</div><div class="label">完整評估最佳 F1</div><div class="explain">\${report.fullEvalCount || 0} 次完整評估\${report.overfitChecks ? ' / overfit×' + report.overfitChecks : ''}</div></div>\`
        : '');

    // 迭代歷史折線（文字版）
    const ruleChart = document.getElementById('ruleChart');
    ruleChart.innerHTML = '<div style="font-size:13px; font-weight:600; margin-bottom:8px;">每輪 F1 變化（含策略）</div>';
    const f1Vals = history.map(h => h.newF1 ?? h.f1).filter(v => typeof v === 'number');
    const maxF1 = f1Vals.length ? Math.max(...f1Vals, report.startF1 || 0) : (report.bestF1 || 1);
    // 起始列
    if (report.startF1 != null) {
      const pct0 = maxF1 > 0 ? (report.startF1 / maxF1 * 100) : 0;
      const row0 = document.createElement('div');
      row0.className = 'rule-row';
      row0.innerHTML =
        \`<div class="rule-name">🔵 起始</div>\` +
        \`<div class="rule-bars"><div class="bar-row"><div class="bar-bg"><div class="bar-fill" style="width:\${pct0}%; background:#3498db">\${(report.startF1*100).toFixed(1)}%</div></div></div></div>\` +
        \`<div class="rule-meta">initial</div>\`;
      ruleChart.appendChild(row0);
    }
    for (const h of history) {
      const f1 = h.newF1 ?? h.f1 ?? 0;
      const pct = maxF1 > 0 ? (f1 / maxF1 * 100) : 0;
      const isImproved = h.action === 'improved';
      const color = isImproved ? '#27ae60' : h.action && h.action.startsWith('reverted') ? '#888' : '#e67e22';
      const icon  = isImproved ? '✅' : h.action && h.action.startsWith('reverted') ? '↩️' : '⏭️';
      const stratIcon = h.strategy === 'prompt' ? '📝' : '🔧';
      const stratName = h.strategy === 'prompt' ? 'prompt' : 'skills';
      const deltaStr = (typeof h.delta === 'number')
        ? \` (Δ\${h.delta>=0?'+':''}\${(h.delta*100).toFixed(1)}pp)\` : '';
      const row = document.createElement('div');
      row.className = 'rule-row';
      row.innerHTML =
        \`<div class="rule-name">\${icon} 第 \${h.iter} 輪 \${stratIcon}\${stratName}</div>\` +
        \`<div class="rule-bars"><div class="bar-row"><div class="bar-bg"><div class="bar-fill" style="width:\${pct}%; background:\${color}">\${(f1*100).toFixed(1)}%\${deltaStr}</div></div></div></div>\` +
        \`<div class="rule-meta">\${h.action || ''}</div>\`;
      ruleChart.appendChild(row);
    }

    // 如果有完整評估結果
    if (report.fullEval) {
      const fe = report.fullEval;
      document.getElementById('suggestions').innerHTML =
        \`<div style="font-weight:600; margin-bottom:8px;">完整評估結果（所有 35 支影片）</div>\` +
        \`<table style="font-size:13px; border-collapse:collapse; width:100%">\` +
        \`<tr><td style="padding:4px 8px">F1</td><td style="padding:4px 8px; font-weight:bold; color:\${fe.f1>=0.9?'#27ae60':fe.f1>=0.7?'#f39c12':'#e74c3c'}">\${(fe.f1*100).toFixed(2)}%</td></tr>\` +
        \`<tr><td style="padding:4px 8px">精確率</td><td style="padding:4px 8px">\${(fe.precision*100).toFixed(2)}%</td></tr>\` +
        \`<tr><td style="padding:4px 8px">召回率</td><td style="padding:4px 8px">\${(fe.recall*100).toFixed(2)}%</td></tr>\` +
        \`<tr><td style="padding:4px 8px">FP</td><td style="padding:4px 8px">\${fe.fp}</td></tr>\` +
        \`<tr><td style="padding:4px 8px">FN</td><td style="padding:4px 8px">\${fe.fn}</td></tr>\` +
        \`</table>\`;
    }
  }

  // ── 載入 editing_skills.md 預覽 ──
  async function loadSkillsContent() {
    try {
      const res = await fetch('/api/skills-content');
      const skillsSection = document.getElementById('skillsPreviewSection');
      if (res.ok) {
        const text = await res.text();
        // 去除 HTML 注釋頭部
        const content = text.replace(/^<!--[\s\S]*?-->\s*/gm, '').trim();
        document.getElementById('skillsContent').textContent = content;
        skillsSection.style.display = '';
        document.getElementById('skillsMetaInfo').textContent = \`(\${content.split('\\n').length} 行)\`;
      } else {
        document.getElementById('skillsContent').textContent = '⚠️ 尚未生成 editing_skills.md，請先點擊「生成 Skills」按鈕。';
        skillsSection.style.display = '';
      }
    } catch (e) {}
  }

  // ── 渲染 AI 評估結果 ──
  async function renderAiEvalResults() {
    try {
      const res = await fetch('/api/ai-evaluate-status');
      if (!res.ok) return;
      const data = await res.json();

      const aiSection = document.getElementById('aiSkillsSection');
      const skillsSection = document.getElementById('skillsPreviewSection');

      if (data.skillsInfo && data.skillsInfo.exists) {
        skillsSection.style.display = '';
        document.getElementById('skillsMetaInfo').textContent = \`(\${data.skillsInfo.lines} 行)\`;
        // 延遲載入內容
        loadSkillsContent();
      }

      if (!data.aiReport) return;

      aiSection.style.display = '';
      const ai = data.aiReport.overall;
      const rule = data.arReport;

      // 比較表
      const compareBody = document.getElementById('aiCompareBody');
      compareBody.innerHTML = '';
      function diffCell(ai, rule) {
        if (!rule) return '<td style="text-align:center; color:#888">-</td>';
        const d = ai - rule;
        const color = d > 0.002 ? '#27ae60' : d < -0.002 ? '#e74c3c' : '#888';
        const sign = d >= 0 ? '+' : '';
        return \`<td style="text-align:center; color:\${color}; font-weight:bold">\${sign}\${(d*100).toFixed(2)}pp</td>\`;
      }
      function valCell(v, good) {
        const cls = v >= 0.9 ? 'val-good' : v >= 0.7 ? 'val-warn' : 'val-bad';
        return \`<td class="\${cls}" style="text-align:center">\${(v*100).toFixed(2)}%</td>\`;
      }
      const rows = [
        { label: 'F1', ai: ai.f1, rule: rule ? rule.f1 : null },
        { label: '精確率', ai: ai.precision, rule: rule ? rule.precision : null },
        { label: '召回率', ai: ai.recall, rule: rule ? rule.recall : null },
        { label: 'FP（誤標）', ai: ai.fp, rule: rule ? rule.fp : null, isCount: true },
        { label: 'FN（漏標）', ai: ai.fn, rule: rule ? rule.fn : null, isCount: true },
      ];
      for (const row of rows) {
        const tr = document.createElement('tr');
        if (row.isCount) {
          const d = rule ? ai - rule : null;
          const color = d !== null ? (d < 0 ? '#27ae60' : d > 0 ? '#e74c3c' : '#888') : '#888';
          const sign = d !== null && d >= 0 ? '+' : '';
          tr.innerHTML = \`
            <td style="padding:5px 10px; font-weight:500">\${row.label}</td>
            <td style="text-align:center">\${rule ? row.rule : '-'}</td>
            <td style="text-align:center">\${row.ai}</td>
            \${d !== null ? \`<td style="text-align:center; color:\${color}; font-weight:bold">\${sign}\${d}</td>\` : '<td style="text-align:center; color:#888">-</td>'}
          \`;
        } else {
          tr.innerHTML = \`
            <td style="padding:5px 10px; font-weight:500">\${row.label}</td>
            \${rule ? valCell(row.rule) : '<td style="text-align:center; color:#888">-</td>'}
            \${valCell(row.ai)}
            \${diffCell(row.ai, row.rule)}
          \`;
        }
        compareBody.appendChild(tr);
      }

      // 各影片 AI 表
      const aiVideoBody = document.getElementById('aiVideoTableBody');
      aiVideoBody.innerHTML = '';
      const rulePerVideo = {};
      if (data.arReport && data.arReport._perVideo) {
        for (const v of data.arReport._perVideo) rulePerVideo[v.name] = v.f1;
      }
      for (const v of (data.aiReport.perVideo || [])) {
        const ruleF1 = rulePerVideo[v.name];
        const d = ruleF1 !== undefined ? v.f1 - ruleF1 : null;
        const color = d !== null ? (d > 0.005 ? '#27ae60' : d < -0.005 ? '#e74c3c' : '#888') : '#888';
        const sign = d !== null && d >= 0 ? '+' : '';
        const f1Cls = v.f1 >= 0.9 ? 'val-good' : v.f1 >= 0.7 ? 'val-warn' : 'val-bad';
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td style="padding:3px 8px">\${v.name}</td>
          <td class="\${f1Cls}" style="text-align:center">\${(v.f1*100).toFixed(1)}%</td>
          <td style="text-align:center; color:#888">\${ruleF1 !== undefined ? (ruleF1*100).toFixed(1)+'%' : '-'}</td>
          <td style="text-align:center; color:\${color}; font-weight:bold">\${d !== null ? sign+(d*100).toFixed(1)+'pp' : '-'}</td>
          <td style="text-align:center">\${v.fp}</td>
          <td style="text-align:center">\${v.fn}</td>
        \`;
        aiVideoBody.appendChild(tr);
      }
      document.getElementById('aiSkillsSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {}
  }

  // ── 輪詢狀態 ──
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1000);
  }

  // 節流：autoresearch 狀態最多每 5 秒查一次
  let _lastSaStatusCheck = 0;
  let _lastSaStatusCache = null;
  async function getThrottledSaStatus() {
    const now = Date.now();
    if (now - _lastSaStatusCheck < 5000 && _lastSaStatusCache) return _lastSaStatusCache;
    _lastSaStatusCheck = now;
    try {
      const sr = await fetch('/api/skills-autoresearch-status');
      if (sr.ok) _lastSaStatusCache = await sr.json();
    } catch (e) {}
    return _lastSaStatusCache;
  }

  async function pollStatus() {
    try {
      const res = await fetch('/api/status');
      const state = await res.json();

      // 更新 badge
      const badge = document.getElementById('statusBadge');
      if (state.running) {
        const step = state.step || '';
        // Skills 優化中：偵測是否處於額度暫停狀態
        let paused = false;
        if (step.includes('Skills') || step.includes('優化') || step.includes('接續')) {
          const sj = await getThrottledSaStatus();
          if (sj && sj.status && sj.status.status === 'paused-quota') paused = true;
        }
        if (paused) {
          badge.textContent = '⏸ 額度暫停中';
          badge.className = 'badge running';
          badge.style.background = '#e67e22';
        } else {
          badge.textContent = step.includes('Skills 自動優化') || step.includes('接續') ? 'Skills 優化中' : step.includes('優化') ? '自動優化中' : step.includes('Skills') ? '生成 Skills 中' : step.includes('評估') ? 'AI 評估中' : '訓練中';
          badge.className = 'badge running';
          badge.style.background = '';
        }
      } else if (state.results) {
        badge.textContent = state.results.autoresearch ? '優化完成' : state.results.skillsAr ? 'Skills 優化完成' : state.results.skills ? 'Skills 生成完成' : state.results.aiEval ? 'AI 評估完成' : '完成';
        badge.className = 'badge done';
      } else {
        badge.textContent = '就緒';
        badge.className = 'badge';
      }

      // 更新進度
      if (state.total > 0) {
        const pct = Math.round(state.progress / state.total * 100);
        document.getElementById('progressBar').style.width = pct + '%';
        document.getElementById('progressText').textContent =
          state.currentVideo + ' (' + state.progress + '/' + state.total + ')';
      } else if (state.step) {
        document.getElementById('progressText').textContent = state.step;
      }

      // 更新步驟進度條
      updateStepper(state.stepIndex || 0);

      // 更新日誌（只顯示最後 50 行）
      const logDiv = document.getElementById('progressLog');
      const recentLog = state.log.slice(-50);
      logDiv.textContent = recentLog.join(String.fromCharCode(10));
      logDiv.scrollTop = logDiv.scrollHeight;

      // 計時
      if (state.startTime) {
        const elapsed = ((state.endTime || Date.now()) - state.startTime) / 1000;
        const min = Math.floor(elapsed / 60);
        const sec = Math.floor(elapsed % 60);
        document.getElementById('timerText').textContent = min + ':' + String(sec).padStart(2, '0');
      }

      // 完成
      if (!state.running && state.results) {
        clearInterval(pollTimer);
        pollTimer = null;
        document.getElementById('trainBtn').disabled = false;
        document.getElementById('trainBtn').textContent = '重新訓練 (' + checkedSet.size + ' 支)';
        const optBtn = document.getElementById('optimizeBtn');
        if (optBtn) optBtn.disabled = false;
        const gsBtn = document.getElementById('genSkillsBtn');
        if (gsBtn) gsBtn.disabled = false;
        const aeBtn = document.getElementById('aiEvalBtn');
        if (aeBtn) aeBtn.disabled = false;
        const aeAllBtn = document.getElementById('aiEvalAllBtn');
        if (aeAllBtn) aeAllBtn.disabled = false;
        const saBtn = document.getElementById('skillsArBtn');
        if (saBtn) saBtn.disabled = false;

        if (state.results.autoresearch) {
          renderAutoresearchResults(state.results.autoresearch);
        } else if (state.results.skillsAr) {
          renderSkillsArResults(state.results.skillsAr);
          loadSkillsContent();
        } else if (state.results.skills) {
          // Skills 生成完成 — 顯示結果區並更新預覽
          document.getElementById('resultsSection').classList.add('show');
          loadSkillsContent();
          document.getElementById('skillsPreviewSection').style.display = '';
        } else if (state.results.aiEval) {
          // AI 評估完成 — 顯示比較表
          document.getElementById('resultsSection').classList.add('show');
          renderAiEvalResults();
        } else {
          renderResults(state.results);
        }
      }
    } catch (err) {
      // 忽略暫時的網路錯誤
    }
  }

  // ── 渲染自動優化結果 ──
  function renderAutoresearchResults(report) {
    document.getElementById('resultsSection').classList.add('show');

    const b = report.baseline;
    const f = report.final;
    const deltaF1 = f.f1 - b.f1;
    const improved = deltaF1 > 0;

    function cardClass(val) { return val >= 0.9 ? 'good' : val >= 0.7 ? 'warn' : 'bad'; }

    // 總覽卡片
    document.getElementById('statCards').innerHTML =
      '<div class="stat-card"><div class="value">' + report.videos + '</div><div class="label">影片數</div></div>' +
      '<div class="stat-card"><div class="value">' + (b.f1*100).toFixed(1) + '%</div><div class="label">優化前 F1</div></div>' +
      '<div class="stat-card ' + cardClass(f.f1) + '"><div class="value">' + (improved ? '📈 ' : '') + (f.f1*100).toFixed(1) + '%</div><div class="label">優化後 F1</div><div class="explain">改善 ' + (deltaF1 >= 0 ? '+' : '') + (deltaF1*100).toFixed(2) + 'pp</div></div>' +
      '<div class="stat-card"><div class="value">' + (report.adoptedParams + (report.adoptedFillers ? report.adoptedFillers.length : 0)) + '</div><div class="label">已採用變更</div><div class="explain">參數: ' + report.adoptedParams + ', 贅詞: ' + (report.adoptedFillers ? report.adoptedFillers.length : 0) + '</div></div>';

    // 規則圖 - 用 FP 分佈
    const ruleChart = document.getElementById('ruleChart');
    ruleChart.innerHTML = '';
    if (report.fpDistribution) {
      const sortedRules = Object.entries(report.fpDistribution).sort((a,b) => b[1] - a[1]);
      const maxFP = sortedRules.length > 0 ? sortedRules[0][1] : 1;
      for (const [rule, count] of sortedRules) {
        const row = document.createElement('div');
        row.className = 'rule-row';
        row.innerHTML =
          '<div class="rule-name">' + (RULE_NAMES[rule] || rule) + '</div>' +
          '<div class="rule-bars">' +
            '<div class="bar-row"><div class="bar-label">FP</div><div class="bar-bg"><div class="bar-fill" style="width:' + (count/maxFP*100) + '%; background:#e74c3c">' + count + '</div></div></div>' +
          '</div>' +
          '<div class="rule-meta"></div>';
        ruleChart.appendChild(row);
      }
    }

    // 直方圖區域清空
    document.getElementById('histContainer').innerHTML = '';
    document.getElementById('histLabels').innerHTML = '';

    // 建議區 - 顯示 top FN 詞
    const sugDiv = document.getElementById('suggestions');
    sugDiv.innerHTML = '';
    if (report.topFNWords && Object.keys(report.topFNWords).length > 0) {
      const fnEntries = Object.entries(report.topFNWords).sort((a,b) => b[1] - a[1]).slice(0, 10);
      let html = '<div style="margin-bottom:8px; font-weight:600; color:#333;">Top 漏標詞（FN）</div>';
      html += '<table style="width:100%; border-collapse:collapse; font-size:13px;">';
      html += '<tr style="background:#f5f5f5;"><th style="padding:4px 8px; text-align:left;">文字</th><th style="padding:4px 8px; text-align:right;">次數</th></tr>';
      for (const [word, cnt] of fnEntries) {
        html += '<tr><td style="padding:4px 8px;">' + word + '</td><td style="padding:4px 8px; text-align:right;">' + cnt + '</td></tr>';
      }
      html += '</table>';
      sugDiv.innerHTML = html;
    } else {
      sugDiv.innerHTML = '<div style="color:#666; font-size:13px;">無顯著漏標模式</div>';
    }

    // 影片表
    const tbody = document.getElementById('videoTableBody');
    tbody.innerHTML = '';
    if (report.perVideo) {
      const sorted = [...report.perVideo].sort((a,b) => a.f1 - b.f1);
      for (const v of sorted) {
        function valClass(val) { return val >= 0.9 ? 'val-good' : val >= 0.7 ? 'val-warn' : 'val-bad'; }
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + v.name + '</td>' +
          '<td>-</td>' +
          '<td class="' + valClass(v.precision) + '">' + (v.precision*100).toFixed(1) + '%</td>' +
          '<td class="' + valClass(v.recall) + '">' + (v.recall*100).toFixed(1) + '%</td>' +
          '<td class="' + valClass(v.f1) + '">' + (v.f1*100).toFixed(1) + '%</td>' +
          '<td>' + v.fp + '</td>' +
          '<td>' + v.fn + '</td>';
        tbody.appendChild(tr);
      }
    }
  }

  // ── 渲染結果 ──
  function renderResults(results) {
    document.getElementById('resultsSection').classList.add('show');

    if (!results.diffReports || results.diffReports.length === 0) return;

    const reports = results.diffReports;

    // ── 總覽卡片 ──
    let totalTP = 0, totalFP = 0, totalFN = 0;
    for (const r of reports) {
      totalFP += (r.falsePositives || []).length;
      totalFN += (r.falseNegatives || []).length;
      totalTP += r.truePositiveCount || (r.aiCount - (r.falsePositives || []).length);
    }
    const precision = totalTP / (totalTP + totalFP) || 0;
    const recall = totalTP / (totalTP + totalFN) || 0;
    const f1 = 2 * precision * recall / (precision + recall) || 0;

    function cardClass(val) { return val >= 0.8 ? 'good' : val >= 0.6 ? 'warn' : 'bad'; }

    document.getElementById('statCards').innerHTML =
      '<div class="stat-card"><div class="value">' + reports.length + '</div><div class="label">影片數</div></div>' +
      '<div class="stat-card ' + cardClass(precision) + '"><div class="value">' + (precision*100).toFixed(1) + '%</div><div class="label">精確率</div><div class="explain">AI 標記的內容中，有多少是你真的會刪的<br>（越高 = 誤標越少）</div></div>' +
      '<div class="stat-card ' + cardClass(recall) + '"><div class="value">' + (recall*100).toFixed(1) + '%</div><div class="label">召回率</div><div class="explain">你實際刪除的內容中，AI 抓到了多少<br>（越高 = 漏標越少）</div></div>' +
      '<div class="stat-card ' + cardClass(f1) + '"><div class="value">' + (f1*100).toFixed(1) + '%</div><div class="label">F1</div><div class="explain">精確率和召回率的綜合分數<br>（越接近 100% = AI 越懂你的剪法）</div></div>';

    // ── 規則條形圖 ──
    const catStats = {};
    for (const r of reports) {
      if (!r.categoryStats) continue;
      for (const [cat, s] of Object.entries(r.categoryStats)) {
        if (!catStats[cat]) catStats[cat] = { tp: 0, fp: 0, fn: 0, videos: 0 };
        catStats[cat].tp += s.tp || 0;
        catStats[cat].fp += s.fp || 0;
        catStats[cat].fn += s.fn || 0;
        catStats[cat].videos++;
      }
    }

    const ruleChart = document.getElementById('ruleChart');
    ruleChart.innerHTML = '';
    const sortedCats = Object.entries(catStats).sort((a, b) => (b[1].tp+b[1].fp+b[1].fn) - (a[1].tp+a[1].fp+a[1].fn));

    for (const [cat, s] of sortedCats) {
      const p = s.tp / (s.tp + s.fp) || 0;
      const r = s.tp / (s.tp + s.fn) || 0;
      const total = s.tp + s.fp + s.fn;
      const conf = total >= 20 ? 'high' : total >= 10 ? 'medium' : 'low';
      const confLabel = conf === 'high' ? '充足' : conf === 'medium' ? '中等' : '不足';

      const row = document.createElement('div');
      row.className = 'rule-row';
      row.innerHTML =
        '<div class="rule-name">' + (RULE_NAMES[cat] || cat) + '</div>' +
        '<div class="rule-bars">' +
          '<div class="bar-row"><div class="bar-label">P</div><div class="bar-bg"><div class="bar-fill precision" style="width:' + (p*100) + '%">' + (p*100).toFixed(0) + '%</div></div></div>' +
          '<div class="bar-row"><div class="bar-label">R</div><div class="bar-bg"><div class="bar-fill recall" style="width:' + (r*100) + '%">' + (r*100).toFixed(0) + '%</div></div></div>' +
        '</div>' +
        '<div class="rule-meta">n=' + total + '<span class="confidence-badge ' + conf + '">' + confLabel + '</span></div>';
      ruleChart.appendChild(row);
    }

    // ── 靜音分佈直方圖 ──
    const allDist = {};
    for (const r of reports) {
      if (!r.silenceAnalysis || !r.silenceAnalysis.distribution) continue;
      for (const [bucket, counts] of Object.entries(r.silenceAnalysis.distribution)) {
        if (!allDist[bucket]) allDist[bucket] = { kept: 0, deleted: 0 };
        allDist[bucket].kept += counts.kept || 0;
        allDist[bucket].deleted += counts.deleted || 0;
      }
    }

    const histContainer = document.getElementById('histContainer');
    const histLabels = document.getElementById('histLabels');
    histContainer.innerHTML = '';
    histLabels.innerHTML = '';

    const buckets = Object.keys(allDist).sort((a, b) => parseFloat(a) - parseFloat(b));
    if (buckets.length > 0) {
      const maxVal = Math.max(...buckets.map(b => allDist[b].kept + allDist[b].deleted));

      for (const bucket of buckets) {
        const d = allDist[bucket];
        const total = d.kept + d.deleted;
        const keptH = maxVal > 0 ? (d.kept / maxVal * 120) : 0;
        const delH = maxVal > 0 ? (d.deleted / maxVal * 120) : 0;

        const group = document.createElement('div');
        group.className = 'hist-bar-group';
        group.title = bucket + 's: ' + d.kept + ' kept, ' + d.deleted + ' deleted (' + (total > 0 ? (d.kept/total*100).toFixed(0) : 0) + '% kept)';
        group.innerHTML =
          '<div class="hist-stack">' +
            '<div class="hist-bar kept" style="height:' + keptH + 'px"></div>' +
            '<div class="hist-bar deleted" style="height:' + delH + 'px"></div>' +
          '</div>';
        histContainer.appendChild(group);

        const label = document.createElement('div');
        label.className = 'hist-label';
        label.textContent = bucket + 's';
        histLabels.appendChild(label);
      }
    }

    // ── 建議（舊版純文字摘要，保留供參考）──
    const sugDiv = document.getElementById('suggestions');
    sugDiv.innerHTML = '';
    if (results.updates && Object.keys(results.updates).length > 0) {
      for (const [rule, update] of Object.entries(results.updates)) {
        const card = document.createElement('div');
        card.className = 'suggestion-card';
        let html = '<div class="title">' + (RULE_NAMES[rule] || rule) + '</div>';
        if (update.recommended) {
          html += '<div class="detail">' + update.field + ': ' + update.current + ' &rarr; <strong>' + update.recommended + '</strong></div>';
        }
        if (update.issue === 'precision_low') {
          html += '<div class="detail">精確率偏低 (' + update.current_precision + ')，' + update.fp_count + ' 個誤標</div>';
        }
        if (update.issue_recall === 'recall_low') {
          html += '<div class="detail">召回率偏低 (' + update.current_recall + ')，' + update.fn_count + ' 個漏標</div>';
        }
        if (update.evidence) {
          html += '<div class="evidence">' + update.evidence + '</div>';
        }
        card.innerHTML = html;
        sugDiv.appendChild(card);
      }
    } else {
      sugDiv.innerHTML = '<div style="color:#666; font-size:13px;">暫無建議（所有規則表現良好）</div>';
    }

    // 訓練完成後自動載入規則審核建議
    rvLoad();

    // ── 影片表 ──
    const tbody = document.getElementById('videoTableBody');
    tbody.innerHTML = '';
    for (const r of reports) {
      const fp = (r.falsePositives || []).length;
      const fn = (r.falseNegatives || []).length;
      const p = r.accuracy?.precision || 0;
      const rc = r.accuracy?.recall || 0;
      const f = r.accuracy?.f1 || 0;

      function valClass(v) { return v >= 0.8 ? 'val-good' : v >= 0.6 ? 'val-warn' : 'val-bad'; }

      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + (r._videoName || r.srtFile || '-') + '</td>' +
        '<td>' + (r.matchRate?.toFixed(1) || '-') + '%</td>' +
        '<td class="' + valClass(p) + '">' + (p*100).toFixed(1) + '%</td>' +
        '<td class="' + valClass(rc) + '">' + (rc*100).toFixed(1) + '%</td>' +
        '<td class="' + valClass(f) + '">' + (f*100).toFixed(1) + '%</td>' +
        '<td>' + fp + '</td>' +
        '<td>' + fn + '</td>';
      tbody.appendChild(tr);
    }
  }

  // ── 規則審核邏輯 ──
  let rvSuggestions = [];

  async function rvLoad() {
    document.getElementById('rvLoadBtn').innerHTML = '<span style="color:#888; font-size:13px">載入中...</span>';
    try {
      const r = await fetch('/api/batch-suggestions');
      const data = await r.json();
      if (!r.ok) {
        document.getElementById('rvLoadBtn').innerHTML =
          '<span style="color:#f44336; font-size:12px">⚠️ ' + escRv(data.error) + '</span>';
        return;
      }
      rvSuggestions = data.suggestions || [];
      document.getElementById('rvLoadBtn').style.display = 'none';
      document.getElementById('rvToolbar').style.display = 'flex';
      rvRender();
    } catch (err) {
      document.getElementById('rvLoadBtn').innerHTML =
        '<span style="color:#f44336; font-size:12px">⚠️ ' + err.message + '</span>';
    }
  }

  function rvRender() {
    const container = document.getElementById('rvTable');
    if (rvSuggestions.length === 0) {
      container.innerHTML = '<div style="color:#666; font-size:13px; padding:12px 0">目前沒有建議（AI 表現已與 SRT 高度吻合）</div>';
      return;
    }

    let html = '<table class="review-table"><thead><tr>' +
      '<th>規則類別</th><th>AI 做法</th><th>使用者實際</th><th>建議修改</th><th>採用?</th>' +
      '</tr></thead><tbody>';

    for (const s of rvSuggestions) {
      const isManual = !s.change || s.requiresManual;
      const exHtml = (s.examples || []).length > 0
        ? '<span class="rv-ex-toggle" onclick="rvToggleEx(this)">▶ ' + s.examples.length + ' 例</span>' +
          '<div class="rv-ex-list">' +
          s.examples.map(e =>
            '<div class="rv-ex-item">' +
            '<span class="at">' + escRv(e.at) + '</span>' +
            '<span class="ai">' + escRv(e.aiAction) + '</span>' +
            '<span class="srt">' + escRv(e.userAction) + '</span>' +
            '<span style="flex:1">' + escRv(e.label) + '</span>' +
            (e.video ? '<span style="color:#555;font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escRv(e.video) + '</span>' : '') +
            '</div>'
          ).join('') +
          '</div>'
        : '';

      let suggHtml = '<div class="rv-sugg">' + escRv(s.suggestion || '') + '</div>';
      if (s.change && s.change.path === 'silence.threshold') {
        suggHtml += '<div class="rv-detail">' + s.change.path + ': ' + s.change.from + ' → ' + s.change.to + 's</div>';
      } else if (s.change && s.change.action === 'add') {
        suggHtml += '<div class="rv-detail">' + s.change.path + ' += 「' + escRv(s.change.value) + '」</div>';
      } else if (isManual) {
        suggHtml += '<div class="rv-detail" style="color:#ff9800">需手動處理</div>';
      }
      if (s.sampleCount) {
        suggHtml += '<div class="rv-detail" style="color:#666">樣本 n=' + s.sampleCount + (s.videoCount ? ', ' + s.videoCount + ' 支影片' : '') + '</div>';
      }

      html += '<tr class="sev-' + (s.severity || 'low') + '" data-id="' + escRv(s.id) + '">' +
        '<td><div class="rv-badge">' + escRv(s.icon || '') + ' ' + escRv(s.category) + '</div>' +
        (s.ruleFile ? '<div style="font-size:10px;color:#555">📄 ' + escRv(s.ruleFile) + '</div>' : '') + '</td>' +
        '<td class="rv-diff"><div class="lbl">AI</div><div class="ai">' + escRv(s.aiAction) + '</div></td>' +
        '<td class="rv-diff"><div class="lbl">使用者</div><div class="srt">' + escRv(s.userShows) + '</div>' + exHtml + '</td>' +
        '<td>' + suggHtml + '</td>' +
        '<td style="text-align:center"><div class="rv-check ' + (isManual ? 'dim' : (s.checked ? 'on' : '')) + '"' +
        (isManual ? ' title="需手動處理"' : ' data-rv-id="' + escRv(s.id) + '"') +
        '></div></td>' +
        '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Event delegation for checkboxes (avoids quote-escaping issues in template literal)
    container.querySelectorAll('.rv-check[data-rv-id]').forEach(function(el) {
      el.addEventListener('click', function() { rvToggle(el, el.dataset.rvId); });
    });

    rvUpdateCount();
  }

  function rvToggle(el, id) {
    const s = rvSuggestions.find(x => x.id === id);
    if (!s) return;
    s.checked = !s.checked;
    el.classList.toggle('on', s.checked);
    rvUpdateCount();
  }

  function rvSelectAll(val) {
    for (const s of rvSuggestions) {
      if (!s.requiresManual && s.change) s.checked = val;
    }
    rvRender();
  }

  function rvUpdateCount() {
    const n = rvSuggestions.filter(s => s.checked && !s.requiresManual && s.change).length;
    document.getElementById('rvSelCount').textContent = '已選 ' + n + ' 項';
    document.getElementById('rvApplyBtn').disabled = n === 0;
  }

  function rvToggleEx(el) {
    const list = el.nextElementSibling;
    list.classList.toggle('open');
    el.textContent = list.classList.contains('open')
      ? el.textContent.replace('▶', '▼')
      : el.textContent.replace('▼', '▶');
  }

  async function rvApply() {
    const toApply = rvSuggestions.filter(s => s.checked && !s.requiresManual && s.change);
    if (toApply.length === 0) return;
    document.getElementById('rvApplyBtn').disabled = true;
    document.getElementById('rvApplyBtn').textContent = '套用中...';
    try {
      const r = await fetch('/api/apply-batch-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestions: toApply })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      const el = document.getElementById('rvResult');
      el.className = 'rv-result ok';
      let html = '<strong>✅ 已套用 ' + data.applied.length + ' 項</strong>';
      if (data.applied.length > 0) {
        html += '<ul>' + data.applied.map(a => '<li>' + escRv(a.desc) + '</li>').join('') + '</ul>';
      }
      if (data.skipped.length > 0) {
        html += '<div style="margin-top:6px;font-size:11px;color:#888">略過 ' + data.skipped.length + ' 項</div>';
      }
      html += '<div style="margin-top:6px;font-size:11px;color:#888">已存入 training_config.json，下次訓練自動生效</div>';
      el.innerHTML = html;
      // 標記已採用的列
      for (const s of toApply) {
        const row = document.querySelector('tr[data-id="' + s.id + '"]');
        if (row) { row.style.opacity = '0.45'; }
      }
    } catch (err) {
      const el = document.getElementById('rvResult');
      el.className = 'rv-result err';
      el.innerHTML = '<strong>❌ 套用失敗</strong><p>' + escRv(err.message) + '</p>';
    } finally {
      document.getElementById('rvApplyBtn').disabled = false;
      document.getElementById('rvApplyBtn').textContent = '✅ 套用選中';
    }
  }

  // ── 步驟進度條更新 ──
  function updateStepper(stepIdx) {
    for (let i = 1; i <= 5; i++) {
      const stepEl = document.getElementById('step' + i);
      const lineEl = document.getElementById('line' + (i - 1));
      if (!stepEl) continue;

      stepEl.classList.remove('done', 'active');
      if (i < stepIdx) {
        stepEl.classList.add('done');
      } else if (i === stepIdx) {
        stepEl.classList.add('active');
      }

      if (lineEl) {
        lineEl.classList.toggle('done', i <= stepIdx);
      }
    }
  }

  function escRv(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── 頁面載入時檢查是否有未完成的訓練 ──
  (async function init() {
    try {
      const res = await fetch('/api/status');
      const state = await res.json();
      if (state.running) {
        document.getElementById('progressSection').classList.add('show');
        document.getElementById('emptyState').style.display = 'none';
        document.getElementById('trainBtn').disabled = true;
        var optBtn = document.getElementById('optimizeBtn');
        if (optBtn) optBtn.disabled = true;
        startPolling();
      } else if (state.results) {
        document.getElementById('emptyState').style.display = 'none';
        if (state.results.autoresearch) {
          renderAutoresearchResults(state.results.autoresearch);
        } else if (state.results.skills) {
          document.getElementById('resultsSection').classList.add('show');
          loadSkillsContent();
          document.getElementById('skillsPreviewSection').style.display = '';
        } else if (state.results.aiEval) {
          document.getElementById('resultsSection').classList.add('show');
          renderAiEvalResults();
        } else {
          renderResults(state.results);
        }
      }
    } catch (e) {}

    // 檢查是否有可接續的 Skills Autoresearch 任務（額度暫停 / 中斷）
    try {
      const resumeRes = await fetch('/api/skills-autoresearch-resumable');
      if (resumeRes.ok) {
        const j = await resumeRes.json();
        if (j.resumable) showResumeBanner(j.resumable);
      }
    } catch (e) {}

    // 也主動檢查是否已有 AI 評估結果和 skills 文件
    try {
      const statusRes = await fetch('/api/ai-evaluate-status');
      if (statusRes.ok) {
        const data = await statusRes.json();
        if (data.skillsInfo && data.skillsInfo.exists) {
          document.getElementById('skillsPreviewSection').style.display = '';
          document.getElementById('skillsMetaInfo').textContent = '(' + data.skillsInfo.lines + ' 行)';
          loadSkillsContent();
        }
        if (data.aiReport) {
          document.getElementById('aiSkillsSection').style.display = '';
          renderAiEvalResults();
        }
      }
    } catch (e) {}
  })();

  // Enter 鍵觸發
  document.getElementById('scanDirInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doScan();
  });
  document.getElementById('editedInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addPair();
  });
</script>

</body>
</html>`;

// ── Portal HTML 已移除：首頁直接給剪輯頁（CUT_DOC_HTML），不再有雙卡片選擇頁與 /train 入口 ──

// ── Cut HTML ──
const CUT_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auto VideoCut - \u526A\u8F2F</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
      background: #1a1a1a;
      color: #e0e0e0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .header {
      background: #252525;
      padding: 10px 20px;
      border-bottom: 1px solid #333;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .header a { color: #9C27B0; text-decoration: none; font-size: 14px; }
    .header a:hover { color: #CE93D8; }
    .header h1 { font-size: 16px; font-weight: 600; }
    .header .badge {
      font-size: 11px; padding: 2px 8px; border-radius: 10px;
      background: #333; color: #888;
    }
    .header .badge.processing { background: #1b5e20; color: #81c784; }
    .header .badge.ready { background: #0d47a1; color: #64b5f6; }
    .header .video-name {
      font-size: 13px; color: #CE93D8; max-width: 40%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      margin-left: auto;
    }

    .main { display: flex; flex: 1; overflow: hidden; }

    /* \u4FEE\u6539 4: \u7DE8\u8F2F\u5340\u653E\u5927\uFF0C\u5F71\u7247\u7E2E\u5C0F */
    .left-panel {
      flex: 1;
      min-width: 320px;
      max-width: 480px;
      border-right: 1px solid #333;
      display: flex;
      flex-direction: column;
    }
    .right-panel {
      flex: 2;
      min-width: 400px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .input-section {
      padding: 12px 16px;
      border-bottom: 1px solid #333;
    }
    .input-section label {
      display: block; font-size: 12px; color: #888; margin-bottom: 6px;
    }
    .input-section input {
      width: 100%; padding: 8px 12px;
      background: #2a2a2a; color: #e0e0e0;
      border: 1px solid #444; border-radius: 6px; font-size: 13px;
    }
    .input-section input:focus { outline: none; border-color: #9C27B0; }
    .input-section .process-btn {
      margin-top: 8px; width: 100%; padding: 10px;
      background: #9C27B0; color: white; border: none;
      border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;
    }
    .input-section .process-btn:hover { background: #7B1FA2; }
    .input-section .process-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── 批量模式 ── */
    .batch-toggle { background:#333; color:#aaa; border:1px solid #555; border-radius:6px; padding:8px 10px; cursor:pointer; font-size:12px; white-space:nowrap; flex-shrink:0; }
    .batch-toggle.active { background:#4a235a; color:#ce93d8; border-color:#7B1FA2; }
    .batch-queue { margin-top:8px; border:1px solid #383838; border-radius:6px; max-height:160px; overflow-y:auto; background:#222; }
    .batch-queue-empty { padding:10px; text-align:center; color:#555; font-size:12px; }
    .batch-item { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid #2d2d2d; font-size:12px; }
    .batch-item:last-child { border-bottom:none; }
    .batch-item .bname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#ccc; }
    .batch-item .bstatus { flex-shrink:0; font-size:11px; }
    .batch-item .bstatus.pending { color:#888; }
    .batch-item .bstatus.running { color:#ce93d8; }
    .batch-item .bstatus.done { color:#4caf50; }
    .batch-item .bstatus.error { color:#ef5350; }
    .batch-item .bremove { flex-shrink:0; background:none; border:none; color:#555; cursor:pointer; font-size:13px; padding:0 2px; line-height:1; }
    .batch-item .bremove:hover { color:#ef5350; }
    .batch-item .breview { flex-shrink:0; background:#7B1FA2; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px; padding:3px 8px; margin-left:auto; transition: background 0.15s; }
    .batch-item .breview:hover { background:#9C27B0; }
    .batch-summary { padding:5px 10px; font-size:11px; color:#666; border-top:1px solid #2d2d2d; }

    /* \u4FEE\u6539 2: \u6B65\u9A5F\u9032\u5EA6\u689D */
    .step-progress {
      padding: 12px 16px;
      border-bottom: 1px solid #333;
      display: none;
    }
    .step-progress.show { display: flex; align-items: center; justify-content: center; gap: 0; }
    .step-item {
      display: flex; align-items: center; gap: 6px; font-size: 11px; color: #555;
      white-space: nowrap;
    }
    .step-item .dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: #333; border: 2px solid #555;
      flex-shrink: 0;
    }
    .step-item.active .dot {
      background: #9C27B0; border-color: #CE93D8;
      animation: pulse 1.5s infinite;
    }
    .step-item.active { color: #CE93D8; font-weight: 600; }
    .step-item.completed .dot {
      background: #2e7d32; border-color: #4caf50;
    }
    .step-item.completed { color: #81c784; }
    .step-connector {
      width: 20px; height: 2px; background: #333; margin: 0 2px; flex-shrink: 0;
    }
    .step-item.completed + .step-connector { background: #4caf50; }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(156,39,176,0.4); }
      50% { box-shadow: 0 0 0 6px rgba(156,39,176,0); }
    }

    /* 進度條 */
    .progress-section {
      padding: 8px 16px 12px;
      border-bottom: 1px solid #333;
      display: none;
    }
    .progress-section.show { display: block; }
    .progress-bar-wrap {
      height: 6px; background: #2a2a2a; border-radius: 3px;
      overflow: hidden; position: relative;
    }
    .progress-bar-fill {
      height: 100%; background: linear-gradient(90deg, #7B1FA2, #CE93D8);
      border-radius: 3px; transition: width 0.5s ease;
      position: relative;
    }
    .progress-bar-fill::after {
      content: ''; position: absolute; top: 0; left: 0;
      width: 100%; height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
      animation: shimmer 2s infinite;
    }
    @keyframes shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .progress-info {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 6px; font-size: 11px; color: #888;
    }
    .progress-info .pct { color: #CE93D8; font-weight: 600; font-size: 12px; }

    /* 頂部分類篩選列 */
    .filter-bar {
      padding: 8px 16px;
      border-bottom: 1px solid #333;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .filter-badge {
      display: flex; align-items: center; gap: 5px;
      padding: 4px 12px; background: #1a2e1a; border: 1px solid #2e5a2e;
      border-radius: 14px; font-size: 12px; color: #8bc34a;
      cursor: pointer; user-select: none; transition: all 0.15s;
    }
    .filter-badge:hover { background: #243a24; }
    .filter-badge.off { background: #2a2a2a; border-color: #444; color: #666; }
    .filter-badge input[type="checkbox"] { width: 13px; height: 13px; accent-color: #4caf50; margin: 0; }
    .filter-badge .cnt { font-weight: 700; }
    .filter-nav {
      margin-left: auto; display: flex; align-items: center; gap: 6px;
      font-size: 12px; color: #888;
    }
    .filter-nav button {
      background: none; border: 1px solid #444; color: #888;
      width: 22px; height: 22px; border-radius: 4px; cursor: pointer; font-size: 12px;
      display: flex; align-items: center; justify-content: center; padding: 0;
    }
    .filter-nav button:hover { background: #333; color: #fff; }

    /* 引導提示 */
    .guide-banner {
      padding: 10px 16px;
      background: linear-gradient(90deg, #1a1a2e, #16213e);
      border-bottom: 1px solid #1976d2;
      font-size: 13px; color: #90caf9;
      display: none; align-items: center; gap: 8px;
      flex-shrink: 0;
    }
    .guide-banner.show { display: flex; }
    .guide-banner .guide-icon { font-size: 16px; }
    .guide-banner .guide-text { flex: 1; }
    .guide-banner .guide-text strong { color: #fff; }
    .guide-banner .guide-dismiss {
      background: none; border: 1px solid #1976d2; color: #64b5f6;
      border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px;
    }
    .guide-banner .guide-dismiss:hover { background: #1976d2; color: #fff; }

    /* 自然文本流 */
    .sentence-list {
      flex: 1; overflow-y: auto; padding: 20px 24px;
      font-size: 14px; line-height: 2.2; color: #d0d0d0;
      user-select: none; -webkit-user-select: none;
    }
    .phrase {
      cursor: pointer; border-radius: 3px; padding: 2px 1px;
      transition: background 0.12s;
    }
    .phrase:hover { background: rgba(255,255,255,0.05); }
    .phrase.deleted {
      background: rgba(196, 155, 48, 0.3); color: #d4b44a; border-radius: 3px;
    }
    .phrase.deleted:hover { background: rgba(196, 155, 48, 0.45); }
    .gap-mk {
      color: #444; font-size: 11px; cursor: pointer; border-radius: 3px;
      padding: 0 2px; transition: background 0.12s;
    }
    .gap-mk.deleted { background: rgba(196, 155, 48, 0.3); color: #d4b44a; }
    .gap-mk.deleted:hover { background: rgba(196, 155, 48, 0.45); }
    .gap-mk.gap-keep { color: #555; cursor: default; opacity: 0.6; }
    .gap-mk.gap-keep:hover { background: none; }
    .pbreak { display: block; height: 8px; }
    .phrase-tooltip {
      position: absolute; background: #333; color: #ccc; padding: 4px 10px;
      border-radius: 6px; font-size: 11px; white-space: nowrap;
      pointer-events: none; z-index: 100; transform: translateY(-110%);
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }

    /* 單字級元素 */
    .w {
      cursor: pointer; border-radius: 2px; padding: 0;
      transition: background 0.1s;
    }
    .w:hover { background: rgba(255,255,255,0.08); }
    .w.deleted {
      background: rgba(196, 155, 48, 0.3); color: #d4b44a;
    }
    .w.deleted:hover { background: rgba(196, 155, 48, 0.45); }
    /* reviewer (整稿潤稿) — 鮮黃 */
    .w.deleted.cat-reviewer {
      background: rgba(255, 235, 59, 0.32); color: #fff176;
    }
    .w.deleted.cat-reviewer:hover { background: rgba(255, 235, 59, 0.50); }
    /* audit (嚴格二讀) — 橘 */
    .w.deleted.cat-audit {
      background: rgba(255, 152, 0, 0.32); color: #ffb74d;
    }
    .w.deleted.cat-audit:hover { background: rgba(255, 152, 0, 0.50); }
    /* 目前播放字 — 綠色發光效果，跟刪除色（金/黃/橘）區分 */
    .w.now-playing {
      background: rgba(76, 175, 80, 0.45) !important;
      color: #a5d6a7 !important;
      box-shadow: 0 0 4px rgba(76, 175, 80, 0.7);
      border-radius: 3px;
    }
    .w.drag-sel {
      background: rgba(100, 149, 237, 0.35); color: #8bb4ff;
    }

    /* 浮動工具列（剪映風格） */
    .float-toolbar {
      position: fixed; display: none; z-index: 200;
      background: #2a2a2a; border: 1px solid #444; border-radius: 8px;
      padding: 4px 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      gap: 4px; align-items: center;
    }
    .float-toolbar.show { display: flex; }
    .float-toolbar button {
      background: none; border: none; color: #ccc; font-size: 13px;
      padding: 6px 14px; border-radius: 6px; cursor: pointer;
      display: flex; align-items: center; gap: 5px;
      transition: background 0.15s;
    }
    .float-toolbar button:hover { background: #444; color: #fff; }
    .float-toolbar .tb-delete { color: #e57373; }
    .float-toolbar .tb-delete:hover { background: #5a2020; color: #ff8a8a; }
    .float-toolbar .tb-restore { color: #81c784; }
    .float-toolbar .tb-restore:hover { background: #1b4a1d; color: #a5d6a7; }
    .float-toolbar .tb-divider { width: 1px; height: 20px; background: #444; }

    .empty-placeholder {
      text-align: center; color: #555; padding: 60px 20px;
    }
    .empty-placeholder .icon { font-size: 48px; margin-bottom: 12px; }
    .empty-placeholder .text { font-size: 14px; line-height: 1.6; }

    .action-bar {
      padding: 10px 16px;
      border-top: 1px solid #333;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }
    .action-bar button {
      padding: 8px 16px;
      background: #333; color: #e0e0e0;
      border: 1px solid #444; border-radius: 6px;
      cursor: pointer; font-size: 13px;
    }
    .action-bar button:hover { background: #444; }
    .action-bar button.primary { background: #9C27B0; border-color: #9C27B0; color: white; font-weight: 600; }
    .action-bar button.primary:hover { background: #7B1FA2; }
    .action-bar button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .action-bar .info { font-size: 12px; color: #888; margin-left: auto; }

    .video-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111;
      max-height: 50vh;
    }
    .video-container video { max-width: 100%; max-height: 100%; }
    .video-placeholder {
      text-align: center; color: #555;
    }
    .video-placeholder .icon { font-size: 48px; margin-bottom: 12px; }
    .video-placeholder .text { font-size: 13px; }

    .result-bar {
      padding: 12px 20px;
      background: #1a2e1a;
      border-top: 1px solid #2e7d32;
      font-size: 13px;
      color: #a5d6a7;
      display: none;
    }
    .result-bar.show { display: block; }

    /* \u4FEE\u6539 5: \u532F\u51FA\u8A2D\u5B9A Modal */
    .modal-overlay {
      display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center;
    }
    .modal-overlay.show { display: flex; }
    .modal-dialog {
      background: #1e1e1e; border-radius: 12px; width: 420px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .modal-header {
      padding: 16px 20px; border-bottom: 1px solid #333; display: flex;
      align-items: center; gap: 8px;
    }
    .modal-header h3 { margin: 0; font-size: 15px; color: #fff; flex: 1; }
    .modal-header button {
      background: none; border: none; color: #888; font-size: 20px; cursor: pointer;
    }
    .modal-header button:hover { color: #fff; }
    .modal-body { padding: 16px 20px; }
    .modal-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 0; border-bottom: 1px solid #2a2a2a;
    }
    .modal-row:last-child { border-bottom: none; }
    .modal-row label { font-size: 13px; color: #ccc; }
    .modal-row select {
      background: #2a2a2a; color: #e0e0e0; border: 1px solid #444;
      border-radius: 6px; padding: 6px 10px; font-size: 13px; min-width: 160px;
    }
    .modal-row select:focus { outline: none; border-color: #9C27B0; }
    .modal-row .toggle-label {
      display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; color: #ccc;
    }
    .modal-row .toggle-label input[type="checkbox"] {
      width: 16px; height: 16px; accent-color: #9C27B0;
    }
    .modal-footer {
      padding: 14px 20px; border-top: 1px solid #333; display: flex;
      align-items: center; gap: 8px; justify-content: space-between;
    }
    .modal-footer .est { font-size: 12px; color: #666; }
    .modal-footer .btns { display: flex; gap: 8px; }
    .modal-footer button {
      padding: 8px 20px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px;
    }
    .modal-footer .cancel { background: #333; color: #ccc; }
    .modal-footer .cancel:hover { background: #444; }
    .modal-footer .export-btn { background: #9C27B0; color: white; font-weight: bold; }
    .modal-footer .export-btn:hover { background: #7B1FA2; }
    .modal-footer .export-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* \u6A94\u6848\u700F\u89BD\u5668 Modal */
    .fb-overlay {
      display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.7); z-index: 2000; align-items: center; justify-content: center;
    }
    .fb-overlay.show { display: flex; }
    .fb-dialog {
      background: #1e1e1e; border-radius: 12px; width: 560px; max-height: 70vh;
      display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .fb-header {
      padding: 16px 20px; border-bottom: 1px solid #333; display: flex;
      align-items: center; gap: 8px;
    }
    .fb-header h3 { margin: 0; font-size: 15px; color: #fff; flex: 1; }
    .fb-header button {
      background: none; border: none; color: #888; font-size: 20px; cursor: pointer; padding: 0 4px;
    }
    .fb-header button:hover { color: #fff; }
    .fb-breadcrumb {
      padding: 8px 20px; border-bottom: 1px solid #2a2a2a;
      font-size: 12px; color: #888; display: flex; align-items: center; gap: 4px;
      flex-wrap: wrap;
    }
    .fb-breadcrumb span { cursor: pointer; color: #64b5f6; }
    .fb-breadcrumb span:hover { text-decoration: underline; }
    .fb-breadcrumb span.current { color: #fff; cursor: default; }
    .fb-breadcrumb span.current:hover { text-decoration: none; }
    .fb-list {
      flex: 1; overflow-y: auto; padding: 8px 0; min-height: 200px; max-height: 50vh;
    }
    .fb-item {
      padding: 8px 20px; display: flex; align-items: center; gap: 10px;
      cursor: pointer; font-size: 13px; color: #ccc;
    }
    .fb-item:hover { background: #2a2a2a; }
    .fb-item.selected { background: #1a3a5c; }
    .fb-item .icon { font-size: 18px; width: 24px; text-align: center; }
    .fb-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fb-item .size { color: #666; font-size: 11px; }
    .fb-footer {
      padding: 12px 20px; border-top: 1px solid #333; display: flex;
      align-items: center; gap: 8px; justify-content: flex-end;
    }
    .fb-footer button {
      padding: 8px 20px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px;
    }
    .fb-footer .cancel { background: #333; color: #ccc; }
    .fb-footer .cancel:hover { background: #444; }
    .fb-footer .select { background: #9C27B0; color: white; font-weight: bold; }
    .fb-footer .select:hover { background: #7B1FA2; }
    .fb-footer .select:disabled { background: #555; color: #888; cursor: not-allowed; }
    .fb-empty { padding: 40px 20px; text-align: center; color: #555; font-size: 13px; }
    .fb-loading { padding: 40px 20px; text-align: center; color: #888; font-size: 13px; }
  </style>
</head>
<body>

<!-- \u6A94\u6848\u700F\u89BD\u5668 Modal -->
<div class="fb-overlay" id="fbOverlay">
  <div class="fb-dialog">
    <div class="fb-header">
      <h3>\u{1F4C2} \u9078\u64C7\u5F71\u7247\u6A94\u6848</h3>
      <button onclick="fbClose()">\u00D7</button>
    </div>
    <div class="fb-breadcrumb" id="fbBreadcrumb"></div>
    <div class="fb-list" id="fbList">
      <div class="fb-loading">\u8F09\u5165\u4E2D...</div>
    </div>
    <div class="fb-footer">
      <button class="cancel" onclick="fbClose()">\u53D6\u6D88</button>
      <button class="select" id="fbSelectBtn" disabled onclick="fbSelect()">\u9078\u53D6</button>
    </div>
  </div>
</div>

<!-- \u532F\u51FA\u8A2D\u5B9A Modal -->
<div class="modal-overlay" id="exportOverlay">
  <div class="modal-dialog">
    <div class="modal-header">
      <h3>\u{1F4E6} \u532F\u51FA\u8A2D\u5B9A</h3>
      <button onclick="exportClose()">\u00D7</button>
    </div>
    <div class="modal-body">
      <div class="modal-row">
        <label>\u89E3\u6790\u5EA6</label>
        <select id="exportResolution">
          <option value="original">\u539F\u59CB\u89E3\u6790\u5EA6</option>
          <option value="480">480P (854\u00D7480)</option>
          <option value="720">720P (1280\u00D7720)</option>
          <option value="1080" selected>1080P (1920\u00D71080)</option>
          <option value="1440">2K (2560\u00D71440)</option>
          <option value="2160">4K (3840\u00D72160)</option>
          <option value="4320">8K (7680\u00D74320)</option>
        </select>
      </div>
      <div class="modal-row">
        <label>\u7DE8\u78BC\u5668</label>
        <select id="exportCodec">
          <option value="h264" selected>H.264 (\u6700\u76F8\u5BB9)</option>
          <option value="h265">H.265 / HEVC (\u7BC0\u7701\u7A7A\u9593)</option>
          <option value="av1">AV1 (\u6700\u7BC0\u7701)</option>
        </select>
      </div>
      <div class="modal-row">
        <label>\u78BC\u7387</label>
        <select id="exportBitrate">
          <option value="low">\u66F4\u4F4E (\u00D70.6, \u7701\u7A7A\u9593)</option>
          <option value="recommended" selected>\u63A8\u85A6 (\u539F\u7247\u78BC\u7387)</option>
          <option value="high">\u66F4\u9AD8 (\u00D71.5, \u756B\u8CEA\u4F73)</option>
        </select>
      </div>
      <div class="modal-row">
        <label>\u54C1\u8CEA\u6A21\u5F0F</label>
        <select id="exportQuality">
          <option value="standard" selected>\u6A19\u6E96\uFF08\u91CD\u65B0\u7DE8\u78BC\uFF0C\u6A94\u6848\u5C0F\uFF09</option>
          <option value="lossless">\u7121\u640D\uFF08\u4FDD\u7559\u539F\u59CB\u97F3\u8CEA\uFF0C\u6A94\u6848\u8F03\u5927\uFF09</option>
        </select>
      </div>
      <div class="modal-row">
        <label>\u683C\u5F0F</label>
        <select id="exportFormat">
          <option value="mp4" selected>MP4</option>
          <option value="mkv">MKV</option>
          <option value="mov">MOV</option>
        </select>
      </div>
      <div class="modal-row">
        <label>\u5E40\u7387</label>
        <select id="exportFps">
          <option value="original">\u539F\u59CB\u5E40\u7387</option>
          <option value="24">24 fps</option>
          <option value="25">25 fps</option>
          <option value="30" selected>30 fps</option>
          <option value="50">50 fps</option>
          <option value="60">60 fps</option>
        </select>
      </div>
      <div class="modal-row">
        <label class="toggle-label">
          <input type="checkbox" id="exportSrt" checked>
          \u540C\u6642\u532F\u51FA SRT \u5B57\u5E55\u6A94
        </label>
      </div>
      <div class="modal-row">
        <label class="toggle-label">
          <input type="checkbox" id="exportAbMode">
          \u540C\u6642\u532F\u51FA AI \u5EFA\u8B70\u7248\uFF08B \u7248\uFF09\u4F9B\u5C0D\u6BD4
        </label>
      </div>
      <div class="modal-row">
        <label>\u8F38\u51FA\u8CC7\u6599\u593E</label>
        <div style="display:flex; gap:6px;">
          <input type="text" id="exportOutputDir" placeholder="\u9810\u8A2D\uFF1A\u5F71\u7247\u6240\u5728\u76EE\u9304" style="flex:1; background:#2a2a2a; color:#e0e0e0; border:1px solid #444; border-radius:6px; padding:6px 10px; font-size:13px;">
          <button onclick="fbOpenFolder()" style="background:#444; color:#e0e0e0; border:1px solid #555; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; white-space:nowrap;">\u{1F4C2}</button>
        </div>
      </div>
      <div class="modal-row">
        <label>\u8F38\u51FA\u6A94\u540D</label>
        <input type="text" id="exportFilename" placeholder="\u9810\u8A2D\uFF1A\u539F\u59CB\u6A94\u540D_cut.mp4" style="width:100%; background:#2a2a2a; color:#e0e0e0; border:1px solid #444; border-radius:6px; padding:6px 10px; font-size:13px;">
      </div>
    </div>
    <div class="modal-footer">
      <div>
        <div class="est" id="exportEst"></div>
        <div class="est" id="exportGpu" style="color:#4caf50;margin-top:4px;"></div>
        <div class="est" id="exportSanity" style="margin-top:4px;display:none;"></div>
      </div>
      <div class="btns">
        <button class="cancel" onclick="exportClose()">\u53D6\u6D88</button>
        <button class="export-btn" id="exportBtn" onclick="executeExport()">\u958B\u59CB\u532F\u51FA</button>
      </div>
    </div>
  </div>
</div>

<div class="header">
  <a href="/">\u2190 \u9996\u9801</a>
  <h1>\u{2702}\u{FE0F} \u526A\u8F2F\u5F71\u7247</h1>
  <span class="badge" id="cutBadge">\u5C31\u7DD2</span>
  <span class="video-name" id="videoName"></span>
</div>

<div class="main">
  <div class="left-panel">
    <div class="input-section">
      <label id="inputLabel">\u5F71\u7247\u8DEF\u5F91</label>
      <div style="display:flex; gap:6px;">
        <input type="text" id="videoInput" placeholder="\u8CBC\u4E0A\u5F71\u7247\u8DEF\u5F91\u6216\u9EDE\u300C\u700F\u89BD\u300D\u9078\u53D6" style="flex:1">
        <button onclick="fetch('/api/native-browse').then(function(r){return r.json()}).then(function(d){if(d.path)document.getElementById('videoInput').value=d.path}).catch(function(e){alert('browse failed: '+e.message)})" style="background:#444; color:#e0e0e0; border:1px solid #555; border-radius:6px; padding:8px 12px; cursor:pointer; font-size:13px; white-space:nowrap;">\u{1F4C2} \u700F\u89BD</button>
        <button id="batchToggle" class="batch-toggle" onclick="toggleBatchMode()" title="\u6279\u91CF\u6A21\u5F0F">\u2630 \u6279\u91CF</button>
      </div>
      <!-- \u6279\u91CF\u6A21\u5F0F\uFF1A\u52A0\u5165\u6309\u9215 -->
      <div id="batchAddRow" style="display:none; margin-top:6px;">
        <button style="width:100%; padding:7px; background:#2d2d2d; color:#ce93d8; border:1px solid #4a235a; border-radius:6px; cursor:pointer; font-size:13px;" onclick="addToQueue()">\uFF0B \u52A0\u5165\u4F47\u5217</button>
      </div>
      <!-- \u6279\u91CF\u4F47\u5217\u6E05\u55AE -->
      <div id="batchQueueBox" class="batch-queue" style="display:none;">
        <div class="batch-queue-empty" id="batchEmpty">\u5C1A\u672A\u52A0\u5165\u5F71\u7247</div>
      </div>
      <div style="margin-top:8px;">
        <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px;">\uD83D\uDCC4 \u53C3\u8003\u6587\u7A3F\uFF08\u9078\u586B\uFF0C\u8B1B\u7A3F/\u5927\u7DB1\u5373\u53EF\uFF0C\u4E0D\u5FC5\u9010\u5B57\uFF09\u2014 \u7528\u4F86\u6A19\u51FA\u7591\u4F3C\u807D\u932F\u7684\u5B57</label>
        <textarea id="referenceText" rows="4" placeholder="\u8CBC\u4E0A\u9019\u652F\u5F71\u7247\u7684\u8B1B\u7A3F\u6216\u5927\u7DB1\uFF1B\u7559\u7A7A\u5247\u76F4\u63A5\u8FA8\u8B58" style="width:100%;box-sizing:border-box;background:#1e1e1e;color:#e0e0e0;border:1px solid #444;border-radius:6px;padding:8px;font-size:12px;resize:vertical;"></textarea>
      </div>
      <button class="process-btn" id="processBtn" onclick="processVideo()">\u{1F3AC} \u958B\u59CB\u8655\u7406</button>
    </div>

    <!-- \u4FEE\u6539 2: \u6B65\u9A5F\u9032\u5EA6\u689D -->
    <div class="step-progress" id="stepProgress">
      <div class="step-item" data-step="\u63D0\u53D6\u97F3\u983B"><div class="dot"></div><span>\u63D0\u53D6\u97F3\u983B</span></div>
      <div class="step-connector"></div>
      <div class="step-item" data-step="\u8A9E\u97F3\u8F49\u9304"><div class="dot"></div><span>\u8A9E\u97F3\u8F49\u9304</span></div>
      <div class="step-connector"></div>
      <div class="step-item" data-step="\u751F\u6210\u5B57\u5E55"><div class="dot"></div><span>\u751F\u6210\u5B57\u5E55</span></div>
      <div class="step-connector"></div>
      <div class="step-item" data-step="AI \u6A19\u8A18"><div class="dot"></div><span>AI \u6A19\u8A18</span></div>
      <div class="step-connector"></div>
      <div class="step-item" data-step="\u5B8C\u6210"><div class="dot"></div><span>\u5B8C\u6210</span></div>
    </div>

    <div class="progress-section" id="progressSection">
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" id="progressFill" style="width:0%"></div>
      </div>
      <div class="progress-info">
        <span class="pct" id="progressPct">0%</span>
        <span id="progressTime">\u5DF2\u7D93\u904E 0s</span>
      </div>
    </div>

    <div class="filter-bar" id="filterBar" style="display:none">
      <label class="filter-badge" id="fbPause"><input type="checkbox" checked onchange="toggleCat('pause')"><span class="cnt" id="cntPause">0</span> \u505C\u9813</label>
      <label class="filter-badge" id="fbFiller"><input type="checkbox" checked onchange="toggleCat('filler')"><span class="cnt" id="cntFiller">0</span> \u8A9E\u6C23\u8A5E</label>
      <label class="filter-badge" id="fbRepeat"><input type="checkbox" checked onchange="toggleCat('repeat')"><span class="cnt" id="cntRepeat">0</span> \u91CD\u8907</label>
      <label class="filter-badge" id="fbReviewer" style="background:#3a3320;border-color:#7a6a35;color:#fff176;"><input type="checkbox" checked onchange="toggleCat('reviewer')"><span class="cnt" id="cntReviewer">0</span> 潤稿</label>
      <label class="filter-badge" id="fbAudit" style="background:#3a2a15;border-color:#7a4a25;color:#ffb74d;"><input type="checkbox" checked onchange="toggleCat('audit')"><span class="cnt" id="cntAudit">0</span> 二讀</label>
      <div class="filter-nav">
        <span id="navInfo">0/0</span>
        <button onclick="navMark(-1)">\u2227</button>
        <button onclick="navMark(1)">\u2228</button>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;">
        <span title="\u9ede\u64ca\u55ae\u5b57\u7684\u5207\u63db\u7c92\u5ea6">\u7c92\u5ea6:</span>
        <button id="granWord" onclick="setGranularity('word')" style="background:#5e35b1;color:#fff;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;">\u5b57\u7d1a</button>
        <button id="granSentence" onclick="setGranularity('sentence')" style="background:#333;color:#aaa;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;">\u53e5\u7d1a</button>
      </div>
    </div>

    <div id="layersPanel" style="display:none;background:#1c1c2e;border-bottom:1px solid #333;padding:10px 14px;font-size:12px;color:#e0e0e0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="color:#9C27B0;">📊 各層 AI 刪除分布</strong>
        <button onclick="document.getElementById('layersPanel').style.display='none'" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;">×</button>
      </div>
      <div id="layersPanelBody"></div>
    </div>

    <div class="guide-banner" id="guideBanner">
      <span class="guide-icon">\u{1F447}</span>
      <span class="guide-text"><strong>\u91D1\u8272</strong> = AI \u5EFA\u8B70\u522A\u9664\u3002\u9EDE\u64CA\u6574\u53E5\u5207\u63DB\uFF0C\u6216<strong>\u62D6\u66F3\u6846\u9078</strong>\u6587\u5B57\u5F8C\u9EDE\u300C\u522A\u9664\u300D\u3002\u5B8C\u6210\u5F8C\u6309\u300C\u{1F4E6} \u532F\u51FA\u300D</span>
      <button class="guide-dismiss" onclick="this.parentElement.classList.remove('show')">\u77E5\u9053\u4E86</button>
    </div>
    <div id="waveformBar" style="display:none;padding:4px 8px 2px;background:#111;border-bottom:1px solid #222;">
      <canvas id="waveformCanvas" height="36" style="width:100%;display:block;cursor:pointer;" title="\u9EDE\u64CA\u8DDF\u91DD\u5230\u5C0D\u61C9\u6642\u9593\u70B9"></canvas>
    </div>
    <div class="sentence-list" id="sentenceList">
      <div class="empty-placeholder">
        <div class="icon">\u{1F4C1}</div>
        <div class="text">\u9078\u64C7\u5F71\u7247\u4E26\u9EDE\u64CA\u300C\u958B\u59CB\u8655\u7406\u300D<br>AI \u6703\u81EA\u52D5\u6A19\u8A18\u53EF\u522A\u9664\u7684\u5167\u5BB9</div>
      </div>
    </div>

    <div class="action-bar" id="actionBar" style="display:none">
      <button onclick="acceptAll()">\u2705 AI \u5168\u90E8</button>
      <button onclick="clearAll()">\u274C \u6E05\u9664</button>
      <button class="primary" onclick="exportOpen()">\u2702\uFE0F \u958B\u59CB\u526A\u8F2F</button>
      <span class="info" id="deleteInfo"></span>
      <label style="font-size:12px;color:#aaa;display:flex;align-items:center;gap:6px;margin-left:8px;">
        \u9759\u97F3\u4FDD\u7559
        <input type="range" id="silenceKeepSlider" min="0" max="1.5" step="0.1" value="0.5" style="width:70px;cursor:pointer;">
        <span id="silenceKeepVal">0.5s</span>
      </label>
      <button onclick="protectedWordsOpen()" title="\u4FDD\u8B77\u8A5E\u6E05\u55AE" style="background:none;border:1px solid #444;color:#aaa;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:14px;margin-left:6px;">\u{1F6E1}\uFE0F</button>
      <button onclick="srtReverseOpen()" title="SRT \u53CD\u5411\u5C0D\u9F4A" style="background:none;border:1px solid #444;color:#aaa;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:14px;margin-left:6px;">&#x1F4CB;</button>
    </div>
  </div>

<!-- SRT 反向對齊 Modal -->
<div class="modal-overlay" id="srtRevOverlay">
  <div class="modal-dialog" style="max-width:560px;">
    <h3>&#x1F4CB; SRT 反向對齊</h3>
    <p style="font-size:12px;color:#aaa;margin:0 0 8px;">貼上手動編輯後的 SRT 字幕（保留想保留的字幕條目），工具將自動反推出哪些字詞應被刪除，並套用到目前的選取狀態。</p>
    <textarea id="srtRevTextarea" rows="14" placeholder="貼上 SRT 內容..." style="width:100%;box-sizing:border-box;background:#1a1a1a;color:#eee;border:1px solid #444;border-radius:6px;padding:8px;font-size:12px;font-family:monospace;resize:vertical;"></textarea>
    <div id="srtRevStatus" style="font-size:12px;color:#aaa;margin-top:6px;min-height:16px;"></div>
    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
      <button onclick="document.getElementById('srtRevOverlay').classList.remove('show')" style="padding:6px 16px;background:#333;color:#eee;border:none;border-radius:6px;cursor:pointer;">取消</button>
      <button onclick="srtReverseApply()" style="padding:6px 16px;background:#4caf50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">套用刪除</button>
    </div>
  </div>
</div>

<!-- 保護詞設定 Modal -->
<div class="modal-overlay" id="pwOverlay">
  <div class="modal-dialog" style="max-width:420px;">
    <div class="modal-header">
      <h3>\u{1F6E1}\uFE0F \u4FDD\u8B77\u8A5E\u6E05\u55AE</h3>
      <button onclick="protectedWordsClose()">\u00D7</button>
    </div>
    <div class="modal-body">
      <p style="font-size:12px;color:#888;margin:0 0 8px;">這些詞語出現時不會被 AI 刪除。每行一個詞（或用、，分隔）。</p>
      <textarea id="pwTextarea" rows="10" style="width:100%;background:#1e1e1e;color:#e0e0e0;border:1px solid #444;border-radius:6px;padding:8px;font-size:13px;resize:vertical;box-sizing:border-box;" placeholder="\u8F09\u5165\u4E2D..."></textarea>
      <div id="pwStatus" style="font-size:12px;color:#888;margin-top:6px;"></div>
    </div>
    <div class="modal-footer">
      <div></div>
      <div class="btns">
        <button class="cancel" onclick="protectedWordsClose()">\u53D6\u6D88</button>
        <button class="export-btn" onclick="protectedWordsSave()">\u5132\u5B58</button>
      </div>
    </div>
  </div>
</div>

  <!-- \u6D6E\u52D5\u5DE5\u5177\u5217 -->
  <div class="float-toolbar" id="floatToolbar">
    <button class="tb-delete" onclick="deleteSelection()">\u{1F5D1} \u522A\u9664</button>
    <div class="tb-divider"></div>
    <button class="tb-restore" onclick="restoreSelection()">\u21A9 \u6062\u5FA9</button>
  </div>

  <div class="right-panel">
    <div class="video-container" id="videoContainer">
      <div class="video-placeholder">
        <div class="icon">\u{1F3AC}</div>
        <div class="text">\u5F71\u7247\u9810\u89BD\u5340</div>
      </div>
    </div>
    <div class="result-bar" id="resultBar"></div>
  </div>
</div>

<script>
  let words = [];
  let silenceKeepSecs = 0.5; // 靜音保留秒數，可由 slider 調整
  let waveformData = null;   // { values: Float[], interval: 0.1 }
  let aiMarked = new Set();
  let aiInlineFillerWords = new Set(); // 句中雜音字（嗯/呃/欸）的 word index，跟整句刪區分
  let aiReasons = {};
  let userSelected = new Set();
  let sentences = [];
  let pollTimer = null;
  let currentVideoPath = '';
  let navIdx = -1;
  let markList = []; // 所有被標記的 phrase 索引，用於導航
  let catFilter = { pause: true, filler: true, repeat: true, reviewer: true, audit: true };
  // 點擊單字的粒度：'word' = 只刪該字（預設），'sentence' = 切換整句
  let editGranularity = (typeof localStorage !== 'undefined' && localStorage.getItem('editGranularity')) || 'word';

  function setGranularity(mode) {
    editGranularity = mode;
    try { localStorage.setItem('editGranularity', mode); } catch (e) {}
    const wBtn = document.getElementById('granWord');
    const sBtn = document.getElementById('granSentence');
    if (wBtn && sBtn) {
      const active = 'background:#5e35b1;color:#fff;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;';
      const inactive = 'background:#333;color:#aaa;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;';
      wBtn.style.cssText = mode === 'word' ? active : inactive;
      sBtn.style.cssText = mode === 'sentence' ? active : inactive;
    }
  }

  // \u4FEE\u6539 2: \u66F4\u65B0\u6B65\u9A5F\u9032\u5EA6
  // AI 標記拆 5 個子步驟，方便看卡在哪一道
  const STEPS = ['\u63D0\u53D6\u97F3\u983B', '\u8A9E\u97F3\u8F49\u9304', '\u751F\u6210\u5B57\u5E55', 'AI \u6A19\u9EDE', 'AI \u5927\u7DB1', 'AI \u5019\u9078\u5C0D', 'AI \u6F64\u7A3F', 'AI \u4E8C\u8B80', '\u5B8C\u6210'];
  function updateSteps(currentStep) {
    const idx = STEPS.indexOf(currentStep);
    document.querySelectorAll('.step-item').forEach((el, i) => {
      el.classList.toggle('completed', i < idx);
      el.classList.toggle('active', i === idx);
    });
    // \u66F4\u65B0 connector
    document.querySelectorAll('.step-connector').forEach((el, i) => {
      el.style.background = i < idx ? '#4caf50' : '#333';
    });
  }

  async function processVideo() {
    if (batchMode) {
      const pending = batchQueue.filter(x => x.status === 'pending');
      if (pending.length === 0) { alert('\u4F47\u5217\u70BA\u7A7A\uFF0C\u8ACB\u5148\u52A0\u5165\u5F71\u7247'); return; }
      document.getElementById('processBtn').disabled = true;
      await syncBatchToServer().catch(() => {}); // 持久化佇列
      startNextBatch();
      return;
    }
    const input = document.getElementById('videoInput');
    const videoPath = input.value.trim();
    if (!videoPath) { input.focus(); return; }
    _startProcessing(videoPath);
  }

  async function _startProcessing(videoPath) {
    currentVideoPath = videoPath;
    document.getElementById('videoName').textContent = videoPath.split(/[/\\\\]/).pop();
    document.getElementById('processBtn').disabled = true;
    document.getElementById('stepProgress').classList.add('show');
    document.getElementById('progressSection').classList.add('show');
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressPct').textContent = '0%';
    window._cutStartTime = Date.now();
    updateSteps('\u63D0\u53D6\u97F3\u983B');
    document.getElementById('cutBadge').textContent = '\u8655\u7406\u4E2D';
    document.getElementById('cutBadge').className = 'badge processing';
    if (batchMode) {
      const done = batchQueue.filter(x=>x.status==='done').length;
      const running = batchQueue.filter(x=>x.status==='running').length + done;
      document.getElementById('cutBadge').textContent = running + '/' + batchQueue.length;
    }
    try {
      const refEl = document.getElementById('referenceText');
      const res = await fetch('/api/process-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath, referenceText: refEl ? refEl.value : '' })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error);
        if (batchMode && batchCurrentIdx >= 0) {
          batchQueue[batchCurrentIdx].status = 'error';
          renderQueue();
          batchCurrentIdx = -1;
          setTimeout(startNextBatch, 300);
        } else {
          document.getElementById('processBtn').disabled = false;
        }
        return;
      }
      const vc = document.getElementById('videoContainer');
      vc.innerHTML = '<video id="videoPlayer" src="/api/video?path=' + encodeURIComponent(videoPath) + '"></video>' +
        '<div id="cutPlayerBar" style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:#1a1a1a;border-top:1px solid #333;color:#e0e0e0;font-size:12px;">' +
          '<button id="cutPlayBtn" style="background:#7c4dff;color:#fff;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:14px;flex-shrink:0;">▶</button>' +
          '<div id="cutProgress" style="flex:1;height:6px;background:#333;border-radius:3px;cursor:pointer;position:relative;overflow:hidden;">' +
            '<div id="cutProgressFill" style="position:absolute;left:0;top:0;height:100%;width:0;background:linear-gradient(90deg,#7c4dff,#b388ff);"></div>' +
          '</div>' +
          '<span id="cutTimeDisp" style="white-space:nowrap;font-variant-numeric:tabular-nums;">0:00 / 0:00</span>' +
          '<span id="cutOrigDisp" style="white-space:nowrap;color:#666;font-size:10px;font-variant-numeric:tabular-nums;" title="原片時間軸（包含被刪段落）"></span>' +
          '<button id="cutFsBtn" style="background:none;color:#999;border:none;cursor:pointer;font-size:14px;">⛶</button>' +
        '</div>';
      setupCutPlayer();
      pollTimer = setInterval(pollCutStatus, 1000);
    } catch (err) {
      alert('\u5931\u6557: ' + err.message);
      document.getElementById('processBtn').disabled = false;
    }
  }

  async function pollCutStatus() {
    try {
      const res = await fetch('/api/cut-status');
      const state = await res.json();
      updateSteps(state.step || '');

      // 更新進度條
      const pct = state.progress || 0;
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('progressPct').textContent = pct + '%';

      // 經過時間 + 預估剩餘
      const elapsed = Math.floor((Date.now() - (window._cutStartTime || Date.now())) / 1000);
      let timeText = '\u5DF2\u7D93\u904E ' + formatElapsed(elapsed);
      if (pct > 5 && pct < 100) {
        const totalEst = Math.round(elapsed / pct * 100);
        const remain = Math.max(0, totalEst - elapsed);
        timeText += ' | \u9810\u8A08\u5269\u9918 ' + formatElapsed(remain);
      }
      document.getElementById('progressTime').textContent = timeText;

      if (!state.running) {
        clearInterval(pollTimer);
        document.getElementById('progressFill').style.width = '100%';
        document.getElementById('progressPct').textContent = '100%';
        document.getElementById('progressTime').textContent = '\u5B8C\u6210\uFF01\u8017\u6642 ' + formatElapsed(elapsed);
        if (state.error) {
          document.getElementById('cutBadge').textContent = '\u932F\u8AA4';
          document.getElementById('cutBadge').className = 'badge';
          if (batchMode && batchCurrentIdx >= 0) {
            batchQueue[batchCurrentIdx].status = 'error';
            renderQueue();
            batchCurrentIdx = -1;
            alert('\u8655\u7406\u5931\u6557: ' + state.error + '\\n\u7E7C\u7E8C\u8655\u7406\u4E0B\u4E00\u652F...');
            setTimeout(startNextBatch, 500);
          } else {
            document.getElementById('processBtn').disabled = false;
            alert('\u8655\u7406\u5931\u6557: ' + state.error);
          }
        } else {
          updateSteps('\u5B8C\u6210');
          setTimeout(() => {
            document.getElementById('progressSection').classList.remove('show');
            document.getElementById('stepProgress').classList.remove('show');
          }, 2000);
          if (batchMode && batchCurrentIdx >= 0) {
            batchQueue[batchCurrentIdx].status = 'done';
            renderQueue();
            const doneCount = batchQueue.filter(x=>x.status==='done').length;
            document.getElementById('cutBadge').textContent = doneCount + '/' + batchQueue.length + ' \u5B8C\u6210';
            document.getElementById('cutBadge').className = 'badge ready';
            batchCurrentIdx = -1;
            loadSubtitles().then(() => setTimeout(startNextBatch, 800));
          } else {
            document.getElementById('cutBadge').textContent = '\u5C31\u7DD2';
            document.getElementById('cutBadge').className = 'badge ready';
            loadSubtitles();
          }
        }
      }
    } catch (e) {}
  }

  function formatElapsed(sec) {
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + 'm ' + s + 's';
  }

  // 補強 sentences：從 words 補 gapAfterIndices、補前置靜音
  function enrichSentences(sents) {
    // 1. 補 gapAfterIndices（舊快取只有 gapAfterIdx 單一 index）
    for (const s of sents) {
      if (!s.gapAfterIndices && s.gapAfterIdx !== undefined) {
        const group = [s.gapAfterIdx];
        let k = s.gapAfterIdx + 1;
        while (k < words.length && words[k] && words[k].isGap) { group.push(k); k++; }
        s.gapAfterIndices = group;
        s.gapAfter = words[group[group.length - 1]].end - words[group[0]].start;
      }
    }
    // 2. 靜音 >= AUTO_GAP_THRESHOLD 秒 → 自動 trim（保留 SILENCE_KEEP_SECS，刪其餘）
    const AUTO_GAP_THRESHOLD = 1.85;
    const SILENCE_KEEP_SECS = silenceKeepSecs || 0.5; // 由全域 slider 控制，預設 0.5s
    for (const s of sents) {
      const g = s.gapAfterIndices || [];
      if (g.length === 0 || s.gapAfter < AUTO_GAP_THRESHOLD) continue;
      // 找切割點：第一個 start >= gapStart + SILENCE_KEEP_SECS 的 word
      const gapStart = words[g[0]].start;
      const splitPos = g.findIndex(idx => words[idx].start >= gapStart + SILENCE_KEEP_SECS);
      const cutAt = splitPos > 0 ? splitPos : 0;
      s.gapKeepIndices = g.slice(0, cutAt);
      s.gapTrimIndices = g.slice(cutAt);
      s.gapKeepDur = cutAt > 0 ? words[g[cutAt - 1]].end - words[g[0]].start : 0;
      s.gapTrimDur = s.gapAfter - s.gapKeepDur;
      s.gapDelete = true;
      s.gapDeleteCategory = s.gapDeleteCategory || 'pause';
      s.gapDeleteReason = s.gapDeleteReason || ('\u9759\u97f3 ' + s.gapTrimDur.toFixed(2) + 's');
    }
    // 3. 如果開頭沒有前置靜音條目，嘗試插入
    if (sents.length === 0 || !sents[0].isLeadingSilence) {
      const LEADING_SILENCE_MIN = 2.0;
      const firstRealIdx = words.findIndex(w => !w.isGap && w.text && w.text.trim());
      if (firstRealIdx > 0) {
        const leadingDuration = words[firstRealIdx].start - words[0].start;
        if (leadingDuration >= LEADING_SILENCE_MIN) {
          const lgIdx = [];
          for (let i = 0; i < firstRealIdx; i++) lgIdx.push(i);
          sents.unshift({
            text: '', displayText: '', wordIndices: [], gapIndices: lgIdx,
            startTime: words[0].start, endTime: words[firstRealIdx].start,
            deleteCategory: 'pause', deleteReason: '\u524d\u7f6e\u975c\u97f3',
            isLeadingSilence: true, gapAfter: 0
          });
        }
      }
    }
    return sents;
  }

  async function loadSubtitles() {
    try {
      const [subsRes, sentRes] = await Promise.all([
        fetch('/api/cut-subtitles'),
        fetch('/api/cut-sentences')
      ]);
      words = await subsRes.json();
      userSelected = new Set();
      aiMarked = new Set();
      aiInlineFillerWords = new Set();

      // 讀取 AI 分析結果（全權 AI 判斷版）
      if (sentRes.ok) {
        sentences = enrichSentences(await sentRes.json());
        console.log('AI sentences:', sentences.length);
        for (const s of sentences) {
          // 段落刪除
          if (s.aiDelete) {
            const allIdx = [...(s.wordIndices || []), ...(s.gapIndices || [])];
            (s.gapAfterIndices || (s.gapAfterIdx !== undefined ? [s.gapAfterIdx] : [])).forEach(gi => allIdx.push(gi));
            allIdx.forEach(i => { userSelected.add(i); aiMarked.add(i); });
          }
          // 停頓刪除（只刪 gap，不刪文字）；有 trim 時只刪 gapTrimIndices
          if (s.gapDelete) {
            const delIdx = s.gapTrimIndices || s.gapAfterIndices || (s.gapAfterIdx !== undefined ? [s.gapAfterIdx] : []);
            delIdx.forEach(gi => { userSelected.add(gi); aiMarked.add(gi); });
          }
          // 句中雜音字（嗯/呃/欸）— 句子保留，但這幾個字標 filler 刪除
          if (Array.isArray(s.inlineFillerWordIndices) && s.inlineFillerWordIndices.length > 0 && !s.aiDelete) {
            s.inlineFillerWordIndices.forEach(gi => {
              userSelected.add(gi);
              aiMarked.add(gi);
              aiInlineFillerWords.add(gi);
            });
          }
        }
      } else {
        sentences = buildSentences();
        console.log('Fallback sentences:', sentences.length);
      }
      renderFlowText();
      setupDragSelect();
      // 非同步載入「各層刪除分布」panel
      loadLayersPanel().catch(() => {});

      // 非同步載入音波圖（不阻塞主流程）
      if (currentVideoPath) {
        fetch('/api/waveform?path=' + encodeURIComponent(currentVideoPath))
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data && data.values) { waveformData = data; renderWaveform(); } })
          .catch(() => {});
      }

      // 檢查 AI 分析是否有效
      const hasAI = sentences.some(s => s.displayText || s.aiDelete);
      const guideBanner = document.getElementById('guideBanner');
      if (!hasAI && sentences.length > 0) {
        // AI 分析未生效 → 顯示警告 + 重跑按鈕
        guideBanner.innerHTML = '<span class="guide-icon">\u26A0\uFE0F</span>' +
          '<span class="guide-text">AI \u5206\u6790\u672A\u751F\u6548\uFF08\u7F3A\u5C11\u6A19\u9EDE\u548C\u522A\u9664\u6A19\u8A18\uFF09</span>' +
          '<button class="guide-dismiss" onclick="rerunAI()" style="background:#7c4dff;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;">\u{1F504} \u91CD\u65B0 AI \u5206\u6790</button>';
        guideBanner.classList.add('show');
      } else {
        guideBanner.classList.add('show');
      }

      document.getElementById('filterBar').style.display = 'flex';
      document.getElementById('actionBar').style.display = 'flex';
      document.getElementById('stepProgress').classList.remove('show');
      document.getElementById('processBtn').disabled = false;
    } catch (err) {
      alert('\u8F09\u5165\u5B57\u5E55\u5931\u6557: ' + err.message);
    }
  }

  // \u4FEE\u6539 3: \u53E5\u5B50\u5316\u908F\u8F2F
  // 「各層 AI 刪除分布」panel：拉 /api/compare-layers 並渲染
  async function loadLayersPanel() {
    const panel = document.getElementById('layersPanel');
    const body  = document.getElementById('layersPanelBody');
    if (!panel || !body) return;
    try {
      const r = await fetch('/api/compare-layers');
      if (!r.ok) return;
      const d = await r.json();
      if (d.error) return;

      const labels = {
        pause: '🟢 停頓 (gap rule)',
        filler: '🟢 語氣詞 (filler rule)',
        repeat: '🟢 重複 (rule)',
        ai_pair: '🟡 ai_cut_pairs (候選對)',
        whisper_hallucination: '🟢 Whisper 幻覺 (rule)',
        take_group: '🟢 重複 take group',
        adjacent_repeat: '🟢 相鄰重複',
        reviewer: '🟡 reviewer (整稿潤稿)',
        audit: '🟠 audit (嚴格二讀)',
        unknown: '⚪ 未分類',
      };
      const colors = { reviewer: '#fff176', audit: '#ffb74d', ai_pair: '#d4b44a' };

      const sorted = Object.entries(d.byCategory || {}).sort((a, b) => b[1] - a[1]);
      const total = sorted.reduce((s, [, c]) => s + c, 0) || 1;

      let html = '<div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:10px;">';
      html += '<span style="color:#aaa;">總計刪 <strong style="color:#f44336;">' + d.totalDeleted + '</strong> 句';
      html += ' / 保留 <strong style="color:#4caf50;">' + d.totalKept + '</strong> 句';
      html += ' · ' + (d.originalDurationSec / 60).toFixed(1) + ' 分 → '
            + (d.keptDurationSec / 60).toFixed(1) + ' 分（省 ' + d.savedPercent.toFixed(0) + '%）</span></div>';

      html += '<div style="display:flex;flex-direction:column;gap:3px;">';
      for (const [cat, count] of sorted) {
        const label = labels[cat] || cat;
        const pct = (count / total * 100).toFixed(1);
        const barW = Math.max(2, Math.round(count / total * 100));
        const color = colors[cat] || '#888';
        html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">';
        html += '<span style="width:200px;color:#ccc;">' + label + '</span>';
        html += '<span style="width:36px;color:' + color + ';font-weight:600;">' + count + '</span>';
        html += '<span style="width:46px;color:#888;">' + pct + '%</span>';
        html += '<span style="flex:1;background:#0e0e1a;border-radius:3px;height:10px;position:relative;overflow:hidden;">';
        html += '<span style="position:absolute;left:0;top:0;height:100%;width:' + barW + '%;background:' + color + ';opacity:.7;"></span>';
        html += '</span></div>';
      }
      html += '</div>';

      for (const focus of ['reviewer', 'audit']) {
        const items = (d.detailsByCategory || {})[focus] || [];
        if (items.length === 0) continue;
        const color = colors[focus];
        html += '<details style="margin-top:10px;font-size:11px;">';
        html += '<summary style="cursor:pointer;color:' + color + ';font-weight:600;">'
             + labels[focus] + ' 詳細（' + items.length + ' 句）</summary>';
        html += '<div style="margin:6px 0 0 16px;color:#bbb;max-height:240px;overflow-y:auto;">';
        for (const it of items.slice(0, 50)) {
          html += '<div style="margin:4px 0;padding:4px 8px;background:#252535;border-radius:4px;">';
          html += '<div style="color:#ddd;">[' + it.id + '] ' + escapeHtmlSafe(it.text) + '</div>';
          html += '<div style="color:#888;font-style:italic;font-size:10px;margin-top:2px;">→ ' + escapeHtmlSafe(it.reason) + '</div>';
          html += '</div>';
        }
        if (items.length > 50) html += '<div style="color:#666;text-align:center;">…還有 ' + (items.length - 50) + ' 句</div>';
        html += '</div></details>';
      }

      const logs = d.logs || [];
      if (logs.length) {
        html += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #333;display:flex;flex-wrap:wrap;gap:4px 16px;font-size:10px;color:#888;">';
        for (const l of logs) {
          if (!l.exists) html += '<span style="opacity:.5;">' + l.name + ': 無 log</span>';
          else html += '<span><strong style="color:#aaa;">' + l.name + ':</strong> ' + escapeHtmlSafe(l.summary || '已跑') + '</span>';
        }
        html += '</div>';
      }

      body.innerHTML = html;
      panel.style.display = 'block';
    } catch (e) {
      console.warn('loadLayersPanel error', e);
    }
  }

  function escapeHtmlSafe(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildSentences() {
    const GAP = 0.5;
    const LEADING_SILENCE_MIN = 2.0; // 前置靜音超過 2 秒才顯示為可刪除的停頓
    const result = [];
    let curr = { text: '', wordIndices: [], gapIndices: [], startTime: 0, endTime: 0 };

    // ── 偵測前置靜音（第一句話之前的 gap）──
    let leadingGapIndices = [];
    let firstRealIdx = words.findIndex(w => !w.isGap && w.text && w.text.trim());
    if (firstRealIdx > 0) {
      const leadingDuration = words[firstRealIdx].start - (words[0] ? words[0].start : 0);
      if (leadingDuration >= LEADING_SILENCE_MIN) {
        for (let i = 0; i < firstRealIdx; i++) leadingGapIndices.push(i);
        result.push({
          text: '',
          displayText: '',
          wordIndices: [],
          gapIndices: leadingGapIndices,
          startTime: words[0].start,
          endTime: words[firstRealIdx].start,
          deleteCategory: 'pause',
          deleteReason: '\u524d\u7f6e\u975c\u97f3',
          isLeadingSilence: true,
          gapAfter: 0
        });
      }
    }

    const leadingSet = new Set(leadingGapIndices);
    for (let i = 0; i < words.length; i++) {
      if (leadingSet.has(i)) continue; // 已被前置靜音收走
      const w = words[i];
      const isLongGap = w.isGap && (w.end - w.start) >= GAP;
      if (isLongGap) {
        if (curr.text.length > 0) {
          // 收集從 i 開始的所有連續 gap words（不管長短）
          const gapGroup = [i];
          let j = i + 1;
          while (j < words.length && words[j].isGap) { gapGroup.push(j); j++; }
          const totalDur = words[gapGroup[gapGroup.length - 1]].end - words[gapGroup[0]].start;
          curr.gapAfter = totalDur;           // 真實總時長
          curr.gapAfterIdx = gapGroup[0];     // 向後相容
          curr.gapAfterIndices = gapGroup;    // 完整 indices
          result.push({ ...curr });
          i = j - 1; // 跳過已處理的 gap words
        } else {
          // curr 是空的（連續 gap 中間），跳過整段
          let j = i + 1;
          while (j < words.length && words[j].isGap) j++;
          i = j - 1;
        }
        curr = { text: '', wordIndices: [], gapIndices: [], startTime: 0, endTime: 0 };
      } else if (!w.isGap) {
        if (curr.wordIndices.length === 0) curr.startTime = w.start;
        curr.text += w.text;
        curr.endTime = w.end;
        curr.wordIndices.push(i);
      } else {
        curr.gapIndices.push(i);
      }
    }
    if (curr.text.length > 0) result.push(curr);
    return result;
  }

  // 取得句子的刪除分類
  function getCat(s) {
    if (s.deleteCategory) return s.deleteCategory;
    if (s.gapDeleteCategory) return s.gapDeleteCategory;
    const reason = (s.deleteReason || '').toLowerCase();
    if (reason.match(/停頓|silence|pause/)) return 'pause';
    if (reason.match(/填充|filler|口吃|stutter|咳|cough|hmm|語氣/)) return 'filler';
    if (reason.match(/重錄|重複|retake|repeat|不完整|incomplete/)) return 'repeat';
    // 根據內容猜測
    if (s.text && s.text.match(/^(嗯|啊|Hmm|Hmm\.|哎|呃|額|唉|哦|噢|呀|欸|咳|咳咳|嗯哼)\.?$/i)) return 'filler';
    return 'repeat';
  }

  // ── 單字級渲染 + 框選邏輯 ──

  // 建立全域「逐字到句子」映射表（每次 loadSubtitles 後呼叫）
  let wordMap = []; // wordMap[globalWordIdx] = { si, localIdx, char }
  function buildWordMap() {
    wordMap = [];
    for (let si = 0; si < sentences.length; si++) {
      const s = sentences[si];
      const display = s.displayText || s.text;
      const wIdx = s.wordIndices || [];
      // 將 displayText 的每個字元對映到 wordIndices
      // displayText 有標點（比 wordIndices 多），按比例分配
      const chars = [...display]; // 拆成字元陣列（含標點）
      const puncRe = /[，。？！；、：\u201C\u201D\u2018\u2019（）「」【】\s·…—\-]/;
      let wi = 0;
      for (let ci = 0; ci < chars.length; ci++) {
        const isPunc = puncRe.test(chars[ci]);
        // 標點字不佔 wordIndex，歸入前一個 word
        const mappedWi = isPunc ? Math.max(0, wi - 1) : wi;
        const globalIdx = (mappedWi < wIdx.length) ? wIdx[mappedWi] : (wIdx.length > 0 ? wIdx[wIdx.length - 1] : -1);
        wordMap.push({ si, globalIdx, char: chars[ci] });
        if (!isPunc && wi < wIdx.length) wi++;
      }
      // gap indices 和 gapAfterIdx 不在文字裡，不需渲染字元
    }
  }

  // 框選狀態
  let dragActive = false;
  let dragStartEl = null;
  let dragEndEl = null;
  let dragSelectedGlobal = new Set(); // 框選中的 global word indices

  function renderFlowText() {
    const list = document.getElementById('sentenceList');
    if (sentences.length === 0) {
      list.innerHTML = '<div class="empty-placeholder"><div class="icon">\u{1F4C1}</div><div class="text">\u7121\u5B57\u5E55\u8CC7\u6599</div></div>';
      return;
    }

    buildWordMap();

    const PARA_GAP = 2.0;
    let html = '';
    let counts = { pause: 0, filler: 0, repeat: 0, reviewer: 0, audit: 0 };
    markList = [];
    let wmIdx = 0; // wordMap cursor

    for (let si = 0; si < sentences.length; si++) {
      const s = sentences[si];
      const cat = getCat(s);
      const reason = s.deleteReason || s.gapDeleteReason || '';
      const display = s.displayText || s.text;
      const chars = [...display];
      let phraseHasMark = false;

      // 前置靜音：特殊渲染（無文字字元，只顯示可點選的停頓標記）
      if (s.isLeadingSilence) {
        const dur = (s.endTime - s.startTime);
        const allDel = s.gapIndices.length > 0 && s.gapIndices.every(gi => userSelected.has(gi));
        if (allDel) { counts.pause = (counts.pause || 0) + 1; markList.push(si); }
        const gCls = allDel ? 'gap-mk deleted' : 'gap-mk';
        html += '<span class="' + gCls + ' leading-silence" data-sidx="' + si + '" data-gap="1" data-leading="1" title="\u524d\u7f6e\u975c\u97f3 ' + dur.toFixed(1) + 's\uff0c\u9ede\u64ca\u522a\u9664">[\u524d\u7f6e\u975c\u97f3 ' + dur.toFixed(1) + 's]</span><span class="pbreak"></span>';
        continue;
      }

      // 逐字渲染
      let phraseHasInlineFiller = false;
      for (let ci = 0; ci < chars.length; ci++) {
        if (wmIdx >= wordMap.length) break;
        const wm = wordMap[wmIdx];
        const gi = wm.globalIdx;
        const isDel = gi >= 0 && userSelected.has(gi);
        // inline filler：句中雜音字，不繼承句子 category，獨立用 'filler'
        const isInlineFiller = gi >= 0 && aiInlineFillerWords.has(gi);
        const wordCat = isInlineFiller ? 'filler' : cat;
        if (isDel) phraseHasMark = true;
        if (isInlineFiller && isDel) phraseHasInlineFiller = true;
        const cls = isDel ? 'w deleted cat-' + wordCat : 'w';
        const wordReason = isInlineFiller ? '句中雜音字（inline filler 自動清理）' : reason;
        const tip = (isDel && wordReason) ? ' title="' + escHtml(wordReason) + '"' : '';
        html += '<span class="' + cls + '" data-wm="' + wmIdx + '" data-gi="' + gi + '" data-si="' + si + '"' + tip + '>' + escHtml(chars[ci]) + '</span>';
        wmIdx++;
      }
      // 句中有 inline filler 時，filler 計數 +1（即使整句沒被刪也會在 navigation 中）
      if (phraseHasInlineFiller && !s.aiDelete) counts.filler = (counts.filler || 0) + 1;

      // 句內 gaps 也要能選（歸入句子刪除計數）
      const gapIdxs = s.gapIndices || [];
      for (const gIdx of gapIdxs) {
        if (userSelected.has(gIdx)) phraseHasMark = true;
      }

      if (phraseHasMark) {
        counts[cat] = (counts[cat] || 0) + 1;
        markList.push(si);
      }

      // 句後停頓標記
      if (s.gapAfter && s.gapAfter >= 0.5) {
        if (s.gapTrimIndices && s.gapKeepDur > 0) {
          // Trim 模式：顯示保留段 [Ks] + 刪除段 [Rs]
          const trimDel = s.gapTrimIndices.length > 0 && s.gapTrimIndices.every(gi => userSelected.has(gi));
          if (trimDel) { counts.pause = (counts.pause || 0) + 1; markList.push('g' + si); }
          const kTip = ' title="\u4fdd\u7559 ' + s.gapKeepDur.toFixed(1) + 's\uff08\u81ea\u7136\u9593\u9694\uff09"';
          html += '<span class="gap-mk gap-keep"' + kTip + '>...[' + s.gapKeepDur.toFixed(2) + 's]</span>';
          const tCls = trimDel ? 'gap-mk deleted' : 'gap-mk';
          const tTip = ' title="' + escHtml(s.gapDeleteReason || ('\u9759\u97f3 ' + s.gapTrimDur.toFixed(1) + 's\uff0c\u9ede\u64ca\u5207\u63db')) + '"';
          html += '<span class="' + tCls + '" data-sidx="' + si + '" data-gap="1" data-trim="1"' + tTip + '>[' + s.gapTrimDur.toFixed(2) + 's]</span>';
        } else {
          // 一般模式（短靜音或無 trim）
          const gapIndices = s.gapAfterIndices || (s.gapAfterIdx !== undefined ? [s.gapAfterIdx] : []);
          const gapDel = gapIndices.length > 0 && gapIndices.every(gi => userSelected.has(gi));
          if (gapDel) { counts.pause = (counts.pause || 0) + 1; markList.push('g' + si); }
          const gCls = gapDel ? 'gap-mk deleted' : 'gap-mk';
          const gTip = gapDel ? ' title="' + escHtml(s.gapDeleteReason || '\u505C\u9813 ' + s.gapAfter.toFixed(1) + 's') + '"' : '';
          html += '<span class="' + gCls + '" data-sidx="' + si + '" data-gap="1"' + gTip + '>...[' + s.gapAfter.toFixed(2) + 's]</span>';
        }
        if (s.gapAfter >= PARA_GAP) {
          html += '<span class="pbreak"></span>';
        }
      }
    }

    list.innerHTML = html;

    // 更新篩選計數
    document.getElementById('cntPause').textContent = counts.pause || 0;
    document.getElementById('cntFiller').textContent = counts.filler || 0;
    document.getElementById('cntRepeat').textContent = counts.repeat || 0;
    const cntRev = document.getElementById('cntReviewer'); if (cntRev) cntRev.textContent = counts.reviewer || 0;
    const cntAud = document.getElementById('cntAudit');    if (cntAud) cntAud.textContent = counts.audit || 0;
    // userSelected 可能在這次 render 前被異動 → 讓 video skip cache 失效，下次 timeupdate 重算
    if (typeof invalidateDelRangesCache === 'function') invalidateDelRangesCache();

    // 更新導航
    const total = markList.length;
    if (navIdx >= total) navIdx = total - 1;
    if (navIdx < 0 && total > 0) navIdx = 0;
    document.getElementById('navInfo').textContent = total > 0 ? (navIdx + 1) + '/' + total : '0/0';

    updateInfo();
    // 同步更新音波圖刪除區段標記
    if (waveformData) renderWaveform();
  }

  // ── 框選（drag-to-select）邏輯 ──
  function setupDragSelect() {
    const list = document.getElementById('sentenceList');
    const toolbar = document.getElementById('floatToolbar');

    // 取得 wordMap index 範圍
    function getRange(a, b) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const set = new Set();
      for (let i = lo; i <= hi; i++) {
        if (i < wordMap.length && wordMap[i].globalIdx >= 0) {
          set.add(wordMap[i].globalIdx);
        }
      }
      return set;
    }

    // 清除框選高亮
    function clearDragHighlight() {
      list.querySelectorAll('.w.drag-sel').forEach(el => el.classList.remove('drag-sel'));
    }

    // 繪製框選高亮
    function applyDragHighlight(startWm, endWm) {
      clearDragHighlight();
      const lo = Math.min(startWm, endWm), hi = Math.max(startWm, endWm);
      list.querySelectorAll('.w').forEach(el => {
        const wm = parseInt(el.dataset.wm);
        if (wm >= lo && wm <= hi) el.classList.add('drag-sel');
      });
    }

    // 顯示浮動工具列
    function showToolbar(x, y) {
      toolbar.style.left = x + 'px';
      toolbar.style.top = (y - 50) + 'px';
      toolbar.classList.add('show');
    }
    function hideToolbar() {
      toolbar.classList.remove('show');
      dragSelectedGlobal.clear();
      clearDragHighlight();
    }

    list.addEventListener('mousedown', function(e) {
      const el = e.target.closest('.w');
      if (!el) {
        // 點空白處 → 隱藏 toolbar
        hideToolbar();
        return;
      }
      e.preventDefault(); // 防止文字選取
      dragActive = true;
      dragStartEl = parseInt(el.dataset.wm);
      dragEndEl = dragStartEl;
      dragSelectedGlobal.clear();
      hideToolbar();
      applyDragHighlight(dragStartEl, dragEndEl);
    });

    list.addEventListener('mousemove', function(e) {
      if (!dragActive) return;
      const el = e.target.closest('.w');
      if (!el) return;
      dragEndEl = parseInt(el.dataset.wm);
      applyDragHighlight(dragStartEl, dragEndEl);
    });

    list.addEventListener('mouseup', function(e) {
      if (!dragActive) { return; }
      dragActive = false;
      const el = e.target.closest('.w');
      if (el) dragEndEl = parseInt(el.dataset.wm);

      dragSelectedGlobal = getRange(dragStartEl, dragEndEl);

      if (dragSelectedGlobal.size === 0) return;

      // 單字點擊（起點 == 終點）→ 依粒度模式切換
      if (dragStartEl === dragEndEl) {
        const gi = parseInt((el || e.target).dataset.gi || '-1');
        if (gi >= 0) {
          if (editGranularity === 'word') {
            // 字級：只 toggle 該字本身
            // 為避免「字刪了但兩側 gap 沒刪」造成跳音，刪該字時連同它的前 gap 一起選
            // （該字索引前一個若是同句的 gap，一起加入）
            if (userSelected.has(gi)) {
              userSelected.delete(gi);
            } else {
              userSelected.add(gi);
              const prev = words[gi - 1];
              if (prev && prev.isGap && (prev.end - prev.start) < 0.5) {
                userSelected.add(gi - 1);
              }
            }
          } else {
            // 句級：切換整句（舊行為）
            const si = parseInt((el || e.target).dataset.si || '0');
            const s = sentences[si];
            const allIdx = [...(s.wordIndices || []), ...(s.gapIndices || [])];
            (s.gapAfterIndices || (s.gapAfterIdx !== undefined ? [s.gapAfterIdx] : [])).forEach(gi => allIdx.push(gi));
            const allSel = allIdx.every(i => userSelected.has(i));
            if (allSel) allIdx.forEach(i => userSelected.delete(i));
            else allIdx.forEach(i => userSelected.add(i));
          }
        }
        clearDragHighlight();
        renderFlowText();

        // 影片跳轉
        const si = parseInt((el || e.target).dataset.si || '0');
        const video = document.getElementById('videoPlayer');
        if (video && sentences[si]) video.currentTime = sentences[si].startTime || 0;
        return;
      }

      // 多字框選 → 顯示工具列
      const rect = list.getBoundingClientRect();
      const lastEl = list.querySelector('.w[data-wm="' + dragEndEl + '"]');
      if (lastEl) {
        const r = lastEl.getBoundingClientRect();
        showToolbar(r.left, r.top);
      }

      // 影片跳轉到框選起點
      const startWm = Math.min(dragStartEl, dragEndEl);
      if (startWm < wordMap.length) {
        const si = wordMap[startWm].si;
        const video = document.getElementById('videoPlayer');
        if (video && sentences[si]) video.currentTime = sentences[si].startTime || 0;
      }
    });

    // gap 點擊（停頓標記）
    list.addEventListener('click', function(e) {
      const gapEl = e.target.closest('.gap-mk');
      if (!gapEl) return;
      const si = parseInt(gapEl.dataset.sidx);
      const s = sentences[si];
      // gap 點擊時影片跳到該句末（靜音開頭）
      if (s && s.endTime !== undefined) {
        const vid = document.getElementById('videoPlayer');
        if (vid) { vid.currentTime = Math.max(0, s.endTime - 0.1); vid.play().catch(() => {}); }
      }
      if (s && s.isLeadingSilence) {
        const allDel = s.gapIndices.every(gi => userSelected.has(gi));
        s.gapIndices.forEach(gi => allDel ? userSelected.delete(gi) : userSelected.add(gi));
        renderFlowText();
      } else if (s) {
        // trim 模式只切換 gapTrimIndices；一般模式切換全部
        const indices = s.gapTrimIndices || s.gapAfterIndices || (s.gapAfterIdx !== undefined ? [s.gapAfterIdx] : []);
        if (indices.length > 0) {
          const allDel = indices.every(gi => userSelected.has(gi));
          indices.forEach(gi => allDel ? userSelected.delete(gi) : userSelected.add(gi));
          renderFlowText();
        }
      }
    });

    // 點擊外部 → 隱藏工具列
    document.addEventListener('mousedown', function(e) {
      if (toolbar.contains(e.target)) return;
      if (list.contains(e.target)) return;
      hideToolbar();
    });
  }

  // ── 音波圖渲染 ──
  function renderWaveform() {
    if (!waveformData || !waveformData.values || waveformData.values.length === 0) return;
    const bar = document.getElementById('waveformBar');
    const canvas = document.getElementById('waveformCanvas');
    if (!bar || !canvas) return;

    bar.style.display = '';
    canvas.width = canvas.offsetWidth || 800;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const vals = waveformData.values;
    const totalSecs = words.length > 0 ? words[words.length - 1].end : vals.length * waveformData.interval;

    ctx.clearRect(0, 0, W, H);

    // 底色
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, W, H);

    // 畫每個時間格的音量條
    const barW = Math.max(1, W / vals.length);
    for (let i = 0; i < vals.length; i++) {
      const t = i * waveformData.interval;
      const x = (t / totalSecs) * W;
      const amp = vals[i];
      const barH = Math.max(1, amp * (H - 4));
      const y = (H - barH) / 2;
      // 顏色：靜音灰、正常綠、響亮橙
      if (amp < 0.05) ctx.fillStyle = '#333';
      else if (amp < 0.6) ctx.fillStyle = '#4caf50';
      else ctx.fillStyle = '#ff9800';
      ctx.fillRect(x, y, Math.max(1, barW - 0.5), barH);
    }

    // 畫被 userSelected 覆蓋的刪除區段（紅色半透明）
    ctx.fillStyle = 'rgba(244,67,54,0.35)';
    let runStart = null;
    const sortedSel = [...userSelected].sort((a, b) => a - b);
    for (const idx of sortedSel) {
      if (!words[idx]) continue;
      const sx = (words[idx].start / totalSecs) * W;
      const ex = (words[idx].end / totalSecs) * W;
      ctx.fillRect(sx, 0, Math.max(1, ex - sx), H);
    }

    // 畫播放位置線
    const vid = document.getElementById('videoPlayer');
    if (vid && !isNaN(vid.currentTime)) {
      const px = (vid.currentTime / totalSecs) * W;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }
  }

  // waveform canvas click → seek
  (function() {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    canvas.addEventListener('click', function(e) {
      if (!waveformData || words.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const totalSecs = words[words.length - 1].end;
      const seekT = ratio * totalSecs;
      const vid = document.getElementById('videoPlayer');
      if (vid) { vid.currentTime = seekT; vid.play().catch(() => {}); }
    });
    // 影片播放時更新播放位置線 + 即時跳過被刪段落（剪後預覽）+ 字幕同步高亮
    document.addEventListener('timeupdate', function(e) {
      if (e.target && e.target.id === 'videoPlayer') {
        renderWaveform();
        skipDeletedRanges(e.target);
        highlightCurrentWord(e.target.currentTime);
      }
    }, true);
  })();

  // 字幕同步：找到目前播放時間對應的詞，套 .now-playing class，並自動捲動進視窗
  let _lastPlayingWmIdx = -1;
  function highlightCurrentWord(originalT) {
    if (!Array.isArray(words) || words.length === 0) return;
    // 二分查找對應的詞（用原片時間 — words[i].start/end 都是原片時間）
    let lo = 0, hi = words.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w = words[mid];
      if (originalT < (w.start || 0)) hi = mid - 1;
      else if (originalT > (w.end || 0)) lo = mid + 1;
      else { hit = mid; break; }
    }
    // 沒命中區間（在 gap 上）就退回最後一個 end<=t 的詞
    if (hit < 0) hit = Math.max(0, lo - 1);
    if (hit < 0 || hit >= words.length) return;

    // wordMap 把全域 word index 映射到 DOM 上的字符（一個 word 可能對應多個 char span）
    // 先找該詞對應的第一個 wm index
    let targetWmIdx = -1;
    for (let i = 0; i < wordMap.length; i++) {
      if (wordMap[i].globalIdx === hit) { targetWmIdx = i; break; }
    }
    if (targetWmIdx === _lastPlayingWmIdx) return; // 沒換字就不重畫

    // 清掉上次高亮
    document.querySelectorAll('.w.now-playing').forEach(el => el.classList.remove('now-playing'));

    // 套新高亮（同一個 word 的所有字 span 都標）
    const newEls = [];
    for (let i = 0; i < wordMap.length; i++) {
      if (wordMap[i].globalIdx === hit) {
        const el = document.querySelector('.w[data-wm="' + i + '"]');
        if (el) { el.classList.add('now-playing'); newEls.push(el); }
      }
    }
    _lastPlayingWmIdx = targetWmIdx;

    // 自動捲動進視窗（throttle：只在元素不在可視範圍才捲）
    if (newEls.length > 0) {
      const el = newEls[0];
      const rect = el.getBoundingClientRect();
      const list = document.getElementById('sentenceList');
      if (list) {
        const lr = list.getBoundingClientRect();
        if (rect.top < lr.top + 50 || rect.bottom > lr.bottom - 50) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  }

  // 把當前 userSelected 轉成 [{start, end}] 排序後的時間區間
  // 用 cache 避免每次 timeupdate 都重算（O(N) 詞數）
  let _delRangesCache = null;
  let _delRangesCacheKey = '';
  function getDeletionRanges() {
    // 用 userSelected size + 一個簡易 hash 當 cache key
    const key = userSelected.size + ':' + (words.length || 0);
    if (key === _delRangesCacheKey && _delRangesCache) return _delRangesCache;

    // 收集被刪的詞時間段
    const segs = [];
    for (const idx of userSelected) {
      if (idx < 0 || idx >= words.length) continue;
      const w = words[idx];
      if (typeof w.start !== 'number' || typeof w.end !== 'number') continue;
      segs.push({ s: w.start, e: w.end });
    }
    segs.sort((a, b) => a.s - b.s);

    // 合併相鄰（< 0.4s 間隔當作連續）
    const merged = [];
    for (const seg of segs) {
      if (merged.length && seg.s - merged[merged.length - 1].e < 0.4) {
        merged[merged.length - 1].e = Math.max(merged[merged.length - 1].e, seg.e);
      } else {
        merged.push({ s: seg.s, e: seg.e });
      }
    }
    _delRangesCache = merged;
    _delRangesCacheKey = key;
    return merged;
  }

  // 影片時間進入刪除區間就跳過
  let _lastSkip = 0;
  function skipDeletedRanges(video) {
    if (video.paused || video.seeking) return;
    const t = video.currentTime;
    // 防抖：同一秒內不重複 seek
    if (Math.abs(t - _lastSkip) < 0.05) return;
    const ranges = getDeletionRanges();
    if (ranges.length === 0) return;
    // binary search 找到最接近的 range
    let lo = 0, hi = ranges.length - 1, hit = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid];
      if (t < r.s) hi = mid - 1;
      else if (t > r.e) lo = mid + 1;
      else { hit = r; break; }
    }
    if (hit) {
      // 跳到區間結束 + 0.05s 緩衝；若後面接著另一個刪除區間，連著跳
      let target = hit.e + 0.05;
      let i = ranges.indexOf(hit) + 1;
      while (i < ranges.length && ranges[i].s - target < 0.1) {
        target = ranges[i].e + 0.05;
        i++;
      }
      _lastSkip = target;
      video.currentTime = target;
    }
  }

  // 改 userSelected 後立刻清 cache（renderFlowText 跟所有 toggle 都會走 invalidate）
  function invalidateDelRangesCache() {
    _delRangesCacheKey = '';
    _cutTotalDur = null;
    updateCutPlayerUI();
  }

  // ────────────── CapCut 式剪後時間軸 ──────────────
  // 觀念：原片時間 t 對應「剪後時間」= 從 0 到 t 之間「沒被刪」的累計秒數
  let _cutTotalDur = null;
  function getCutTotalDuration() {
    if (_cutTotalDur != null) return _cutTotalDur;
    const v = document.getElementById('videoPlayer');
    if (!v || !isFinite(v.duration) || v.duration <= 0) return 0;
    let deleted = 0;
    for (const r of getDeletionRanges()) deleted += (r.e - r.s);
    _cutTotalDur = Math.max(0, v.duration - deleted);
    return _cutTotalDur;
  }

  // 原片時間 → 剪後時間
  function originalToCut(t) {
    const ranges = getDeletionRanges();
    let cutT = t;
    for (const r of ranges) {
      if (t >= r.e) cutT -= (r.e - r.s);          // 整段都在 t 之前 → 全扣
      else if (t > r.s) { cutT -= (t - r.s); break; } // t 落在刪除區間中 → 扣到 t
      else break;                                   // 後面的區間還沒到 → 結束
    }
    return Math.max(0, cutT);
  }

  // 剪後時間 → 原片時間
  function cutToOriginal(cutT) {
    const ranges = getDeletionRanges();
    let origT = cutT;
    for (const r of ranges) {
      const cutAtRangeStart = originalToCut(r.s);
      if (cutT < cutAtRangeStart) break;        // 目標在這個 range 之前 → 不用累加
      origT += (r.e - r.s);                      // 跳過整個 range
    }
    return origT;
  }

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateCutPlayerUI() {
    const v = document.getElementById('videoPlayer');
    if (!v) return;
    const total = getCutTotalDuration();
    const cutNow = originalToCut(v.currentTime);
    const fill = document.getElementById('cutProgressFill');
    const disp = document.getElementById('cutTimeDisp');
    const orig = document.getElementById('cutOrigDisp');
    if (fill) fill.style.width = total > 0 ? (cutNow / total * 100).toFixed(2) + '%' : '0%';
    if (disp) disp.textContent = fmtTime(cutNow) + ' / ' + fmtTime(total);
    if (orig) orig.textContent = '原: ' + fmtTime(v.currentTime) + ' / ' + fmtTime(v.duration || 0);
  }

  function setupCutPlayer() {
    const v = document.getElementById('videoPlayer');
    const btn = document.getElementById('cutPlayBtn');
    const prog = document.getElementById('cutProgress');
    const fs = document.getElementById('cutFsBtn');
    if (!v || !btn || !prog) return;

    btn.onclick = () => v.paused ? v.play() : v.pause();
    v.addEventListener('play',  () => { btn.textContent = '⏸'; });
    v.addEventListener('pause', () => { btn.textContent = '▶'; });
    v.addEventListener('loadedmetadata', () => { _cutTotalDur = null; updateCutPlayerUI(); });
    v.addEventListener('durationchange', () => { _cutTotalDur = null; updateCutPlayerUI(); });

    // 點進度條 → 跳到對應的原片時間
    prog.addEventListener('click', (e) => {
      const rect = prog.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const total = getCutTotalDuration();
      const targetCut = ratio * total;
      const targetOrig = cutToOriginal(targetCut);
      v.currentTime = targetOrig;
    });

    if (fs) fs.onclick = () => {
      if (v.requestFullscreen) v.requestFullscreen();
      else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
    };

    // 鍵盤空白鍵 = 播放暫停（介面焦點在外時不擋字幕編輯）
    // 進度條每幀更新（rAF 比 timeupdate 平滑）
    function tick() {
      if (!document.body.contains(v)) return;
      updateCutPlayerUI();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // 靜音保留 slider
  (function() {
    const slider = document.getElementById('silenceKeepSlider');
    const valEl = document.getElementById('silenceKeepVal');
    if (!slider) return;
    slider.addEventListener('input', function() {
      silenceKeepSecs = parseFloat(this.value);
      valEl.textContent = silenceKeepSecs.toFixed(1) + 's';
      if (sentences.length > 0) {
        // 重新 enrich 並清空舊的 userSelected 中屬於 trim 的部分再重繪
        sentences = enrichSentences(sentences.slice());
        renderFlowText();
      }
    });
  })();

  // 工具列操作
  function deleteSelection() {
    // 將框選的 global indices 加入 userSelected
    dragSelectedGlobal.forEach(i => userSelected.add(i));
    // 同時加入相關的 gapIndices
    const touchedSentences = new Set();
    dragSelectedGlobal.forEach(gi => {
      for (const s of sentences) {
        if ((s.wordIndices || []).includes(gi)) {
          touchedSentences.add(s);
        }
      }
    });
    // 如果句子中所有 word 都被刪，也刪除 gap
    for (const s of touchedSentences) {
      const allWordsDel = (s.wordIndices || []).every(i => userSelected.has(i));
      if (allWordsDel) {
        (s.gapIndices || []).forEach(i => userSelected.add(i));
        (s.gapAfterIndices || (s.gapAfterIdx !== undefined ? [s.gapAfterIdx] : [])).forEach(gi => userSelected.add(gi));
      }
    }

    document.getElementById('floatToolbar').classList.remove('show');
    dragSelectedGlobal.clear();
    renderFlowText();
  }

  function restoreSelection() {
    // 將框選的 global indices 從 userSelected 移除
    dragSelectedGlobal.forEach(i => userSelected.delete(i));
    document.getElementById('floatToolbar').classList.remove('show');
    dragSelectedGlobal.clear();
    renderFlowText();
  }

  // 分類篩選：切換某個分類的全部標記
  function toggleCat(cat) {
    const badge = document.getElementById('fb' + cat.charAt(0).toUpperCase() + cat.slice(1));
    const cb = badge.querySelector('input');
    catFilter[cat] = cb.checked;

    // 根據 checkbox 狀態，加入或移除該分類的所有標記
    for (const s of sentences) {
      const sCat = getCat(s);
      const allIdx = [...(s.wordIndices || []), ...(s.gapIndices || [])];
      (s.gapAfterIndices || (s.gapAfterIdx !== undefined ? [s.gapAfterIdx] : [])).forEach(gi => allIdx.push(gi));

      if (sCat === cat && s.aiDelete) {
        if (cb.checked) {
          allIdx.forEach(i => userSelected.add(i));
        } else {
          allIdx.forEach(i => userSelected.delete(i));
        }
      }

      // gap 分類
      if (cat === 'pause' && s.gapDelete) {
        const gIndices = s.gapAfterIndices || (s.gapAfterIdx !== undefined ? [s.gapAfterIdx] : []);
        gIndices.forEach(gi => { if (cb.checked) userSelected.add(gi); else userSelected.delete(gi); });
      }
    }

    badge.classList.toggle('off', !cb.checked);
    renderFlowText();
  }

  // 導航：跳到上/下一個標記
  function navMark(dir) {
    if (markList.length === 0) return;
    navIdx = (navIdx + dir + markList.length) % markList.length;
    document.getElementById('navInfo').textContent = (navIdx + 1) + '/' + markList.length;

    // 找到對應的 DOM 元素並滾動
    const mk = markList[navIdx];
    const si = typeof mk === 'string' ? parseInt(mk.slice(1)) : mk;
    const isGap = typeof mk === 'string';
    const selector = isGap
      ? '.gap-mk[data-sidx="' + si + '"]'
      : '.w[data-si="' + si + '"]';
    const el = document.querySelector('#sentenceList ' + selector);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 短暫高亮
      el.style.outline = '2px solid #d4b44a';
      setTimeout(() => { el.style.outline = ''; }, 1200);
    }

    // 影片跳轉
    const s = sentences[si];
    const video = document.getElementById('videoPlayer');
    if (video && s) video.currentTime = s.startTime || 0;
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function updateInfo() {
    const del = userSelected.size;
    const total = words.length;
    const delDur = [...userSelected].reduce((sum, i) => sum + (words[i].end - words[i].start), 0);
    const totalDur = words.length > 0 ? words[words.length - 1].end : 0;
    const keptDur = totalDur - delDur;
    document.getElementById('deleteInfo').textContent =
      '\u522A\u9664 ' + delDur.toFixed(0) + 's | \u4FDD\u7559 ' + formatTime(keptDur);
    // \u66F4\u65B0\u532F\u51FA\u9810\u4F30
    document.getElementById('exportEst').textContent =
      '\u{1F4CA} \u4FDD\u7559\u6642\u9577: ' + formatTime(keptDur);
  }

  function acceptAll() {
    userSelected = new Set(aiMarked);
    // 恢復所有 checkbox 為 checked
    Object.keys(catFilter).forEach(k => { catFilter[k] = true; });
    document.querySelectorAll('.filter-badge input').forEach(cb => { cb.checked = true; });
    document.querySelectorAll('.filter-badge').forEach(b => { b.classList.remove('off'); });
    renderFlowText();
  }

  function clearAll() {
    userSelected = new Set();
    renderFlowText();
  }

  async function rerunAI() {
    const btn = document.querySelector('#guideBanner button');
    if (btn) { btn.disabled = true; btn.textContent = '\u2699\uFE0F AI \u5206\u6790\u4E2D...'; }
    try {
      const res = await fetch('/api/rerun-ai', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { alert(data.error || '\u5931\u6557'); if (btn) { btn.disabled = false; btn.textContent = '\u{1F504} \u91CD\u65B0 AI \u5206\u6790'; } return; }

      // 輪詢等待完成（最多 15 分鐘）
      let pollCount = 0;
      const MAX_POLLS = 450; // 15min / 2s
      const poll = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          clearInterval(poll);
          if (btn) { btn.disabled = false; btn.textContent = '\u{1F504} \u91CD\u65B0 AI \u5206\u6790'; }
          alert('AI \u5206\u6790\u903E\u6642\uFF0C\u8ACB\u91CD\u8A66');
          return;
        }
        try {
          const st = await fetch('/api/cut-status').then(r => r.json());
          if (btn) btn.textContent = '\u2699\uFE0F AI \u5206\u6790\u4E2D... ' + st.progress + '%';
          if (!st.running) {
            clearInterval(poll);
            await loadSubtitles();
          }
        } catch (e) {
          console.error('poll error:', e);
        }
      }, 2000);
    } catch (err) {
      alert('AI \u5206\u6790\u5931\u6557: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = '\u{1F504} \u91CD\u65B0 AI \u5206\u6790'; }
    }
  }

  // \u4FEE\u6539 5: \u532F\u51FA\u5C0D\u8A71\u6846
  function exportOpen() {
    if (userSelected.size === 0) { alert('\u8ACB\u5148\u9078\u64C7\u8981\u522A\u9664\u7684\u5167\u5BB9'); return; }
    updateInfo();
    // 自動填入預設檔名
    const fnInput = document.getElementById('exportFilename');
    if (fnInput && !fnInput.value && currentVideoPath) {
      const base = currentVideoPath.split(/[/\\\\]/).pop().replace(/\\.[^/.]+$/, '');
      fnInput.placeholder = base + '_cut.mp4';
    }
    document.getElementById('exportOverlay').classList.add('show');
    // 取得 GPU 資訊
    fetch('/api/gpu-info').then(r => r.json()).then(d => {
      document.getElementById('exportGpu').textContent = '\u{1F3AE} \u7DE8\u78BC\u5668: ' + d.encoder;
    }).catch(() => {});
    // Sanity check：顯示刪除比例，>50% 或保留 <30s 給橘色警示
    const delDur2 = [...userSelected].reduce((sum, i) => sum + (words[i] ? words[i].end - words[i].start : 0), 0);
    const totalDur2 = words.length > 0 ? words[words.length - 1].end : 0;
    const delPct = totalDur2 > 0 ? Math.round(delDur2 / totalDur2 * 100) : 0;
    const keptSec = totalDur2 - delDur2;
    const keptMin = (keptSec / 60).toFixed(1);
    const origMin = (totalDur2 / 60).toFixed(1);
    const sanEl = document.getElementById('exportSanity');
    if (delPct > 50 || keptSec < 30) {
      sanEl.textContent = '\u26A0\uFE0F \u5C07\u522A\u9664 ' + delPct + '%\uFF08' + origMin + 'min \u2192 ' + keptMin + 'min\uFF09\u8ACB\u78BA\u8A8D';
      sanEl.style.color = '#ff9800';
    } else {
      sanEl.textContent = '\u2702\uFE0F \u5C07\u522A\u9664 ' + delPct + '%\uFF08' + origMin + 'min \u2192 ' + keptMin + 'min\uFF09';
      sanEl.style.color = '#888';
    }
    sanEl.style.display = '';
  }

  function exportClose() {
    document.getElementById('exportOverlay').classList.remove('show');
  }

  // ── 保護詞設定 ──
  async function protectedWordsOpen() {
    const ta = document.getElementById('pwTextarea');
    const st = document.getElementById('pwStatus');
    ta.value = '';
    st.textContent = '載入中...';
    document.getElementById('pwOverlay').classList.add('show');
    try {
      const r = await fetch('/api/protected-words');
      const d = await r.json();
      ta.value = (d.words || []).join('\\n');
      st.textContent = '\u5171 ' + d.words.length + ' \u500B\u4FDD\u8B77\u8A5E';
    } catch (e) {
      st.textContent = '載入失敗: ' + e.message;
    }
  }
  function protectedWordsClose() {
    document.getElementById('pwOverlay').classList.remove('show');
  }
  async function protectedWordsSave() {
    const ta = document.getElementById('pwTextarea');
    const st = document.getElementById('pwStatus');
    const words = ta.value
      .split(/[、，\\n]/)
      .map(w => w.trim())
      .filter(Boolean);
    st.textContent = '儲存中...';
    try {
      const r = await fetch('/api/protected-words', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      st.textContent = '\u2705 \u5DF2\u5132\u5B58 ' + d.count + ' \u500B\u4FDD\u8B77\u8A5E\uFF08\u4E0B\u6B21\u8655\u7406\u5F71\u7247\u6642\u751F\u6548\uFF09';
    } catch (e) {
      st.textContent = '❌ 儲存失敗: ' + e.message;
    }
  }

  function srtReverseOpen() {
    document.getElementById('srtRevTextarea').value = '';
    document.getElementById('srtRevStatus').textContent = '';
    document.getElementById('srtRevOverlay').classList.add('show');
  }
  async function srtReverseApply() {
    const ta  = document.getElementById('srtRevTextarea');
    const st  = document.getElementById('srtRevStatus');
    const srtContent = ta.value.trim();
    if (!srtContent) { st.textContent = '⚠️ 請貼上 SRT 內容'; return; }
    st.textContent = '分析中...';
    try {
      const r = await fetch('/api/srt-reverse-align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ srtContent })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      const idxSet = new Set(d.deleteIndices || []);
      // 套用到 userSelected：清空現有，再加入反推的刪除索引
      userSelected.clear();
      for (const i of idxSet) userSelected.add(i);
      renderFlowText();
      document.getElementById('srtRevOverlay').classList.remove('show');
      const bar = document.getElementById('resultBar');
      bar.classList.add('show');
      bar.innerHTML = '\u2705 SRT \u53CD\u5411\u5C0D\u9F4A\u5B8C\u6210\uFF1A\u522A\u9664 ' + idxSet.size + ' \u500B\u5B57\u8A5E';
      st.textContent = '';
    } catch (e) {
      st.textContent = '❌ 失敗: ' + e.message;
    }
  }

  async function executeExport() {
    const btn = document.getElementById('exportBtn');
    btn.disabled = true;
    btn.textContent = '\u2699\uFE0F \u526A\u8F2F\u4E2D...';

    // 收集手動回饋（AI 建議 vs 使用者最終決定的差異）
    const fpSentences = []; // AI 標記刪除，使用者保留
    const fnSentences = []; // 使用者手動標記刪除，AI 沒抓到
    try {
      const allSents = sentences.length > 0 ? sentences : buildSentences();
      for (const s of allSents) {
        if (!s.wordIndices || s.wordIndices.length === 0) continue;
        const aiSuggests = s.wordIndices.some(i => aiMarked.has(i));
        const userKeeps  = s.wordIndices.every(i => !userSelected.has(i));
        const userDels   = s.wordIndices.some(i => userSelected.has(i));
        const aiMissed   = s.wordIndices.every(i => !aiMarked.has(i));
        if (aiSuggests && userKeeps)
          fpSentences.push({ text: s.displayText || s.text, reason: s.deleteReason || s.deleteCategory || '' });
        if (userDels && aiMissed)
          fnSentences.push({ text: s.displayText || s.text });
      }
    } catch(e) {}

    const options = {
      deleteIndices: [...userSelected],
      resolution: document.getElementById('exportResolution').value,
      codec: document.getElementById('exportCodec').value,
      fps: document.getElementById('exportFps').value,
      quality: document.getElementById('exportQuality').value,
      bitrate: (document.getElementById('exportBitrate') || { value: 'recommended' }).value,
      container: (document.getElementById('exportFormat') || { value: 'mp4' }).value,
      exportSrt: document.getElementById('exportSrt').checked,
      abMode: document.getElementById('exportAbMode').checked,
      abIndices: document.getElementById('exportAbMode').checked ? [...aiMarked] : null,
      outputDir: document.getElementById('exportOutputDir').value.trim() || null,
      outputFilename: document.getElementById('exportFilename').value.trim() || null,
      manualFeedback: (fpSentences.length + fnSentences.length > 0) ? {
        version: 1,
        timestamp: new Date().toISOString(),
        videoName: currentVideoPath ? currentVideoPath.split(/[/\\\\]/).pop() : '',
        aiMarkedCount: aiMarked.size,
        userFinalCount: userSelected.size,
        falsePositives: fpSentences,
        falseNegatives: fnSentences
      } : null
    };

    try {
      const res = await fetch('/api/execute-cut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // 輪詢等待剪輯完成（最多 30 分鐘）
      let pollCount = 0;
      const MAX_POLLS = 900; // 30min / 2s
      const poll = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          clearInterval(poll);
          btn.disabled = false;
          btn.textContent = '\u958B\u59CB\u526A\u8F2F';
          alert('\u526A\u8F2F\u903E\u6642\uFF0C\u8ACB\u91CD\u8A66');
          return;
        }
        try {
          const st = await fetch('/api/cut-status').then(r => r.json());
          btn.textContent = '\u2699\uFE0F \u526A\u8F2F\u4E2D... ' + st.progress + '%';
          if (!st.running) {
            clearInterval(poll);
            btn.disabled = false;
            btn.textContent = '\u958B\u59CB\u526A\u8F2F';
            exportClose();
            const bar = document.getElementById('resultBar');
            bar.classList.add('show');
            const lastLogs = st.log.slice(-3).join('<br>');
            const bNote = st.outputPathB ? '<br>🔀 B版: ' + st.outputPathB : '';
            bar.innerHTML = lastLogs + bNote;
          }
        } catch (e) {
          console.error('poll error:', e);
        }
      }, 2000);
    } catch (err) {
      alert('\u526A\u8F2F\u5931\u6557: ' + err.message);
      btn.disabled = false;
      btn.textContent = '\u958B\u59CB\u526A\u8F2F';
    }
  }

  // Enter to process
  document.getElementById('videoInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') processVideo();
  });

  // 頁面載入時：嘗試從伺服器恢復批次佇列（斷點續傳）
  setTimeout(() => restoreBatchFromServer().catch(() => {}), 1200);

  // 套用 localStorage 的粒度偏好（按鈕樣式同步）
  setGranularity(editGranularity);

  // ESC \u95DC\u9589 modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('exportOverlay').classList.contains('show')) exportClose();
      else if (document.getElementById('fbOverlay').classList.contains('show')) fbClose();
    }
  });

  // \u2500\u2500 \u6A94\u6848\u700F\u89BD\u5668 \u2500\u2500
  // ── \u6279\u91CF\u6A21\u5F0F ──
  let batchMode = false;
  let batchQueue = []; // [{path, name, status:'pending'|'running'|'done'|'error'}]
  let batchCurrentIdx = -1;

  // ── \u4F47\u5217\u65B7\u9EDE\u7E8C\u50B3\uFF1A\u540C\u6B65\u5230\u4F3A\u670D\u5668\u7AEF ──
  async function syncBatchToServer() {
    const pending = batchQueue.filter(x => x.status === 'pending' || x.status === 'running');
    if (pending.length === 0) return;
    try {
      await fetch('/api/batch/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPaths: pending.map(x => x.path) })
      });
    } catch (_) {}
  }

  async function restoreBatchFromServer() {
    try {
      const r = await fetch('/api/batch');
      const d = await r.json();
      if (!d.items || d.items.length === 0) return;
      const restorable = d.items.filter(i => i.status === 'pending' || i.status === 'interrupted');
      if (restorable.length === 0) return;
      const confirmed = confirm('\u4F3A\u670D\u5668\u6709 ' + restorable.length + ' \u500B\u672A\u5B8C\u6210\u7684\u6279\u6B21\u4EFB\u52D9\uFF0C\u662F\u5426\u6062\u5FA9\u5230\u6279\u6B21\u4F47\u5217\uFF1F');
      if (!confirmed) return;
      if (!batchMode) toggleBatchMode();
      for (const item of restorable) {
        const name = item.videoPath.split(/[/\\\\]/).pop();
        if (!batchQueue.some(x => x.path === item.videoPath)) {
          batchQueue.push({ path: item.videoPath, name, status: 'pending' });
        }
      }
      renderQueue();
    } catch (_) {}
  }

  function toggleBatchMode() {
    batchMode = !batchMode;
    document.getElementById('batchToggle').classList.toggle('active', batchMode);
    document.getElementById('batchAddRow').style.display = batchMode ? 'block' : 'none';
    document.getElementById('batchQueueBox').style.display = batchMode ? 'block' : 'none';
    document.getElementById('processBtn').textContent = batchMode ? '\u{1F680} \u958B\u59CB\u6279\u91CF\u8655\u7406' : '\u{1F3AC} \u958B\u59CB\u8655\u7406';
    document.getElementById('inputLabel').textContent = batchMode ? '\u5F71\u7247\u8DEF\u5F91\uFF08\u52A0\u5165\u4F47\u5217\uFF09' : '\u5F71\u7247\u8DEF\u5F91';
  }

  function addToQueue(pathOverride) {
    const p = pathOverride || document.getElementById('videoInput').value.trim();
    if (!p) { document.getElementById('videoInput').focus(); return; }
    if (batchQueue.some(x => x.path === p)) { if (!pathOverride) alert('\u6B64\u5F71\u7247\u5DF2\u5728\u4F47\u5217\u4E2D'); return; }
    const name = p.split(/[/\\\\]/).pop();
    batchQueue.push({ path: p, name, status: 'pending' });
    if (!pathOverride) document.getElementById('videoInput').value = '';
    renderQueue();
    // 同步到伺服器（斷點續傳支援）
    fetch('/api/batch/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPaths: [p] })
    }).catch(() => {});
  }

  function openReview(encodedBaseName) {
    // encodedBaseName 已是 encodeURIComponent 過的 baseName
    window.open('/review/' + encodedBaseName, '_blank');
  }

  function removeFromQueue(idx) {
    if (batchQueue[idx] && batchQueue[idx].status !== 'running') {
      batchQueue.splice(idx, 1);
      renderQueue();
    }
  }

  function renderQueue() {
    const container = document.getElementById('batchQueueBox');
    const empty = document.getElementById('batchEmpty');
    [...container.querySelectorAll('.batch-item, .batch-summary')].forEach(el => el.remove());
    if (batchQueue.length === 0) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    const icons = { pending:'\u23F3', running:'\u2699\uFE0F', done:'\u2705', error:'\u274C' };
    batchQueue.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'batch-item';
      const baseName = item.name.replace(/\.[^/.]+$/, '');
      const reviewBtn = item.status === 'done'
        ? '<button class="breview" onclick="openReview(\\'' + encodeURIComponent(baseName).replace(/'/g, "%27") + '\\')" title="\u9032\u5165\u5be9\u6838\u9801\u9762">\u{1F50D} \u5be9\u6838</button>'
        : '';
      const removeBtn = item.status === 'pending'
        ? '<button class="bremove" onclick="removeFromQueue(' + i + ')">\u2715</button>'
        : '';
      el.innerHTML = '<span class="bstatus ' + item.status + '">' + icons[item.status] + '</span>'
        + '<span class="bname" title="' + item.path + '">' + item.name + '</span>'
        + reviewBtn
        + removeBtn;
      container.appendChild(el);
    });
    const done = batchQueue.filter(x=>x.status==='done').length;
    const err  = batchQueue.filter(x=>x.status==='error').length;
    const sum = document.createElement('div');
    sum.className = 'batch-summary';
    sum.textContent = '\u5171 ' + batchQueue.length + ' \u652F | \u5B8C\u6210 ' + done + (err ? ' | \u5931\u6557 ' + err : '');
    container.appendChild(sum);
  }

  function startNextBatch() {
    const nextIdx = batchQueue.findIndex(x => x.status === 'pending');
    if (nextIdx === -1) {
      const done = batchQueue.filter(x=>x.status==='done').length;
      const err  = batchQueue.filter(x=>x.status==='error').length;
      document.getElementById('cutBadge').textContent = '\u5C31\u7DD2';
      document.getElementById('cutBadge').className = 'badge ready';
      document.getElementById('processBtn').disabled = false;
      const msg = '\u{1F389} \u6279\u91CF\u8655\u7406\u5B8C\u6210\uFF01\\n\u5171 ' + batchQueue.length + ' \u652F\uFF0C\u6210\u529F ' + done + (err ? '\uFF0C\u5931\u6557 ' + err : '');
      alert(msg);
      return;
    }
    batchCurrentIdx = nextIdx;
    batchQueue[nextIdx].status = 'running';
    renderQueue();
    document.getElementById('videoInput').value = batchQueue[nextIdx].path;
    _startProcessing(batchQueue[nextIdx].path);
  }

  let fbSelectedPath = '';
  let fbCurrentDir = '';
  let fbFolderMode = false; // 資料夾選取模式（給匯出用）

  function fbOpenFolder() {
    fbFolderMode = true;
    document.getElementById('fbOverlay').classList.add('show');
    fbSelectedPath = '';
    document.getElementById('fbSelectBtn').textContent = '\u9078\u53D6\u6B64\u8CC7\u6599\u593E';
    document.getElementById('fbSelectBtn').disabled = false; // 資料夾模式隨時可選取當前目錄
    fbNavigate('');
  }

  function fbOpen() {
    fbFolderMode = false;
    document.getElementById('fbSelectBtn').textContent = '\u9078\u53D6';
    document.getElementById('fbOverlay').classList.add('show');
    fbSelectedPath = '';
    document.getElementById('fbSelectBtn').disabled = true;
    fbNavigate('');
  }

  function fbClose() {
    document.getElementById('fbOverlay').classList.remove('show');
    fbFolderMode = false;
    document.getElementById('fbSelectBtn').textContent = '\u9078\u53D6';
    document.getElementById('fbSelectBtn').disabled = true;
  }

  function fbSelect() {
    if (fbFolderMode) {
      // 資料夾模式：選取當前目錄
      const dir = fbCurrentDir;
      if (dir) {
        document.getElementById('exportOutputDir').value = dir;
        fbClose();
      }
      return;
    }
    if (fbSelectedPath) {
      document.getElementById('videoInput').value = fbSelectedPath;
      fbClose();
      if (batchMode) addToQueue(fbSelectedPath);
    }
  }

  async function fbNavigate(dirPath) {
    const list = document.getElementById('fbList');
    list.innerHTML = '<div class="fb-loading">\u8F09\u5165\u4E2D...</div>';
    fbSelectedPath = '';
    if (!fbFolderMode) document.getElementById('fbSelectBtn').disabled = true;

    try {
      const filter = fbFolderMode ? 'folder' : 'video';
      const url = '/api/browse?path=' + encodeURIComponent(dirPath) + '&filter=' + filter;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) { list.innerHTML = '<div class="fb-empty">\u2757 ' + (data.error || '\u932F\u8AA4') + '</div>'; return; }

      fbCurrentDir = data.current;
      // 資料夾模式：只要進入任何目錄都可以選取
      if (fbFolderMode && data.current) document.getElementById('fbSelectBtn').disabled = false;

      const bc = document.getElementById('fbBreadcrumb');
      bc.innerHTML = '';
      if (data.current) {
        const rootSpan = document.createElement('span');
        rootSpan.textContent = '\u{1F4BB} \u78C1\u789F';
        rootSpan.onclick = () => fbNavigate('');
        bc.appendChild(rootSpan);

        const parts = data.current.replace(/\\\\/g, '/').split('/').filter(Boolean);
        let accumulated = '';
        for (let i = 0; i < parts.length; i++) {
          bc.appendChild(document.createTextNode(' \u203A '));
          accumulated += parts[i] + '/';
          const span = document.createElement('span');
          span.textContent = parts[i];
          if (i === parts.length - 1) {
            span.className = 'current';
          } else {
            const navPath = accumulated;
            span.onclick = () => fbNavigate(navPath);
          }
          bc.appendChild(span);
        }
      } else {
        bc.innerHTML = '<span class="current">\u{1F4BB} \u9078\u64C7\u78C1\u789F</span>';
      }

      if (data.items.length === 0) {
        list.innerHTML = '<div class="fb-empty">\u6B64\u8CC7\u6599\u593E\u6C92\u6709\u5F71\u7247\u6A94\u6848</div>';
        return;
      }

      list.innerHTML = '';

      if (data.parent !== undefined && data.parent !== '') {
        const upItem = document.createElement('div');
        upItem.className = 'fb-item';
        upItem.innerHTML = '<span class="icon">\u2B06\uFE0F</span><span class="name">..\u00A0\u00A0(\u4E0A\u4E00\u5C64)</span>';
        upItem.onclick = () => fbNavigate(data.parent);
        list.appendChild(upItem);
      }

      for (const item of data.items) {
        const el = document.createElement('div');
        el.className = 'fb-item';

        if (item.type === 'drive') {
          el.innerHTML = '<span class="icon">\u{1F4BF}</span><span class="name">' + item.name + '</span>';
          el.onclick = () => fbNavigate(item.path);
        } else if (item.type === 'dir') {
          el.innerHTML = '<span class="icon">\u{1F4C1}</span><span class="name">' + item.name + '</span>';
          el.onclick = () => fbNavigate(item.path);
        } else {
          const sizeMB = item.size ? (item.size / 1048576).toFixed(1) + ' MB' : '';
          el.innerHTML = '<span class="icon">\u{1F3AC}</span><span class="name">' + item.name + '</span><span class="size">' + sizeMB + '</span>';
          el.onclick = () => {
            list.querySelectorAll('.fb-item.selected').forEach(x => x.classList.remove('selected'));
            el.classList.add('selected');
            fbSelectedPath = item.path;
            document.getElementById('fbSelectBtn').disabled = false;
          };
          el.ondblclick = () => {
            fbSelectedPath = item.path;
            fbSelect();
          };
        }
        list.appendChild(el);
      }
    } catch (err) {
      list.innerHTML = '<div class="fb-empty">\u2757 ' + err.message + '</div>';
    }
  }
</script>

</body>
</html>`;

server.listen(PORT, () => {
  console.log(`
\u{1F3AF} Auto VideoCut \u5DF2\u555F\u52D5
\u{1F4CD} \u5730\u5740: http://localhost:${PORT}
\u{1F4C2} \u5DE5\u4F5C\u76EE\u9304: ${process.cwd()}

\u{2702}\u{FE0F}  \u526A\u8F2F\u5F71\u7247: http://localhost:${PORT}/
  `);
});

