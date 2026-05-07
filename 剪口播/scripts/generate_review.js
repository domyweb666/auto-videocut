#!/usr/bin/env node
/**
 * 生成审核网页（视频版本）
 *
 * 模組用法（由 training_server 等呼叫）:
 *   const buildReviewHtml = require('./generate_review');
 *   const html = buildReviewHtml(words, autoSelected, autoReasons, opts);
 *
 * CLI 用法:
 *   node generate_review.js <subtitles_words.json> [auto_selected.json] [video_file]
 *   输出: review.html, video.mp4（符号链接到当前目录）
 */

const fs = require('fs');
const path = require('path');

/**
 * 解析 auto_selected.json 的兩種格式：純陣列 / { indices, reasons }
 * 回傳 { autoSelected: number[], autoReasons: { [idx]: string } }
 */
function parseAutoSelected(raw) {
  let autoSelected = [];
  let autoReasons = {};
  if (Array.isArray(raw)) {
    autoSelected = raw;
  } else if (raw && raw.indices) {
    autoSelected = raw.indices;
    if (raw.reasons) {
      for (const [key, reason] of Object.entries(raw.reasons)) {
        if (key.includes('-')) {
          const [start, end] = key.split('-').map(Number);
          for (let i = start; i <= end; i++) autoReasons[i] = reason;
        } else {
          autoReasons[key] = reason;
        }
      }
    }
  }
  return { autoSelected, autoReasons };
}

/**
 * 產出 review.html 字串
 *
 * @param {Array} words            subtitles_words.json 內容
 * @param {number[]} autoSelected  AI 預選刪除的 word indices
 * @param {Object} autoReasons     idx → 原因字串
 * @param {Object} [opts]
 * @param {string} [opts.videoSrc]         video 元素的 src（預設 'video.mp4'）
 * @param {string} [opts.cutApiPath]       導出 API path（預設 '/api/cut'）
 * @param {string} [opts.encodersApiPath]  編碼器偵測 API path（預設 '/api/encoders'）
 * @param {string} [opts.diffReportApiPath] 學習報告 API path（預設 '/api/diff-report'）
 */
function buildReviewHtml(words, autoSelected, autoReasons, opts) {
  opts = opts || {};
  const videoSrc          = opts.videoSrc          || 'video.mp4';
  const cutApiPath        = opts.cutApiPath        || '/api/cut';
  const encodersApiPath   = opts.encodersApiPath   || '/api/encoders';
  const diffReportApiPath = opts.diffReportApiPath || '/api/diff-report';

return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>剪口播審核</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
      margin: 0;
      padding: 0;
      background: #1a1a1a;
      color: #e0e0e0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      user-select: none;
    }

    .toolbar {
      background: #252525;
      padding: 8px 16px;
      border-bottom: 1px solid #333;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

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
    button.danger { background: #333; border-color: #555; color: #f44336; }
    button.danger:hover { background: #3d2323; }

    select {
      padding: 6px 10px;
      background: #333;
      color: white;
      border: 1px solid #444;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }

    #time { font-family: monospace; font-size: 13px; color: #888; margin-left: auto; }

    .stats-bar {
      background: #1e1e1e;
      padding: 5px 16px;
      border-bottom: 1px solid #2a2a2a;
      font-size: 12px;
      color: #888;
      flex-shrink: 0;
      display: flex;
      gap: 20px;
    }
    .stats-bar span { color: #ccc; }

    .main {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ── Left panel ── */
    .left-panel {
      width: 340px;
      flex-shrink: 0;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-right: 1px solid #2a2a2a;
      background: #1e1e1e;
    }

    #player {
      width: 100%;
      border-radius: 6px;
      background: #000;
    }

    .help {
      font-size: 11px;
      color: #666;
      line-height: 1.8;
    }
    .help b { color: #999; }

    .legend {
      display: flex;
      gap: 12px;
      font-size: 11px;
      flex-wrap: wrap;
    }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-dot {
      width: 10px; height: 10px; border-radius: 2px;
    }
    .legend-dot.ai { background: #ff9800; }
    .legend-dot.del { background: #f44336; }
    .legend-dot.cur { background: #2196F3; }
    .legend-dot.sil { background: #333; border: 1px solid #555; }

    /* ── Right panel: script view ── */
    .right-panel {
      flex: 1;
      overflow-y: auto;
      padding: 20px 28px;
    }

    .script {
      font-size: 17px;
      line-height: 2.2;
      color: #ddd;
    }

    /* Word spans */
    .w {
      display: inline;
      padding: 2px 1px;
      border-radius: 3px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .w:hover { background: rgba(255,255,255,0.08); }
    .w.cur { background: #1565C0; color: #fff; border-radius: 3px; }
    .w.ai  { background: rgba(255,152,0,0.25); color: #ffcc80; }
    .w.del { background: rgba(244,67,54,0.3); color: #ef9a9a; text-decoration: line-through; }
    .w.selecting { background: rgba(33,150,243,0.35); color: #90caf9; }

    /* Silence block */
    .sil {
      display: inline-block;
      background: #2a2a2a;
      border: 1px solid #3a3a3a;
      color: #666;
      font-size: 11px;
      padding: 1px 7px;
      border-radius: 10px;
      margin: 0 4px;
      vertical-align: middle;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .sil:hover { background: #333; color: #999; border-color: #555; }
    .sil.del { background: rgba(244,67,54,0.2); border-color: rgba(244,67,54,0.4); color: #ef9a9a; }
    .sil.partial { border-color: rgba(244,67,54,0.3); color: #888; }

    /* Line break between utterances */
    .line-break { display: block; height: 0.3em; }

    /* Loading overlay */
    .loading-overlay {
      display: none;
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.88);
      z-index: 9999;
      justify-content: center; align-items: center; flex-direction: column;
    }
    .loading-overlay.show { display: flex; }
    .loading-spinner {
      width: 56px; height: 56px;
      border: 4px solid #333; border-top-color: #9C27B0;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { margin-top: 18px; font-size: 17px; color: #fff; }
    .loading-progress-container {
      margin-top: 18px; width: 280px; height: 6px;
      background: #333; border-radius: 3px; overflow: hidden;
    }
    .loading-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #9C27B0, #E91E63);
      width: 0%; transition: width 0.3s ease;
    }
    .loading-time { margin-top: 12px; font-size: 13px; color: #888; }

    /* ── Export Panel (CapCut-style) ── */
    .modal-backdrop {
      display: none;
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.7);
      z-index: 9000;
      justify-content: center; align-items: center;
    }
    .modal-backdrop.show { display: flex; }
    .export-panel {
      background: #232323;
      border: 1px solid #3a3a3a;
      border-radius: 10px;
      width: 440px;
      max-width: 95vw;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      padding: 0;
    }
    .export-panel .ep-head {
      padding: 16px 22px;
      border-bottom: 1px solid #333;
      font-size: 16px; font-weight: 600; color: #fff;
      display: flex; align-items: center; gap: 8px;
    }
    .export-panel .ep-body { padding: 12px 22px 4px; }
    .export-panel .ep-row {
      display: flex; align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid #2b2b2b;
      gap: 12px;
    }
    .export-panel .ep-row:last-child { border-bottom: none; }
    .export-panel .ep-label {
      flex: 0 0 88px;
      font-size: 13px; color: #bbb;
    }
    .export-panel .ep-control { flex: 1; }
    .export-panel select {
      width: 100%;
      padding: 7px 10px;
      background: #2c2c2c;
      color: #e0e0e0;
      border: 1px solid #3c3c3c;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }
    .export-panel select:hover { border-color: #555; }
    .export-panel select option[disabled] { color: #666; }
    .export-panel .ep-hint {
      font-size: 11px; color: #777; margin-top: 4px;
    }
    .export-panel .ep-check {
      display: flex; align-items: center; gap: 8px;
      font-size: 13px; color: #ccc; cursor: pointer;
      user-select: none;
    }
    .export-panel .ep-check input[type="checkbox"] {
      width: 16px; height: 16px; cursor: pointer; accent-color: #9C27B0;
    }
    .export-panel .ep-foot {
      display: flex; justify-content: flex-end; gap: 10px;
      padding: 14px 22px;
      border-top: 1px solid #333;
      background: #1e1e1e;
      border-radius: 0 0 10px 10px;
    }
    .export-panel .ep-summary {
      font-size: 12px; color: #888; margin-right: auto;
      align-self: center;
    }
    .export-panel .ep-summary b { color: #CE93D8; }
    .export-panel button.ep-primary {
      padding: 8px 22px; background: #9C27B0; color: #fff;
      border: none; border-radius: 6px; cursor: pointer; font-size: 13px;
      font-weight: 500;
    }
    .export-panel button.ep-primary:hover { background: #7B1FA2; }
    .export-panel button.ep-secondary {
      padding: 8px 18px; background: #3a3a3a; color: #ddd;
      border: 1px solid #4a4a4a; border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    .export-panel button.ep-secondary:hover { background: #444; }
  </style>
</head>
<body>

<!-- ── 匯出設定 Modal（剪映風格）── -->
<div class="modal-backdrop" id="exportBackdrop">
  <div class="export-panel" onclick="event.stopPropagation()">
    <div class="ep-head">🎬 視頻匯出</div>
    <div class="ep-body">

      <div class="ep-row">
        <div class="ep-label">分辨率</div>
        <div class="ep-control">
          <select id="epResolution">
            <option value="">保持原始</option>
            <option value="1080">1080P</option>
            <option value="720">720P</option>
            <option value="480">480P</option>
          </select>
        </div>
      </div>

      <div class="ep-row">
        <div class="ep-label">碼率</div>
        <div class="ep-control">
          <select id="epBitrate">
            <option value="recommended" selected>推薦（原片碼率）</option>
            <option value="high">更高（×1.5，畫質更好）</option>
            <option value="low">更低（×0.6，省空間）</option>
          </select>
        </div>
      </div>

      <div class="ep-row">
        <div class="ep-label">編碼</div>
        <div class="ep-control">
          <select id="epCodec">
            <option value="">H.264（最相容）</option>
            <option value="h265">HEVC / H.265（省 50% 空間）</option>
            <option value="av1" id="epCodecAv1">AV1（最省空間，需新顯卡）</option>
          </select>
          <div class="ep-hint" id="epCodecHint"></div>
        </div>
      </div>

      <div class="ep-row">
        <div class="ep-label">格式</div>
        <div class="ep-control">
          <select id="epContainer">
            <option value="mp4" selected>MP4（通用）</option>
            <option value="mkv">MKV（萬能容器）</option>
            <option value="mov">MOV（Apple）</option>
          </select>
        </div>
      </div>

      <div class="ep-row">
        <div class="ep-label">幀率</div>
        <div class="ep-control">
          <select id="epFps">
            <option value="">保持原始</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps</option>
          </select>
        </div>
      </div>

      <div class="ep-row">
        <div class="ep-label">附加</div>
        <div class="ep-control">
          <label class="ep-check" style="margin-bottom:6px">
            <input type="checkbox" id="epAudioOnly">
            單獨匯出音訊（MP3，忽略視訊編碼設定）
          </label>
          <label class="ep-check">
            <input type="checkbox" id="epGif">
            同步匯出 GIF（240P, 15fps）
          </label>
        </div>
      </div>

    </div>
    <div class="ep-foot">
      <span class="ep-summary" id="epSummary">將刪減 <b>0</b> 個片段</span>
      <button class="ep-secondary" onclick="closeExportPanel()">取消</button>
      <button class="ep-primary" onclick="confirmExport()">導出</button>
    </div>
  </div>
</div>

<div class="loading-overlay" id="loadingOverlay">
  <div class="loading-spinner"></div>
  <div class="loading-text">🎬 正在剪輯中...</div>
  <div class="loading-progress-container">
    <div class="loading-progress-bar" id="loadingProgress"></div>
  </div>
  <div class="loading-time" id="loadingTime">已等待 0 秒</div>
</div>

<div class="toolbar">
  <button onclick="togglePlay()">▶ 播放 / 暫停</button>
  <select id="speed" onchange="player.playbackRate=parseFloat(this.value)">
    <option value="0.5">0.5x</option>
    <option value="0.75">0.75x</option>
    <option value="1" selected>1x</option>
    <option value="1.25">1.25x</option>
    <option value="1.5">1.5x</option>
    <option value="2">2x</option>
  </select>
  <button onclick="openExportPanel()" class="primary">⚙️ 匯出設定</button>
  <button onclick="exportMarkdown()">📝 匯出 MD</button>
  <button class="danger" onclick="clearAll()">清空選擇</button>
  <button onclick="copyDeleteList()">📋 複製刪除清單</button>
  <button onclick="updateNarrativeStyle()" title="建議累積 5-10 支新影片後再按，約需 10-20 分鐘" style="background:#1a3a1a;border:1px solid #2d6a2d;">🧠 更新剪輯守則</button>
  <button id="rollbackBtn" onclick="openRollbackModal()" title="查看守則快照歷史，可一鍵回滾" style="background:#2a1a1a;border:1px solid #6a2d2d;">↶ 守則歷史</button>
  <span style="margin-left:12px; padding-left:12px; border-left:1px solid #444; font-size:13px; color:#aaa;">
    剪輯模式
  </span>
  <select id="modeSwitch" onchange="switchMode(this.value)" style="background:#222;color:#fff;border:1px solid #444;padding:4px 8px;border-radius:4px;">
    <option value="rules">rules（規則層）</option>
  </select>
  <span id="modeInfo" style="font-size:12px;color:#888"></span>
  <span id="time">00:00 / 00:00</span>
</div>

<div class="stats-bar">
  已選 <span id="selCount">0</span> 個元素 ·
  刪減時長 <span id="selDur">0.0</span>s ·
  <span style="color:#ff9800">橙色</span> = AI預選 ·
  <span style="color:#f44336">紅色</span> = 確認刪除 ·
  拖曳選取文字可批量刪除
</div>

<div class="main">
  <div class="left-panel">
    <video id="player" src="${videoSrc}" preload="auto"></video>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot ai"></div><span>AI預選</span></div>
      <div class="legend-item"><div class="legend-dot del"></div><span>確認刪除</span></div>
      <div class="legend-item"><div class="legend-dot cur"></div><span>當前播放</span></div>
      <div class="legend-item"><div class="legend-dot sil"></div><span>靜音段</span></div>
    </div>
    <div class="help">
      <b>選取：</b>直接拖曳文字即可批量標記刪除<br>
      <b>單擊：</b>跳轉到該時間點<br>
      <b>雙擊：</b>切換單個詞的選取狀態<br>
      <b>靜音塊：</b>點擊切換整段靜音<br>
      <b>空格：</b>播放/暫停 · <b>←→：</b>跳1秒
    </div>
  </div>

  <div class="right-panel">
    <div class="script" id="script"></div>
  </div>
</div>

<script>
  const words = ${JSON.stringify(words)};
  const autoSelected = new Set(${JSON.stringify(autoSelected)});
  const autoReasons = ${JSON.stringify(autoReasons)};
  const selected = new Set(autoSelected);

  const player = document.getElementById('player');
  const timeDisplay = document.getElementById('time');
  const scriptDiv = document.getElementById('script');

  // wordEl[i] = the DOM span for word index i (null for gaps inside silence blocks)
  let wordEl = [];
  // silenceBlocks: array of { el, indices[] }
  let silenceBlocks = [];

  // ── Drag selection state ──
  let dragActive = false;
  let dragStart = -1;
  let dragMode = 'add'; // 'add' | 'remove'
  let dragCurrent = -1;

  function togglePlay() {
    if (player.paused) player.play(); else player.pause();
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m.toString().padStart(2,'0') + ':' + s.toString().padStart(2,'0');
  }
  function formatDuration(sec) {
    const v = parseFloat(sec);
    const m = Math.floor(v / 60);
    const s = (v % 60).toFixed(1);
    return m > 0 ? m + '分' + s + '秒' : s + '秒';
  }

  // ── Build segments: merge consecutive gaps ──
  function buildSegments() {
    const segs = [];
    let i = 0;
    while (i < words.length) {
      if (words[i].isGap) {
        let dur = 0, indices = [];
        while (i < words.length && words[i].isGap) {
          dur += words[i].end - words[i].start;
          indices.push(i);
          i++;
        }
        segs.push({ type: 'sil', dur, indices });
      } else {
        segs.push({ type: 'word', idx: i });
        i++;
      }
    }
    return segs;
  }

  function getWordClass(i) {
    if (selected.has(i)) return 'w del';
    if (autoSelected.has(i)) return 'w ai';
    return 'w';
  }

  function getSilClass(indices) {
    const allDel = indices.every(i => selected.has(i));
    const someDel = indices.some(i => selected.has(i));
    if (allDel) return 'sil del';
    if (someDel) return 'sil partial';
    return 'sil';
  }

  // ── Render ──
  function render() {
    scriptDiv.innerHTML = '';
    wordEl = new Array(words.length).fill(null);
    silenceBlocks = [];

    const segs = buildSegments();
    // Track if we should insert a line break after the next silence block
    let pendingBreak = false;

    segs.forEach((seg, si) => {
      if (seg.type === 'sil') {
        // Silence block
        if (pendingBreak) {
          scriptDiv.appendChild(document.createElement('br'));
          pendingBreak = false;
        }
        const span = document.createElement('span');
        span.className = getSilClass(seg.indices);
        span.textContent = '靜音 ' + seg.dur.toFixed(1) + 's';
        const silReason = seg.indices.map(i => autoReasons[i]).find(r => r);
        span.title = (silReason ? silReason + ' | ' : '') + '點擊切換整段靜音 (' + seg.indices.length + ' 個間隔)';

        // Click = toggle all gaps in this block
        span.addEventListener('click', (e) => {
          e.stopPropagation();
          const allDel = seg.indices.every(i => selected.has(i));
          seg.indices.forEach(i => {
            if (allDel) selected.delete(i); else selected.add(i);
          });
          span.className = getSilClass(seg.indices);
          rebuildSkipIntervals();
          updateStats();
        });

        scriptDiv.appendChild(span);
        silenceBlocks.push({ el: span, indices: seg.indices });
        seg.indices.forEach(i => wordEl[i] = span);

        // After a silence >= 0.3s, next word cluster starts on a new line
        if (seg.dur >= 0.3) {
          pendingBreak = true;
        }

      } else {
        // Word
        const i = seg.idx;
        if (pendingBreak) {
          scriptDiv.appendChild(document.createElement('br'));
          pendingBreak = false;
        }
        const span = document.createElement('span');
        span.className = getWordClass(i);
        span.dataset.idx = i;
        span.textContent = words[i].text;
        if (autoReasons[i]) span.title = autoReasons[i];

        // Mousedown: start drag
        span.addEventListener('mousedown', (e) => {
          e.preventDefault();
          dragActive = true;
          dragStart = i;
          dragCurrent = i;
          dragMode = selected.has(i) ? 'remove' : 'add';
          applyDrag(i, i);
        });

        // Dblclick: toggle single word (fallback)
        span.addEventListener('dblclick', (e) => {
          e.preventDefault();
          toggleWord(i);
        });

        // Single click (no drag): seek video (handled in mouseup)
        span.addEventListener('click', (e) => {
          if (!e._wasDrag) {
            player.currentTime = words[i].start;
          }
        });

        scriptDiv.appendChild(span);
        wordEl[i] = span;
      }
    });

    updateStats();
  }

  // Apply drag selection from startIdx to endIdx
  function applyDrag(startIdx, endIdx) {
    const min = Math.min(startIdx, endIdx);
    const max = Math.max(startIdx, endIdx);
    for (let j = min; j <= max; j++) {
      if (words[j] && !words[j].isGap) {
        if (dragMode === 'add') {
          selected.add(j);
        } else {
          selected.delete(j);
        }
        if (wordEl[j]) {
          wordEl[j].className = getWordClass(j);
        }
      }
    }
  }

  // Global mousemove for drag selection
  document.addEventListener('mousemove', (e) => {
    if (!dragActive) return;
    const target = e.target.closest('[data-idx]');
    if (!target) return;
    const i = parseInt(target.dataset.idx);
    if (i === dragCurrent) return;
    dragCurrent = i;
    applyDrag(dragStart, i);
    updateStats();
  });

  document.addEventListener('mouseup', (e) => {
    if (dragActive) {
      const movedRange = dragStart !== dragCurrent;
      if (movedRange) {
        // Mark the click event as a drag so we don't seek
        if (e.target._wasDrag !== undefined) e.target._wasDrag = true;
      }
      dragActive = false;
      rebuildSkipIntervals();
      updateStats();
    }
  });

  function toggleWord(i) {
    if (selected.has(i)) {
      selected.delete(i);
    } else {
      selected.add(i);
    }
    if (wordEl[i]) wordEl[i].className = getWordClass(i);
    rebuildSkipIntervals();
    updateStats();
  }

  function updateStats() {
    let dur = 0;
    selected.forEach(i => { dur += words[i].end - words[i].start; });
    document.getElementById('selCount').textContent = selected.size;
    document.getElementById('selDur').textContent = dur.toFixed(1);
  }

  // ── Web Audio API (mute during skipped segments) ──
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaElementSource(player);
  const gainNode = audioCtx.createGain();
  source.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  player.addEventListener('play', () => { if (audioCtx.state === 'suspended') audioCtx.resume(); });

  // ── Skip intervals ──
  let skipIntervals = [];
  function rebuildSkipIntervals() {
    const sorted = Array.from(selected).sort((a, b) => a - b);
    skipIntervals = [];
    let i = 0;
    while (i < sorted.length) {
      let start = words[sorted[i]].start;
      let end = words[sorted[i]].end;
      let j = i + 1;
      while (j < sorted.length && words[sorted[j]].start - end < 0.1) {
        end = words[sorted[j]].end;
        j++;
      }
      skipIntervals.push({ start: start - 0.05, end });
      i = j;
    }
  }
  rebuildSkipIntervals();

  // ── rAF tick: skip + highlight current word ──
  let lastHighlight = -1;
  let skipLock = false;

  function tick() {
    requestAnimationFrame(tick);
    const t = player.currentTime;

    if (!player.paused) {
      for (const iv of skipIntervals) {
        if (t >= iv.start && t < iv.end) {
          if (!skipLock) {
            skipLock = true;
            gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            player.currentTime = iv.end;
          }
          return;
        }
      }
      if (skipLock) {
        skipLock = false;
        gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
      }
    }

    timeDisplay.textContent = formatTime(t) + ' / ' + formatTime(player.duration || 0);

    // Highlight current word
    let curr = -1;
    for (let i = 0; i < words.length; i++) {
      if (t >= words[i].start && t < words[i].end) { curr = i; break; }
    }
    if (curr !== lastHighlight) {
      if (lastHighlight >= 0 && wordEl[lastHighlight]) {
        const el = wordEl[lastHighlight];
        if (el.dataset && el.dataset.idx !== undefined) {
          el.className = getWordClass(lastHighlight);
        }
      }
      if (curr >= 0 && wordEl[curr]) {
        const el = wordEl[curr];
        if (el.dataset && el.dataset.idx !== undefined) {
          const base = getWordClass(curr);
          el.className = base + ' cur';
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      lastHighlight = curr;
    }
  }
  requestAnimationFrame(tick);

  function clearAll() {
    selected.clear();
    autoSelected.forEach(i => selected.add(i));
    render();
    rebuildSkipIntervals();
    updateStats();
  }

  // ── 剪輯模式切換 ──
  let currentMode = 'rules';
  const MODE_LABELS = {
    rules:   'rules（規則層）',
    layered: 'layered（規則 + AI 敘事）',
    full:    'full_edit（純 AI 整段）'
  };

  function countManualEdits() {
    // 對稱差: 使用者改了多少個 idx 跟 AI 預選不一樣
    let diff = 0;
    selected.forEach(i => { if (!autoSelected.has(i)) diff++; });
    autoSelected.forEach(i => { if (!selected.has(i)) diff++; });
    return diff;
  }

  async function initModeSwitch() {
    try {
      const r = await fetch('/api/auto-modes');
      const modes = await r.json();
      const sel = document.getElementById('modeSwitch');
      sel.innerHTML = '';
      let firstAvailable = null;
      for (const m of ['rules', 'layered', 'full']) {
        if (!modes[m]) continue;
        if (!firstAvailable) firstAvailable = m;
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = MODE_LABELS[m];
        sel.appendChild(opt);
      }
      // 用 server 決定的 defaultMode（layered when guide+polished ready, else rules）
      const preferredMode = modes.defaultMode || firstAvailable || 'rules';
      if (modes[preferredMode]) {
        currentMode = preferredMode;
        sel.value = preferredMode;
        // 若預設是 layered，自動載入一次
        if (preferredMode !== 'rules') {
          await switchMode(preferredMode);
        }
      } else if (!modes[currentMode] && firstAvailable) {
        currentMode = firstAvailable;
        sel.value = firstAvailable;
      }
    } catch (e) {
      console.warn('無法載入模式列表:', e);
    }
  }

  async function switchMode(mode) {
    if (mode === currentMode) return;
    const manualEdits = countManualEdits();
    if (manualEdits > 0) {
      const ok = confirm('你有 ' + manualEdits + ' 處手動編輯，切換到「' + (MODE_LABELS[mode] || mode) + '」會覆蓋掉這些變更。繼續？');
      if (!ok) {
        document.getElementById('modeSwitch').value = currentMode;
        return;
      }
    }
    try {
      const r = await fetch('/api/auto-selected?mode=' + encodeURIComponent(mode));
      const data = await r.json();
      if (data.error) { alert('切換失敗: ' + data.error); document.getElementById('modeSwitch').value = currentMode; return; }
      autoSelected.clear();
      data.indices.forEach(i => autoSelected.add(i));
      Object.keys(autoReasons).forEach(k => delete autoReasons[k]);
      Object.assign(autoReasons, data.reasons || {});
      selected.clear();
      autoSelected.forEach(i => selected.add(i));
      currentMode = mode;
      updateModeInfo(data);
      render();
      rebuildSkipIntervals();
      updateStats();
    } catch (e) {
      alert('切換失敗: ' + e.message);
      document.getElementById('modeSwitch').value = currentMode;
    }
  }

  function updateModeInfo(data) {
    const info = document.getElementById('modeInfo');
    if (!info) return;
    const meta = (data && data.meta) || {};
    const stats = meta.stats || {};
    const warn = (meta.alignment_warnings || []).length;
    let parts = [];
    parts.push('共 ' + (data.indices ? data.indices.length : autoSelected.size) + ' 個 idx');
    if (stats.rules_deleted !== undefined && stats.narrative_deleted !== undefined) {
      parts.push('規則 ' + stats.rules_deleted + ' + AI ' + stats.narrative_deleted);
    }
    if (warn > 0) parts.push('⚠️ ' + warn + ' 對齊警告');
    info.textContent = parts.join(' · ');
    info.style.color = warn > 0 ? '#ff9800' : '#888';
  }

  initModeSwitch();

  // 啟動時檢查 holdout F1 是否有退步，若有則警示回滾按鈕
  (async function checkRegressionOnLoad() {
    try {
      const r = await fetch('/api/holdout-status');
      const data = await r.json();
      if (data.available && data.latest && data.latest.regression) {
        const btn = document.getElementById('rollbackBtn');
        if (btn) {
          btn.style.background = '#5a1a1a';
          btn.style.borderColor = '#c0392b';
          btn.textContent = '⚠️ 守則退步 — 點擊回滾';
        }
      }
    } catch (e) { /* holdout 尚未設定，忽略 */ }
  })();

  async function updateNarrativeStyle() {
    const btn = document.querySelector('button[onclick="updateNarrativeStyle()"]');
    btn.disabled = true;
    btn.textContent = '🧠 檢查中...';
    try {
      const r = await fetch('/api/update-narrative-style', { method: 'POST' });
      const data = await r.json();
      if (data.status === 'up_to_date') {
        alert('✅ 守則已是最新，無需更新');
      } else if (data.status === 'started') {
        alert('🧠 開始更新守則（' + data.newVideos + ' 支新影片）\n\n' + data.message + '\n\n視窗關閉後在背景執行，完成後自動生效。');
      } else {
        alert('⚠️ ' + (data.message || '未知狀態'));
      }
    } catch(e) {
      showToast('❌ 更新失敗: ' + e.message);
    }
    setTimeout(() => { btn.disabled = false; btn.textContent = '🧠 更新剪輯守則'; }, 3000);
  }

  // ── 守則快照 / 回滾 Modal ──
  async function openRollbackModal() {
    let modal = document.getElementById('rollbackModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'rollbackModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center';
      modal.innerHTML = '<div style="background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:24px;min-width:480px;max-width:680px;max-height:80vh;overflow-y:auto">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
        '<h3 style="margin:0;color:#fff">↶ 守則快照歷史</h3>' +
        '<button onclick="document.getElementById(\'rollbackModal\').remove()" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer">✕</button>' +
        '</div>' +
        '<div id="rollbackList">載入中...</div>' +
        '</div>';
      document.body.appendChild(modal);
    } else {
      modal.style.display = 'flex';
    }
    try {
      const [snapRes, holdoutRes] = await Promise.all([
        fetch('/api/narrative-style-snapshots'),
        fetch('/api/holdout-status')
      ]);
      const { snapshots } = await snapRes.json();
      const holdout = await holdoutRes.json();
      const latestF1 = holdout.available ? (holdout.latest.avgF1 * 100).toFixed(2) : null;
      const regression = holdout.available && holdout.latest.regression;

      // 更新回滾按鈕顏色
      const rollbackBtn = document.getElementById('rollbackBtn');
      if (regression) {
        rollbackBtn.style.background = '#5a1a1a';
        rollbackBtn.style.borderColor = '#c0392b';
        rollbackBtn.textContent = '⚠️ 守則退步 — 點擊回滾';
      }

      const list = document.getElementById('rollbackList');
      if (!snapshots || snapshots.length === 0) {
        list.innerHTML = '<p style="color:#888">目前沒有快照（增量更新後才會產生）</p>';
        return;
      }
      const rows = snapshots.map(s => {
        const date = new Date(s.timestamp).toLocaleString('zh-TW');
        const kb   = (s.size / 1024).toFixed(1);
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #333">' +
          '<div>' +
          '<div style="color:#ccc;font-size:14px">' + date + '</div>' +
          '<div style="color:#666;font-size:12px">' + s.filename + ' (' + kb + ' KB)</div>' +
          '</div>' +
          '<button onclick="doRollback(\'' + s.filename + '\')" style="background:#3a1a1a;border:1px solid #8b2e2e;color:#e88;padding:6px 14px;border-radius:4px;cursor:pointer">還原此版本</button>' +
          '</div>';
      }).join('');
      list.innerHTML = (latestF1 ? '<div style="margin-bottom:12px;padding:8px 12px;background:#1e2a1e;border-radius:4px;color:#8c8">' +
        '目前 Holdout F1：' + latestF1 + '%' + (regression ? ' ⚠️ 退步' : '') + '</div>' : '') + rows;
    } catch (e) {
      document.getElementById('rollbackList').innerHTML = '<p style="color:#e44">載入失敗: ' + e.message + '</p>';
    }
  }

  async function doRollback(filename) {
    if (!confirm('確定要還原到「' + filename + '」？\n\n目前守則會先備份一份，再還原。')) return;
    try {
      const r = await fetch('/api/narrative-style-rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: filename })
      });
      const data = await r.json();
      if (data.success) {
        showToast('✅ 守則已還原（備份: ' + data.backup + '）');
        document.getElementById('rollbackModal').remove();
        const btn = document.getElementById('rollbackBtn');
        btn.style.background = '#2a1a1a';
        btn.style.borderColor = '#6a2d2d';
        btn.textContent = '↶ 守則歷史';
      } else {
        alert('❌ 還原失敗: ' + (data.error || '未知錯誤'));
      }
    } catch (e) {
      alert('❌ 還原失敗: ' + e.message);
    }
  }

  function copyDeleteList() {
    const segments = buildDeleteSegments();
    const json = JSON.stringify(segments, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      alert('已複製 ' + segments.length + ' 個刪除片段到剪貼板');
    });
  }

  function buildDeleteSegments() {
    const segs = [];
    const sortedSelected = Array.from(selected).sort((a, b) => a - b);
    sortedSelected.forEach(i => segs.push({ start: words[i].start, end: words[i].end }));
    const merged = [];
    for (const seg of segs) {
      if (merged.length === 0) {
        merged.push({ ...seg });
      } else {
        const last = merged[merged.length - 1];
        if (seg.start - last.end < 0.05) { last.end = seg.end; }
        else merged.push({ ...seg });
      }
    }
    return merged;
  }

  // ── 匯出面板 ──
  let encoderCaps = null;
  async function loadEncoderCaps() {
    try {
      const r = await fetch('${encodersApiPath}');
      if (!r.ok) return;
      encoderCaps = await r.json();
      const av1Opt = document.getElementById('epCodecAv1');
      const hint = document.getElementById('epCodecHint');
      if (encoderCaps.av1 && encoderCaps.av1.supported) {
        av1Opt.disabled = false;
        av1Opt.textContent = 'AV1（' + (encoderCaps.av1.hardware ? '硬體加速可用' : '軟體編碼，較慢') + '）';
      } else {
        av1Opt.disabled = true;
        av1Opt.textContent = 'AV1（此系統無可用編碼器）';
      }
      // 切換編碼時提示
      document.getElementById('epCodec').addEventListener('change', (e) => {
        if (e.target.value === 'av1' && encoderCaps.av1 && !encoderCaps.av1.hardware) {
          hint.textContent = '⚠️ 未偵測到 AV1 硬體編碼，將使用 libsvtav1 軟體編碼（速度較慢）';
        } else if (e.target.value === 'av1') {
          hint.textContent = '✓ 將使用硬體 AV1 編碼';
        } else {
          hint.textContent = '';
        }
      });
    } catch (_) { /* silent */ }
  }
  loadEncoderCaps();

  function openExportPanel() {
    const segs = buildDeleteSegments();
    document.getElementById('epSummary').innerHTML = '將刪減 <b>' + segs.length + '</b> 個片段';
    document.getElementById('exportBackdrop').classList.add('show');
  }
  function closeExportPanel() {
    document.getElementById('exportBackdrop').classList.remove('show');
  }
  document.getElementById('exportBackdrop').addEventListener('click', closeExportPanel);

  function collectExportOptions() {
    return {
      resolution: document.getElementById('epResolution').value,
      bitrate: document.getElementById('epBitrate').value,
      codec: document.getElementById('epCodec').value,
      container: document.getElementById('epContainer').value,
      fps: document.getElementById('epFps').value,
      audioOnly: document.getElementById('epAudioOnly').checked,
      gif: document.getElementById('epGif').checked,
    };
  }

  function confirmExport() {
    closeExportPanel();
    executeCut(collectExportOptions());
  }

  async function executeCut(exportOptions) {
    exportOptions = exportOptions || {};
    const videoDuration = player.duration;
    const estimatedTime = Math.max(5, Math.ceil(videoDuration / 4));
    const estMin = Math.floor(estimatedTime / 60);
    const estSec = estimatedTime % 60;
    const estText = estMin > 0 ? estMin + '分' + estSec + '秒' : estSec + '秒';

    const fmtLabel = exportOptions.audioOnly
      ? '音訊 MP3'
      : ((exportOptions.codec || 'H.264') + ' / ' + (exportOptions.container || 'mp4').toUpperCase());

    if (!confirm('確認導出？\\n\\n📹 視頻時長: ' + (videoDuration/60).toFixed(1) + ' 分鐘\\n🎬 格式: ' + fmtLabel + '\\n⏱️ 預計耗時: ' + estText + '\\n\\n點擊確定開始')) return;

    const segments = buildDeleteSegments();

    // ── 學習報告：記錄 AI vs 使用者差異 ──
    const falsePositives = []; // AI 標了但使用者取消
    const falseNegatives = []; // 使用者新增但 AI 沒標
    autoSelected.forEach(i => {
      if (!selected.has(i)) falsePositives.push({ idx: i, text: words[i].text || '[靜音]', start: words[i].start, isGap: words[i].isGap });
    });
    selected.forEach(i => {
      if (!autoSelected.has(i)) falseNegatives.push({ idx: i, text: words[i].text || '[靜音]', start: words[i].start, isGap: words[i].isGap });
    });
    const diffReport = { timestamp: new Date().toISOString(), aiCount: autoSelected.size, userCount: selected.size, falsePositives, falseNegatives };
    // POST diff report to server (fire-and-forget)
    fetch('${diffReportApiPath}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(diffReport) }).catch(() => {});

    const overlay = document.getElementById('loadingOverlay');
    const loadingTimeEl = document.getElementById('loadingTime');
    const loadingProgress = document.getElementById('loadingProgress');
    overlay.classList.add('show');

    const startTime = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      loadingTimeEl.textContent = '已等待 ' + elapsed + ' 秒';
      loadingProgress.style.width = Math.min(95, (elapsed / estimatedTime) * 100) + '%';
    }, 500);

    try {
      const res = await fetch('${cutApiPath}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteList: segments, exportOptions })
      });
      const data = await res.json();

      clearInterval(timer);
      loadingProgress.style.width = '100%';
      await new Promise(r => setTimeout(r, 300));
      overlay.classList.remove('show');
      loadingProgress.style.width = '0%';
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

      if (data.success) {
        alert('✅ 剪輯完成！(耗時 ' + totalTime + 's)\\n\\n📁 輸出: ' + data.output + '\\n\\n原時長: ' + formatDuration(data.originalDuration) + '\\n新時長: ' + formatDuration(data.newDuration) + '\\n刪減: ' + formatDuration(data.deletedDuration) + ' (' + data.savedPercent + '%)');
      } else {
        alert('❌ 剪輯失敗: ' + data.error);
      }
    } catch (err) {
      clearInterval(timer);
      overlay.classList.remove('show');
      loadingProgress.style.width = '0%';
      alert('❌ 請求失敗: ' + err.message + '\\n\\n請確保使用 review_server.js 啟動服務');
    }
  }

  function exportMarkdown() {
    // Build markdown from kept (non-selected) words, grouped by silence breaks
    const lines = [];
    let currentLine = [];

    const segs = buildSegments();
    segs.forEach(seg => {
      if (seg.type === 'sil') {
        // Flush current line
        if (currentLine.length > 0) {
          lines.push(currentLine.join(''));
          currentLine = [];
        }
        // Long silence (>=1s) adds blank line for paragraph break
        if (seg.dur >= 1.0) lines.push('');
      } else {
        const i = seg.idx;
        if (!selected.has(i)) {
          currentLine.push(words[i].text);
        }
      }
    });
    if (currentLine.length > 0) lines.push(currentLine.join(''));

    // Collapse multiple blank lines into one
    const md = lines.reduce((acc, line) => {
      if (line === '' && acc.endsWith('\\n\\n')) return acc;
      return acc + line + '\\n';
    }, '').trim();

    // Download as .md file
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'script.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  document.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') player.currentTime = Math.max(0, player.currentTime - (e.shiftKey ? 5 : 1));
    else if (e.code === 'ArrowRight') player.currentTime = player.currentTime + (e.shiftKey ? 5 : 1);
  });

  render();
</script>
</body>
</html>`;
}

module.exports = buildReviewHtml;
module.exports.parseAutoSelected = parseAutoSelected;

// ── CLI 入口（保留原行為：吃 argv → 寫 review.html + symlink video.mp4）──
if (require.main === module) {
  const subtitlesFile = process.argv[2] || 'subtitles_words.json';
  const autoSelectedFile = process.argv[3] || 'auto_selected.json';
  const videoFile = process.argv[4] || 'video.mp4';

  // 创建视频文件的符号链接到当前目录（避免复制大文件）
  const videoBaseName = 'video.mp4';
  if (videoFile !== videoBaseName && fs.existsSync(videoFile)) {
    const absVideoPath = path.resolve(videoFile);
    if (fs.existsSync(videoBaseName)) fs.unlinkSync(videoBaseName);
    fs.symlinkSync(absVideoPath, videoBaseName);
    console.log('📁 已链接视频到当前目录:', videoBaseName, '→', absVideoPath);
  }

  if (!fs.existsSync(subtitlesFile)) {
    console.error('❌ 找不到字幕文件:', subtitlesFile);
    process.exit(1);
  }

  const words = JSON.parse(fs.readFileSync(subtitlesFile, 'utf8'));
  let autoSelected = [];
  let autoReasons = {};
  if (fs.existsSync(autoSelectedFile)) {
    const raw = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
    const parsed = parseAutoSelected(raw);
    autoSelected = parsed.autoSelected;
    autoReasons = parsed.autoReasons;
    console.log('AI 预选:', autoSelected.length, '个元素');
    const reasonCount = Object.keys(autoReasons).length;
    if (reasonCount > 0) console.log('帶理由:', reasonCount, '個 idx');
  }

  const html = buildReviewHtml(words, autoSelected, autoReasons, {
    videoSrc: videoBaseName,
    cutApiPath: '/api/cut',
    encodersApiPath: '/api/encoders',
    diffReportApiPath: '/api/diff-report',
  });
  fs.writeFileSync('review.html', html);
  console.log('✅ 已生成 review.html');
}
