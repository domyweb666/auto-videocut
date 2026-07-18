/**
 * llm_call.js — AI 呼叫統一閘道（三模式）
 *
 * 所有腳本原本各自 execSync(claudeCmd + ' -p -' + modelFlag, opts) 呼叫 claude CLI；
 * 本模組提供簽名相容的 llmExec(modelFlag, opts)，依 scripts/.env 的 LLM_MODE 分派：
 *
 *   claude_code（預設）→ 本機 claude CLI，吃 Claude 訂閱額度，行為與舊版逐位元相同
 *   codex_cli          → 本機 codex exec，吃 ChatGPT 訂閱額度
 *   api                → 自填端點（anthropic / openai 協定），API 計費
 *
 * 設定鍵（scripts/.env，環境變數同名可覆寫）：
 *   LLM_MODE=claude_code|codex_cli|api
 *   LLM_API_PROTOCOL=anthropic|openai
 *   LLM_API_BASE_URL=（anthropic 預設 https://api.anthropic.com/v1；openai 必填）
 *   LLM_API_KEY=
 *   LLM_API_MODEL=（api 模式必填，例 claude-sonnet-5 / deepseek-chat）
 *
 * 踩坑對照（抄自 E:\模組化\cli permission 的實測教訓）：
 * - prompt 一律走 stdin：Windows 上 claude/codex 是 .cmd 批次包，
 *   Node 修補 CVE-2024-27980 後含換行的命令列參數直接被拒。
 * - .cmd 需要 shell:true 才 spawn 得起來；命令字串全為寫死常量，無注入面。
 * - api 模式的 key 走子行程 stdin 傳遞，不進命令列（行程列表看得到命令列）。
 * - codex 撞額度／失敗訊息統一拋 Error，訊息含 usage limit 字樣時提示等額度重置。
 */
'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');
const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';
const codexCmd = isWindows ? 'codex.cmd' : 'codex';

// ── .env 讀寫（保留註解與未知行）──
function parseEnvText(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function readEnvFile(envPath) {
  try { return parseEnvText(fs.readFileSync(envPath || ENV_PATH, 'utf8')); }
  catch (_) { return {}; }
}

// 合併寫回：已有的鍵原地替換，新鍵附加在檔尾；其他行（含註解）原樣保留
function mergeEnvText(text, patch) {
  const lines = String(text || '').split(/\r?\n/);
  const done = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(patch, m[1])) {
      done.add(m[1]);
      return `${m[1]}=${patch[m[1]]}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const k of Object.keys(patch)) {
    if (!done.has(k)) out.push(`${k}=${patch[k]}`);
  }
  return out.join('\n') + '\n';
}

function saveSettings(patch, envPath) {
  const p = envPath || ENV_PATH;
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) {}
  fs.writeFileSync(p, mergeEnvText(text, patch), 'utf8');
}

function loadSettings(envPath) {
  const f = readEnvFile(envPath);
  const g = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : (f[k] !== undefined && f[k] !== '' ? f[k] : d));
  return {
    mode: g('LLM_MODE', 'claude_code'),
    apiProtocol: g('LLM_API_PROTOCOL', 'anthropic'),
    apiBaseUrl: g('LLM_API_BASE_URL', ''),
    apiKey: g('LLM_API_KEY', ''),
    apiModel: g('LLM_API_MODEL', ''),
    byteplusKey: g('BYTEPLUS_API_KEY', ''),
  };
}

// ── codex exec 的 JSONL 輸出解析（純函式，可測）──
function parseCodexJsonl(raw) {
  const texts = [];
  let errMsg = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let ev; try { ev = JSON.parse(s); } catch (_) { continue; }
    if (ev.type === 'item.completed') {
      const item = ev.item || {};
      if (item.type === 'agent_message' && item.text) texts.push(String(item.text));
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      const e = ev.error;
      errMsg = (e && typeof e === 'object' ? e.message : e) || ev.message || errMsg;
    }
  }
  if (!texts.length && errMsg) throw new Error(codexErrorHint(String(errMsg)));
  return texts.join('\n\n');
}

function codexErrorHint(msg) {
  const low = msg.toLowerCase();
  if (low.includes('usage limit') || low.includes('rate limit') || low.includes('quota')) {
    return `codex 額度用盡或被限流，請稍後再試：${msg}`;
  }
  return msg;
}

// ── API 回應抽文字（純函式，可測）──
function extractApiText(protocol, resp) {
  if (protocol === 'openai') {
    const c = resp && resp.choices && resp.choices[0];
    const t = c && c.message && c.message.content;
    if (typeof t !== 'string') throw new Error('API 回應缺 choices[0].message.content');
    return t;
  }
  // anthropic
  const parts = resp && Array.isArray(resp.content) ? resp.content : null;
  if (!parts) throw new Error('API 回應缺 content 陣列');
  return parts.map((p) => (p && p.type === 'text' ? p.text : '')).join('');
}

function buildApiRequest(prompt, s) {
  if (s.apiProtocol === 'openai') {
    const base = (s.apiBaseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('api 模式（openai 協定）需要 LLM_API_BASE_URL');
    return {
      url: base + '/chat/completions',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.apiKey },
      body: { model: s.apiModel, messages: [{ role: 'user', content: prompt }] },
    };
  }
  const base = (s.apiBaseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  return {
    url: base + '/messages',
    headers: { 'content-type': 'application/json', 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' },
    body: { model: s.apiModel, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] },
  };
}

// 子行程做同步 HTTP：請求資料（含 key）走 stdin，不進命令列
const HTTP_HELPER = `
let raw='';process.stdin.setEncoding('utf8');
process.stdin.on('data',(c)=>raw+=c);
process.stdin.on('end',async()=>{
  try{
    const req=JSON.parse(raw);
    const res=await fetch(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(req.body)});
    const text=await res.text();
    if(!res.ok){process.stderr.write('HTTP '+res.status+': '+text.slice(0,2000));process.exit(1);}
    process.stdout.write(text);
  }catch(e){process.stderr.write(String(e&&e.message||e));process.exit(1);}
});`;

function apiCall(prompt, s, opts) {
  if (!s.apiKey) throw new Error('api 模式需要 LLM_API_KEY（到設定頁填入）');
  if (!s.apiModel) throw new Error('api 模式需要 LLM_API_MODEL（到設定頁填入）');
  const req = buildApiRequest(prompt, s);
  const raw = execFileSync(process.execPath, ['-e', HTTP_HELPER], {
    input: JSON.stringify(req),
    encoding: 'utf8',
    timeout: opts.timeout || 300000,
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
    windowsHide: true,
  });
  return extractApiText(s.apiProtocol, JSON.parse(raw));
}

/**
 * execSync(claudeCmd + ' -p -' + modelFlag, opts) 的簽名相容替身。
 * opts 與原本傳給 execSync 的完全相同（input=prompt、encoding:'utf8'、timeout、maxBuffer…）。
 * 回傳值同樣是 stdout 字串；呼叫端照舊自行 .trim() / parseJSON。
 */
function llmExec(modelFlag, opts) {
  const s = loadSettings();
  if (s.mode === 'codex_cli') {
    // modelFlag 是 claude 的模型檔位，codex 無對應物，忽略
    const cmd = codexCmd + ' -s read-only exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules -';
    const raw = execSync(cmd, Object.assign({}, opts, {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: '', CODEX_API_KEY: '' }), // 防止偷切 API 計費
    }));
    return parseCodexJsonl(raw);
  }
  if (s.mode === 'api') {
    return apiCall(String(opts.input || ''), s, opts);
  }
  // claude_code（預設）：與舊版完全相同的一行
  return execSync(claudeCmd + ' -p -' + (modelFlag || ''), opts);
}

// 設定頁「測試連線」用：30 秒內回不來就當失敗
function testConnection() {
  const reply = llmExec('', {
    input: '請只回覆兩個字：成功',
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });
  return String(reply || '').trim() || '（連上了，但沒回內容）';
}

module.exports = {
  llmExec,
  loadSettings,
  saveSettings,
  testConnection,
  // 以下輸出給單元測試
  parseEnvText,
  mergeEnvText,
  parseCodexJsonl,
  extractApiText,
  buildApiRequest,
};
