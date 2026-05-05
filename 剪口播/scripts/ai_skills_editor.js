#!/usr/bin/env node
/**
 * ai_skills_editor.js — 精準手術編輯器（Surgeon）
 *
 * 職責：吃策略師給的 tasks.json，精準修改 editing_skills.md。
 * 兩種模式：
 *   Mode A（程式化）— 直接做字串 modify/add/remove，最精準、零 token
 *   Mode B（模型）— 任何 task 在 Mode A 失敗時，把整檔 + 任務交給 Claude 兜底
 *
 * 用法：
 *   node ai_skills_editor.js \
 *     --skills <editing_skills.md> \
 *     --tasks  <tasks_iterN.json> \
 *     [--prompt <editor_prompt.md>] \
 *     [--model opus|sonnet] (default: sonnet, 只在 Mode B 用) \
 *     [--mode-b-only]       (除錯用：跳過 Mode A 直接走模型) \
 *     [--dry-run]           (不寫檔，只印出結果)
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const ROOT_DIR   = path.join(SCRIPT_DIR, '..');
const DEFAULT_PROMPT_PATH = path.join(ROOT_DIR, 'prompts', 'editor_prompt.md');

// ── 解析參數 ──
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--mode-b-only' || a === '--dry-run') { args[a.slice(2)] = true; continue; }
  if (a.startsWith('--')) {
    const key = a.slice(2);
    args[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
      ? process.argv[++i] : true;
  }
}

const SKILLS_PATH = args.skills || path.join(ROOT_DIR, 'editing_skills.md');
const TASKS_PATH  = args.tasks  || (() => { console.error('--tasks 必填'); process.exit(1); })();
const PROMPT_PATH = args.prompt || DEFAULT_PROMPT_PATH;
const MODEL       = args.model  || 'sonnet';
const MODE_B_ONLY = !!args['mode-b-only'];
const DRY_RUN     = !!args['dry-run'];

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

function log(msg) { console.log(`[editor] ${msg}`); }

// ── 文字 normalize：忽略尾隨空白差異，統一換行 ──
function normalize(s) {
  return s.replace(/\r\n/g, '\n');
}

// ── Mode A：程式化套用任務 ──
// 回傳 { text, applied: [taskIds], unmatched: [taskIds] }
function applyTasksDeterministic(skills, tasks) {
  let text = normalize(skills);
  const applied = [];
  const unmatched = [];

  for (const task of tasks) {
    const tid = task.id || '<no-id>';
    const action = task.action;

    if (action === 'preserve') {
      // 不做事，但記為 applied（提供給策略師驗證紅線確實有被尊重）
      applied.push(tid);
      continue;
    }

    if (action === 'modify_section') {
      const find = normalize(task.find_text || '');
      const replace = normalize(task.replace_text || '');
      if (!find) { unmatched.push(tid); continue; }
      if (!text.includes(find)) { unmatched.push(tid); continue; }
      // 多次出現時警告但仍替換第一次
      const occurrences = text.split(find).length - 1;
      if (occurrences > 1) {
        log(`  ⚠️ ${tid} find_text 在檔案中出現 ${occurrences} 次，只替換第一次`);
      }
      text = text.replace(find, replace);
      applied.push(tid);
      continue;
    }

    if (action === 'add_rule') {
      const anchor = normalize(task.insert_after || '');
      const newText = normalize(task.new_text || '');
      if (!anchor || !newText) { unmatched.push(tid); continue; }
      if (!text.includes(anchor)) { unmatched.push(tid); continue; }
      // 找到 anchor 行，在它的下一行（同一段）插入 newText
      const idx = text.indexOf(anchor);
      const eolIdx = text.indexOf('\n', idx + anchor.length);
      const insertAt = eolIdx === -1 ? text.length : eolIdx + 1;
      const block = newText.endsWith('\n') ? newText : newText + '\n';
      text = text.slice(0, insertAt) + block + text.slice(insertAt);
      applied.push(tid);
      continue;
    }

    if (action === 'remove_rule') {
      const find = normalize(task.find_text || '');
      if (!find) { unmatched.push(tid); continue; }
      if (!text.includes(find)) { unmatched.push(tid); continue; }
      text = text.replace(find, '');
      // 清理連續多個空行（最多保留 2 個換行）
      text = text.replace(/\n{3,}/g, '\n\n');
      applied.push(tid);
      continue;
    }

    if (action === 'replace_section') {
      // 整段替換：用 target_section（含 ## 標題）作 anchor，到下一個同級標題前
      const heading = normalize(task.target_section || '');
      const newText = normalize(task.replace_text || task.new_text || '');
      if (!heading || !newText) { unmatched.push(tid); continue; }
      const startIdx = text.indexOf(heading);
      if (startIdx === -1) { unmatched.push(tid); continue; }
      const headingLevel = (heading.match(/^#+/) || [''])[0].length;
      // 找下一個同級或更高層級的 heading
      const restAfter = text.slice(startIdx + heading.length);
      const reHeading = new RegExp('^#{1,' + headingLevel + '} ', 'm');
      const m = restAfter.match(reHeading);
      const endIdx = m ? startIdx + heading.length + m.index : text.length;
      text = text.slice(0, startIdx) + (newText.endsWith('\n') ? newText : newText + '\n') + text.slice(endIdx);
      applied.push(tid);
      continue;
    }

    log(`  ⚠️ ${tid} 未知 action: ${action}`);
    unmatched.push(tid);
  }

  return { text, applied, unmatched };
}

// ── modify_config：直接改 JSON config 檔的數值 ──
// task schema: { id, action:'modify_config', file:'training_config.json', json_path:'silence.threshold', old_value, new_value }
// 回傳 { applied: [taskIds], failed: [taskIds] }
function applyConfigTasks(tasks) {
  const applied = [];
  const failed  = [];

  // 按 file 分組，讀一次寫一次
  const byFile = {};
  for (const task of tasks) {
    if (task.action !== 'modify_config') continue;
    const file = task.file || 'training_config.json';
    if (!byFile[file]) byFile[file] = [];
    byFile[file].push(task);
  }

  const ROOT_DIR = path.join(SCRIPT_DIR, '..');
  for (const [filename, fileTasks] of Object.entries(byFile)) {
    const filePath = path.resolve(ROOT_DIR, filename);
    let obj;
    try {
      obj = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    } catch (e) {
      log(`  ❌ 讀取 ${filename} 失敗: ${e.message}`);
      fileTasks.forEach(t => failed.push(t.id));
      continue;
    }

    for (const task of fileTasks) {
      const tid = task.id || '<no-id>';
      const jp  = task.json_path;   // e.g. 'silence.threshold'
      if (!jp) { failed.push(tid); continue; }

      // 設定深路徑值
      const keys = jp.split('.');
      let cur = obj;
      for (let ki = 0; ki < keys.length - 1; ki++) {
        if (typeof cur[keys[ki]] !== 'object' || cur[keys[ki]] === null) {
          cur[keys[ki]] = {};
        }
        cur = cur[keys[ki]];
      }
      const lastKey = keys[keys.length - 1];
      const oldVal = cur[lastKey];

      // 驗證 old_value（若提供）
      if (task.old_value !== undefined && task.old_value !== null) {
        if (String(oldVal) !== String(task.old_value)) {
          log(`  ⚠️ ${tid} old_value 不符（期望 ${task.old_value}，實際 ${oldVal}），仍繼續`);
        }
      }

      cur[lastKey] = task.new_value;
      log(`  ✅ ${tid} ${filename}[${jp}]: ${oldVal} → ${task.new_value}`);
      applied.push(tid);
    }

    try {
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      log(`  ❌ 寫入 ${filename} 失敗: ${e.message}`);
      fileTasks.forEach(t => {
        if (!applied.includes(t.id)) failed.push(t.id);
      });
    }
  }

  return { applied, failed };
}

// ── Mode B：呼叫 Claude 兜底 ──
function applyTasksWithClaude(skills, tasksObj) {
  const tpl = fs.readFileSync(PROMPT_PATH, 'utf8');
  const tasks = tasksObj.tasks || [];
  const doNotTouch = tasksObj.doNotTouch || [];

  const prompt = tpl
    .replace('{{TASKS_JSON}}',     JSON.stringify(tasks, null, 2))
    .replace('{{DO_NOT_TOUCH}}',   doNotTouch.length ? doNotTouch.map(x => `- ${x}`).join('\n') : '（無）')
    .replace('{{SKILLS_CONTENT}}', skills);

  log(`Mode B: 呼叫 Claude（model=${MODEL}）兜底...`);
  const result = execSync(`${claudeCmd} -p - --model ${MODEL}`, {
    input: prompt,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });
  let content = result.trim();
  if (content.startsWith('```markdown')) content = content.slice('```markdown'.length).trim();
  else if (content.startsWith('```md'))   content = content.slice('```md'.length).trim();
  else if (content.startsWith('```'))     content = content.slice(3).trim();
  if (content.endsWith('```')) content = content.slice(0, -3).trim();
  return content;
}

// ── 主流程 ──
function main() {
  if (!fs.existsSync(SKILLS_PATH)) { console.error(`找不到 skills: ${SKILLS_PATH}`); process.exit(1); }
  if (!fs.existsSync(TASKS_PATH))  { console.error(`找不到 tasks: ${TASKS_PATH}`); process.exit(1); }

  const skills   = fs.readFileSync(SKILLS_PATH, 'utf8');
  const tasksObj = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8'));
  const tasks    = Array.isArray(tasksObj.tasks) ? tasksObj.tasks : [];

  if (tasks.length === 0) {
    log('⚠️ tasks 清單為空，不做任何事');
    process.exit(0);
  }

  log(`收到 ${tasks.length} 個任務：${tasks.map(t => `${t.id}=${t.action}`).join(', ')}`);

  // ── 先分離 modify_config 任務（直接改 JSON，不走 skills 文字流程）──
  const configTasks    = tasks.filter(t => t.action === 'modify_config');
  const skillsTasks    = tasks.filter(t => t.action !== 'modify_config');
  let configApplied = [], configFailed = [];
  if (configTasks.length > 0) {
    const cr = applyConfigTasks(configTasks);
    configApplied = cr.applied;
    configFailed  = cr.failed;
    log(`Config 任務：套用 ${configApplied.length}，失敗 ${configFailed.length}`);
  }

  // 若只有 config 任務，直接結束
  if (skillsTasks.length === 0) {
    log(`✅ 全部為 modify_config 任務，skills 檔不動`);
    const reportPath = TASKS_PATH.replace(/\.json$/, '.applied.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      mode: 'config-only',
      appliedTaskIds:   configApplied,
      unmatchedTaskIds: configFailed,
      timestamp:        new Date().toISOString(),
    }, null, 2));
    process.exit(configFailed.length > 0 ? 3 : 0);
  }

  let finalText, applied, unmatched, mode;

  if (MODE_B_ONLY) {
    log('--mode-b-only：直接走 Claude');
    finalText = applyTasksWithClaude(skills, tasksObj);
    applied = tasks.map(t => t.id);
    unmatched = [];
    mode = 'B';
  } else {
    const r = applyTasksDeterministic(skills, tasks);
    if (r.unmatched.length === 0) {
      log(`Mode A 完成：套用 ${r.applied.length} 個任務`);
      finalText = r.text;
      applied   = r.applied;
      unmatched = [];
      mode = 'A';
    } else {
      log(`Mode A 部分失敗：${r.unmatched.length}/${tasks.length} 個任務找不到 anchor → fallback 到 Mode B`);
      try {
        finalText = applyTasksWithClaude(skills, tasksObj);
        applied   = tasks.map(t => t.id);
        unmatched = [];
        mode = 'B';
      } catch (e) {
        log(`❌ Mode B 也失敗：${e.message}`);
        log(`   保留 Mode A 部分結果（已套用 ${r.applied.length} 個）`);
        finalText = r.text;
        applied   = r.applied;
        unmatched = r.unmatched;
        mode = 'A-partial';
      }
    }
  }

  if (DRY_RUN) {
    log('--dry-run：不寫檔');
    log(`最終長度：${finalText.length} 字元`);
    log(`套用：${applied.join(', ')}`);
    if (unmatched.length) log(`未套用：${unmatched.join(', ')}`);
    process.exit(0);
  }

  // 寫回（用原本副檔名與 BOM 設定保持原樣）
  fs.writeFileSync(SKILLS_PATH, finalText);
  log(`✅ ${SKILLS_PATH} 已更新（mode=${mode}, 套用 ${applied.length}/${tasks.length}）`);

  // 把套用紀錄存到 tasks.json 旁邊（給 autoresearch / 策略師下輪參考）
  const reportPath = TASKS_PATH.replace(/\.json$/, '.applied.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    mode,
    appliedTaskIds:   [...applied, ...configApplied],
    unmatchedTaskIds: [...unmatched, ...configFailed],
    timestamp:        new Date().toISOString(),
  }, null, 2));
  log(`📝 套用報告：${reportPath}`);

  // 用 exit code 暗示 unmatched（autoresearch 可選擇 revert）
  process.exit(unmatched.length > 0 ? 3 : 0);
}

main();
