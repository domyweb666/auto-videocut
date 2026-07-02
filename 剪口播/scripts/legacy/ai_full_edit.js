#!/usr/bin/env node
/**
 * AI 整段文稿編輯模式（並行於現有規則層的新模式）
 *
 * 把整篇潤飾後的文稿一次丟給 Claude，請它做整體可讀性編輯
 * （只能刪不能改寫），再用字級對齊演算法把保留版本映射回原始 word 索引。
 *
 * 用法:
 *   node ai_full_edit.js [--model <model>] <polished.json> <subtitles_words.json> [output_path]
 *
 * 預設輸出: 與 polished.json 同目錄的 auto_selected_full.json
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { alignKeptText } = require('./lib/align_kept_text');

// ── 解析參數 ──
let MODEL = '';
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--model' && process.argv[i + 1]) {
    MODEL = process.argv[++i];
  } else {
    positional.push(a);
  }
}

const polishedFile = positional[0];
const wordsFile    = positional[1];
const outputFile   = positional[2]
  || (polishedFile && path.join(path.dirname(polishedFile), 'auto_selected_full.json'));

if (!polishedFile || !wordsFile) {
  console.error('用法: node ai_full_edit.js [--model <model>] <polished.json> <subtitles_words.json> [output_path]');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 載入 prompt 模板 ──
const PROMPT_TEMPLATE_PATH = path.join(__dirname, '..', 'prompts', 'ai_full_edit_prompt.md');
let PROMPT_TEMPLATE_RAW;
try {
  PROMPT_TEMPLATE_RAW = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim();
} catch (e) {
  console.error(`❌ 無法讀取 prompt 模板: ${PROMPT_TEMPLATE_PATH}`);
  process.exit(1);
}

// ── 讀取 NOTES（專有名詞 / guidelines）──
let notesSection = '';
try {
  const configPath = path.join(__dirname, '..', 'training_config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const notes = config.notes || {};
    if (notes.proper_nouns && notes.proper_nouns.length > 0) {
      notesSection += `\n## 專有名詞（必須保留，不可拆字）\n${notes.proper_nouns.join('、')}\n`;
    }
    if (notes.guidelines) {
      notesSection += `\n## 注意事項\n${notes.guidelines}\n`;
    }
  }
} catch (e) {}

// ── 讀取輸入 ──
const phrases = JSON.parse(fs.readFileSync(polishedFile, 'utf8'));
const words   = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));

console.error(`📖 載入：${phrases.length} 段、${words.length} 個 word（含 gap）`);

// ── 組裝整篇文稿（用 displayText 給 Claude 看；對齊用 raw text）──
const inputText = phrases
  .map(p => p.displayText || p.text)
  .join('\n');

const charCount = inputText.length;
console.error(`📝 整篇文稿 ${charCount} 字`);

if (charCount > 20000) {
  console.error(`⚠️ 文稿超過 2 萬字，可能逼近 Claude 單次回應上限，建議考慮分段（本版未實作）`);
}

// ── 組 prompt ──
const prompt = PROMPT_TEMPLATE_RAW
  .replace('{{NOTES_SECTION}}', notesSection)
  .replace('{{INPUT_TEXT}}', inputText);

// ── 呼叫 Claude ──
console.error(`\n🤖 呼叫 Claude [模型: ${MODEL || 'default'}]...`);
const startTime = Date.now();

let keptText;
try {
  const modelFlag = MODEL ? ` --model ${MODEL}` : '';
  keptText = execSync(claudeCmd + ' -p -' + modelFlag, {
    input:     prompt,
    encoding:  'utf8',
    timeout:   600000,
    maxBuffer: 20 * 1024 * 1024,
    stdio:     ['pipe', 'pipe', 'pipe'],
    shell:     true
  }).trim();
} catch (err) {
  const errMsg = ((err.stdout && err.stdout.toString()) || '')
               + ((err.stderr && err.stderr.toString()) || '')
               + (err.message || '');
  console.error(`❌ Claude 呼叫失敗: ${err.message}`);
  if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
    console.error('   請確認 claude CLI 已安裝（執行 claude --version 確認）');
  }
  process.exit(1);
}

// 移除可能的 ```text ... ``` 包裝
keptText = keptText
  .replace(/^```(?:text|markdown|md)?\s*\n/i, '')
  .replace(/\n```\s*$/, '')
  .trim();

// 後處理防呆：截掉 Claude 違規附加的「刪除記錄」表格、總結、分隔線後段落
// 觸發 marker（任一行只含這些就視為不該保留）
const TRIM_MARKERS = [
  /^---+\s*$/,           // markdown 水平線
  /^\*\*\*+\s*$/,
  /^___+\s*$/,
  /^#+\s+/,              // markdown 標題
  /^\*\*[^*]*[:：][\s\S]*\*\*\s*$/, // **粗體標題：**
  /^\|.*\|.*\|/,         // markdown 表格列
];
function shouldTrimAt(line) {
  return TRIM_MARKERS.some(re => re.test(line));
}
{
  const lines = keptText.split('\n');
  let cutAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (shouldTrimAt(lines[i].trim())) { cutAt = i; break; }
  }
  if (cutAt >= 0) {
    const removedLines = lines.length - cutAt;
    keptText = lines.slice(0, cutAt).join('\n').trim();
    console.error(`⚠️ 後處理：偵測到第 ${cutAt + 1} 行為違規 marker，截掉後 ${removedLines} 行`);
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.error(`✅ Claude 回應 ${keptText.length} 字（耗時 ${elapsed}s）`);

// ── 對齊 ──
console.error(`\n🔗 對齊保留文字到字級索引...`);
const alignResult = alignKeptText(keptText, phrases, words);

console.error(`   原文字數（去標點）: ${alignResult.stats.origChars}`);
console.error(`   保留字數（去標點）: ${alignResult.stats.keptChars}`);
console.error(`   匹配 wordIdx 數:    ${alignResult.stats.matched}`);
console.error(`   被刪 wordIdx 數:    ${alignResult.stats.skipped}`);

if (alignResult.deletionRuns.length > 0) {
  const sumLen = alignResult.deletionRuns.reduce((s, r) => s + r.length, 0);
  console.error(`   大段刪除（≥30字）${alignResult.deletionRuns.length} 處，共 ${sumLen} 字`);
}

if (alignResult.warnings.length > 0) {
  console.error(`\n⚠️ 對齊警告 ${alignResult.warnings.length} 條（Claude 違反「只刪不寫」約束）：`);
  for (const w of alignResult.warnings) {
    console.error(`   ${w}`);
  }
} else {
  console.error(`   ✅ Claude 完全遵守「只刪不寫」約束（無對齊失敗）`);
}

// ── 組 auto_selected_full.json ──
const reasons = {};
for (const idx of alignResult.deletedWordIndices) {
  reasons[idx] = 'AI 整段編輯模式刪除';
}

const output = {
  indices: alignResult.deletedWordIndices,
  reasons,
  mode: 'full_edit',
  alignment_warnings: alignResult.warnings,
  deletion_runs: alignResult.deletionRuns,
  stats: alignResult.stats,
  meta: {
    model: MODEL || 'default',
    elapsed_seconds: parseFloat(elapsed),
    input_chars: charCount,
    kept_chars: keptText.length
  }
};

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

// 順便存一份 Claude 的原始輸出，方便除錯
const keptTextFile = path.join(path.dirname(outputFile), 'kept_text_full_edit.txt');
fs.writeFileSync(keptTextFile, keptText);

console.error(`\n✅ 完成`);
console.error(`   📄 刪除清單: ${outputFile}`);
console.error(`   📄 Claude 原始輸出: ${keptTextFile}`);
console.error(`   🗑️  刪除 ${alignResult.deletedWordIndices.length} 個 word`);
