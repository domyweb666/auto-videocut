#!/usr/bin/env node
/**
 * Skills Autoresearch — 全自動雙策略迭代優化，直到 F1 ≥ 目標
 *
 * 雙策略：
 *   skills 策略 → 改寫 editing_skills.md
 *   prompt 策略 → 改寫 prompts/ai_cut_prompt.md
 *
 * 自動切換：單一策略連續 N 輪無進步 → 切到另一個策略
 *           兩策略總計連續 M 輪無進步 → 結束
 *
 * 用法: node ai_skills_autoresearch.js [選項]
 *   --max-iter <n>         最大迭代輪數（預設 30）
 *   --target <f1>          目標 F1（0-1，預設 0.90）
 *   --strategy <s>         初始策略 skills|prompt|auto（預設 auto，從 skills 開始）
 *   --max-stuck <n>        單一策略連續 n 輪無進步後切換（預設 3）
 *   --max-total-stuck <n>  總計連續 n 輪無進步即結束（預設 5）
 *   --sample <n>           每輪快速評估使用幾支影片（預設 8）
 *   --concurrency <n>      並行數（預設 3）
 *   --no-full-eval         達標後不執行完整評估
 */

const fs   = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const SCRIPT_DIR    = __dirname;
const ROOT_DIR      = path.join(SCRIPT_DIR, '..');
const TRAINING_DIR  = path.join(SCRIPT_DIR, 'training_output');
const SKILLS_PATH        = path.join(ROOT_DIR, 'editing_skills.md');
const PROMPT_PATH        = path.join(ROOT_DIR, 'prompts', 'ai_cut_prompt.md');
const PAIRS_PROMPT_PATH  = path.join(ROOT_DIR, 'prompts', 'ai_cut_pairs_prompt.md');
const BACKUPS_DIR   = path.join(ROOT_DIR, 'backups');
const STATUS_PATH   = path.join(TRAINING_DIR, 'skills_autoresearch_status.json');
const REPORT_PATH   = path.join(TRAINING_DIR, 'skills_autoresearch_report.json');

if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
if (!fs.existsSync(TRAINING_DIR)) fs.mkdirSync(TRAINING_DIR, { recursive: true });

// ── 解析參數 ──
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--no-full-eval') { args['no-full-eval'] = true; continue; }
  if (a.startsWith('--')) {
    const key = a.slice(2);
    args[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
      ? process.argv[++i] : true;
  }
}

const MAX_ITER        = parseInt(args['max-iter'])        || 30;
const TARGET_F1       = parseFloat(args['target'])        || 0.90;
const INIT_STRATEGY   = (args['strategy'] === 'prompt') ? 'prompt' : 'skills'; // 'auto' 視為 skills 起手
const MAX_STUCK       = parseInt(args['max-stuck'])       || 3;
const MAX_TOTAL_STUCK = parseInt(args['max-total-stuck']) || 5;
const SAMPLE          = parseInt(args['sample'])          || 8;
const CONCUR          = parseInt(args['concurrency'])     || 3;
const FULL_EVAL       = !args['no-full-eval'];
// 小樣本達標後「跑完整評估驗證」的最多次數（避免對樣本 overfit 無限迴圈）
const MAX_OVERFIT     = parseInt(args['max-overfit']) || 5;
// 評估與執行階段都用 Sonnet（訓練評估只是比較 skills/prompt 好壞，無需最強模型，省 token）
// 用 alias（'sonnet' / 'opus'）避免寫死版本號失效；要改回 opus 只要加 --eval-model opus
const EVAL_MODEL      = args['eval-model']  || 'sonnet';
const EXEC_MODEL      = args['exec-model']  || 'sonnet';
// Phase 4：策略師 + 外科手術編輯器
//   --no-strategist        關閉策略師，回到舊的整檔重寫模式（debug 用）
//   --strategist-model M   策略師模型（預設 opus；若 token 緊可降 sonnet）
//   --editor-model M       編輯器 Mode B fallback 模型（預設 opus）
const USE_PAIR_MODE     = !!args['use-pair-mode'];   // 新管線：規則前置 + 候選對 AI 判斷
const USE_STRATEGIST    = !args['no-strategist'];
const STRATEGIST_MODEL  = args['strategist-model'] || 'opus';
const EDITOR_MODEL      = args['editor-model']     || 'opus';
const STRATEGIST_PATH   = path.join(SCRIPT_DIR, 'ai_strategist.js');
const EDITOR_PATH       = path.join(SCRIPT_DIR, 'ai_skills_editor.js');
const STRATEGIST_STATE  = path.join(TRAINING_DIR, 'strategist_state.json');
// 接續上次未完成的優化（讀 STATUS_PATH 還原 state，從 iter+1 繼續）
const RESUME          = !!args['resume'];
// 額度等候參數
const PROBE_INTERVAL_MS = parseInt(args['probe-interval'])
                            ? parseInt(args['probe-interval']) * 60 * 1000
                            : 15 * 60 * 1000;   // 預設 15 分鐘探測一次
const MAX_WAIT_MS       = parseInt(args['max-wait'])
                            ? parseInt(args['max-wait']) * 60 * 60 * 1000
                            : 6  * 60 * 60 * 1000;  // 預設等最多 6 小時

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── Pipeline 版本（改變評估管線時遞增；不同版本的 F1 不可直接比較）──
const PIPELINE_VERSION = 2;  // v2 = 兩階段（ai_polish + ai_cut），v1 = 舊版 ai_sentencize

// ── 狀態（會被持續寫到 STATUS_PATH 供 UI 讀取） ──
const state = {
  status:           'starting',  // 'starting' | 'running' | 'paused-quota' | 'finished' | 'failed'
  pipelineVersion:  PIPELINE_VERSION,
  startedAt:        new Date().toISOString(),
  finishedAt:       null,
  pausedAt:         null,
  resumed:          false,
  currentStrategy:  INIT_STRATEGY,
  iter:             0,
  maxIter:          MAX_ITER,
  targetF1:         TARGET_F1,
  startF1:          null,
  bestF1:           null,
  currentF1:        null,
  stuckOnSkills:    0,
  stuckOnPrompt:    0,
  totalStuck:       0,
  quotaPauseCount:  0,
  fullBestF1:       null,   // 目前為止完整評估（35 支）最佳 F1
  lastFullF1:       null,   // 上一次觸發完整評估的結果
  fullEvalCount:    0,      // 累計完整評估次數
  overfitChecks:    0,      // 連續「小量達標但完整未達標」次數
  reachedTarget:    false,  // 完整評估也達到 TARGET_F1 才算真正達標
  history:          [],   // [{iter, strategy, file, prevF1, newF1, delta, action}]
  recentLogs:       [],   // 最後 N 條 log（給 UI 顯示）
  message:          '',
};

const MAX_LOG_BUFFER = 100;
function persistStatus() {
  try {
    fs.writeFileSync(STATUS_PATH, JSON.stringify(state, null, 2));
  } catch (e) { /* swallow */ }
}

function log(msg) {
  console.log(msg);
  state.recentLogs.push({ t: new Date().toISOString(), msg });
  if (state.recentLogs.length > MAX_LOG_BUFFER) {
    state.recentLogs.splice(0, state.recentLogs.length - MAX_LOG_BUFFER);
  }
  state.message = msg;
  persistStatus();
}

// ── 讀取 ai_evaluation_report.json ──
function readEvalReport() {
  const p = path.join(TRAINING_DIR, 'ai_evaluation_report.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// ── 從各影片收集 FP/FN 明細（優先讀 combined_diff_report，fallback 到 ai_diff_report）──
function collectFPFN() {
  const fnCounts = {};
  const fpCounts = {};
  const worstVideos = [];

  if (!fs.existsSync(TRAINING_DIR)) return { fnCounts, fpCounts, worstVideos };

  for (const dir of fs.readdirSync(TRAINING_DIR)) {
    const analysisDir = path.join(TRAINING_DIR, dir, '2_分析');
    const combinedPath = path.join(analysisDir, 'combined_diff_report.json');
    const aiPath       = path.join(analysisDir, 'ai_diff_report.json');
    const diffPath = fs.existsSync(combinedPath) ? combinedPath : aiPath;
    if (!fs.existsSync(diffPath)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
      const af = r.accuracy_filtered || r.accuracy || {};
      if (af.f1 !== undefined) {
        worstVideos.push({ name: dir, f1: af.f1, fn: af.fn || 0, fp: af.fp || 0 });
      }
      for (const fn of (r.falseNegatives || [])) {
        if (fn.isGap || !fn.text || fn.text.length < 2) continue;
        fnCounts[fn.text] = (fnCounts[fn.text] || 0) + 1;
      }
      for (const fp of (r.falsePositives || [])) {
        if (fp.isGap || !fp.text || fp.text.length < 2) continue;
        fpCounts[fp.text] = (fpCounts[fp.text] || 0) + 1;
      }
    } catch (e) {}
  }

  worstVideos.sort((a, b) => a.f1 - b.f1);
  return { fnCounts, fpCounts, worstVideos };
}

// ── 執行快速評估，回傳 F1 ──
function runQuickEval(forceFlag = true) {
  return new Promise((resolve) => {
    log(`   🧪 執行快速評估（樣本 ${SAMPLE} 支，並行 ${CONCUR}，評估模型: ${EVAL_MODEL || 'default'}）...`);
    const evalArgs = [
      path.join(SCRIPT_DIR, 'ai_evaluate_training.js'),
      '--sample', String(SAMPLE),
      '--concurrency', String(CONCUR),
    ];
    if (EVAL_MODEL) evalArgs.push('--model', EVAL_MODEL);
    if (forceFlag) evalArgs.push('--force');
    if (USE_PAIR_MODE) evalArgs.push('--use-pair-mode');

    const child = spawn('node', evalArgs, {
      cwd: SCRIPT_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', d => {
      const lines = d.toString().split('\n').filter(l => l.trim());
      for (const line of lines) log(`      ${line}`);
    });
    child.stderr.on('data', d => {
      const lines = d.toString().split('\n').filter(l => l.trim());
      for (const line of lines) log(`      ${line}`);
    });
    child.on('close', code => {
      if (code !== 0) { resolve(null); return; }
      const report = readEvalReport();
      resolve(report ? (report.overallCombined || report.overall).f1 : null);
    });
  });
}

// ── 執行完整評估（全部影片） ──
function runFullEval() {
  return new Promise((resolve) => {
    log(`\n🔬 執行完整評估（所有訓練影片，評估模型: ${EVAL_MODEL || 'default'}）...`);
    const fullArgs = [
      path.join(SCRIPT_DIR, 'ai_evaluate_training.js'),
      '--concurrency', String(CONCUR),
      '--force',
    ];
    if (EVAL_MODEL) fullArgs.push('--model', EVAL_MODEL);
    if (USE_PAIR_MODE) fullArgs.push('--use-pair-mode');
    const child = spawn('node', fullArgs, {
      cwd: SCRIPT_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => {
      const lines = d.toString().split('\n').filter(l => l.trim());
      for (const line of lines) log(`   ${line}`);
    });
    child.stderr.on('data', d => {});
    child.on('close', code => {
      const report = readEvalReport();
      resolve(report);
    });
  });
}

// ── 額度錯誤偵測 ──
function isQuotaError(msg) {
  if (!msg) return false;
  const s = String(msg).toLowerCase();
  return /(rate.?limit|usage.?limit|credit.?balance|5.?hour.?limit|quota|too\s+many\s+requests|\b429\b|exceeded.*limit|limit.*reached|insufficient.*credit)/i.test(s);
}

// ── 探測額度：發小 prompt 給 EXEC_MODEL 看是否能回應 ──
function probeQuota() {
  try {
    const probeFlag = EXEC_MODEL ? ` --model ${EXEC_MODEL}` : '';
    execSync(claudeCmd + ' -p -' + probeFlag, {
      input: 'ok',
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });
    return { ok: true };
  } catch (err) {
    // claude CLI 部分錯誤訊息在 stdout
    const errMsg = ((err.stdout && err.stdout.toString()) || '') + ' '
                 + ((err.stderr && err.stderr.toString()) || '') + ' '
                 + (err.message || '');
    return { ok: false, error: errMsg, isQuota: isQuotaError(errMsg) };
  }
}

// ── 等待額度恢復：每 PROBE_INTERVAL_MS 探測一次，最多 MAX_WAIT_MS ──
async function waitForQuotaRecovery(reason) {
  log(`\n   ⏸  ${reason}，進入暫停模式（每 ${Math.round(PROBE_INTERVAL_MS/60000)} 分鐘探測，最多等 ${Math.round(MAX_WAIT_MS/3600000)} 小時）`);
  state.status = 'paused-quota';
  state.message = `額度不足暫停中（${reason}）`;
  state.pausedAt = new Date().toISOString();
  state.quotaPauseCount = (state.quotaPauseCount || 0) + 1;
  persistStatus();

  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    const waitedMin = Math.floor((Date.now() - start) / 60000);
    log(`   💤 已等候 ${waitedMin} 分鐘，${Math.round(PROBE_INTERVAL_MS/60000)} 分鐘後探測...`);
    await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS));
    log(`   🔍 探測額度...`);
    const probe = probeQuota();
    if (probe.ok) {
      log(`   ✅ 額度已恢復，繼續執行`);
      state.status = 'running';
      state.message = '額度已恢復';
      state.pausedAt = null;
      persistStatus();
      return true;
    }
    if (probe.isQuota) {
      log(`   ⏳ 仍受限，繼續等候`);
    } else {
      log(`   ⚠️  探測收到非額度錯誤: ${(probe.error || '').slice(0, 120)}`);
      // 視為仍未恢復，繼續等
    }
  }
  log(`   🛑 等候超過 ${Math.round(MAX_WAIT_MS/3600000)} 小時仍未恢復，放棄`);
  state.status = 'failed';
  state.message = `等候額度超過 ${Math.round(MAX_WAIT_MS/3600000)} 小時仍未恢復`;
  persistStatus();
  return false;
}

// ── 共用：呼叫 Claude CLI 改寫一段內容（執行階段，使用 EXEC_MODEL）──
// async：遇到額度錯誤會自動暫停 + 等候 + 重試
async function runClaude(prompt, label) {
  log(`   🤖 ${label} [模型: ${EXEC_MODEL || 'default'}]...`);
  while (true) {
    try {
      const execModelFlag = EXEC_MODEL ? ` --model ${EXEC_MODEL}` : '';
      const result = execSync(claudeCmd + ' -p -' + execModelFlag, {
        input: prompt,
        encoding: 'utf8',
        timeout: 600000, // 10 分鐘
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      });
      let content = result.trim();
      // 去除 Markdown code fence
      if (content.startsWith('```markdown')) content = content.slice('```markdown'.length).trim();
      else if (content.startsWith('```md')) content = content.slice('```md'.length).trim();
      else if (content.startsWith('```')) content = content.slice(3).trim();
      if (content.endsWith('```')) content = content.slice(0, -3).trim();
      return content;
    } catch (err) {
      // claude CLI 部分錯誤（含「模型不存在」）會印到 stdout，需一併檢查
      const errMsg = ((err.stdout && err.stdout.toString()) || '') + ' '
                   + ((err.stderr && err.stderr.toString()) || '') + ' '
                   + (err.message || '');
      if (isQuotaError(errMsg)) {
        log(`   ⚠️  Claude 呼叫疑似額度不足: ${errMsg.slice(0, 200)}`);
        const recovered = await waitForQuotaRecovery('runClaude 額度不足');
        if (recovered) continue;  // 重試
        return null;              // 等不到，放棄本輪
      }
      if (/may not exist|may not have access|invalid model|not a valid model/i.test(errMsg)) {
        log(`   🛑 執行模型「${EXEC_MODEL}」無效，停止 autoresearch（避免燒掉所有迭代）`);
        state.status = 'failed';
        state.message = `執行模型「${EXEC_MODEL}」無效`;
        state.finishedAt = new Date().toISOString();
        persistStatus();
        process.exit(1);
      }
      log(`   ❌ Claude 呼叫失敗: ${err.message}`);
      return null;
    }
  }
}

// ── 共用：產生錯誤分析摘要 ──
function buildErrorAnalysis(evalReport) {
  const { fnCounts, fpCounts, worstVideos } = collectFPFN();
  const overall = evalReport.overallCombined || evalReport.overall;
  const f1Pct  = (overall.f1 * 100).toFixed(1);
  const recPct = (overall.recall * 100).toFixed(1);
  const prePct = (overall.precision * 100).toFixed(1);

  const topFN = Object.entries(fnCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([t, c]) => `  「${t}」: ${c}次`).join('\n') || '  （無明顯文字模式）';

  const topFP = Object.entries(fpCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([t, c]) => `  「${t}」: ${c}次`).join('\n') || '  （誤刪很少）';

  const worstStr = worstVideos.slice(0, 3)
    .map(v => `  ${v.name}: F1=${(v.f1 * 100).toFixed(1)}% FN=${v.fn}`).join('\n') || '  （無資料）';

  return { f1Pct, recPct, prePct, topFN, topFP, worstStr, recall: overall.recall };
}

// ── 策略 1：改寫 editing_skills.md ──
async function improveSkills(currentSkills, evalReport, iterNum) {
  const { f1Pct, recPct, prePct, topFN, topFP, worstStr, recall } = buildErrorAnalysis(evalReport);

  let direction;
  if (recall < 0.5) {
    direction = `召回率僅 ${recPct}%，嚴重不足。需要大幅放寬刪除條件，去除所有「有疑慮就保留」的規則，改為「有疑慮就刪除」。重錄判斷要更寬鬆，語意模糊相似就刪。`;
  } else if (recall < 0.7) {
    direction = `召回率 ${recPct}%，仍不足。主要問題是重錄判斷太嚴格和系統性漏刪詞彙。需要擴大重錄的語意模糊範圍，並明確列出必刪詞彙模式。`;
  } else if (recall < 0.85) {
    direction = `召回率 ${recPct}%，接近目標。需要針對剩餘的漏刪模式做精細調整，特別是 FN 最多的詞彙。`;
  } else {
    direction = `召回率 ${recPct}%，已接近目標，需要在不降低精確率的前提下微調。`;
  }

  const prompt = `你是 AI 剪輯助理的 prompt 工程師。

## 任務
目前 editing_skills.md 讓 AI 剪輯的 F1 = ${f1Pct}%，精確率 ${prePct}%，召回率 ${recPct}%。
這是第 ${iterNum} 輪優化（策略：editing_skills.md）。

**方向：${direction}**

請改寫 editing_skills.md，讓 AI 更積極刪除，目標：召回率提升到 80%+ 同時精確率維持在 85%+。

## 目前 editing_skills.md 全文
${currentSkills}

## 目前錯誤分析

### 最常漏刪（FN）— 使用者刪了但 AI 沒刪（這些需要被刪）
${topFN}

### 最常誤刪（FP）— AI 刪了但使用者沒刪（這些需要被保留）
${topFP}

### 最差影片（FN 最多的）
${worstStr}

## 修改要求
1. **直接輸出完整的 Markdown 內容**，不加任何說明、不加 code fence
2. **核心原則改為積極刪除**：「遇到重複就刪，遇到語意相同就刪，不確定就參考 FN 清單」
3. **移除或反轉保守規則**：特別是「有疑慮就保留」、「不確定時保留」這類規則
4. **針對 FN 清單加強**：上面漏刪的詞彙，寫清楚在什麼脈絡下要刪
5. **重錄判斷要更積極**：語意模糊相似（60% 相似度以上）就視為重錄刪除前段
6. **FP 例外要精確且少**：只保留真正重要的例外，不要過度擴大例外`;

  const content = await runClaude(prompt, `Claude 改寫 editing_skills.md（第 ${iterNum} 輪）`);
  if (!content || content.length < 200) {
    log('   ⚠️ Claude 輸出太短或失敗');
    return null;
  }
  return content;
}

// ── 策略 1b（Phase 4）：策略師 + 外科手術編輯器 ──
// 直接修改 SKILLS_PATH，回傳新內容字串（autoresearch 主迴圈仍用相同 keep/revert 流程）
function spawnSync(cmd, argv, opts = {}) {
  const { spawnSync: ss } = require('child_process');
  return ss(cmd, argv, { stdio: 'inherit', ...opts });
}

async function runStrategistAndEditor(currentSkills, evalReport, iterNum, prevF1) {
  // 算上輪 ΔF1（pp）— 從 state.history 找上一筆有效結果
  let lastDeltaPp = null;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const h = state.history[i];
    if (h.action === 'improved' || h.action === 'reverted') {
      lastDeltaPp = (h.delta || 0) * 100;
      break;
    }
  }

  const tasksPath = path.join(TRAINING_DIR, `tasks_iter${iterNum}.json`);
  log(`   🧠 [策略師] 規劃第 ${iterNum} 輪任務（model=${STRATEGIST_MODEL}）...`);

  // pair-mode：策略師優化 ai_cut_pairs_prompt.md；否則優化 editing_skills.md
  const activeSkillsPath = USE_PAIR_MODE ? PAIRS_PROMPT_PATH : SKILLS_PATH;
  const stratArgs = [
    STRATEGIST_PATH,
    '--skills',      activeSkillsPath,
    '--eval-report', path.join(TRAINING_DIR, 'ai_evaluation_report.json'),
    '--state',       STRATEGIST_STATE,
    '--out',         tasksPath,
    '--model',       STRATEGIST_MODEL,
    '--iter',        String(iterNum),
  ];
  if (lastDeltaPp != null) {
    stratArgs.push('--last-delta', lastDeltaPp.toFixed(4));
  }

  const stratResult = spawnSync('node', stratArgs, { cwd: SCRIPT_DIR });
  if (stratResult.status !== 0) {
    log(`   ❌ 策略師失敗（exit ${stratResult.status}）— 本輪視為改寫失敗`);
    return null;
  }
  if (!fs.existsSync(tasksPath)) {
    log(`   ❌ 策略師沒產出 ${path.basename(tasksPath)}`);
    return null;
  }

  // 檢查 task 數
  let tasksObj = {};
  try { tasksObj = JSON.parse(fs.readFileSync(tasksPath, 'utf8')); } catch (e) {}
  const tasks = Array.isArray(tasksObj.tasks) ? tasksObj.tasks : [];
  log(`   📋 策略師規劃 ${tasks.length} 個任務、${(tasksObj.doNotTouch || []).length} 個 doNotTouch`);
  if (tasks.length === 0) {
    log(`   ⚠️ 策略師未給任何任務，跳過編輯器`);
    return null;
  }

  // 編輯器
  log(`   ✂️  [編輯器] 套用任務（Mode A 優先，Mode B model=${EDITOR_MODEL}）...`);
  const editorResult = spawnSync('node', [
    EDITOR_PATH,
    '--skills', activeSkillsPath,  // pair-mode: ai_cut_pairs_prompt.md; 否則: editing_skills.md
    '--tasks',  tasksPath,
    '--model',  EDITOR_MODEL,
  ], { cwd: SCRIPT_DIR });

  // exit code 3 = Mode A 部分 unmatched 仍寫檔；0 = 全部成功；其他 = 失敗
  if (editorResult.status !== 0 && editorResult.status !== 3) {
    log(`   ❌ 編輯器失敗（exit ${editorResult.status}）`);
    return null;
  }
  if (editorResult.status === 3) {
    log(`   ⚠️ 編輯器有 unmatched 任務，仍套用部分結果`);
  }

  // 讀回新 skills 內容（編輯器已直接寫到 SKILLS_PATH）
  const newContent = fs.readFileSync(SKILLS_PATH, 'utf8');
  if (!newContent || newContent.length < 200) {
    log(`   ⚠️ 編輯器產出內容過短（${newContent.length} 字元），回退`);
    return null;
  }
  return newContent;
}

// ── 把本輪結果回饋給 strategist_state.json（給下一輪策略師當證據用）──
function recordRoundOutcomeForStrategist({ iter, prevF1, newF1, action }) {
  if (!USE_STRATEGIST) return;
  if (!fs.existsSync(STRATEGIST_STATE)) return;
  let st;
  try { st = JSON.parse(fs.readFileSync(STRATEGIST_STATE, 'utf8')); } catch (e) { return; }
  // 從本輪 tasks.json 讀出 linkedHypotheses
  const tasksPath = path.join(TRAINING_DIR, `tasks_iter${iter}.json`);
  let linkedHypotheses = [];
  if (fs.existsSync(tasksPath)) {
    try {
      const tj = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
      linkedHypotheses = (tj.tasks || [])
        .map(t => t.linked_hypothesis)
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
    } catch (e) {}
  }
  st.roundHistory = Array.isArray(st.roundHistory) ? st.roundHistory : [];
  st.roundHistory.push({
    iter, prevF1, newF1, action,
    linkedHypotheses,
    taskIds: (() => {
      try { return (JSON.parse(fs.readFileSync(tasksPath, 'utf8')).tasks || []).map(t => t.id); }
      catch (e) { return []; }
    })(),
    note: action === 'improved' ? `+${((newF1-prevF1)*100).toFixed(2)}pp 保留` : `${((newF1-prevF1)*100).toFixed(2)}pp 回退`,
  });
  if (st.roundHistory.length > 20) st.roundHistory = st.roundHistory.slice(-20);
  fs.writeFileSync(STRATEGIST_STATE, JSON.stringify(st, null, 2));
}

// ── 策略 2：改寫 ai_cut_prompt.md ──
async function improvePromptTemplate(currentTemplate, evalReport, iterNum) {
  const { f1Pct, recPct, prePct, topFN, topFP, worstStr, recall } = buildErrorAnalysis(evalReport);

  let direction;
  if (recall < 0.5) {
    direction = `召回率僅 ${recPct}%，AI 太保守。重點是收緊「絕對不要刪的」清單，並在「必須刪除」加入更明確的判定條件。`;
  } else if (recall < 0.7) {
    direction = `召回率 ${recPct}%，仍不足。主要是「絕對不要刪的」例外太寬，重錄判斷不夠積極。`;
  } else {
    direction = `召回率 ${recPct}%，接近目標。針對剩餘 FN 模式做精細調整。`;
  }

  const prompt = `你是 prompt engineer，專門優化 LLM prompt 模板。

## 任務
ai_cut.js 使用一個 prompt 模板來請 Claude 判斷哪些段落該刪除（輸入是已加標點的段落）。
目前這個模板讓 Claude 太保守：F1 = ${f1Pct}%, 精確率 ${prePct}%, 召回率 ${recPct}%。
這是第 ${iterNum} 輪優化（策略：ai_cut_prompt.md）。

**方向：${direction}**

## ⚠️ 硬性禁止（破壞會導致整個系統爛掉）
1. 不可動 \`{{NOTES_SECTION}}\` 與 \`{{INPUT_LINES}}\` 這兩個 placeholder
2. 不可加入「## 回傳格式」段落（程式會在執行時自動附加）
3. 不可移除「## 任務」「## 段落：」這些章節標題
4. 必須保留 \`<!-- AUTORESEARCH_END -->\` 標記，且其後內容（## 段落 + {{INPUT_LINES}}）保持不動
5. 不可加 Markdown code fence（不要用 \\\`\\\`\\\`），直接輸出純 Markdown
6. 輸入的段落文字**已加標點**，不需要任務二（加標點），模板中也不能出現標點相關任務

## 目前模板
${currentTemplate}

## 目前錯誤分析

### 最常漏刪（FN）— Claude 沒抓到的，需要寫進刪除規則
${topFN}

### 最常誤刪（FP）— Claude 多殺的，需要寫進保留例外
${topFP}

### 最差影片
${worstStr}

## 改寫建議
- **收緊「絕對不要刪的」清單**：把不該保留的條件移除或加上條件限制
- **強化「必須刪除」**：列出更明確的刪除模式，覆蓋上面的 FN 詞彙
- **重錄判斷的關鍵思維**：強化語意相似的判斷，引入「不確定就刪」的傾向
- 注意：輸入已有標點（ai_polish 處理過），可以利用標點判斷句子完整性輔助重錄偵測

直接輸出完整的新模板（從「你是口播影片的剪輯助手」開頭到「{{INPUT_LINES}}」結尾），不要加說明、不要加 code fence。`;

  const content = await runClaude(prompt, `Claude 改寫 ai_cut_prompt.md（第 ${iterNum} 輪）`);
  if (!content || content.length < 300) {
    log('   ⚠️ Claude 輸出太短或失敗');
    return null;
  }

  // ── 安全檢查：禁止破壞 placeholder / 結構 ──
  const required = ['{{NOTES_SECTION}}', '{{INPUT_LINES}}', '<!-- AUTORESEARCH_END -->', '## 任務', '## 段落'];
  for (const token of required) {
    if (!content.includes(token)) {
      log(`   ⚠️ 改寫結果缺少必要 token「${token}」，拒絕套用`);
      return null;
    }
  }
  if (content.includes('## 回傳格式')) {
    log('   ⚠️ 改寫結果違規加入「## 回傳格式」段落，拒絕套用');
    return null;
  }
  return content;
}

// ── 策略切換邏輯 ──
// prompt 策略已停用：ai_cut_prompt.md 現為純骨架，所有判斷規則統一在 editing_skills.md
// 卡住時重置 stuckOnSkills 繼續嘗試，totalStuck 仍正常累積作為最終放棄條件
function maybeSwitchStrategy() {
  if (state.currentStrategy !== 'skills') {
    log(`\n   🔄 強制回 skills 策略（prompt 策略已停用）`);
    state.currentStrategy = 'skills';
    state.stuckOnPrompt = 0;
    persistStatus();
  }
  if (state.stuckOnSkills >= MAX_STUCK) {
    log(`\n   🔄 skills 連續 ${MAX_STUCK} 輪無進步 → 重置計數繼續（totalStuck=${state.totalStuck}）`);
    state.stuckOnSkills = 0;
    persistStatus();
  }
}

// ── Resume：嘗試從 STATUS_PATH 還原上次未完成的 state ──
let resumed = false;
if (RESUME && fs.existsSync(STATUS_PATH)) {
  try {
    const prev = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
    // 版本不同（舊管線 v1 vs 新管線 v2）→ F1 基準不相容，不允許接續
    if (prev && (prev.pipelineVersion || 1) !== PIPELINE_VERSION) {
      console.log(`⚠️  Resume 中止：上次 pipeline_version=${prev.pipelineVersion || 1}，目前版本=${PIPELINE_VERSION}，F1 基準不相容，改為重新開始`);
    } else if (prev && !prev.finishedAt && (prev.iter || 0) > 0
        && (prev.status === 'running' || prev.status === 'paused-quota' || prev.status === 'starting')) {
      state.startedAt        = prev.startedAt        || state.startedAt;
      state.currentStrategy  = prev.currentStrategy  || INIT_STRATEGY;
      state.iter             = prev.iter             || 0;
      state.startF1          = prev.startF1          ?? null;
      state.bestF1           = prev.bestF1           ?? null;
      state.currentF1        = prev.currentF1        ?? null;
      state.stuckOnSkills    = prev.stuckOnSkills    || 0;
      state.stuckOnPrompt    = prev.stuckOnPrompt    || 0;
      state.totalStuck       = prev.totalStuck       || 0;
      state.quotaPauseCount  = prev.quotaPauseCount  || 0;
      state.history          = Array.isArray(prev.history) ? prev.history : [];
      state.recentLogs       = Array.isArray(prev.recentLogs) ? prev.recentLogs.slice(-50) : [];
      state.resumed          = true;
      resumed = true;
    }
  } catch (e) { /* 不能還原就當新跑 */ }
}

// ── 主流程 ──
(async () => {
  state.status = 'running';
  if (resumed) {
    log(`📂 接續上次優化 — 已跑 ${state.iter} 輪 / 最佳 F1 ${(state.bestF1 ? state.bestF1*100 : 0).toFixed(2)}%（策略: ${state.currentStrategy}）`);
  } else {
    log('🚀 Skills Autoresearch（全自動雙策略）啟動');
  }
  log(`   目標 F1: ${(TARGET_F1 * 100).toFixed(0)}% | 最大輪次: ${MAX_ITER}`);
  log(`   起始策略: ${INIT_STRATEGY} | 切換閾值: ${MAX_STUCK} 輪無進步 | 放棄閾值: ${MAX_TOTAL_STUCK} 輪總無進步`);
  log(`   樣本: ${SAMPLE} 支 | 並行: ${CONCUR}`);
  log(`   🧠 評估模型: ${EVAL_MODEL || '(預設)'} | ✏️  執行模型: ${EXEC_MODEL || '(預設)'}`);
  if (USE_STRATEGIST) {
    log(`   🎯 Phase 4 啟用：策略師(${STRATEGIST_MODEL}) → 編輯器(${EDITOR_MODEL})  [關閉用 --no-strategist]`);
  } else {
    log(`   📜 策略師已停用（--no-strategist）— 使用舊整檔重寫模式`);
  }
  log(`   ⏸ 額度暫停策略: 每 ${Math.round(PROBE_INTERVAL_MS/60000)} 分鐘探測，最多等 ${Math.round(MAX_WAIT_MS/3600000)} 小時`);

  // ── 啟動時驗證模型有效性，拼錯版本立即停止（避免燒掉 30 輪）──
  function validateModel(model, label) {
    if (!model) return true;
    log(`   🔎 驗證 ${label} 模型「${model}」...`);
    try {
      execSync(claudeCmd + ` -p - --model ${model}`, {
        input: 'ok', encoding: 'utf8', timeout: 30000,
        maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], shell: true
      });
      return true;
    } catch (err) {
      // claude CLI 把「模型不存在」錯誤印到 stdout，不是 stderr
      const errMsg = ((err.stdout && err.stdout.toString()) || '') + ' '
                   + ((err.stderr && err.stderr.toString()) || '') + ' '
                   + (err.message || '');
      if (/may not exist|may not have access|invalid model|not a valid model/i.test(errMsg)) {
        log(`❌ ${label} 模型「${model}」不存在或無權使用`);
        log(`   建議：用 'sonnet' / 'opus' alias，或 claude-sonnet-4-6 / claude-opus-4-1 等實際版本`);
        return false;
      }
      // 其他錯誤（如額度）放行，交由後續 quota 暫停邏輯處理
      log(`   ⚠️ 驗證遇到非「模型無效」錯誤，視為可用：${errMsg.slice(0, 120)}`);
      return true;
    }
  }
  if (!validateModel(EXEC_MODEL, '執行') || !validateModel(EVAL_MODEL, '評估')) {
    state.status = 'failed';
    state.message = '模型名稱無效，已停止';
    state.finishedAt = new Date().toISOString();
    persistStatus();
    process.exit(1);
  }

  // 確認檔案存在
  if (!fs.existsSync(SKILLS_PATH)) {
    log('❌ 找不到 editing_skills.md，請先點「生成 Skills」');
    state.status = 'failed';
    state.message = '缺少 editing_skills.md';
    persistStatus();
    process.exit(1);
  }
  if (!fs.existsSync(PROMPT_PATH)) {
    log('❌ 找不到 prompts/ai_cut_prompt.md');
    state.status = 'failed';
    state.message = '缺少 ai_cut_prompt.md';
    persistStatus();
    process.exit(1);
  }

  // 確認有評估報告（如果沒有，先跑一次）
  let evalReport = readEvalReport();
  if (!evalReport) {
    log('\n📊 尚無評估結果，先執行快速評估...');
    const f1 = await runQuickEval(true);
    if (f1 === null) {
      log('❌ 初始評估失敗，無法繼續');
      state.status = 'failed';
      persistStatus();
      process.exit(1);
    }
    evalReport = readEvalReport();
  }

  let currentF1 = (evalReport.overallCombined || evalReport.overall).f1;
  if (resumed) {
    // 還原時：startF1 / bestF1 從前次 state 繼承；currentF1 改用最新報告
    if (state.startF1 == null) state.startF1 = currentF1;
    if (state.bestF1  == null || currentF1 > state.bestF1) state.bestF1 = currentF1;
    state.currentF1 = currentF1;
    log(`\n📊 接續中：當前 F1 ${(currentF1*100).toFixed(2)}% (起始: ${(state.startF1*100).toFixed(2)}%, 最佳: ${(state.bestF1*100).toFixed(2)}%)`);
  } else {
    state.startF1   = currentF1;
    state.currentF1 = currentF1;
    state.bestF1    = currentF1;
    log(`\n📊 起始 F1: ${(currentF1 * 100).toFixed(2)}% (P: ${(evalReport.overall.precision * 100).toFixed(1)}% R: ${(evalReport.overall.recall * 100).toFixed(1)}%)`);
  }

  if (currentF1 >= TARGET_F1) {
    log(`✅ 已達目標 F1 ${(TARGET_F1 * 100).toFixed(0)}%，無需優化`);
    state.status = 'finished';
    state.reachedTarget = true;
    state.finishedAt = new Date().toISOString();
    persistStatus();
    process.exit(0);
  }

  // 主迴圈（接續時從 state.iter + 1 開始）
  const startIter = resumed && state.iter > 0 ? state.iter + 1 : 1;
  if (resumed) log(`   ▶ 從第 ${startIter} 輪繼續`);
  for (let iter = startIter; iter <= MAX_ITER; iter++) {
    state.iter = iter;
    persistStatus();

    log(`\n${'═'.repeat(50)}`);
    log(`🔄 第 ${iter}/${MAX_ITER} 輪 [策略: ${state.currentStrategy}] (最佳 F1: ${(state.bestF1 * 100).toFixed(2)}%)`);
    log(`   無進步: skills=${state.stuckOnSkills} 總計=${state.totalStuck}（prompt 策略已停用）`);
    log('═'.repeat(50));

    const isSkillsStrategy = state.currentStrategy === 'skills';
    // pair-mode：skills 策略優化 ai_cut_pairs_prompt.md；prompt 策略也用同一個（pair-mode 無 ai_cut_prompt.md）
    const targetPath  = USE_PAIR_MODE
      ? PAIRS_PROMPT_PATH
      : (isSkillsStrategy ? SKILLS_PATH : PROMPT_PATH);
    const targetName  = USE_PAIR_MODE
      ? 'ai_cut_pairs_prompt.md'
      : (isSkillsStrategy ? 'editing_skills.md' : 'ai_cut_prompt.md');
    const backupPath  = path.join(BACKUPS_DIR, `${path.basename(targetPath, '.md')}_iter${iter}.bak`);

    // 1. 備份
    const beforeContent = fs.readFileSync(targetPath, 'utf8');
    fs.writeFileSync(backupPath, beforeContent);
    log(`   💾 備份: backups/${path.basename(backupPath)}`);

    // 2. Claude 改寫
    //    Phase 4：skills 策略改走「策略師 + 編輯器」（精準手術），prompt 策略保留舊路徑
    //    --no-strategist 旗標可退回舊整檔重寫
    const useStrategistThisRound = USE_STRATEGIST && isSkillsStrategy;
    let newContent;
    let alreadyWritten = false;  // 編輯器已直接寫到 SKILLS_PATH，避免重複加 header

    if (useStrategistThisRound) {
      newContent = await runStrategistAndEditor(beforeContent, evalReport, iter, currentF1);
      alreadyWritten = (newContent != null);  // 編輯器已寫檔
    } else {
      newContent = isSkillsStrategy
        ? await improveSkills(beforeContent.replace(/^<!--[\s\S]*?-->\s*/gm, '').trim(), evalReport, iter)
        : await improvePromptTemplate(beforeContent.replace(/^<!--[\s\S]*?-->\s*/m, '').trim(), evalReport, iter);
    }

    if (!newContent) {
      log(`   ⚠️ 改寫失敗，視為本輪無進步`);
      // 確保檔案還原（若編輯器寫了一半失敗）
      if (useStrategistThisRound) fs.writeFileSync(targetPath, beforeContent);
      state.history.push({ iter, strategy: state.currentStrategy, file: targetName, prevF1: currentF1, newF1: currentF1, delta: 0, action: 'skipped_claude_failed' });
      // 算入 stuck
      if (isSkillsStrategy) state.stuckOnSkills++; else state.stuckOnPrompt++;
      state.totalStuck++;
      persistStatus();
      maybeSwitchStrategy();
      if (state.totalStuck >= MAX_TOTAL_STUCK) { log(`\n🛑 連續 ${MAX_TOTAL_STUCK} 輪無進步，結束`); break; }
      continue;
    }

    // 3. 寫入新內容（加上戳記） — 策略師路徑已寫過了，跳過
    if (!alreadyWritten) {
      const header = isSkillsStrategy
        ? `<!-- 由 ai_skills_autoresearch.js 自動生成（第 ${iter} 輪 / skills） -->\n<!-- 生成時間: ${new Date().toISOString()} -->\n<!-- 優化前 F1: ${(currentF1 * 100).toFixed(2)}% -->\n\n`
        : '';  // prompt 模板不加 header，避免破壞前綴格式
      fs.writeFileSync(targetPath, header + newContent, 'utf8');
    }
    log(`   ✅ ${targetName} 已更新（${useStrategistThisRound ? '策略師+編輯器' : '整檔重寫'}）`);

    // 4. 快速評估（失敗時先用 probeQuota 判斷是不是額度問題）
    let newF1 = await runQuickEval(true);
    if (newF1 === null) {
      log('   ⚠️ 評估失敗，先探測是否為額度問題...');
      const probe = probeQuota();
      if (!probe.ok && (probe.isQuota || isQuotaError(probe.error))) {
        log('   ⏸  探測確認為額度不足，進入暫停（不算 stuck，等恢復後重試本輪評估）');
        const recovered = await waitForQuotaRecovery('runQuickEval 額度不足');
        if (recovered) {
          log('   🔁 重試本輪評估...');
          newF1 = await runQuickEval(true);
        }
      }
    }
    if (newF1 === null) {
      log('   ⚠️ 評估仍失敗，回退備份並計入 stuck');
      fs.writeFileSync(targetPath, beforeContent);
      state.history.push({ iter, strategy: state.currentStrategy, file: targetName, prevF1: currentF1, newF1: null, delta: 0, action: 'reverted_eval_failed' });
      if (isSkillsStrategy) state.stuckOnSkills++; else state.stuckOnPrompt++;
      state.totalStuck++;
      persistStatus();
      maybeSwitchStrategy();
      if (state.totalStuck >= MAX_TOTAL_STUCK) { log(`\n🛑 連續 ${MAX_TOTAL_STUCK} 輪無進步，結束`); break; }
      continue;
    }

    const newReport = readEvalReport();
    const newPrec   = newReport ? newReport.overall.precision : 0;
    const newRecall = newReport ? newReport.overall.recall    : 0;
    const delta     = newF1 - currentF1;
    log(`   📊 結果: F1=${(newF1 * 100).toFixed(2)}% P=${(newPrec * 100).toFixed(1)}% R=${(newRecall * 100).toFixed(1)}% (Δ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}pp)`);

    // 5. 進步 / 退步判斷
    const prevF1ThisRound = currentF1;  // 在 keep/revert 改動 currentF1 之前抓住
    let roundAction;
    if (newF1 > currentF1 + 0.005) {
      log(`   ✅ 進步！保留新版本`);
      roundAction = 'improved';
      state.history.push({ iter, strategy: state.currentStrategy, file: targetName, prevF1: currentF1, newF1, delta, action: roundAction });
      currentF1 = newF1;
      state.currentF1 = newF1;
      evalReport = newReport;
      if (newF1 > state.bestF1) state.bestF1 = newF1;
      // 重置 stuck
      if (isSkillsStrategy) state.stuckOnSkills = 0; else state.stuckOnPrompt = 0;
      state.totalStuck = 0;
    } else {
      log(`   ↩️  沒有明顯進步（Δ${(delta * 100).toFixed(2)}pp），回退`);
      fs.writeFileSync(targetPath, beforeContent);
      roundAction = 'reverted';
      state.history.push({ iter, strategy: state.currentStrategy, file: targetName, prevF1: currentF1, newF1, delta, action: roundAction });
      if (isSkillsStrategy) state.stuckOnSkills++; else state.stuckOnPrompt++;
      state.totalStuck++;
    }

    // 5b. 把本輪結果回饋給策略師（驗證假設用）
    if (useStrategistThisRound) {
      recordRoundOutcomeForStrategist({
        iter,
        prevF1: prevF1ThisRound,
        newF1,
        action: roundAction,
      });
    }

    persistStatus();

    // 6. 小樣本達標 → 觸發「完整評估驗證」
    if (state.bestF1 >= TARGET_F1) {
      log(`\n🎯 快速評估達標 F1 ${(state.bestF1*100).toFixed(2)}% ≥ ${(TARGET_F1*100).toFixed(0)}%，開始完整評估驗證（35 支）...`);
      state.fullEvalCount++;
      persistStatus();
      const fullReport = await runFullEval();
      if (!fullReport) {
        log('   ⚠️ 完整評估失敗（可能為額度或其他問題），本輪先不視為達標，繼續迭代');
      } else {
        const fullF1 = fullReport.overall.f1;
        state.lastFullF1 = fullF1;
        if (state.fullBestF1 == null || fullF1 > state.fullBestF1) state.fullBestF1 = fullF1;
        log(`   📊 完整評估 F1: ${(fullF1*100).toFixed(2)}% (P: ${(fullReport.overall.precision*100).toFixed(1)}% R: ${(fullReport.overall.recall*100).toFixed(1)}%)`);

        state.history.push({
          iter, strategy: state.currentStrategy, file: targetName,
          prevF1: currentF1, newF1: state.bestF1, delta: 0,
          action: fullF1 >= TARGET_F1 ? 'full_eval_passed' : 'full_eval_below_target',
          fullF1,
        });

        if (fullF1 >= TARGET_F1) {
          log(`\n🎉 完整評估也達標！真正成功（sample ${(state.bestF1*100).toFixed(2)}% / full ${(fullF1*100).toFixed(2)}%）`);
          state.reachedTarget = true;
          break;
        }

        // Sample 過 但 Full 未過 → overfit 計數 +1
        state.overfitChecks++;
        log(`   ⚠️ 完整 F1 ${(fullF1*100).toFixed(2)}% < ${(TARGET_F1*100).toFixed(0)}%，疑似對 8 支樣本過擬合（overfit ${state.overfitChecks}/${MAX_OVERFIT}）`);
        log(`   📌 改用完整評估結果作為下一輪基準，繼續迭代`);

        // 以完整結果為新的 evalReport / currentF1，避免繼續被 sample 誤導
        evalReport = fullReport;
        currentF1  = fullF1;
        state.currentF1 = fullF1;
        state.bestF1    = fullF1;   // 重設 bestF1，下一輪 sample 要再改進 fullF1 才會觸發驗證
        persistStatus();

        if (state.overfitChecks >= MAX_OVERFIT) {
          log(`\n🛑 已連續 ${MAX_OVERFIT} 次「快速達標但完整未達標」，判定 overfit，結束`);
          break;
        }
      }
    }

    // 7. 策略切換 / 放棄
    maybeSwitchStrategy();
    if (state.totalStuck >= MAX_TOTAL_STUCK) {
      log(`\n🛑 連續 ${MAX_TOTAL_STUCK} 輪無進步，結束`);
      break;
    }
  }

  // ── 最終完整評估（若達標時在迴圈內就已跑完）──
  let fullReport = null;
  if (state.reachedTarget) {
    // 達標時的 full eval 已在迴圈內跑過；這裡從 eval 報告檔讀取最新結果
    const latest = readEvalReport();
    if (latest) fullReport = latest;
    log(`\n✅ 已達標，完整評估 F1: ${fullReport ? (fullReport.overall.f1 * 100).toFixed(2) + '%' : 'n/a'}`);
  } else if (FULL_EVAL) {
    // 未達標：跑一次完整評估當作最終 benchmark（使用者知道現況）
    log(`\n🔬 未達目標，執行最終完整評估作為 benchmark...`);
    fullReport = await runFullEval();
    if (fullReport) {
      log(`   最終完整 F1: ${(fullReport.overall.f1 * 100).toFixed(2)}%`);
      state.lastFullF1 = fullReport.overall.f1;
      if (state.fullBestF1 == null || fullReport.overall.f1 > state.fullBestF1) state.fullBestF1 = fullReport.overall.f1;
    }
  } else {
    log('\n（--no-full-eval，跳過最終完整評估）');
  }

  // ── 寫入最終報告 ──
  const report = {
    timestamp:      new Date().toISOString(),
    maxIter:        MAX_ITER,
    targetF1:       TARGET_F1,
    sampleSize:     SAMPLE,
    startF1:        state.startF1,
    bestF1:         state.bestF1,
    improved:       state.bestF1 > state.startF1,
    reachedTarget:  state.reachedTarget,
    iter:           state.iter,
    history:        state.history,
    stuckOnSkills:  state.stuckOnSkills,
    stuckOnPrompt:  state.stuckOnPrompt,
    totalStuck:     state.totalStuck,
    fullEval:       fullReport ? fullReport.overall : null,
    fullBestF1:     state.fullBestF1,
    overfitChecks:  state.overfitChecks,
    fullEvalCount:  state.fullEvalCount,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  state.status = 'finished';
  state.finishedAt = new Date().toISOString();
  persistStatus();

  log('\n' + '═'.repeat(50));
  log('📊 Skills Autoresearch 完成');
  log('═'.repeat(50));
  log(`  起始 F1:    ${(state.startF1 * 100).toFixed(2)}%`);
  log(`  最佳 F1:    ${(state.bestF1 * 100).toFixed(2)}%`);
  log(`  改善:       ${((state.bestF1 - state.startF1) * 100).toFixed(2)}pp`);
  log(`  達到目標:   ${state.reachedTarget ? '✅ 是' : '❌ 否（目標 ' + (TARGET_F1 * 100).toFixed(0) + '%）'}`);
  log(`  總迭代:     ${state.iter} 輪`);
  if (state.fullBestF1 != null) {
    log(`  最佳完整 F1: ${(state.fullBestF1 * 100).toFixed(2)}% (完整評估 ${state.fullEvalCount} 次)`);
    if (state.overfitChecks > 0) {
      log(`  Overfit 警告: ${state.overfitChecks} 次快速達標但完整未達標`);
    }
  }
  log(`\n📄 報告: ${REPORT_PATH}`);
})().catch(err => {
  log(`\n❌ 主流程未捕獲錯誤: ${err && err.stack || err}`);
  state.status = 'failed';
  state.message = String(err && err.message || err);
  state.finishedAt = new Date().toISOString();
  persistStatus();
  process.exit(1);
});

