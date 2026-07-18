#!/usr/bin/env node
/**
 * 風格抽取實驗 (Step 1)
 *
 * 餵 Claude N 對 (原始逐字稿, 編輯後逐字稿) 配對，問它能否觀察出
 * 編輯者的刪除/保留決策模式。
 *
 * 目的: 驗證「逆向工程編輯風格」這個假設是否可行。
 *      若 Claude 能輸出實質規則 + 具體例子 → 假設可行，繼續做
 *      ai_narrative_pass.js 的風格注入版本。
 *
 * 用法: node ai_extract_style.js <video_name> [video_name2 ...]
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

const videos = process.argv.slice(2);
if (videos.length === 0) {
  console.error('用法: node ai_extract_style.js <video_name> [video_name2 ...]');
  process.exit(1);
}

function getText(jsonFile) {
  const arr = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  return arr.filter(w => !w.isGap).map(w => w.text).join('');
}

const pairs = [];
for (const name of videos) {
  const raw    = path.join(TRAINING_DIR, name, '1_轉錄', 'subtitles_words.json');
  const edited = path.join(TRAINING_DIR, name, '2_分析', 'edited_words.json');
  if (!fs.existsSync(raw) || !fs.existsSync(edited)) {
    console.error(`❌ ${name}: 缺檔，跳過`);
    continue;
  }
  const rawText    = getText(raw);
  const editedText = getText(edited);
  pairs.push({ name, rawText, editedText });
  console.error(`✅ ${name}: 原始 ${rawText.length} 字 → 編輯後 ${editedText.length} 字（刪 ${(100 - editedText.length/rawText.length*100).toFixed(0)}%）`);
}

if (pairs.length === 0) { console.error('沒有有效配對'); process.exit(1); }

// 組 prompt
let prompt = `你是一位剪輯研究員。以下是同一位 YouTuber 親自處理過的 ${pairs.length} 對「原始口語逐字稿 → 編輯後逐字稿」配對。

## 你的任務

仔細比對 5 對配對，找出這位編輯者**一致使用的剪輯決策模式**——也就是哪些東西他**幾乎總是會刪**、哪些他**幾乎總是會留**。

### 重要要求

1. **不要講大家都知道的廢話**（例如「刪贅字」「刪重複」）。要講具體可操作的規則，例如「同一個論點講兩次時，他傾向保留**較完整、較後出現**的那次」
2. **每條規則必須引用至少 1 個跨配對的具體例子**——直接從原文/編輯後抓字串對照
3. **指出規則的優先順序**（兩條規則衝突時誰勝）
4. **標出反例**（規則的邊界 / 例外情況）
5. **規則信心度**：出現於幾對配對中？

### 輸出格式（嚴格遵循 markdown 結構）

\`\`\`
# 編輯者風格觀察

## 規則 1: <短名稱>
**現象**: <具體描述>
**例子**:
- (配對 N - 影片名) 原文 "XXX" → 編輯後 "YYY"，因為 ...
- (配對 M - 影片名) 原文 "AAA" → 編輯後 "BBB"，因為 ...
**信心**: 高/中/低（出現於 X/${pairs.length} 對配對）

## 規則 2: ...
...

## 整體觀察
<3-5 句你對這位編輯者整體風格的判斷>

## 可機械化的規則建議
<列出哪幾條規則簡單到可以寫成程式判斷，哪幾條只能靠 LLM>
\`\`\`

不要用 \`\`\` 包整份輸出。直接從 \`# 編輯者風格觀察\` 開始。

## 配對

`;

pairs.forEach((p, i) => {
  prompt += `\n### 配對 ${i + 1}: ${p.name}\n\n**原始 (${p.rawText.length} 字)**:\n${p.rawText}\n\n**編輯後 (${p.editedText.length} 字)**:\n${p.editedText}\n`;
});

console.error(`\n📤 送 ${pairs.length} 對給 Claude（總計 prompt ${prompt.length} 字）...`);

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

const start = Date.now();
let output;
try {
  output = llmExec('', {
    input:     prompt,
    encoding:  'utf8',
    timeout:   600000,
    maxBuffer: 20 * 1024 * 1024,
    stdio:     ['pipe', 'pipe', 'pipe'],
    shell:     true
  }).trim();
} catch (err) {
  console.error('❌ Claude 失敗:', err.message);
  process.exit(1);
}
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

const outFile = path.join(TRAINING_DIR, 'style_extraction.md');
fs.writeFileSync(outFile, output);

console.error(`\n✅ Claude 回 ${output.length} 字（耗時 ${elapsed}s）`);
console.error(`📄 ${outFile}`);

// 簡易品質指標
const ruleCount    = (output.match(/^## 規則/gm) || []).length;
const exampleCount = (output.match(/配對 \d+/g) || []).length;
const hasOverall   = /^## 整體觀察/m.test(output);
const hasMech      = /^## 可機械化的規則建議/m.test(output);

console.error(`\n📊 品質指標:`);
console.error(`   規則條數:        ${ruleCount}`);
console.error(`   引用配對例子:    ${exampleCount}`);
console.error(`   含「整體觀察」:  ${hasOverall ? '✅' : '❌'}`);
console.error(`   含「可機械化建議」: ${hasMech ? '✅' : '❌'}`);

if (ruleCount >= 3 && exampleCount >= ruleCount && hasOverall) {
  console.error(`\n🎯 結果: 假設**可行**——Claude 抽出實質規則 + 配對例子。建議繼續做風格注入。`);
} else {
  console.error(`\n⚠️ 結果: 假設**待商榷**——抽出規則 < 3 條或缺乏跨配對例子。可能需要更多配對或更精準的 prompt。`);
}
