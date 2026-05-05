#!/usr/bin/env node
/**
 * ai_strategist.js — 總策略師（Chief Reasoner）
 *
 * 職責：讀「跨輪假設記憶」+「上輪結果」+「FN/FP 統計」→ 給編輯器一份精準任務清單。
 * 不直接改 editing_skills.md，只輸出 tasks.json。
 *
 * 用法：
 *   node ai_strategist.js \
 *     --skills      <path to editing_skills.md> \
 *     --eval-report <path to ai_evaluation_report.json> \
 *     --state       <path to strategist_state.json> \
 *     --out         <path to tasks_iterN.json> \
 *     [--prompt     <path to strategist_prompt.md>] \
 *     [--model      opus|sonnet|haiku]            (default: opus) \
 *     [--iter       <int>]                         (default: state.lastIter + 1) \
 *     [--prev-f1    <float>]                       (上輪 F1，若不傳則從 state 推) \
 *     [--last-delta <float>]                       (上輪 ΔF1)
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR    = __dirname;
const ROOT_DIR      = path.join(SCRIPT_DIR, '..');
const TRAINING_DIR  = path.join(SCRIPT_DIR, 'training_output');
const DEFAULT_PROMPT_PATH = path.join(ROOT_DIR, 'prompts', 'strategist_prompt.md');

// ── 解析參數 ──
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    args[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
      ? process.argv[++i] : true;
  }
}

const SKILLS_PATH      = args.skills      || path.join(ROOT_DIR, 'editing_skills.md');
const EVAL_REPORT_PATH = args['eval-report'] || path.join(TRAINING_DIR, 'ai_evaluation_report.json');
const STATE_PATH       = args.state       || path.join(TRAINING_DIR, 'strategist_state.json');
const OUT_PATH         = args.out         || path.join(TRAINING_DIR, 'tasks_latest.json');
const PROMPT_PATH      = args.prompt      || DEFAULT_PROMPT_PATH;
const MODEL            = args.model       || 'opus';

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

function log(msg) { console.log(`[strategist] ${msg}`); }

// ── 收集 FP/FN（優先讀 combined_diff_report，fallback 到 ai_diff_report，並掃 cut_work 手動回饋）──
const CUT_WORK_DIR = path.join(SCRIPT_DIR, 'cut_work');

function collectFPFN() {
  const fnCounts = {};
  const fpCounts = {};
  const worstVideos = [];
  let manualFeedbackCount = 0;

  // ── 1. 讀訓練集 diff_report ──
  if (fs.existsSync(TRAINING_DIR)) {
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
  }

  // ── 2. 讀 cut_work 手動回饋（real user edits，權重 x2）──
  if (fs.existsSync(CUT_WORK_DIR)) {
    for (const dir of fs.readdirSync(CUT_WORK_DIR)) {
      const feedbackPath = path.join(CUT_WORK_DIR, dir, '2_分析', 'manual_feedback.json');
      if (!fs.existsSync(feedbackPath)) continue;
      try {
        const mf = JSON.parse(fs.readFileSync(feedbackPath, 'utf8'));
        manualFeedbackCount++;
        // AI 誤刪（FP）：使用者保留了這些句子
        for (const fp of (mf.falsePositives || [])) {
          if (!fp.text || fp.text.length < 2) continue;
          fpCounts[fp.text] = (fpCounts[fp.text] || 0) + 2; // 真實行為，加倍權重
        }
        // AI 漏刪（FN）：使用者手動標記刪除
        for (const fn of (mf.falseNegatives || [])) {
          if (!fn.text || fn.text.length < 2) continue;
          fnCounts[fn.text] = (fnCounts[fn.text] || 0) + 2;
        }
      } catch (e) {}
    }
    if (manualFeedbackCount > 0) {
      log(`📝 讀取 ${manualFeedbackCount} 筆手動回饋（cut_work）`);
    }
  }

  worstVideos.sort((a, b) => a.f1 - b.f1);
  return { fnCounts, fpCounts, worstVideos, manualFeedbackCount };
}

function loadJSON(p, fallback = null) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function loadOrInitState() {
  let st = loadJSON(STATE_PATH, null);
  if (!st) {
    st = {
      version: 1,
      currentFocus: '尚未設定',
      hypotheses: [],
      rejectedDirections: [],
      roundHistory: [],
    };
  }
  if (!Array.isArray(st.hypotheses))         st.hypotheses = [];
  if (!Array.isArray(st.rejectedDirections)) st.rejectedDirections = [];
  if (!Array.isArray(st.roundHistory))       st.roundHistory = [];
  return st;
}

// ── 根據上輪 ΔF1 自動更新 hypothesis confidence（在送 prompt 前先做 baseline）──
function autoUpdateHypotheses(state, lastDeltaPp) {
  if (lastDeltaPp == null || isNaN(lastDeltaPp)) return state;
  const delta = lastDeltaPp / 100; // pp → 比例

  // 找上一輪有改動的 hypotheses（透過 roundHistory 最後一筆）
  const lastRound = state.roundHistory[state.roundHistory.length - 1];
  if (!lastRound || !lastRound.linkedHypotheses) return state;

  for (const hid of lastRound.linkedHypotheses) {
    const h = state.hypotheses.find(x => x.id === hid);
    if (!h) continue;
    let verdict, confDelta;
    if (delta >  0.01)        { verdict = 'supported';     confDelta = +0.15; }
    else if (delta >= -0.005) { verdict = 'inconclusive';  confDelta = -0.05; }
    else if (delta >  -0.02)  { verdict = 'weakened';      confDelta = -0.20; }
    else                      { verdict = 'refuted';       confDelta = -1.00; }

    h.evidence = h.evidence || [];
    h.evidence.push({ iter: lastRound.iter, F1Delta: delta, verdict });
    h.confidence = Math.max(0, Math.min(1, (h.confidence || 0.5) + confDelta));

    if (verdict === 'refuted' || h.confidence < 0.15) {
      h.status = 'rejected';
      // 進 rejectedDirections 摘要（避免重複）
      const summary = `H${h.id.replace(/^H/, '')}: ${h.claim}（${verdict} @ iter ${lastRound.iter}, ΔF1=${(delta*100).toFixed(2)}pp）`;
      if (!state.rejectedDirections.includes(summary)) {
        state.rejectedDirections.push(summary);
      }
    }
  }
  return state;
}

// ── 組 prompt ──
function buildPrompt({ skills, evalReport, state, fnCounts, fpCounts, worstVideos, iter, lastDeltaPp, manualFeedbackCount }) {
  const tpl = fs.readFileSync(PROMPT_PATH, 'utf8');

  // 優先使用合併 F1（規則引擎 + AI），fallback 到 AI 單獨 F1
  const overall = evalReport.overallCombined || evalReport.overall || {};
  const f1Pct  = ((overall.f1        || 0) * 100).toFixed(2);
  const prePct = ((overall.precision || 0) * 100).toFixed(2);
  const recPct = ((overall.recall    || 0) * 100).toFixed(2);

  const manualNote = manualFeedbackCount > 0
    ? `（包含 ${manualFeedbackCount} 筆使用者實際剪輯回饋，權重 x2）`
    : '';
  const topFN = Object.entries(fnCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([t, c]) => `  「${t}」: ${c}次`).join('\n') || '  （無明顯文字模式）';
  const topFP = Object.entries(fpCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([t, c]) => `  「${t}」: ${c}次`).join('\n') || '  （誤刪很少）';
  const worstStr = worstVideos.slice(0, 5)
    .map(v => `  ${v.name}: F1=${(v.f1 * 100).toFixed(1)}% FN=${v.fn} FP=${v.fp}`).join('\n') || '  （無資料）';

  // 只把 active 假設給 prompt，rejected 折疊到 rejectedDirections
  const activeHyp = state.hypotheses.filter(h => h.status !== 'rejected');
  const recent5 = state.roundHistory.slice(-5)
    .map(r => `  iter ${r.iter}: ΔF1=${((r.newF1 - r.prevF1)*100).toFixed(2)}pp, action=${r.action || 'n/a'}, tasks=[${(r.taskIds || []).join(',')}]`)
    .join('\n') || '  （首輪，無歷史）';

  const rejectedStr = state.rejectedDirections.length
    ? state.rejectedDirections.map(d => `  - ${d}`).join('\n')
    : '  （目前無）';

  return tpl
    .replace('{{CURRENT_F1}}',         f1Pct + '%')
    .replace('{{CURRENT_PRECISION}}',  prePct + '%')
    .replace('{{CURRENT_RECALL}}',     recPct + '%')
    .replace('{{TARGET_F1}}',          '90%')
    .replace('{{LAST_DELTA_PP}}',      lastDeltaPp != null ? lastDeltaPp.toFixed(2) : 'n/a')
    .replace('{{ITER}}',               String(iter))
    .replace('{{TOP_FN}}',             topFN + (manualNote ? '\n  ' + manualNote : ''))
    .replace('{{TOP_FP}}',             topFP + (manualNote ? '\n  ' + manualNote : ''))
    .replace('{{WORST_VIDEOS}}',       worstStr)
    .replace('{{HYPOTHESES_JSON}}',    JSON.stringify(activeHyp, null, 2))
    .replace('{{REJECTED_DIRECTIONS}}',rejectedStr)
    .replace('{{RECENT_HISTORY}}',     recent5)
    .replace('{{SKILLS_CONTENT}}',     skills)
    .replace('{{CURRENT_CONFIG}}',     (() => {
      try {
        const cfgPath = path.join(__dirname, '..', 'training_config.json');
        if (!fs.existsSync(cfgPath)) return '（無 training_config.json）';
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const relevant = {
          silence:         cfg.silence,
          semantic_repeat: cfg.semantic_repeat,
          take_group:      cfg.take_group,
          candidate_pair:  cfg.candidate_pair,
        };
        return JSON.stringify(relevant, null, 2);
      } catch(_) { return '（讀取失敗）'; }
    })());
}

// ── 呼叫 Claude CLI（簡化版，不含 quota wait — 由 autoresearch 外層處理）──
function callClaude(prompt) {
  log(`呼叫 Claude（model=${MODEL}）...`);
  const result = execSync(`${claudeCmd} -p - --model ${MODEL}`, {
    input: prompt,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });
  let content = result.trim();
  if (content.startsWith('```json')) content = content.slice('```json'.length).trim();
  else if (content.startsWith('```')) content = content.slice(3).trim();
  if (content.endsWith('```')) content = content.slice(0, -3).trim();
  return content;
}

function parseStrategistOutput(raw) {
  // 容錯：嘗試直接 parse；失敗則找第一個 { 到最後一個 }
  try { return JSON.parse(raw); } catch (e) {}
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (e) {}
  }
  throw new Error('strategist 輸出無法解析為 JSON: ' + raw.slice(0, 300));
}

// ── 將 verdictsByHypothesis 與 newHypotheses 合併回 state ──
function mergeVerdictsAndHypotheses(state, output, iter) {
  // verdicts → 更新已有 hypotheses
  const verdicts = output.verdictsByHypothesis || {};
  for (const [hid, v] of Object.entries(verdicts)) {
    const h = state.hypotheses.find(x => x.id === hid);
    if (!h) continue;
    h.evidence = h.evidence || [];
    h.evidence.push({ iter, verdict: v.verdict, note: v.note || '' });
    if (typeof v.confidenceDelta === 'number') {
      h.confidence = Math.max(0, Math.min(1, (h.confidence || 0.5) + v.confidenceDelta));
    }
    if (v.verdict === 'refuted') {
      h.status = 'rejected';
      const summary = `${hid}: ${h.claim}（refuted @ iter ${iter}）`;
      if (!state.rejectedDirections.includes(summary)) state.rejectedDirections.push(summary);
    }
  }
  // newHypotheses → append
  for (const nh of (output.newHypotheses || [])) {
    if (state.hypotheses.find(x => x.id === nh.id)) continue;
    state.hypotheses.push({
      id:               nh.id,
      claim:            nh.claim,
      rationale:        nh.rationale || '',
      introducedAtIter: iter,
      evidence:         [],
      confidence:       typeof nh.confidence === 'number' ? nh.confidence : 0.5,
      status:           'active',
    });
  }
  // 限制 hypotheses 大小：rejected 超過 30 條時折疊最舊的
  const rejected = state.hypotheses.filter(h => h.status === 'rejected');
  if (rejected.length > 30) {
    state.hypotheses = state.hypotheses.filter(h => h.status !== 'rejected')
      .concat(rejected.slice(-30));
  }
  // 限制 roundHistory：只留最近 20 輪
  if (state.roundHistory.length > 20) {
    state.roundHistory = state.roundHistory.slice(-20);
  }
  return state;
}

// ── 主流程 ──
async function main() {
  if (!fs.existsSync(SKILLS_PATH))      { console.error(`找不到 skills: ${SKILLS_PATH}`); process.exit(1); }
  if (!fs.existsSync(EVAL_REPORT_PATH)) { console.error(`找不到 eval report: ${EVAL_REPORT_PATH}`); process.exit(1); }
  if (!fs.existsSync(PROMPT_PATH))      { console.error(`找不到 prompt: ${PROMPT_PATH}`); process.exit(1); }

  const skills     = fs.readFileSync(SKILLS_PATH, 'utf8');
  const evalReport = loadJSON(EVAL_REPORT_PATH);
  const state      = loadOrInitState();

  const iter        = args.iter ? parseInt(args.iter) : ((state.roundHistory[state.roundHistory.length - 1] || {}).iter || 0) + 1;
  const lastDeltaPp = args['last-delta'] != null ? parseFloat(args['last-delta']) : null;

  // 0. 根據上輪 ΔF1 自動更新假設 confidence
  autoUpdateHypotheses(state, lastDeltaPp);

  // 1. 收集當前 FN/FP
  const { fnCounts, fpCounts, worstVideos, manualFeedbackCount } = collectFPFN();

  // 2. 組 prompt → call Claude
  const prompt = buildPrompt({ skills, evalReport, state, fnCounts, fpCounts, worstVideos, iter, lastDeltaPp, manualFeedbackCount });
  log(`送 prompt（${prompt.length} 字元）`);

  const raw = callClaude(prompt);
  log(`收到回應（${raw.length} 字元）`);

  let output;
  try {
    output = parseStrategistOutput(raw);
  } catch (e) {
    console.error(e.message);
    // 仍寫一份 raw 給 debug
    fs.writeFileSync(OUT_PATH + '.raw.txt', raw);
    process.exit(2);
  }

  // 3. 驗證 task 數量
  const tasks = Array.isArray(output.tasks) ? output.tasks : [];
  if (tasks.length === 0) {
    log('⚠️ 策略師未給出任何 task');
  } else if (tasks.length > 4) {
    log(`⚠️ 策略師給出 ${tasks.length} 個 task（> 4），autoresearch 應警示`);
  }

  // 4. 合併 verdict / newHypothesis 到 state
  mergeVerdictsAndHypotheses(state, output, iter);

  // 5. 寫 tasks.json（給 editor 吃）
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  log(`✅ 任務清單寫入 ${OUT_PATH}`);

  // 6. 寫回 state
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  log(`✅ state 更新 ${STATE_PATH}`);

  // 7. 摘要
  log(`本輪規劃：${tasks.length} 個任務，${(output.doNotTouch || []).length} 個 doNotTouch 章節`);
  if (output.strategistNote) log(`策略師備註：${output.strategistNote.slice(0, 200)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
