#!/usr/bin/env node
/**
 * 風格抽取（批量版）
 *
 * 把 N 支訓練影片分成 K 批（每批 5 對），各別跑 Claude 抽風格。
 * 最後再讓 Claude 合併 K 份報告 → master style guide。
 *
 * 用法:
 *   node ai_extract_style_batch.js [--per-batch 5] [--out master_style_guide.md] [video_name ...]
 *   若沒給 video_name，自動掃描 training_output/ 下所有有配對的影片
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

let perBatch = 5;
let outFile  = path.join(TRAINING_DIR, 'master_style_guide.md');
const explicit = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--per-batch' && process.argv[i + 1]) perBatch = parseInt(process.argv[++i]);
  else if (a === '--out' && process.argv[i + 1]) outFile = process.argv[++i];
  else explicit.push(a);
}

let videos = explicit;
if (videos.length === 0) {
  videos = fs.readdirSync(TRAINING_DIR)
    .filter(d => {
      const dir = path.join(TRAINING_DIR, d);
      if (!fs.statSync(dir).isDirectory()) return false;
      return fs.existsSync(path.join(dir, '1_轉錄', 'subtitles_words.json')) &&
             fs.existsSync(path.join(dir, '2_分析', 'edited_words.json'));
    })
    .sort();
}

console.error(`📚 共 ${videos.length} 支訓練影片，每批 ${perBatch} 對`);

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

function getText(jsonFile) {
  return JSON.parse(fs.readFileSync(jsonFile, 'utf8')).filter(w => !w.isGap).map(w => w.text).join('');
}

// ── Step A: 各批跑 ai_extract_style.js (in-memory，避免 IO)──
function runBatch(batchVideos, batchIdx, totalBatches) {
  const pairs = [];
  for (const name of batchVideos) {
    const raw    = path.join(TRAINING_DIR, name, '1_轉錄', 'subtitles_words.json');
    const edited = path.join(TRAINING_DIR, name, '2_分析', 'edited_words.json');
    pairs.push({ name, rawText: getText(raw), editedText: getText(edited) });
  }

  let prompt = `你是剪輯研究員。以下是同一位 YouTuber 親自處理的 ${pairs.length} 對「原始口語逐字稿 → 編輯後逐字稿」配對。

仔細比對，找出這位編輯者**一致使用的剪輯決策模式**。

## 重要要求
1. 不要講廢話（「刪贅字」「刪重複」）。要講具體可操作的規則。
2. 每條規則引用至少 1 個跨配對的具體例子（直接從原文/編輯後抓字串對照）。
3. 標出規則的優先順序與反例邊界。
4. 標出每條規則的**信心度**：出現於幾對配對中？

## 輸出格式（嚴格遵循）

# 編輯者風格觀察 - 批 ${batchIdx + 1}/${totalBatches}

## 規則 1: <短名稱>
**現象**: <具體描述>
**例子**:
- (配對 N - 影片名) 原文 "XXX" → 編輯後 "YYY"
**信心**: 高/中/低（出現於 X/${pairs.length} 對）

## 規則 2: ...

## 整體觀察
<3-5 句>

## 配對

`;

  pairs.forEach((p, i) => {
    prompt += `\n### 配對 ${i + 1}: ${p.name}\n\n**原始 (${p.rawText.length} 字)**:\n${p.rawText}\n\n**編輯後 (${p.editedText.length} 字)**:\n${p.editedText}\n`;
  });

  console.error(`\n📤 批 ${batchIdx + 1}/${totalBatches}（${pairs.length} 對，prompt ${prompt.length} 字）...`);

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
    console.error(`   ❌ 批 ${batchIdx + 1} 失敗: ${err.message}`);
    return null;
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`   ✅ ${output.length} 字（${elapsed}s）`);
  return output;
}

// 切批
const batches = [];
for (let i = 0; i < videos.length; i += perBatch) {
  batches.push(videos.slice(i, i + perBatch));
}

const reports = [];
for (let i = 0; i < batches.length; i++) {
  const r = runBatch(batches[i], i, batches.length);
  if (r) reports.push({ batch: i + 1, videos: batches[i], report: r });
}

console.error(`\n📊 收到 ${reports.length}/${batches.length} 份報告`);

// 存批量報告（除錯用）
const batchOutFile = outFile.replace(/\.md$/, '_batches.md');
const batchContent = reports.map(r => `\n\n=== 批 ${r.batch}（${r.videos.join(', ')}）===\n\n${r.report}`).join('\n');
fs.writeFileSync(batchOutFile, batchContent);
console.error(`📄 批量報告: ${batchOutFile}`);

if (reports.length === 0) {
  console.error(`❌ 所有批次都失敗`);
  process.exit(1);
}

// ── Step B: 合併 K 份報告 → master style guide ──
console.error(`\n🔀 合併 ${reports.length} 份批報告為 master style guide...`);

const mergePrompt = `你是剪輯研究員。以下是同一位 YouTuber 風格的 ${reports.length} 份**獨立批次風格觀察報告**（每份基於 ${perBatch} 對配對，總計 ${videos.length} 支影片）。

請合併成一份**master style guide**：

## 合併原則

1. **找出跨批次穩定的規則** — 至少 ${Math.ceil(reports.length / 2)} 份報告中都有出現的，列為「核心規則」
2. **找出只在某些批次出現的規則** — 列為「條件性規則」並標明何種條件下觸發
3. **去除矛盾或不一致的觀察** — 若 A 批說「保留後版」B 批說「保留前版」，就降信心或合併描述
4. **保留具體例子** — 從各批引用最具代表性的 1-2 個例子，不要全保留
5. **加上覆蓋率評估** — 規則涵蓋多少 % 的訓練配對？

## 輸出格式

# 編輯者風格守則（master）

## 核心規則（高信心，跨多批次出現）

### 規則 1: <名稱>
**現象**: ...
**信心**: 出現於 X/${reports.length} 批次（覆蓋約 Y% 配對）
**例子**:
- ...
**可機械化**: 是 / 否（簡述）

### 規則 2: ...

## 條件性規則（特定情境才觸發）

### 規則 N: <名稱>
**觸發條件**: ...
**現象**: ...
**信心**: 出現於 X/${reports.length} 批次

## 整體觀察

<5-8 句總結這位編輯者的編輯哲學，特別是跨批次都看到的核心特徵>

## 機械化規則建議（給工程實作參考）

<列出哪些規則簡單到可以寫成程式判斷（例如 regex / 字串比對），哪些必須靠 LLM 語義理解>

## 各批次風格觀察報告

`;

const fullMerge = mergePrompt + reports.map(r => `\n\n=== 批 ${r.batch} ===\n\n${r.report}`).join('\n');
console.error(`📤 合併 prompt ${fullMerge.length} 字...`);

const mergeStart = Date.now();
let masterGuide;
try {
  masterGuide = llmExec('', {
    input:     fullMerge,
    encoding:  'utf8',
    timeout:   900000,
    maxBuffer: 20 * 1024 * 1024,
    stdio:     ['pipe', 'pipe', 'pipe'],
    shell:     true
  }).trim();
} catch (err) {
  console.error(`❌ 合併失敗: ${err.message}`);
  process.exit(1);
}
const mergeElapsed = ((Date.now() - mergeStart) / 1000).toFixed(1);

fs.writeFileSync(outFile, masterGuide);
console.error(`\n✅ Master style guide: ${outFile}（${masterGuide.length} 字，${mergeElapsed}s）`);

// 簡易品質指標
const coreCount = (masterGuide.match(/^### 規則 \d/gm) || []).length;
console.error(`\n📊 抽到 ${coreCount} 條規則`);
