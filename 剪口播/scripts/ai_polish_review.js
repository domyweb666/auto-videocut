#!/usr/bin/env node
/**
 * ai_polish_review.js — 第三層整稿潤稿 reviewer
 *
 * 流程位置：ai_cut_pairs（pair-mode 第二層）→ ai_polish_review（本模組）→ 人類審核
 *
 * 動機：ai_cut_pairs 是 pair-by-pair 局部判決，看不到整稿視野；
 *      但「論點冗餘、廢話、不通順」這類問題只有讀完全篇才看得見。
 *      所以前一輪剪掉明顯垃圾後，把剩下的「粗剪稿」整篇交給 Sonnet 做最終潤稿。
 *
 * 用法：
 *   node ai_polish_review.js [--model <model>] [--outline-file <path>] <sentences.json> [output_sentences.json]
 *
 * 不指定 --model 預設 sonnet（整稿潤稿需要強模型，不用 haiku）。
 * 預設原檔覆寫（output_sentences.json 不指定時 = sentences.json）。
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── 解析參數 ──
let MODEL        = 'sonnet';
let OUTLINE_FILE = '';
let PASS         = 'review'; // review | audit
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--model' && process.argv[i + 1]) {
    MODEL = process.argv[++i];
  } else if (a === '--outline-file' && process.argv[i + 1]) {
    OUTLINE_FILE = process.argv[++i];
  } else if (a === '--pass' && process.argv[i + 1]) {
    PASS = process.argv[++i];
  } else {
    positional.push(a);
  }
}
if (PASS !== 'review' && PASS !== 'audit') {
  console.error('❌ --pass 必須是 review 或 audit');
  process.exit(1);
}

const inputFile  = positional[0];
const outputFile = positional[1] || inputFile;

if (!inputFile) {
  console.error('用法: node ai_polish_review.js [--pass review|audit] [--model sonnet] [--outline-file <path>] <sentences.json> [output.json]');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 載入 prompt 模板（依 pass 不同檔）──
const PROMPT_FILENAME = PASS === 'audit'
  ? 'ai_polish_audit_prompt.md'
  : 'ai_polish_review_prompt.md';
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', PROMPT_FILENAME);
let PROMPT_RAW = '';
try {
  PROMPT_RAW = fs.readFileSync(PROMPT_PATH, 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim();
} catch (e) {
  console.error('❌ 無法讀取 prompt: ' + PROMPT_PATH);
  process.exit(1);
}

// ── 載入 sentences ──
const sentences = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
if (!Array.isArray(sentences)) {
  console.error('❌ sentences.json 格式錯誤：應為陣列');
  process.exit(1);
}

// ── 載入 outline（可選） ──
let outlineText = '';
if (OUTLINE_FILE && fs.existsSync(OUTLINE_FILE)) {
  try {
    const outline = JSON.parse(fs.readFileSync(OUTLINE_FILE, 'utf8'));
    if (Array.isArray(outline.units) && outline.units.length > 0) {
      outlineText = '## 影片大綱（thought-units）\n\n';
      outlineText += outline.units.map(u => `- [${u.id}] ${u.topic} (${u.importance || 'normal'})`).join('\n');
      outlineText += '\n\n讀文稿時請對照這個大綱，論點重複請優先刪。';
    }
  } catch (_) { /* ignore */ }
}

// ── 篩出「粗剪稿」：所有未被前面層刪除的 sentence ──
// 為了讓 reviewer 能用穩定 ID 引用，我們用「在 sentences.json 中的原始 index」作為 ID（從 0 開始顯示為 1）
const draft = [];
for (let i = 0; i < sentences.length; i++) {
  const s = sentences[i];
  if (s.aiDelete) continue;             // 已被前一層刪除
  if (s.gapDelete && !s.text) continue; // 純 gap delete，沒有文字
  const text = (s.displayText || s.text || '').trim();
  if (!text) continue;
  draft.push({ id: i, text });
}

console.error(`📖 粗剪稿：${draft.length} 句（總 ${sentences.length} 句中扣除已刪 ${sentences.length - draft.length} 句）`);

if (draft.length < 5) {
  console.error('⚠️ 粗剪稿太短（< 5 句），跳過 reviewer');
  fs.writeFileSync(outputFile, JSON.stringify(sentences, null, 2));
  process.exit(0);
}

// ── 負例庫：讀 user_corrections.jsonl 最近的誤刪 / 漏刪案例，校準 reviewer / audit ──
function loadNegativeExamples(maxFP = 25, maxFN = 15) {
  const corrPath = path.join(__dirname, 'training_output', 'user_corrections.jsonl');
  if (!fs.existsSync(corrPath)) return '';
  let allFP = [], allFN = [];
  try {
    const lines = fs.readFileSync(corrPath, 'utf8').trim().split('\n').filter(Boolean);
    // 從新到舊：reverse 後逐行讀，累積到 cap 為止
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        const vidName = (rec.videoName || '').replace(/\.[^/.]+$/, '');
        for (const fp of (rec.falsePositives || [])) {
          if (allFP.length >= maxFP) break;
          if (fp && fp.text && fp.text.trim().length > 1) {
            allFP.push({ text: fp.text.trim(), reason: (fp.reason || '').slice(0, 80), video: vidName });
          }
        }
        for (const fn of (rec.falseNegatives || [])) {
          if (allFN.length >= maxFN) break;
          if (fn && fn.text && fn.text.trim().length > 1) {
            allFN.push({ text: fn.text.trim(), video: vidName });
          }
        }
      } catch {}
      if (allFP.length >= maxFP && allFN.length >= maxFN) break;
    }
  } catch (e) {
    console.error('⚠️ 讀 user_corrections.jsonl 失敗：' + e.message);
    return '';
  }
  if (allFP.length === 0 && allFN.length === 0) return '';

  let out = '## ⚠️ 過往剪輯校準（這個使用者的個人偏好）\n\n';
  out += '以下是這個使用者過往**修正過 AI 的案例**，你要根據這些校準你的判斷：\n\n';
  if (allFP.length > 0) {
    out += '### 🚫 AI 之前刪錯了（使用者救回）→ 這類**傾向保留**\n\n';
    for (const fp of allFP) {
      out += `- 「${fp.text.slice(0, 80)}」`;
      if (fp.reason) out += `（AI 當時理由：${fp.reason}）`;
      out += '\n';
    }
    out += '\n看到結構/語氣類似的句子，**從寬處置，傾向保留**。\n\n';
  }
  if (allFN.length > 0) {
    out += '### 🎯 AI 之前漏抓了（使用者後來補刪）→ 這類**傾向刪除**\n\n';
    for (const fn of allFN) {
      out += `- 「${fn.text.slice(0, 80)}」\n`;
    }
    out += '\n看到結構/語氣類似的句子，**從嚴處置，傾向刪除**。\n\n';
  }
  out += '上面是個人化校準範例，務必納入判斷。但若稿件本身與校準範例情境差異很大，仍以稿件本身為主，不要硬套。\n';
  console.error(`📚 負例庫：${allFP.length} 筆 FP（誤刪反例）+ ${allFN.length} 筆 FN（漏刪反例）`);
  return out;
}
const negativeExamplesText = loadNegativeExamples();

// ── audit pass：附上 reviewer 的刪除紀錄當 context ──
let reviewerLogText = '';
if (PASS === 'audit') {
  const reviewerLogPath = path.join(path.dirname(outputFile), 'ai_polish_review_log.txt');
  if (fs.existsSync(reviewerLogPath)) {
    try {
      const logContent = fs.readFileSync(reviewerLogPath, 'utf8');
      // 擷取「## 套用清單」段落
      const m = logContent.match(/## 套用清單\n([\s\S]*?)(?:\n## |\n*$)/);
      if (m && m[1].trim()) {
        reviewerLogText = '## 上一道 reviewer 已刪的內容（你不用重複抓這些）\n\n'
                        + m[1].trim() + '\n\n'
                        + '請專注找 reviewer 漏掉的問題。';
      }
    } catch (_) { /* ignore */ }
  }
}

// ── 組 prompt ──
const draftSection = draft.map(d => `[${d.id + 1}] ${d.text}`).join('\n');
const filledPrompt = PROMPT_RAW
  .replace('{{OUTLINE_SECTION}}', outlineText)
  .replace('{{REVIEWER_LOG_SECTION}}', reviewerLogText)
  .replace('{{NEGATIVE_EXAMPLES_SECTION}}', negativeExamplesText)
  .replace('{{DRAFT_SECTION}}', draftSection);

const totalChars = filledPrompt.length;
console.error(`📝 prompt 長度：${totalChars} 字元（約 ${Math.ceil(totalChars / 2)} tokens）`);

// ── 呼叫 Claude ──
function callClaude(prompt) {
  const modelFlag = MODEL ? ` --model ${MODEL}` : '';
  const result = execSync(claudeCmd + ' -p -' + modelFlag, {
    input: prompt,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });
  return result.trim();
}

function parseJSON(raw) {
  const s = raw.trim();
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

console.error(`🤖 呼叫 Claude (${MODEL}) 做整稿潤稿...`);
let raw;
try {
  raw = callClaude(filledPrompt);
} catch (err) {
  console.error('❌ Claude 呼叫失敗: ' + err.message);
  // reviewer 失敗不阻塞 pipeline，原檔不動退出
  fs.writeFileSync(outputFile, JSON.stringify(sentences, null, 2));
  process.exit(0);
}

const parsed = parseJSON(raw);
if (!parsed || !Array.isArray(parsed.deletions)) {
  console.error('❌ JSON 解析失敗，原檔不動。Claude 原始輸出：');
  console.error(raw.slice(0, 500));
  fs.writeFileSync(outputFile, JSON.stringify(sentences, null, 2));
  process.exit(0);
}

// ── 套用 reviewer 的追加刪除 ──
let appliedCount = 0;
const skipped = [];
for (const del of parsed.deletions) {
  // prompt 裡 ID 是 1-based，內部是 0-based
  const idx = (typeof del.id === 'number') ? (del.id - 1) : NaN;
  if (Number.isNaN(idx) || idx < 0 || idx >= sentences.length) {
    skipped.push({ id: del.id, why: 'id 越界' });
    continue;
  }
  const s = sentences[idx];
  if (!s) { skipped.push({ id: del.id, why: 'sentence 不存在' }); continue; }
  if (s.aiDelete) { skipped.push({ id: del.id, why: '已被前層刪除' }); continue; }

  s.aiDelete = true;
  s.deleteReason = (PASS === 'audit' ? 'audit: ' : 'reviewer: ') + (del.reason || '通順度問題');
  s.deleteCategory = (PASS === 'audit') ? 'audit' : 'reviewer';
  appliedCount++;
}

console.error(`\n📊 reviewer 判決：建議追加刪除 ${parsed.deletions.length} 句，實際套用 ${appliedCount} 句，跳過 ${skipped.length} 句`);

// ── 寫 log ──
try {
  const logLines = [
    `# ai_polish_${PASS} 執行記錄`,
    `時間：${new Date().toISOString()}`,
    `模型：${MODEL}`,
    `粗剪稿長度：${draft.length} 句 / ${totalChars} 字元`,
    `reviewer 建議刪除：${parsed.deletions.length}`,
    `實際套用：${appliedCount}`,
    `跳過：${skipped.length}`,
    ``,
    `## 套用清單`,
    ...parsed.deletions
      .filter(d => !skipped.find(x => x.id === d.id))
      .map(d => `- [${d.id}] ${d.reason || ''}`),
    ``,
    `## 跳過清單`,
    ...skipped.map(s => `- [${s.id}] ${s.why}`),
    ``,
  ].join('\n');
  const logPath = path.join(path.dirname(outputFile), `ai_polish_${PASS}_log.txt`);
  fs.writeFileSync(logPath, logLines);
  console.error(`📝 log 已寫出: ${logPath}`);
} catch (e) {
  console.error('⚠️ log 寫出失敗: ' + e.message);
}

fs.writeFileSync(outputFile, JSON.stringify(sentences, null, 2));
console.error(`✅ 已寫出: ${outputFile}`);
