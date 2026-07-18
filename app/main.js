// Electron 殼：啟動 training_server.js（port 8900）並開視窗載入。
// 已在跑的 server（例如 .bat 開的）直接沿用，不重複啟動、關窗也不誤殺。
const { app, BrowserWindow, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 8900;
const URL = `http://127.0.0.1:${PORT}/`;
// 打包後 pipeline 在 resources/pipeline（唯讀）；開發模式直接用 repo 裡的 剪口播/
const SCRIPTS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'pipeline', 'scripts')
  : path.join(__dirname, '..', '剪口播', 'scripts');
const SERVER_JS = path.join(SCRIPTS_DIR, 'training_server.js');

let serverProc = null; // 只有自己 spawn 的才需要收拾

function ping(cb) {
  const req = http.get(URL, { timeout: 1500 }, (res) => { res.resume(); cb(true); });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

function startServer() {
  // 打包後 resources 唯讀：工作目錄與 .env 都改到 userData（開發模式維持 scripts/ 原地）
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  let cwd = SCRIPTS_DIR;
  if (app.isPackaged) {
    const dataDir = app.getPath('userData');
    try { require('fs').mkdirSync(path.join(dataDir, 'cut_work'), { recursive: true }); } catch (_) {}
    env.VIDEOCUT_ENV_FILE = path.join(dataDir, '.env');
    cwd = dataDir;
  }
  // ELECTRON_RUN_AS_NODE：用 Electron 自帶的 Node 跑 server，打包後不依賴系統 node
  serverProc = spawn(process.execPath, [SERVER_JS, String(PORT)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  serverProc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  serverProc.on('exit', (code) => {
    const unexpected = serverProc && !app.isQuitting;
    serverProc = null;
    if (unexpected && code !== 0) {
      dialog.showErrorBox('剪輯服務中斷', `training_server.js 意外結束（code ${code}），請重開應用程式。`);
      app.quit();
    }
  });
}

function killServer() {
  if (!serverProc) return;
  const pid = serverProc.pid;
  serverProc = null;
  if (process.platform === 'win32') {
    // Windows 要殺整棵行程樹，否則 ffmpeg/python 子行程會變孤兒
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  }
}

function waitReady(deadline, cb) {
  ping((ok) => {
    if (ok) return cb(true);
    if (Date.now() > deadline) return cb(false);
    setTimeout(() => waitReady(deadline, cb), 300);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    autoHideMenuBar: true,
    title: '多米自動剪輯',
    icon: path.join(__dirname, 'build', 'icon.png'), // Windows/Linux 視窗與工作列圖示（mac 忽略，用 icns）
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('did-finish-load', () => console.log('[app] window loaded:', URL));
  win.loadURL(URL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    ping((alreadyRunning) => {
      if (!alreadyRunning) startServer();
      waitReady(Date.now() + 20000, (ok) => {
        if (!ok) {
          dialog.showErrorBox('啟動失敗', '20 秒內連不上 127.0.0.1:8900，請確認 training_server.js 能單獨啟動。');
          app.quit();
          return;
        }
        createWindow();
      });
    });
  });

  app.on('activate', () => { // macOS dock 點擊重開窗
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { app.isQuitting = true; killServer(); });
}
