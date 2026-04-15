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

const PORT = process.argv[2] || 8900;
const SCRIPT_DIR = __dirname;

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

  // ── 首頁 ──
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
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
      padding: 12px 16px;
      border-top: 1px solid #333;
      display: flex;
      gap: 8px;
      align-items: center;
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
    <div class="train-bar">
      <select id="transcriber">
        <option value="openai">OpenAI Whisper API</option>
        <option value="google">Google STT</option>
        <option value="whisper">Whisper 本機 (免費)</option>
      </select>
      <button class="primary" id="trainBtn" onclick="startTraining()" style="flex:1;">
        開始訓練
      </button>
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
            <tr><th>影片</th><th>匹配率</th><th>精確率</th><th>召回率</th><th>F1</th><th>FP</th><th>FN</th></tr>
          </thead>
          <tbody id="videoTableBody"></tbody>
        </table>
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

  // ── 輪詢狀態 ──
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1000);
  }

  async function pollStatus() {
    try {
      const res = await fetch('/api/status');
      const state = await res.json();

      // 更新 badge
      const badge = document.getElementById('statusBadge');
      if (state.running) {
        badge.textContent = '訓練中';
        badge.className = 'badge running';
      } else if (state.results) {
        badge.textContent = '完成';
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
        renderResults(state.results);
      }
    } catch (err) {
      // 忽略暫時的網路錯誤
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
      '<div class="stat-card ' + cardClass(precision) + '"><div class="value">' + (precision*100).toFixed(1) + '%</div><div class="label">精確率</div></div>' +
      '<div class="stat-card ' + cardClass(recall) + '"><div class="value">' + (recall*100).toFixed(1) + '%</div><div class="label">召回率</div></div>' +
      '<div class="stat-card ' + cardClass(f1) + '"><div class="value">' + (f1*100).toFixed(1) + '%</div><div class="label">F1</div></div>';

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
      '<th>規則類別</th><th>AI 做法</th><th>SRT 顯示</th><th>建議修改</th><th>採用?</th>' +
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
            '<span class="srt">' + escRv(e.srtAction) + '</span>' +
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
        '<td class="rv-diff"><div class="lbl">SRT</div><div class="srt">' + escRv(s.srtShows) + '</div>' + exHtml + '</td>' +
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
        startPolling();
      } else if (state.results) {
        document.getElementById('emptyState').style.display = 'none';
        renderResults(state.results);
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

server.listen(PORT, () => {
  console.log(`
\u{1F3AF} 批量訓練儀表板已啟動
\u{1F4CD} 地址: http://localhost:\${PORT}
\u{1F4C2} 工作目錄: \${process.cwd()}

操作說明:
1. 在左側輸入影片目錄路徑，點擊「掃描」找出 影片+SRT 配對
2. 勾選要訓練的影片
3. 點擊「開始訓練」
4. 等待訓練完成，查看右側結果
  `);
});
