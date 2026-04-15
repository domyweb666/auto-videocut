#!/usr/bin/env node
/**
 * 生成审核网页（视频版本）
 *
 * 用法: node generate_review.js <subtitles_words.json> [auto_selected.json] [video_file]
 * 输出: review.html, video.mp4（符号链接到当前目录）
 */

const fs = require('fs');
const path = require('path');

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
let autoReasons = {}; // idx → reason string

if (fs.existsSync(autoSelectedFile)) {
  const raw = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
  if (Array.isArray(raw)) {
    // 簡單格式: [72, 85, 120]
    autoSelected = raw;
  } else if (raw.indices) {
    // 帶理由格式: { indices: [...], reasons: { "72": "...", "200-203": "..." } }
    autoSelected = raw.indices;
    // 展開範圍 key 為個別 idx
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
  console.log('AI 预选:', autoSelected.length, '个元素');
  const reasonCount = Object.keys(autoReasons).length;
  if (reasonCount > 0) console.log('帶理由:', reasonCount, '個 idx');
}

const html = `<!DOCTYPE html>
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
  </style>
</head>
<body>

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
  <button onclick="executeCut()" class="primary">🎬 執行剪輯</button>
  <button onclick="exportMarkdown()">📝 匯出 MD</button>
  <button class="danger" onclick="clearAll()">清空選擇</button>
  <button onclick="copyDeleteList()">📋 複製刪除清單</button>
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
    <video id="player" src="${videoBaseName}" preload="auto"></video>
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

  async function executeCut() {
    const videoDuration = player.duration;
    const estimatedTime = Math.max(5, Math.ceil(videoDuration / 4));
    const estMin = Math.floor(estimatedTime / 60);
    const estSec = estimatedTime % 60;
    const estText = estMin > 0 ? estMin + '分' + estSec + '秒' : estSec + '秒';

    if (!confirm('確認執行剪輯？\\n\\n📹 視頻時長: ' + (videoDuration/60).toFixed(1) + ' 分鐘\\n⏱️ 預計耗時: ' + estText + '\\n\\n點擊確定開始')) return;

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
    fetch('/api/diff-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(diffReport) }).catch(() => {});

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
      const res = await fetch('/api/cut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(segments)
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

fs.writeFileSync('review.html', html);
console.log('✅ 已生成 review.html');
