#!/usr/bin/env node
/**
 * AI 文稿潤飾（Phase 1：只加標點，不判斷刪除）
 *
 * 接收 Whisper 逐字稿，用 Claude 為每個短語段落加上中文標點符號。
 * 不做任何刪除判斷，輸出供 ai_cut.js 做第二階段剪輯判斷。
 *
 * 用法: node ai_polish.js [--model <model>] [--skills-file <path>] <subtitles_words.json> [output_polished.json]
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

// ── 解析參數 ──
let POLISH_MODEL = '';
let SKILLS_FILE  = '';
const _positionalArgs = [];
for (let _i = 2; _i < process.argv.length; _i++) {
  const a = process.argv[_i];
  if (a === '--model' && process.argv[_i + 1]) {
    POLISH_MODEL = process.argv[++_i];
  } else if (a === '--skills-file' && process.argv[_i + 1]) {
    SKILLS_FILE = process.argv[++_i];
  } else {
    _positionalArgs.push(a);
  }
}

const wordsFile  = _positionalArgs[0];
const outputFile = _positionalArgs[1]
  || (_positionalArgs[0] && path.join(path.dirname(_positionalArgs[0]), 'polished.json'));

if (!wordsFile) {
  console.error('用法: node ai_polish.js [--model <model>] [--skills-file <path>] <subtitles_words.json> [output_polished.json]');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 載入 prompt 模板 ──
const PROMPT_TEMPLATE_PATH = path.join(__dirname, '..', 'prompts', 'ai_polish_prompt.md');
let PROMPT_TEMPLATE_RAW = '';
try {
  PROMPT_TEMPLATE_RAW = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim();
} catch (e) {
  console.error(`❌ 無法讀取 prompt 模板: ${PROMPT_TEMPLATE_PATH}`);
  process.exit(1);
}

// ── 回傳格式（寫死在程式，不允許模板改）──
const RETURN_FORMAT_BLOCK = `## 回傳格式
JSON 物件，只含 texts：

{
  "texts": {
    "0": "嗨，大家好，",
    "1": "第一步是列出預算，",
    "2": "那第二步是什麼呢？"
  }
}

- key 為段落編號（字串），value 為加上標點的文字
- **所有段落都要有 texts 條目**（不可省略任何段落）
- 只回傳 JSON，不要其他文字`;

/**
 * 從模板生成最終 prompt。
 * ai_polish_prompt.md 沒有 AUTORESEARCH_END 分隔線，整份視為 editable。
 */
function buildPrompt(notesSection, inputLines) {
  const filled = PROMPT_TEMPLATE_RAW.replace('{{NOTES_SECTION}}', notesSection);
  const withInput = filled.replace('{{INPUT_LINES}}', inputLines);
  // 把 RETURN_FORMAT_BLOCK 插在 INPUT_LINES 前（即段落之前）
  const splitMarker = '## 段落：';
  const splitIdx = withInput.lastIndexOf(splitMarker);
  if (splitIdx === -1) {
    return `${withInput}\n\n${RETURN_FORMAT_BLOCK}\n\n## 段落：\n${inputLines}`;
  }
  const before = withInput.slice(0, splitIdx).trimEnd();
  const after  = withInput.slice(splitIdx);
  return `${before}\n\n${RETURN_FORMAT_BLOCK}\n\n${after}`;
}

// ── 讀取潤飾 Skills（供 {{NOTES_SECTION}} 填入）──
let polishSkills = '';
try {
  const skillsPath = SKILLS_FILE
    ? path.resolve(SKILLS_FILE)
    : path.join(__dirname, '..', 'polishing_skills.md');
  if (fs.existsSync(skillsPath)) {
    polishSkills = fs.readFileSync(skillsPath, 'utf8')
      .replace(/^<!--[\s\S]*?-->\s*/gm, '')
      .trim();
    console.log('📚 已載入潤飾 Skills');
  }
} catch (e) {}

// ── 讀取訓練設定（專有名詞等）──
let notes = {};
try {
  const configPath = path.join(__dirname, '..', 'training_config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    notes = config.notes || {};
  }
} catch (e) {}

// ── 讀取逐字稿 ──
const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));

// ── 第一步：用 gap 分割成短語（與 ai_sentencize.js 相同邏輯）──
const PHRASE_GAP = 0.3;
const phrases = [];
let curr = { text: '', wordIndices: [], gapIndices: [], startTime: 0, endTime: 0 };

words.forEach((w, i) => {
  if (w.isGap) {
    const dur = w.end - w.start;
    if (dur >= PHRASE_GAP && curr.text.length > 0) {
      curr.gapAfter    = dur;
      curr.gapAfterIdx = i;
      phrases.push({ ...curr });
      curr = { text: '', wordIndices: [], gapIndices: [], startTime: 0, endTime: 0 };
    } else if (dur < PHRASE_GAP) {
      curr.gapIndices.push(i);
    }
  } else {
    if (curr.wordIndices.length === 0) curr.startTime = w.start;
    curr.text += w.text;
    curr.endTime = w.end;
    curr.wordIndices.push(i);
  }
});
if (curr.text.length > 0) phrases.push(curr);

console.log(`📝 共 ${phrases.length} 個短語段落`);

// ── 第二步：分批送 AI 加標點 ──
// 150：每批更多段落，可攤薄 prompt 頭部（NOTES_SECTION + 規則）的固定開銷，省 ~15% token
const BATCH_SIZE = 150;
const batches = [];
for (let i = 0; i < phrases.length; i += BATCH_SIZE) {
  batches.push({ startIdx: i, items: phrases.slice(i, i + BATCH_SIZE) });
}

// 組 NOTES_SECTION
let notesSection = '';
if (polishSkills) {
  notesSection += `\n## 潤飾風格說明書（請嚴格遵循）\n${polishSkills}\n`;
}
if (notes.proper_nouns && notes.proper_nouns.length > 0) {
  notesSection += `\n## 專有名詞參考（不可拆字）\n${notes.proper_nouns.join('、')}\n`;
}
if (notes.guidelines) {
  notesSection += `\n## 注意事項\n${notes.guidelines}\n`;
}

let successBatches = 0;

for (let bi = 0; bi < batches.length; bi++) {
  const batch      = batches[bi];
  const batchPhrases = batch.items;
  const offset     = batch.startIdx;

  console.log(`\n🤖 潤飾批次 ${bi + 1}/${batches.length}（${batchPhrases.length} 段，編號 ${offset}–${offset + batchPhrases.length - 1}）[模型: ${POLISH_MODEL || 'default'}]`);

  const inputLines = batchPhrases.map((p, idx) => {
    const gap = p.gapAfter ? ` [停${p.gapAfter.toFixed(1)}s]` : '';
    return `[${offset + idx}] ${p.text}${gap}`;
  }).join('\n');

  const prompt = buildPrompt(notesSection, inputLines);

  try {
    const modelFlag = POLISH_MODEL ? ` --model ${POLISH_MODEL}` : '';
    const result = llmExec(modelFlag, {
      input:     prompt,
      encoding:  'utf8',
      timeout:   600000,
      maxBuffer: 10 * 1024 * 1024,
      stdio:     ['pipe', 'pipe', 'pipe'],
      shell:     true
    });

    // ── 解析 JSON ──
    let parsed;
    try {
      parsed = JSON.parse(result.trim());
    } catch {
      const objMatch = result.match(/\{[\s\S]*\}(?=\s*$)/);
      if (objMatch) {
        parsed = JSON.parse(objMatch[0]);
      } else {
        const anyObj = result.match(/\{[\s\S]*\}/);
        parsed = anyObj ? JSON.parse(anyObj[0]) : { texts: {} };
      }
    }

    const texts = parsed.texts || {};

    // ── 套用標點 ──
    let punctCount = 0;
    for (const [idxStr, pText] of Object.entries(texts)) {
      const actualIdx = parseInt(idxStr);
      if (actualIdx >= 0 && actualIdx < phrases.length && pText) {
        phrases[actualIdx].displayText = pText;
        punctCount++;
      }
    }
    console.log(`   📝 ${punctCount} 段已加標點`);
    successBatches++;

  } catch (err) {
    // claude CLI 錯誤可能在 stdout 或 stderr
    const errMsg = ((err.stdout && err.stdout.toString()) || '')
                 + ((err.stderr && err.stderr.toString()) || '')
                 + (err.message || '');
    console.error(`   ⚠️ 潤飾批次 ${bi + 1} 失敗: ${err.message}`);
    if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
      console.error('   ❌ 找不到 claude CLI，請確認已安裝 Claude Code');
    }
  }
}

// ── 確認成功率 ──
if (successBatches === 0) {
  console.error(`\n❌ 所有 ${batches.length} 批潤飾均失敗，請確認 claude CLI 可用`);
  console.error('   嘗試執行: claude --version');
  process.exit(1);
}

// ── 補全未被 AI 處理的段落（displayText 預設等於 text）──
let fallbackCount = 0;
for (const p of phrases) {
  if (!p.displayText) {
    p.displayText = p.text;
    fallbackCount++;
  }
}
if (fallbackCount > 0) {
  console.log(`   ⚠️ ${fallbackCount} 段 AI 未回應，已用原文補齊`);
}

// ── 輸出（只含潤飾結果，不含 aiDelete 欄位）──
fs.writeFileSync(outputFile, JSON.stringify(phrases, null, 2));

const totalPunct = phrases.filter(p => p.displayText && p.displayText !== p.text).length;
console.log(`\n✅ 潤飾完成:`);
console.log(`   📊 共 ${phrases.length} 段，${totalPunct} 段加了標點（${fallbackCount} 段使用原文）`);
console.log(`   📄 輸出: ${outputFile}`);
