#!/usr/bin/env node
/**
 * ai_cut_pairs.js — 候選對 AI 判斷（Pair-mode AI Cut）
 *
 * 接收 phrase_prefilter.js 的輸出（cut_input.json），
 * 套用規則刪除，然後把候選對送給 Claude 做局部比對判斷。
 * 輸出 ai_sentences.json（schema 與 ai_cut.js 一致，下游 convert_ai_to_indices 不需改）。
 *
 * 用法：
 *   node ai_cut_pairs.js [--model <model>] [--skills-file <path>] <cut_input.json> [ai_sentences.json]
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── 解析參數 ──
let MODEL        = '';
let SKILLS_FILE  = '';
let OUTLINE_FILE = '';
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--model' && process.argv[i + 1]) {
    MODEL = process.argv[++i];
  } else if (a === '--skills-file' && process.argv[i + 1]) {
    SKILLS_FILE = process.argv[++i];
  } else if (a === '--outline-file' && process.argv[i + 1]) {
    OUTLINE_FILE = process.argv[++i];
  } else {
    positional.push(a);
  }
}

const inputFile  = positional[0];
const outputFile = positional[1]
  || (positional[0] && path.join(path.dirname(positional[0]), 'ai_sentences.json'));

if (!inputFile) {
  console.error('用法: node ai_cut_pairs.js [--model <model>] [--skills-file <path>] <cut_input.json> [ai_sentences.json]');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';
const BATCH_SIZE = 30; // 每批最多 30 對，控制 token 用量

// ── 載入 prompt 模板 ──
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'ai_cut_pairs_prompt.md');
let PROMPT_RAW = '';
try {
  PROMPT_RAW = fs.readFileSync(PROMPT_PATH, 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim();
} catch (e) {
  console.error(`❌ 無法讀取 prompt: ${PROMPT_PATH}`);
  process.exit(1);
}

// ── 載入 Skills（判斷原則）──
let notesSection = '';
try {
  const skillsPath = SKILLS_FILE
    ? path.resolve(SKILLS_FILE)
    : path.join(__dirname, '..', 'editing_skills.md');
  if (fs.existsSync(skillsPath)) {
    const skills = fs.readFileSync(skillsPath, 'utf8')
      .replace(/^<!--[\s\S]*?-->\s*/gm, '')
      .trim();
    notesSection = `\n## 個人剪輯風格說明書\n${skills}\n`;
  }
} catch (e) {}

// ── 載入 outline（實驗 A：意圖層上下文）──
let outlineSection = '';
if (OUTLINE_FILE && fs.existsSync(OUTLINE_FILE)) {
  try {
    const ol = JSON.parse(fs.readFileSync(OUTLINE_FILE, 'utf8'));
    if (ol.units && ol.units.length > 0) {
      const impLabel = { core: '核心', support: '支撐', redundant: '冗餘' };
      const lines = ol.units.map(u =>
        `  Unit ${u.id}（${impLabel[u.importance] || u.importance}）: ${u.topic}（段落 ${u.start}–${u.end}）`
      );
      outlineSection = '\n## 整集大綱（供判斷上下文使用）\n\n' + lines.join('\n') + '\n';
      console.log(`📋 outline 載入：${ol.units.length} 個 thought-units`);
    }
  } catch (e) {
    console.warn('⚠️ outline 載入失敗:', e.message);
  }
}

// ── 載入近期使用者回饋（few-shot 學習案例）──
const CORRECTIONS_FILE = path.join(__dirname, 'training_output', 'user_corrections.jsonl');
const MAX_CORRECTION_ENTRIES = 5;  // 最多用最近 5 筆
let correctionsSection = '';
try {
  if (fs.existsSync(CORRECTIONS_FILE)) {
    const lines = fs.readFileSync(CORRECTIONS_FILE, 'utf8')
      .split('\n').filter(l => l.trim());
    const recent = lines.slice(-MAX_CORRECTION_ENTRIES).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);

    if (recent.length > 0) {
      const fpExamples = [];
      const fnExamples = [];
      for (const entry of recent) {
        (entry.falsePositives || []).slice(0, 3).forEach(fp => {
          if (fp.text) fpExamples.push(`  - 「${fp.text}」${fp.reason ? `（${fp.reason}）` : ''}`);
        });
        (entry.falseNegatives || []).slice(0, 3).forEach(fn => {
          if (fn.text) fnExamples.push(`  - 「${fn.text}」`);
        });
      }
      if (fpExamples.length > 0 || fnExamples.length > 0) {
        correctionsSection = '\n## 近期使用者回饋（請學習這些模式）\n';
        if (fpExamples.length > 0) {
          correctionsSection += '\n### AI 多刪了，使用者選擇保留：\n' + fpExamples.join('\n') + '\n';
        }
        if (fnExamples.length > 0) {
          correctionsSection += '\n### 使用者手動刪除，AI 沒抓到：\n' + fnExamples.join('\n') + '\n';
        }
      }
    }
  }
} catch (e) {}

// ── 組 prompt ──
const SPLIT_MARKER = '<!-- AUTORESEARCH_END -->';
function buildPrompt(pairsSection) {
  let editable, tail;
  if (PROMPT_RAW.includes(SPLIT_MARKER)) {
    [editable, tail] = PROMPT_RAW.split(SPLIT_MARKER);
  } else {
    editable = PROMPT_RAW;
    tail = '\n## 候選重複對\n{{PAIRS_SECTION}}';
  }
  const filled = editable
    .replace('{{NOTES_SECTION}}', notesSection + outlineSection + correctionsSection)
    .trimEnd();
  const tailFilled = tail
    .replace('{{PAIRS_SECTION}}', pairsSection)
    .trimStart();
  return `${filled}\n\n${tailFilled}`;
}

// ── 格式化一個候選對（實驗 A：加 thought-unit；實驗 C：加音訊特徵）──
function formatPair(pair) {
  const e = pair.earlier;
  const l = pair.later;
  const timeDiff = pair.timeGap != null ? `（間隔 ${pair.timeGap}s）` : '';

  // 實驗 A：thought-unit 上下文
  function unitTag(side) {
    const tu = side.thoughtUnit;
    if (!tu) return '';
    const imp = { core: '核心', support: '支撐', redundant: '冗餘' }[tu.importance] || tu.importance;
    return ` [主題: ${tu.topic} / ${imp}]`;
  }

  // 實驗 C：音訊特徵標籤
  function audioTag(side) {
    const af = side.audioFeatures;
    if (!af) return '';
    const parts = [];
    if (af.speakingRate != null) parts.push(`語速 ${af.speakingRate}字/s`);
    if (af.pauseRatio   != null) parts.push(`停頓 ${af.pauseRatio}%`);
    return parts.length ? ` [${parts.join(', ')}]` : '';
  }

  let out = `[${pair.id}]${timeDiff}\n`;
  if (e.prevText) out += `  前文: …${e.prevText}\n`;
  out += `  A（較早）: ${e.displayText}${unitTag(e)}${audioTag(e)}\n`;
  if (e.nextText) out += `  後文: ${e.nextText}…\n`;
  out += `\n`;
  if (l.prevText) out += `  前文: …${l.prevText}\n`;
  out += `  B（較晚）: ${l.displayText}${unitTag(l)}${audioTag(l)}\n`;
  if (l.nextText) out += `  後文: ${l.nextText}…\n`;
  return out;
}

// ── 呼叫 Claude ──
function callClaude(prompt) {
  const modelFlag = MODEL ? ` --model ${MODEL}` : '';
  const result = execSync(claudeCmd + ' -p -' + modelFlag, {
    input: prompt,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });
  return result.trim();
}

// ── 解析 JSON ──
function parseJSON(raw) {
  const s = raw.trim();
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

// ── 快取工具 ──
function hashPairs(pairs) {
  return crypto.createHash('md5').update(JSON.stringify(pairs)).digest('hex').slice(0, 12);
}

// ── 主程式 ──
const cutInput = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const { phrases, ruleDeletions = [], gapDeletions = [], candidatePairs = [] } = cutInput;

console.log(`📂 cut_input: ${phrases.length} phrases, ${ruleDeletions.length} rule deletions, ${candidatePairs.length} candidate pairs`);

// 初始化輸出 phrases（複製完整 polished 欄位）
const output = phrases.map(p => ({
  ...p,
  aiDelete:           false,
  deleteReason:       null,
  deleteCategory:     null,
  gapDelete:          false,
  gapDeleteReason:    null,
  gapDeleteCategory:  null,
}));

// 套用規則刪除
for (const rd of ruleDeletions) {
  const p = output[rd.phraseIdx];
  if (!p) continue;
  p.aiDelete       = true;
  p.deleteReason   = rd.reason;
  p.deleteCategory = rd.rule;
}
console.log(`✅ 套用規則刪除: ${ruleDeletions.length} 個`);

// 套用 gap 刪除
for (const gd of gapDeletions) {
  const p = output[gd.phraseIdx];
  if (!p) continue;
  p.gapDelete         = true;
  p.gapDeleteReason   = gd.reason;
  p.gapDeleteCategory = 'silence';
}
console.log(`✅ 套用 gap 刪除: ${gapDeletions.length} 個`);

// 分批送候選對給 Claude（有快取機制）
const verdicts = {}; // id → { verdict, reason }
const batches = [];
for (let i = 0; i < candidatePairs.length; i += BATCH_SIZE) {
  batches.push(candidatePairs.slice(i, i + BATCH_SIZE));
}

// ── 快取 ──
const cacheFile = outputFile.replace(/\.json$/, '_pairs_cache.json');
const pairsHash = hashPairs(candidatePairs);
let cacheHit = false;

if (candidatePairs.length > 0 && fs.existsSync(cacheFile)) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.hash === pairsHash && cached.model === (MODEL || 'default')) {
      Object.assign(verdicts, cached.verdicts);
      cacheHit = true;
      console.log(`⚡ 快取命中（hash=${pairsHash}），跳過 ${batches.length} 批 Claude 呼叫`);
    }
  } catch (e) {}
}

let aiDeleteCount = 0;
let keepBothCount = 0;
let failedBatches = 0;

if (!cacheHit)
for (let bi = 0; bi < batches.length; bi++) {
  const batch = batches[bi];
  const pairsSection = batch.map(formatPair).join('\n---\n\n');
  const prompt = buildPrompt(pairsSection);

  console.log(`\n🤖 AI 判斷批次 ${bi + 1}/${batches.length}（${batch.length} 對）[模型: ${MODEL || 'default'}]`);

  try {
    const raw  = callClaude(prompt);
    const json = parseJSON(raw);
    if (!json) {
      console.warn(`  ⚠️ 批次 ${bi + 1} 回傳無法解析，跳過`);
      failedBatches++;
      continue;
    }
    for (const [id, v] of Object.entries(json)) {
      verdicts[id] = v;
    }
    console.log(`  ✅ 批次 ${bi + 1} 完成（${Object.keys(json).length} 個判決）`);
  } catch (e) {
    console.warn(`  ⚠️ 批次 ${bi + 1} Claude 呼叫失敗: ${e.message.slice(0, 80)}`);
    failedBatches++;
  }
}

// 儲存快取（僅在非快取命中且無失敗批次時）
if (!cacheHit && candidatePairs.length > 0 && failedBatches === 0) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ hash: pairsHash, model: MODEL || 'default', ts: new Date().toISOString(), verdicts }, null, 2));
    console.log(`💾 快取已儲存（hash=${pairsHash}）`);
  } catch (e) {
    console.warn(`⚠️ 快取儲存失敗: ${e.message}`);
  }
}

// 合併 AI 對判決
for (const pair of candidatePairs) {
  const v = verdicts[pair.id];
  if (!v) continue;
  const verdict = (v.verdict || '').toLowerCase().trim();

  if (verdict === 'delete_earlier') {
    const p = output[pair.earlier.phraseIdx];
    if (p && !p.aiDelete) {
      p.aiDelete       = true;
      p.deleteReason   = v.reason || `AI: 語意重複，保留後者（${pair.id}）`;
      p.deleteCategory = 'ai_pair';
      aiDeleteCount++;
    }
  } else if (verdict === 'delete_later') {
    const p = output[pair.later.phraseIdx];
    if (p && !p.aiDelete) {
      p.aiDelete       = true;
      p.deleteReason   = v.reason || `AI: 後者不完整，保留前者（${pair.id}）`;
      p.deleteCategory = 'ai_pair';
      aiDeleteCount++;
    }
  } else {
    keepBothCount++;
  }
}

console.log(`\n📊 AI 判決彙整：刪除 ${aiDeleteCount} 個，保留雙方 ${keepBothCount} 個，批次失敗 ${failedBatches}/${batches.length}`);
console.log(`📊 總計刪除：規則 ${ruleDeletions.length} + AI ${aiDeleteCount} = ${ruleDeletions.length + aiDeleteCount} 個`);

// 寫 log 到 2_分析/ai_cut_pairs_log.txt（落地，讓使用者能診斷第二層 AI 真的有跑）
try {
  let deleteEarlier = 0, deleteLater = 0, keepBoth = 0, other = 0;
  for (const pair of candidatePairs) {
    const v = verdicts[pair.id];
    const verdict = ((v && v.verdict) || '').toLowerCase().trim();
    if (verdict === 'delete_earlier') deleteEarlier++;
    else if (verdict === 'delete_later') deleteLater++;
    else if (verdict === 'keep_both') keepBoth++;
    else other++;
  }
  const logLines = [
    `# ai_cut_pairs 執行記錄`,
    `時間：${new Date().toISOString()}`,
    `模型：${MODEL || 'default'}`,
    `輸入候選對：${candidatePairs.length}`,
    `批次：${batches.length}（失敗 ${failedBatches}）`,
    `快取命中：${cacheHit ? '是' : '否'}`,
    ``,
    `## AI 判決分布`,
    `- delete_earlier（刪前留後）：${deleteEarlier}`,
    `- delete_later（刪後留前）：${deleteLater}`,
    `- keep_both（都保留）：${keepBoth}`,
    `- 其他/缺判決：${other}`,
    ``,
    `## 套用結果`,
    `- 規則刪除：${ruleDeletions.length}`,
    `- AI 刪除：${aiDeleteCount}`,
    `- 總刪除：${ruleDeletions.length + aiDeleteCount}`,
    ``,
  ].join('\n');
  const logPath = path.join(path.dirname(outputFile), 'ai_cut_pairs_log.txt');
  fs.writeFileSync(logPath, logLines);
  console.log(`📝 log 已寫出: ${logPath}`);
} catch (e) {
  console.warn(`⚠️ log 寫出失敗: ${e.message}`);
}

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
console.log(`✅ 已寫出: ${outputFile}`);
