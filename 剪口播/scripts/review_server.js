#!/usr/bin/env node
/**
 * 审核服务器
 *
 * 功能：
 * 1. 提供静态文件服务（review.html, video.mp4）
 * 2. POST /api/cut - 接收删除列表，执行剪辑
 *
 * 用法: node review_server.js [port] [video_file]
 * 默认: port=8899, video_file=自动检测目录下的 .mp4
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { getAvailableEncoders } = require('./encoder_utils');
const { parseAutoSelected } = require('./generate_review');

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

// auto_selected 三模式 → 檔名（位於 ../2_分析/）
const AUTO_MODES = {
  rules:   'auto_selected.json',
  layered: 'auto_selected_layered.json',
  full:    'auto_selected_full.json'
};

function autoModePath(mode) {
  const fname = AUTO_MODES[mode];
  if (!fname) return null;
  return path.resolve('..', '2_分析', fname);
}

const PORT = process.argv[2] || 8899;
let VIDEO_FILE = process.argv[3] || findVideoFile();

function findVideoFile() {
  const files = fs.readdirSync('.').filter(f => f.endsWith('.mp4'));
  return files[0] || 'source.mp4';
}

// 啟動時自動補產 polished.json（背景，不阻塞啟動）
let polishedSpawning = false;
(function ensurePolished() {
  try {
    const polishedPath  = path.resolve('..', '2_分析', 'polished.json');
    const subtitlesPath = path.resolve('..', '1_轉錄', 'subtitles_words.json');
    if (!fs.existsSync(polishedPath) && fs.existsSync(subtitlesPath)) {
      console.log('🔧 polished.json 不存在，背景產出中（layered 模式所需）...');
      polishedSpawning = true;
      const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node',
        [path.join(__dirname, 'ai_polish.js'), subtitlesPath, polishedPath],
        { detached: true, stdio: 'ignore' });
      child.unref();
      // 標記檔案：表示正在產出中，前端可查
      fs.writeFileSync(polishedPath + '.pending', String(Date.now()));
    }
  } catch (e) {
    console.error('⚠️ polished.json 自動產出失敗:', e.message);
  }
})();

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: 保存學習報告（AI vs 使用者差異）
  if (req.method === 'POST' && req.url === '/api/diff-report') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const report = JSON.parse(body);
        const reportPath = path.resolve('..', '2_分析', 'diff_report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`📊 學習報告: AI標${report.aiCount}個, 使用者最終${report.userCount}個, 誤標${report.falsePositives.length}個, 漏標${report.falseNegatives.length}個`);
        console.log(`💡 訪問 http://localhost:${PORT}/learning 審核並選擇是否更新規則`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, learningUrl: `/learning` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: 执行剪辑
  if (req.method === 'POST' && req.url === '/api/cut') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        // 相容新舊 payload：
        //   新：{ deleteList: [...], exportOptions: { codec, resolution, bitrate, fps, container, audioOnly, gif } }
        //   舊：[...] 或 { deleteList: [...] }（無 exportOptions）
        const parsed = JSON.parse(body);
        let deleteList, exportOptions;
        if (Array.isArray(parsed)) {
          deleteList = parsed;
          exportOptions = {};
        } else {
          deleteList = parsed.deleteList || parsed.segments || [];
          exportOptions = parsed.exportOptions || {};
        }

        // 保存删除列表到当前目录
        fs.writeFileSync('delete_segments.json', JSON.stringify(deleteList, null, 2));
        console.log(`📝 保存 ${deleteList.length} 个删除片段`);

        // 決定副檔名：audioOnly 強制 .mp3、gif 僅附加不影響主檔、否則依 container
        const container = (exportOptions.container || 'mp4').toLowerCase();
        const mainExt = exportOptions.audioOnly ? 'mp3' : container;

        // 生成输出文件名
        const baseName = path.basename(VIDEO_FILE).replace(/\.[^/.]+$/, '');
        // cut_video.sh 若 audioOnly，會先輸出視訊中繼再轉 mp3，此處先用 container
        const shellOutputFile = path.resolve(`${baseName}_cut.${container}`);
        const finalOutputFile = path.resolve(`${baseName}_cut.${mainExt}`);

        // 執行剪輯
        const scriptPath = path.join(__dirname, 'cut_video.sh');
        const deleteSegmentsPath = path.resolve('delete_segments.json');

        // 組環境變數給 cut_video.sh
        const env = {
          ...process.env,
          CUT_CODEC: exportOptions.codec || '',
          CUT_RESOLUTION: exportOptions.resolution || '',
          CUT_BITRATE_MODE: exportOptions.bitrate || 'recommended',
          CUT_FPS: exportOptions.fps || '',
          CUT_CONTAINER: container,
          CUT_AUDIO_ONLY: exportOptions.audioOnly ? '1' : '0',
          CUT_EXPORT_GIF: exportOptions.gif ? '1' : '0',
        };

        console.log(`⚙️ 匯出選項:`, {
          codec: env.CUT_CODEC || 'h264(default)',
          resolution: env.CUT_RESOLUTION || 'original',
          bitrate: env.CUT_BITRATE_MODE,
          fps: env.CUT_FPS || 'original',
          container,
          audioOnly: env.CUT_AUDIO_ONLY === '1',
          gif: env.CUT_EXPORT_GIF === '1',
        });

        if (!fs.existsSync(scriptPath)) {
          // 如果没有 cut_video.sh，用内置的 ffmpeg 命令（不支援 exportOptions）
          console.log('🎬 执行剪辑（內建 fallback，忽略匯出選項）...');
          executeFFmpegCut(VIDEO_FILE, deleteList, shellOutputFile);
        } else {
          console.log('🎬 调用 cut_video.sh...');
          const scriptPathPosix = scriptPath.replace(/\\/g, '/');
          const deletePathPosix = deleteSegmentsPath.replace(/\\/g, '/');
          const outputFilePosix = shellOutputFile.replace(/\\/g, '/');
          execSync(`bash "${scriptPathPosix}" "${VIDEO_FILE}" "${deletePathPosix}" "${outputFilePosix}"`, {
            stdio: 'inherit',
            cwd: path.dirname(deleteSegmentsPath),
            env,
          });
        }

        // 收斂 outputFile 到實際產出的檔案（audioOnly 模式 shell 端會刪 shellOutputFile）
        const outputFile = fs.existsSync(finalOutputFile) ? finalOutputFile : shellOutputFile;

        // 自動產出 SRT 字幕（音訊匯出模式不產 SRT）
        let srtFile = null;
        if (!exportOptions.audioOnly) {
          try {
            const srtScript = path.join(__dirname, 'generate_cut_srt.js');
            const subtitlesPath = path.resolve('..', '1_轉錄', 'subtitles_words.json');
            srtFile = outputFile.replace(/\.[^/.]+$/, '.srt');
            if (fs.existsSync(srtScript) && fs.existsSync(subtitlesPath)) {
              execSync(`node "${srtScript}" "${subtitlesPath}" "${deleteSegmentsPath}" "${srtFile}"`, { stdio: 'inherit' });
              console.log(`📝 已產出 SRT: ${srtFile}`);
            }
          } catch (srtErr) {
            console.error('⚠️ SRT 生成失敗:', srtErr.message);
            srtFile = null;
          }
        }

        // 获取剪辑前后的时长信息
        const originalDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${VIDEO_FILE}"`).toString().trim());
        const newDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${outputFile}"`).toString().trim());
        const deletedDuration = originalDuration - newDuration;
        const savedPercent = ((deletedDuration / originalDuration) * 100).toFixed(1);

        // ── 自動存為訓練配對 ──
        try {
          const videoName = path.basename(VIDEO_FILE).replace(/\.[^/.]+$/, '');
          const trainingBase = path.join(__dirname, 'training_output', videoName);
          const subtitlesPath = path.resolve('..', '1_轉錄', 'subtitles_words.json');
          if (fs.existsSync(subtitlesPath)) {
            fs.mkdirSync(path.join(trainingBase, '1_轉錄'), { recursive: true });
            fs.mkdirSync(path.join(trainingBase, '2_分析'), { recursive: true });
            fs.copyFileSync(subtitlesPath, path.join(trainingBase, '1_轉錄', 'subtitles_words.json'));
            const words = JSON.parse(fs.readFileSync(subtitlesPath, 'utf8'));
            const keptWords = words.filter(w =>
              !deleteList.some(seg => w.start < seg.end && w.end > seg.start)
            );
            fs.writeFileSync(path.join(trainingBase, '2_分析', 'edited_words.json'), JSON.stringify(keptWords, null, 2));
            // 同步複製 diff_report.json（若存在），供 AI→user 偏差分析
            const diffSrc = path.resolve('..', '2_分析', 'diff_report.json');
            if (fs.existsSync(diffSrc)) {
              fs.copyFileSync(diffSrc, path.join(trainingBase, '2_分析', 'diff_report.json'));
            }
            console.log(`📚 訓練配對已儲存: ${videoName}（保留 ${keptWords.filter(w=>!w.isGap).length} 字）`);
          }
        } catch (trainErr) {
          console.error('⚠️ 訓練配對儲存失敗:', trainErr.message);
        }

        // ── 匯出後自動驗證（verify_export，advisory：驗證失敗不阻斷匯出）──
        const verify = runVerify(outputFile, VIDEO_FILE, deleteSegmentsPath);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: outputFile,
          srt: srtFile,
          originalDuration: originalDuration.toFixed(2),
          newDuration: newDuration.toFixed(2),
          deletedDuration: deletedDuration.toFixed(2),
          savedPercent: savedPercent,
          verify,
          message: `剪辑完成: ${outputFile}`
        }));

      } catch (err) {
        console.error('❌ 剪辑失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── API: 增量更新敘事風格守則 ──
  if (req.method === 'POST' && req.url === '/api/update-narrative-style') {
    const scriptPath = path.join(__dirname, 'ai_extract_narrative_style_batch.js');
    const processedFile = path.join(__dirname, 'training_output', 'narrative_style_guide_processed.json');
    let processed = [];
    try { processed = JSON.parse(fs.readFileSync(processedFile, 'utf8')).processed || []; } catch {}
    const trainingDir = path.join(__dirname, 'training_output');
    const allVideos = fs.readdirSync(trainingDir).filter(d => {
      const dir = path.join(trainingDir, d);
      try { return fs.statSync(dir).isDirectory() &&
        fs.existsSync(path.join(dir, '1_轉錄', 'subtitles_words.json')) &&
        fs.existsSync(path.join(dir, '2_分析', 'edited_words.json')); } catch { return false; }
    });
    const newCount = allVideos.filter(v => !processed.includes(v)).length;
    if (newCount === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'up_to_date', message: '守則已是最新，無新影片需要處理' }));
      return;
    }
    const { spawn } = require('child_process');
    const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node',
      [scriptPath, '--incremental'], { detached: true, stdio: 'ignore' });
    child.unref();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started', newVideos: newCount,
      message: `開始更新守則（${newCount} 支新影片），約需 ${Math.ceil(newCount / 5) * 4} 分鐘，完成後自動生效` }));
    return;
  }

  // ── 規則學習審核頁 ──
  if (req.method === 'GET' && req.url === '/learning') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LEARNING_HTML);
    return;
  }

  // ── API: 取得學習建議 ──
  if (req.method === 'GET' && req.url === '/api/get-suggestions') {
    try {
      const reportPath = path.resolve('..', '2_分析', 'diff_report.json');
      const configPath = path.join(__dirname, '..', 'training_config.json');
      if (!fs.existsSync(reportPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '尚未產生 diff_report.json，請先完成剪輯並提交差異報告' }));
        return;
      }
      const diff = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
      // 清除 require cache 以載入最新版
      delete require.cache[require.resolve(path.join(__dirname, 'generate_suggestions.js'))];
      const { generateSuggestions } = require(path.join(__dirname, 'generate_suggestions.js'));
      const suggestions = generateSuggestions(diff, config);
      const meta = {
        aiCount: diff.aiCount || 0,
        userCount: diff.userCount || 0,
        fpCount: (diff.falsePositives || []).length,
        fnCount: (diff.falseNegatives || []).length,
        videoFile: diff.videoFile || null
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suggestions, meta }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: 套用選中建議 ──
  if (req.method === 'POST' && req.url === '/api/apply-suggestions') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { suggestions } = JSON.parse(body);
        const configPath = path.join(__dirname, '..', 'training_config.json');
        const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
        const applied = [];
        const skipped = [];

        for (const s of suggestions) {
          if (!s.checked) continue;
          const change = s.change;
          if (!change) { skipped.push({ id: s.id, reason: '需手動處理' }); continue; }

          // 靜音閾值
          if (change.path === 'silence.threshold') {
            if (!config.silence) config.silence = {};
            const old = config.silence.threshold;
            config.silence.threshold = change.to;
            applied.push({ id: s.id, desc: `silence.threshold: ${old} → ${change.to}` });

          // 語氣詞例外（加入保留清單）
          } else if (change.path === 'filler_exceptions' && change.action === 'add') {
            if (!config.filler_exceptions) config.filler_exceptions = [];
            if (!config.filler_exceptions.includes(change.value)) {
              config.filler_exceptions.push(change.value);
              applied.push({ id: s.id, desc: `filler_exceptions: +「${change.value}」` });
            } else {
              skipped.push({ id: s.id, reason: `「${change.value}」已在例外清單中` });
            }

          // 保護詞（需寫入 .md 檔）
          } else if (change.action === 'add_to_md') {
            const mdFile = path.join(__dirname, '..', 'rules', 'user_habits', change.file || '10-保留連接詞.md');
            try {
              const existing = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
              if (!existing.includes(change.value)) {
                fs.appendFileSync(mdFile, `\n- ${change.value}`);
                applied.push({ id: s.id, desc: `保護詞清單 +「${change.value}」(${change.file})` });
              } else {
                skipped.push({ id: s.id, reason: `「${change.value}」已在保護詞清單中` });
              }
            } catch (mdErr) {
              skipped.push({ id: s.id, reason: `.md 更新失敗: ${mdErr.message}` });
            }

          } else {
            skipped.push({ id: s.id, reason: '不支援的變更類型' });
          }
        }

        if (applied.length > 0) {
          config._updated = new Date().toISOString();
          config._source = 'manual_approval';
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          // 記錄到 feedback_history
          const historyPath = path.join(__dirname, '..', 'feedback_history.jsonl');
          const entry = {
            timestamp: config._updated,
            source: 'learning_review',
            applied: applied.map(a => a.desc),
            skipped: skipped.map(s => s.reason)
          };
          fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ applied, skipped, configPath }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── API: 列出可回滾的守則快照 ──
  if (req.method === 'GET' && req.url === '/api/narrative-style-snapshots') {
    try {
      const guideDir  = path.join(__dirname, 'training_output');
      const base      = 'narrative_style_guide';
      const snapshots = fs.readdirSync(guideDir)
        .filter(f => f.startsWith(base + '_snapshot_') && f.endsWith('.md'))
        .map(f => {
          const ts   = parseInt(f.replace(base + '_snapshot_', '').replace('.md', '')) || 0;
          const stat = fs.statSync(path.join(guideDir, f));
          return { filename: f, timestamp: ts, size: stat.size };
        })
        .sort((a, b) => b.timestamp - a.timestamp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ snapshots }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: 回滾守則到指定快照 ──
  if (req.method === 'POST' && req.url === '/api/narrative-style-rollback') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { snapshot } = JSON.parse(body);
        if (!snapshot) throw new Error('缺少 snapshot 欄位');
        const guideDir    = path.join(__dirname, 'training_output');
        const snapshotPath = path.join(guideDir, snapshot);
        const guidePath    = path.join(guideDir, 'narrative_style_guide.md');
        if (!fs.existsSync(snapshotPath)) throw new Error('快照不存在: ' + snapshot);
        // 先把現在的守則也快照一份（避免誤操作無法還原）
        const backupPath = guidePath.replace(/\.md$/, '_snapshot_' + Date.now() + '_prerollback.md');
        if (fs.existsSync(guidePath)) fs.copyFileSync(guidePath, backupPath);
        fs.copyFileSync(snapshotPath, guidePath);
        console.log('↶ 守則已回滾到: ' + snapshot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, restoredFrom: snapshot, backup: path.basename(backupPath) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── API: holdout F1 狀態（最新一筆 vs 前一筆）──
  if (req.method === 'GET' && req.url === '/api/holdout-status') {
    try {
      const historyFile = path.join(__dirname, 'training_output', 'holdout_f1_history.jsonl');
      if (!fs.existsSync(historyFile)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false }));
        return;
      }
      const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false }));
        return;
      }
      const latest = JSON.parse(lines[lines.length - 1]);
      const prev   = lines.length > 1 ? JSON.parse(lines[lines.length - 2]) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: true, latest, prev }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: polished.json 是否就緒 ──
  if (req.method === 'GET' && req.url === '/api/polished-status') {
    try {
      const polishedPath = path.resolve('..', '2_分析', 'polished.json');
      const pendingPath  = polishedPath + '.pending';
      const ready   = fs.existsSync(polishedPath);
      const pending = !ready && fs.existsSync(pendingPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, pending }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: 列出哪些 auto_selected 模式可用 ──
  if (req.method === 'GET' && req.url === '/api/auto-modes') {
    try {
      const available = {};
      for (const [mode, fname] of Object.entries(AUTO_MODES)) {
        const p = autoModePath(mode);
        available[mode] = fs.existsSync(p);
      }
      const polishedPath    = path.resolve('..', '2_分析', 'polished.json');
      const narrativeGuide  = path.join(__dirname, 'training_output', 'narrative_style_guide.md');
      const layeredJsonPath = autoModePath('layered');
      const layeredReady    = fs.existsSync(layeredJsonPath)
        && fs.existsSync(narrativeGuide)
        && fs.existsSync(polishedPath);
      const defaultMode = layeredReady ? 'layered' : 'rules';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...available, defaultMode }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: 取得指定模式的刪除清單 ──
  // GET /api/auto-selected?mode=rules|layered|full
  if (req.method === 'GET' && req.url.startsWith('/api/auto-selected')) {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const mode = url.searchParams.get('mode') || 'rules';
      const p = autoModePath(mode);
      if (!p || !fs.existsSync(p)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `mode "${mode}" 對應檔案不存在` }));
        return;
      }
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const parsed = parseAutoSelected(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        mode,
        indices: parsed.autoSelected,
        reasons: parsed.autoReasons,
        meta: {
          mode_marker:        raw.mode || null,           // layered / full_edit
          stats:              raw.stats || null,
          alignment_warnings: raw.alignment_warnings || []
        }
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: 偵測可用編碼器（前端用來灰掉不支援選項）──
  if (req.method === 'GET' && req.url === '/api/encoders') {
    try {
      const available = getAvailableEncoders();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(available));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 静态文件服务（从当前目录读取）
  let filePath = req.url === '/' ? '/review.html' : req.url;
  filePath = '.' + filePath;

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(filePath);

  // 支持 Range 请求（音频/视频拖动）
  if (req.headers.range && (ext === '.mp3' || ext === '.mp4')) {
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
    return;
  }

  // 普通请求
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(filePath).pipe(res);
});

// 检测可用的硬件编码器
function detectEncoder() {
  const platform = process.platform;
  const encoders = [];

  // 根据平台确定候选编码器
  if (platform === 'darwin') {
    encoders.push({ name: 'h264_videotoolbox', args: '-q:v 60', label: 'VideoToolbox (macOS)' });
  } else if (platform === 'win32') {
    encoders.push({ name: 'h264_nvenc', args: '-preset p4 -cq 20', label: 'NVENC (NVIDIA)' });
    encoders.push({ name: 'h264_qsv', args: '-global_quality 20', label: 'QSV (Intel)' });
    encoders.push({ name: 'h264_amf', args: '-quality balanced', label: 'AMF (AMD)' });
  } else {
    // Linux
    encoders.push({ name: 'h264_nvenc', args: '-preset p4 -cq 20', label: 'NVENC (NVIDIA)' });
    encoders.push({ name: 'h264_vaapi', args: '-qp 20', label: 'VAAPI (Linux)' });
  }

  // 软件编码兜底
  encoders.push({ name: 'libx264', args: '-preset fast -crf 18', label: 'x264 (软件)' });

  // 检测哪个可用
  for (const enc of encoders) {
    try {
      execSync(`ffmpeg -hide_banner -encoders 2>/dev/null | grep ${enc.name}`, { stdio: 'pipe' });
      console.log(`🎯 检测到编码器: ${enc.label}`);
      return enc;
    } catch (e) {
      // 该编码器不可用，继续检测下一个
    }
  }

  // 默认返回软件编码
  return { name: 'libx264', args: '-preset fast -crf 18', label: 'x264 (软件)' };
}

// 缓存编码器检测结果
let cachedEncoder = null;
function getEncoder() {
  if (!cachedEncoder) {
    cachedEncoder = detectEncoder();
  }
  return cachedEncoder;
}

// 編碼器偵測由 encoder_utils 共用模組提供（getAvailableEncoders）

// 内置 FFmpeg 剪辑逻辑（filter_complex 精确剪辑 + buffer + crossfade）
function executeFFmpegCut(input, deleteList, output) {
  // 配置参数
  const BUFFER_MS = 120;    // 删除范围前后各扩展 120ms（吃掉尾音和气口）
  const CROSSFADE_MS = 30;  // 音频淡入淡出 30ms

  console.log(`⚙️ 优化参数: 扩展范围=${BUFFER_MS}ms, 音频crossfade=${CROSSFADE_MS}ms`);

  // 检测音频偏移量（MP3编码引入的延迟）
  let audioOffset = 0;
  const audioPath = path.resolve(path.dirname(path.dirname(process.cwd())), '1_转录', 'audio.mp3');
  if (fs.existsSync(audioPath)) {
    try {
      audioOffset = parseFloat(execSync(`ffprobe -v error -show_entries format=start_time -of csv=p=0 "${audioPath}"`).toString().trim()) || 0;
      if (audioOffset > 0) {
        console.log(`🔧 检测到音频偏移: ${audioOffset.toFixed(3)}s，自动补偿`);
      }
    } catch (e) { /* 忽略 */ }
  }

  // 获取视频总时长
  const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${input}"`;
  const duration = parseFloat(execSync(probeCmd).toString().trim());

  const bufferSec = BUFFER_MS / 1000;
  const crossfadeSec = CROSSFADE_MS / 1000;

  // 不扩展删除范围，使用精确边界（防止吃掉相邻保留字的头尾音）
  const expandedDelete = deleteList
    .map(seg => ({
      start: Math.max(0, seg.start - audioOffset),
      end: Math.min(duration, seg.end - audioOffset)
    }))
    .sort((a, b) => a.start - b.start);

  // 合并重叠 + 间隙小于 200ms 的相邻删除段（避免产生无意义碎片）
  const MERGE_GAP = 0.2;
  const mergedDelete = [];
  for (const seg of expandedDelete) {
    if (mergedDelete.length === 0 || seg.start > mergedDelete[mergedDelete.length - 1].end + MERGE_GAP) {
      mergedDelete.push({ ...seg });
    } else {
      mergedDelete[mergedDelete.length - 1].end = Math.max(mergedDelete[mergedDelete.length - 1].end, seg.end);
    }
  }

  // 计算保留片段
  const keepSegments = [];
  let cursor = 0;

  for (const del of mergedDelete) {
    if (del.start > cursor) {
      keepSegments.push({ start: cursor, end: del.start });
    }
    cursor = del.end;
  }
  if (cursor < duration) {
    keepSegments.push({ start: cursor, end: duration });
  }

  console.log(`保留 ${keepSegments.length} 个片段，删除 ${mergedDelete.length} 个片段`);

  // 生成 filter_complex（带 crossfade）
  let filters = [];
  let vconcat = '';

  for (let i = 0; i < keepSegments.length; i++) {
    const seg = keepSegments[i];
    filters.push(`[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(`[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    vconcat += `[v${i}]`;
  }

  // 视频直接 concat
  filters.push(`${vconcat}concat=n=${keepSegments.length}:v=1:a=0[outv]`);

  // 音频使用 acrossfade 逐个拼接（消除接缝咔声）
  if (keepSegments.length === 1) {
    filters.push(`[a0]anull[outa]`);
  } else {
    let currentLabel = 'a0';
    for (let i = 1; i < keepSegments.length; i++) {
      const nextLabel = `a${i}`;
      const outLabel = (i === keepSegments.length - 1) ? 'outa' : `amid${i}`;
      filters.push(`[${currentLabel}][${nextLabel}]acrossfade=d=${crossfadeSec.toFixed(3)}:c1=tri:c2=tri[${outLabel}]`);
      currentLabel = outLabel;
    }
  }

  const filterComplex = filters.join(';');

  const encoder = getEncoder();
  console.log(`✂️ 执行 FFmpeg 精确剪辑（${encoder.label}）...`);

  const cmd = `ffmpeg -y -i "file:${input}" -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" -c:v ${encoder.name} ${encoder.args} -c:a aac -b:a 192k "file:${output}"`;

  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log(`✅ 输出: ${output}`);

    const newDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${output}"`).toString().trim());
    console.log(`📹 新时长: ${newDuration.toFixed(2)}s`);
  } catch (err) {
    console.error('FFmpeg 执行失败，尝试分段方案...');
    executeFFmpegCutFallback(input, keepSegments, output);
  }
}

// 备用方案：分段切割 + concat（当 filter_complex 失败时使用）
function executeFFmpegCutFallback(input, keepSegments, output) {
  const tmpDir = `tmp_cut_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const partFiles = [];
    keepSegments.forEach((seg, i) => {
      const partFile = path.join(tmpDir, `part${i.toString().padStart(4, '0')}.mp4`);
      const segDuration = seg.end - seg.start;

      const encoder = getEncoder();
      const cmd = `ffmpeg -y -ss ${seg.start.toFixed(3)} -i "file:${input}" -t ${segDuration.toFixed(3)} -c:v ${encoder.name} ${encoder.args} -c:a aac -b:a 128k -avoid_negative_ts make_zero "${partFile}"`;

      console.log(`切割片段 ${i + 1}/${keepSegments.length}: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s`);
      execSync(cmd, { stdio: 'pipe' });
      partFiles.push(partFile);
    });

    const listFile = path.join(tmpDir, 'list.txt');
    const listContent = partFiles.map(f => `file '${path.resolve(f)}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${output}"`;
    console.log('合并片段...');
    execSync(concatCmd, { stdio: 'pipe' });

    console.log(`✅ 输出: ${output}`);
  } finally {
    // 避免 fs.rmSync recursive 在 Windows 上 crash
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
      fs.rmdirSync(tmpDir);
    } catch (e) { /* 清理失敗不影響流程 */ }
  }
}

// ── 學習審核 HTML ──
const LEARNING_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>規則審核 — 自動學習</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
      background: #1a1a1a; color: #e0e0e0; min-height: 100vh;
    }
    .header {
      background: #252525; padding: 14px 24px; border-bottom: 1px solid #333;
      display: flex; align-items: center; gap: 12px;
    }
    .header h1 { font-size: 17px; font-weight: 600; }
    .header .sub { font-size: 13px; color: #888; }
    .header a { color: #9C27B0; text-decoration: none; font-size: 13px; margin-left: auto; }
    .header a:hover { color: #CE93D8; }

    .meta-bar {
      background: #222; padding: 10px 24px;
      border-bottom: 1px solid #2a2a2a;
      display: flex; gap: 24px; font-size: 13px; color: #aaa;
    }
    .meta-bar span strong { color: #e0e0e0; }
    .meta-bar .ok { color: #4caf50; }
    .meta-bar .warn { color: #ff9800; }

    .toolbar {
      padding: 12px 24px; display: flex; gap: 10px; align-items: center;
      border-bottom: 1px solid #2a2a2a; flex-wrap: wrap;
    }
    .btn {
      padding: 7px 16px; border-radius: 6px; border: none;
      cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.15s;
    }
    .btn-primary { background: #7B1FA2; color: #fff; }
    .btn-primary:hover { background: #9C27B0; }
    .btn-primary:disabled { background: #444; color: #777; cursor: default; }
    .btn-ghost { background: #2a2a2a; color: #ccc; border: 1px solid #444; }
    .btn-ghost:hover { background: #333; color: #fff; }
    .filter-tabs { display: flex; gap: 6px; margin-left: auto; }
    .filter-tab {
      padding: 5px 12px; border-radius: 20px; font-size: 12px;
      cursor: pointer; background: #2a2a2a; color: #888; border: 1px solid #444;
      transition: all 0.15s;
    }
    .filter-tab.active { background: #4a148c; color: #CE93D8; border-color: #7B1FA2; }

    .content { padding: 0 24px 40px; }

    /* ── 空狀態 ── */
    .empty-state {
      text-align: center; padding: 80px 20px; color: #666;
    }
    .empty-state .icon { font-size: 48px; margin-bottom: 16px; }
    .empty-state p { font-size: 14px; line-height: 1.8; }

    /* ── 載入中 ── */
    .loading {
      text-align: center; padding: 60px 20px; color: #666;
    }
    .spinner {
      width: 32px; height: 32px; border: 3px solid #333;
      border-top-color: #9C27B0; border-radius: 50%;
      animation: spin 0.8s linear infinite; margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── 建議卡片表格 ── */
    .suggestion-table {
      width: 100%; border-collapse: collapse; margin-top: 16px;
    }
    .suggestion-table th {
      background: #252525; padding: 10px 12px; text-align: left;
      font-size: 12px; color: #888; font-weight: 500;
      border-bottom: 1px solid #333; white-space: nowrap;
    }
    .suggestion-table th:last-child { text-align: center; width: 60px; }
    .suggestion-table td {
      padding: 12px; border-bottom: 1px solid #2a2a2a;
      vertical-align: top; font-size: 13px;
    }
    .suggestion-table tr:hover td { background: #1e1e1e; }
    .suggestion-table tr.severity-high td:first-child { border-left: 3px solid #f44336; }
    .suggestion-table tr.severity-medium td:first-child { border-left: 3px solid #ff9800; }
    .suggestion-table tr.severity-low td:first-child { border-left: 3px solid #4caf50; }

    .cat-badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px; border-radius: 4px; font-size: 12px;
      background: #2a2a2a; color: #ccc; margin-bottom: 6px;
    }
    .rule-file { font-size: 11px; color: #666; margin-top: 4px; }

    .diff-col { font-size: 13px; line-height: 1.7; }
    .diff-col .label { font-size: 11px; color: #666; margin-bottom: 2px; }
    .diff-col .current { color: #888; }
    .diff-col .ai-action { color: #f44336; }
    .diff-col .srt-shows { color: #4caf50; }

    .suggestion-text { color: #CE93D8; font-size: 13px; font-weight: 500; }
    .change-detail {
      font-size: 11px; color: #777; margin-top: 4px;
      font-family: 'Courier New', monospace;
    }

    .examples-toggle {
      font-size: 12px; color: #9C27B0; cursor: pointer;
      margin-top: 6px; display: inline-block; user-select: none;
    }
    .examples-toggle:hover { color: #CE93D8; }
    .examples-list {
      display: none; margin-top: 8px; padding: 8px;
      background: #222; border-radius: 6px; border: 1px solid #2a2a2a;
    }
    .examples-list.open { display: block; }
    .example-item {
      display: flex; gap: 8px; font-size: 12px; padding: 4px 0;
      border-bottom: 1px solid #2a2a2a; align-items: center;
    }
    .example-item:last-child { border-bottom: none; }
    .example-item .at { color: #666; min-width: 60px; }
    .example-item .ai { color: #f44336; min-width: 70px; }
    .example-item .srt { color: #4caf50; min-width: 80px; }
    .example-item .vid { color: #555; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }

    /* ── 勾選框 ── */
    .check-cell { text-align: center; }
    .custom-check {
      width: 22px; height: 22px; border: 2px solid #555; border-radius: 5px;
      display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.15s; user-select: none;
    }
    .custom-check.checked { background: #7B1FA2; border-color: #9C27B0; }
    .custom-check.checked::after { content: '✓'; color: #fff; font-size: 14px; font-weight: bold; }
    .custom-check.manual { border-color: #444; cursor: default; opacity: 0.4; }

    /* ── 結果提示 ── */
    .result-banner {
      display: none; margin: 16px 0; padding: 14px 18px; border-radius: 8px;
      font-size: 14px; line-height: 1.8;
    }
    .result-banner.success {
      background: #1a2e1a; border: 1px solid #2e7d32; color: #a5d6a7;
    }
    .result-banner.error {
      background: #2c1a1a; border: 1px solid #7d2020; color: #ef9a9a;
    }
    .result-banner.open { display: block; }
    .result-banner ul { padding-left: 20px; margin-top: 6px; }
    .result-banner li { font-size: 13px; }

    .section-title {
      font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;
      margin: 20px 0 0; padding-bottom: 8px; border-bottom: 1px solid #2a2a2a;
    }
  </style>
</head>
<body>
  <div class="header">
    <span style="font-size:20px">🧠</span>
    <h1>規則審核</h1>
    <span class="sub">根據本次剪輯與 SRT 的差異，決定是否更新編輯準則</span>
    <a href="/">← 返回審核頁</a>
  </div>

  <div class="meta-bar" id="metaBar" style="display:none">
    <span>AI 標記 <strong id="metaAi">-</strong> 個</span>
    <span>使用者最終 <strong id="metaUser">-</strong> 個</span>
    <span class="warn">誤標（AI 多剪）<strong id="metaFp">-</strong> 個</span>
    <span class="warn">漏標（AI 少剪）<strong id="metaFn">-</strong> 個</span>
  </div>

  <div class="toolbar">
    <button class="btn btn-primary" id="applyBtn" disabled onclick="applySelected()">
      ✅ 套用選中建議
    </button>
    <button class="btn btn-ghost" onclick="selectAll(true)">全選</button>
    <button class="btn btn-ghost" onclick="selectAll(false)">全不選</button>
    <span id="selectedCount" style="font-size:13px; color:#888">已選 0 項</span>
    <div class="filter-tabs">
      <div class="filter-tab active" onclick="setFilter('all', this)">全部</div>
      <div class="filter-tab" onclick="setFilter('high', this)">🔴 高優先</div>
      <div class="filter-tab" onclick="setFilter('medium', this)">🟡 中優先</div>
      <div class="filter-tab" onclick="setFilter('low', this)">🟢 低優先</div>
    </div>
  </div>

  <div class="content">
    <div class="result-banner" id="resultBanner"></div>
    <div class="loading" id="loadingState">
      <div class="spinner"></div>
      <p>載入建議中...</p>
    </div>
    <div class="empty-state" id="emptyState" style="display:none">
      <div class="icon">✨</div>
      <p>目前沒有需要調整的項目<br>AI 的剪輯方式已與你的 SRT 高度吻合！</p>
    </div>
    <table class="suggestion-table" id="suggTable" style="display:none">
      <thead>
        <tr>
          <th>規則類別</th>
          <th>📌 目前設定</th>
          <th>🤖 AI 做法</th>
          <th>✂️ SRT 顯示</th>
          <th>💡 建議修改</th>
          <th>採用?</th>
        </tr>
      </thead>
      <tbody id="suggBody"></tbody>
    </table>
  </div>

  <script>
    let allSuggestions = [];
    let currentFilter = 'all';

    // ── 載入建議 ──
    async function load() {
      try {
        const r = await fetch('/api/get-suggestions');
        if (!r.ok) {
          const err = await r.json();
          showError(err.error || '載入失敗');
          return;
        }
        const data = await r.json();
        allSuggestions = data.suggestions || [];

        // 更新 meta bar
        const meta = data.meta || {};
        document.getElementById('metaAi').textContent = meta.aiCount || 0;
        document.getElementById('metaUser').textContent = meta.userCount || 0;
        document.getElementById('metaFp').textContent = meta.fpCount || 0;
        document.getElementById('metaFn').textContent = meta.fnCount || 0;
        document.getElementById('metaBar').style.display = 'flex';

        document.getElementById('loadingState').style.display = 'none';
        renderTable();
      } catch (err) {
        showError(err.message);
      }
    }

    function showError(msg) {
      document.getElementById('loadingState').style.display = 'none';
      document.getElementById('emptyState').style.display = 'block';
      document.getElementById('emptyState').innerHTML =
        '<div class="icon">⚠️</div><p>' + escHtml(msg) + '</p>';
    }

    // ── 渲染表格 ──
    function renderTable() {
      const filtered = currentFilter === 'all'
        ? allSuggestions
        : allSuggestions.filter(s => s.severity === currentFilter);

      const tbody = document.getElementById('suggBody');
      tbody.innerHTML = '';

      if (filtered.length === 0) {
        document.getElementById('suggTable').style.display = 'none';
        document.getElementById('emptyState').style.display = 'block';
        return;
      }

      document.getElementById('suggTable').style.display = 'table';
      document.getElementById('emptyState').style.display = 'none';

      for (const s of filtered) {
        const isManual = !s.change || s.requiresManual;
        const tr = document.createElement('tr');
        tr.className = 'severity-' + (s.severity || 'low');
        tr.dataset.id = s.id;

        // 例子列表 HTML
        const examplesHtml = (s.examples || []).length > 0 ? \`
          <span class="examples-toggle" onclick="toggleEx(this)">▶ 查看 \${s.examples.length} 個例子</span>
          <div class="examples-list">
            \${s.examples.map(e => \`
              <div class="example-item">
                <span class="at">\${escHtml(e.at)}</span>
                <span class="ai">\${escHtml(e.aiAction)}</span>
                <span class="srt">\${escHtml(e.userAction)}</span>
                <span style="flex:1">\${escHtml(e.label)}</span>
                \${e.video ? '<span class="vid">' + escHtml(e.video) + '</span>' : ''}
              </div>
            \`).join('')}
          </div>
        \` : '';

        // 建議修改列
        let changeHtml = '<span class="suggestion-text">' + escHtml(s.suggestion || '') + '</span>';
        if (s.change && s.change.path === 'silence.threshold') {
          changeHtml += '<div class="change-detail">' + s.change.path + ': ' + s.change.from + ' → ' + s.change.to + 's</div>';
        } else if (s.change && s.change.action === 'add') {
          changeHtml += '<div class="change-detail">' + s.change.path + ' += 「' + escHtml(s.change.value) + '」</div>';
        } else if (isManual) {
          changeHtml += '<div class="change-detail" style="color:#ff9800">⚠️ 需手動處理</div>';
        }

        tr.innerHTML = \`
          <td>
            <div class="cat-badge">\${escHtml(s.icon || '')} \${escHtml(s.category)}</div>
            \${s.ruleFile ? '<div class="rule-file">📄 ' + escHtml(s.ruleFile) + '</div>' : ''}
          </td>
          <td class="diff-col">
            <div class="label">目前設定</div>
            <div class="current">\${escHtml(s.current)}</div>
          </td>
          <td class="diff-col">
            <div class="label">AI 做法</div>
            <div class="ai-action">\${escHtml(s.aiAction)}</div>
          </td>
          <td class="diff-col">
            <div class="label">SRT 顯示</div>
            <div class="srt-shows">\${escHtml(s.userShows)}</div>
            \${examplesHtml}
          </td>
          <td>\${changeHtml}</td>
          <td class="check-cell">
            <div class="custom-check \${isManual ? 'manual' : (s.checked ? 'checked' : '')}"
                 \${isManual ? 'title="需手動處理，無法自動套用"' : ''}
                 \${isManual ? '' : 'data-sugg-id="' + s.id + '"'}>
            </div>
          </td>
        \`;
        tbody.appendChild(tr);
      }

      // Event delegation for checkboxes (avoids quote-escaping issues in template literal)
      document.querySelectorAll('.custom-check[data-sugg-id]').forEach(function(el) {
        el.addEventListener('click', function() { toggleCheck(el, el.dataset.suggId); });
      });

      updateSelectedCount();
    }

    // ── 勾選邏輯 ──
    function toggleCheck(el, id) {
      const s = allSuggestions.find(x => x.id === id);
      if (!s) return;
      s.checked = !s.checked;
      el.classList.toggle('checked', s.checked);
      updateSelectedCount();
    }

    function selectAll(checked) {
      const filtered = currentFilter === 'all' ? allSuggestions : allSuggestions.filter(s => s.severity === currentFilter);
      for (const s of filtered) {
        if (!s.requiresManual && s.change) s.checked = checked;
      }
      renderTable();
    }

    function updateSelectedCount() {
      const n = allSuggestions.filter(s => s.checked && !s.requiresManual && s.change).length;
      document.getElementById('selectedCount').textContent = '已選 ' + n + ' 項';
      document.getElementById('applyBtn').disabled = n === 0;
    }

    // ── 過濾 ──
    function setFilter(f, el) {
      currentFilter = f;
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      renderTable();
    }

    // ── 展開例子 ──
    function toggleEx(el) {
      const list = el.nextElementSibling;
      list.classList.toggle('open');
      el.textContent = list.classList.contains('open')
        ? el.textContent.replace('▶', '▼')
        : el.textContent.replace('▼', '▶');
    }

    // ── 套用建議 ──
    async function applySelected() {
      const toApply = allSuggestions.filter(s => s.checked && !s.requiresManual && s.change);
      if (toApply.length === 0) return;

      document.getElementById('applyBtn').disabled = true;
      document.getElementById('applyBtn').textContent = '套用中...';

      try {
        const r = await fetch('/api/apply-suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ suggestions: toApply })
        });
        const data = await r.json();

        if (!r.ok) throw new Error(data.error || '套用失敗');

        const banner = document.getElementById('resultBanner');
        banner.className = 'result-banner success open';
        let html = '<strong>✅ 已成功套用 ' + data.applied.length + ' 項建議</strong>';
        if (data.applied.length > 0) {
          html += '<ul>' + data.applied.map(a => '<li>' + escHtml(a.desc) + '</li>').join('') + '</ul>';
        }
        if (data.skipped.length > 0) {
          html += '<div style="margin-top:8px; color:#888; font-size:12px">略過 ' + data.skipped.length + ' 項：'
            + data.skipped.map(s => escHtml(s.reason)).join('、') + '</div>';
        }
        html += '<div style="margin-top:8px; font-size:12px; color:#888">設定已存入 training_config.json，下次剪輯自動生效</div>';
        banner.innerHTML = html;
        banner.scrollIntoView({ behavior: 'smooth' });

        // 標記已採用的項目
        for (const s of toApply) {
          const row = document.querySelector('tr[data-id="' + s.id + '"]');
          if (row) {
            row.style.opacity = '0.5';
            row.querySelector('.check-cell').innerHTML = '<span style="color:#4caf50;font-size:18px">✓</span>';
          }
        }
      } catch (err) {
        const banner = document.getElementById('resultBanner');
        banner.className = 'result-banner error open';
        banner.innerHTML = '<strong>❌ 套用失敗</strong><p>' + escHtml(err.message) + '</p>';
      } finally {
        document.getElementById('applyBtn').disabled = false;
        document.getElementById('applyBtn').textContent = '✅ 套用選中建議';
      }
    }

    function escHtml(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    load();
  </script>
</body>
</html>`;

server.listen(PORT, () => {
  console.log(`
🎬 审核服务器已启动
📍 地址: http://localhost:${PORT}
📹 视频: ${VIDEO_FILE}

操作說明:
1. 在網頁中審核選擇要刪除的片段
2. 點擊「🎬 執行剪輯」按鈕
3. 等待剪輯完成
4. 剪輯完成後訪問 http://localhost:${PORT}/learning 審核規則更新
  `);
});
