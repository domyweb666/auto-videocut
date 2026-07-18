#!/usr/bin/env node
/**
 * 敘事層風格抽取（X→Y 批量版，支援增量更新）
 *
 * X = 規則層輸出後保留的文本（A 廚師剪完）
 * Y = 人工最終版（edited_words.json）
 *
 * 學習 X→Y 之間「B 廚師應該做什麼」的敘事決策模式，
 * 產出「敘事層專屬守則」narrative_style_guide.md，
 * 再注入 ai_narrative_pass.js 的 prompt。
 *
 * 用法:
 *   node ai_extract_narrative_style_batch.js [--per-batch 5] [--out narrative_style_guide.md] [--incremental] [video_name ...]
 *
 * --incremental: 只處理新影片，與現有守則合併（避免重跑舊影片）
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

let perBatch    = 3;
let outFile     = path.join(TRAINING_DIR, 'narrative_style_guide.md');
let incremental = false;
const explicit  = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--per-batch' && process.argv[i + 1]) perBatch = parseInt(process.argv[++i]);
  else if (a === '--out' && process.argv[i + 1]) outFile = process.argv[++i];
  else if (a === '--incremental') incremental = true;
  else explicit.push(a);
}

const PROCESSED_FILE = path.join(TRAINING_DIR, 'narrative_style_guide_processed.json');
const HOLDOUT_FILE   = path.join(TRAINING_DIR, 'narrative_style_guide_holdout.json');

// 讀 holdout 清單（永不參與訓練的影片）
let holdoutSet = new Set();
try {
  if (fs.existsSync(HOLDOUT_FILE)) {
    const ho = JSON.parse(fs.readFileSync(HOLDOUT_FILE, 'utf8'));
    holdoutSet = new Set(ho.holdout || []);
    if (holdoutSet.size > 0) {
      console.error(`🔒 已排除 ${holdoutSet.size} 支 holdout 影片：${[...holdoutSet].join(', ')}`);
    }
  }
} catch (e) {
  console.error(`⚠️ holdout 清單讀取失敗：${e.message}`);
}

// 讀已處理清單
function readProcessed() {
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
  } catch { return { processed: [] }; }
}
function saveProcessed(names) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify({ processed: names, lastUpdated: new Date().toISOString() }, null, 2));
}

// 掃描所有有效配對影片（自動排除 holdout）
const allVideos = fs.readdirSync(TRAINING_DIR)
  .filter(d => {
    const dir = path.join(TRAINING_DIR, d);
    if (!fs.statSync(dir).isDirectory()) return false;
    if (holdoutSet.has(d)) return false;
    return fs.existsSync(path.join(dir, '1_轉錄', 'subtitles_words.json')) &&
           fs.existsSync(path.join(dir, '2_分析', 'edited_words.json'));
  })
  .sort();

// 顯式傳入的影片名也濾掉 holdout（避免誤用）
let videos = explicit.length > 0
  ? explicit.filter(v => !holdoutSet.has(v))
  : allVideos;

if (explicit.length > 0 && videos.length < explicit.length) {
  const skipped = explicit.filter(v => holdoutSet.has(v));
  console.error(`⚠️ 已忽略 holdout 影片：${skipped.join(', ')}`);
}

// 增量模式：只跑新影片
let processedRecord = readProcessed();
if (incremental && explicit.length === 0) {
  const processedSet = new Set(processedRecord.processed);
  const newVideos = allVideos.filter(v => !processedSet.has(v));
  if (newVideos.length === 0) {
    console.error(`✅ 無新影片，守則已是最新（${processedRecord.processed.length} 支已處理）`);
    process.exit(0);
  }
  console.error(`🆕 增量模式：${newVideos.length} 支新影片（跳過已處理的 ${processedRecord.processed.length} 支）`);
  videos = newVideos;
}

console.error(`📚 共 ${videos.length} 支訓練影片，每批 ${perBatch} 對${incremental ? '（增量）' : ''}`);

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// 取得規則層輸出後的保留文本（X）
function getXText(videoDir, videoName) {
  const subs    = path.join(videoDir, '1_轉錄', 'subtitles_words.json');
  const measOut = path.join(videoDir, '2_分析', 'auto_selected_measure.json');

  execSync(`node auto_select_rules.js "${subs}" "${measOut}"`, {
    cwd: SCRIPT_DIR, encoding: 'utf8', shell: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rulesResult = JSON.parse(fs.readFileSync(measOut, 'utf8'));
  const deleteSet   = new Set(Array.isArray(rulesResult) ? rulesResult : (rulesResult.indices || []));
  const words       = JSON.parse(fs.readFileSync(subs, 'utf8'));

  return words
    .filter((w, i) => !w.isGap && !deleteSet.has(i))
    .map(w => w.text)
    .join('');
}

// 取得人工最終版文本（Y）
function getYText(videoDir) {
  const edited = path.join(videoDir, '2_分析', 'edited_words.json');
  return JSON.parse(fs.readFileSync(edited, 'utf8'))
    .filter(w => !w.isGap)
    .map(w => w.text)
    .join('');
}

// ── Step A: 各批跑風格抽取 ──
function runBatch(batchVideos, batchIdx, totalBatches) {
  const pairs = [];
  for (const name of batchVideos) {
    const dir = path.join(TRAINING_DIR, name);
    try {
      const xText = getXText(dir, name);
      const yText = getYText(dir);
      // 只收錄 X 跟 Y 有差異的影片（若規則層已完美對齊人工版，則無敘事層資訊）
      if (xText.length > 0 && yText.length > 0 && xText !== yText) {
        pairs.push({ name, xText, yText });
      } else {
        console.error(`   ⏭️ ${name}: X=Y，規則層已完美對齊，跳過`);
      }
    } catch (e) {
      console.error(`   ❌ ${name}: ${e.message}`);
    }
  }

  if (pairs.length === 0) {
    console.error(`   ⚠️ 批 ${batchIdx + 1}: 無有效配對`);
    return null;
  }

  const prompt = `你是剪輯研究員，專門研究一位 YouTuber 的**敘事剪輯決策**。

背景說明：
- **X（規則層之後）**：機械規則已自動處理了逐字重複、咳嗽聲、靜音、開場問候等。X 是規則層清理後的「乾淨口語文稿」。
- **Y（人工最終版）**：編輯者在 X 基礎上，再做了一次**敘事級判斷**，進一步精簡。
- 你的任務：找出 X→Y 之間，這位編輯者**額外刪除了什麼模式**——這些全是規則層抓不到、需要語義理解的決策。

## 重要要求
1. 只分析 X→Y 之間的差異，不要討論規則層已處理的問題（逐字重複等）。
2. 每條規則必須引用跨配對的具體例子（直接從 X/Y 文本抓字串）。
3. 標出規則信心度：出現於幾對配對中？
4. 說明觸發條件：什麼情況下刪？什麼情況下留？

## 輸出格式（嚴格遵循）

# 敘事層剪輯風格 - 批 ${batchIdx + 1}/${totalBatches}

## 規則 1: <短名稱>
**現象**: <X 裡有什麼，Y 裡不見了>
**觸發條件**: <什麼情況刪>
**例子**:
- (配對 N - 影片名) X 有 "XXX" → Y 無
**信心**: 高/中/低（出現於 X/${pairs.length} 對）

## 規則 2: ...

## 整體觀察
<3-5 句，描述 X→Y 之間最主要的敘事剪輯哲學>

## 各配對

`;

  const pairsText = pairs.map((p, i) =>
    `\n### 配對 ${i + 1}: ${p.name}\n\n**X（規則層後，${p.xText.length} 字）**:\n${p.xText}\n\n**Y（人工最終，${p.yText.length} 字）**:\n${p.yText}\n`
  ).join('\n');

  const fullPrompt = prompt + pairsText;
  console.error(`\n📤 批 ${batchIdx + 1}/${totalBatches}（${pairs.length} 對，prompt ${fullPrompt.length} 字）...`);

  const start = Date.now();
  let output;
  try {
    output = llmExec('', {
      input:     fullPrompt,
      encoding:  'utf8',
      timeout:   600000,
      maxBuffer: 20 * 1024 * 1024,
      stdio:     ['pipe', 'pipe', 'pipe'],
      shell:     true
    }).trim();
  } catch (err) {
    console.error(`   ⚠️ 批 ${batchIdx + 1} 第一次失敗，等 60s 重試...`);
    execSync('node -e "setTimeout(()=>{},60000)"', { timeout: 65000, shell: true });
    try {
      output = llmExec('', {
        input:     fullPrompt,
        encoding:  'utf8',
        timeout:   600000,
        maxBuffer: 20 * 1024 * 1024,
        stdio:     ['pipe', 'pipe', 'pipe'],
        shell:     true
      }).trim();
    } catch (err2) {
      console.error(`   ❌ 批 ${batchIdx + 1} 重試仍失敗: ${err2.message.slice(0, 80)}`);
      return null;
    }
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
  // 批次間等待 90s 避免 rate limit
  if (i < batches.length - 1) {
    console.error(`   ⏳ 等待 90s 避免 rate limit...`);
    execSync('node -e "setTimeout(()=>{},90000)"', { timeout: 95000, shell: true });
  }
}

console.error(`\n📊 收到 ${reports.length}/${batches.length} 份報告`);

// 存批量報告（除錯用）
const batchOutFile = outFile.replace(/\.md$/, '_batches.md');
fs.writeFileSync(batchOutFile, reports.map(r =>
  `\n\n=== 批 ${r.batch}（${r.videos.join(', ')}）===\n\n${r.report}`
).join('\n'));
console.error(`📄 批量報告: ${batchOutFile}`);

if (reports.length === 0) {
  console.error('❌ 所有批次都失敗');
  process.exit(1);
}

// ── Step A2: diff_report 批次分析（AI→user 第二訊號）──
function runDiffBatch(batchVideos, batchIdx, totalBatches) {
  const cases = [];
  for (const name of batchVideos) {
    const dir        = path.join(TRAINING_DIR, name);
    const diffPath   = path.join(dir, '2_分析', 'diff_report.json');
    if (!fs.existsSync(diffPath)) continue;
    try {
      const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
      const fp = (diff.falsePositives || []).filter(w => !w.isGap && w.text && w.text.trim().length > 1);
      const fn = (diff.falseNegatives || []).filter(w => !w.isGap && w.text && w.text.trim().length > 1);
      if (fp.length === 0 && fn.length === 0) continue;
      cases.push({ name, fp, fn });
    } catch (e) {
      console.error(`   ⚠️ ${name} diff_report 讀取失敗: ${e.message}`);
    }
  }
  if (cases.length === 0) return null;

  const prompt = `你是剪輯研究員，分析 AI 剪輯系統的偏差模式。

以下是 ${cases.length} 支影片的「AI 判斷 vs 使用者最終決定」差異紀錄：
- **AI 過度刪除**（falsePositive）：AI 刪了，但使用者留下來
- **AI 漏刪**（falseNegative）：使用者刪了，但 AI 沒刪

請找出跨影片的穩定模式：哪類內容 AI 習慣性地刪多了？哪類內容 AI 習慣性地漏掉？

## 輸出格式（嚴格遵循）

# AI 偏差分析 - 批 ${batchIdx + 1}/${totalBatches}

## AI 過度刪除的模式（編輯者會留下）
### 模式 1: <短名稱>
**現象**: <AI 習慣刪什麼>
**應該保留的理由**: <為何編輯者會留>
**例子**: (影片名) AI 刪了「XXX」，但編輯者留下
**出現頻率**: X/${cases.length} 支

## AI 漏刪的模式（編輯者會刪）
### 模式 N: <短名稱>
**現象**: <AI 沒抓到什麼>
**應該刪除的理由**: <為何編輯者會刪>
**例子**: (影片名) AI 保留「XXX」，但編輯者刪去
**出現頻率**: X/${cases.length} 支

## 各影片差異

` + cases.map(c =>
    `\n### ${c.name}\n\n**AI 過度刪除（${c.fp.length} 處）**:\n${c.fp.slice(0, 20).map(w => '- 「' + w.text + '」').join('\n')}\n\n**AI 漏刪（${c.fn.length} 處）**:\n${c.fn.slice(0, 20).map(w => '- 「' + w.text + '」').join('\n')}`
  ).join('\n');

  console.error(`\n📊 Diff 批 ${batchIdx + 1}/${totalBatches}（${cases.length} 支有記錄）...`);
  try {
    const out = llmExec('', {
      input:     prompt,
      encoding:  'utf8',
      timeout:   600000,
      maxBuffer: 20 * 1024 * 1024,
      stdio:     ['pipe', 'pipe', 'pipe'],
      shell:     true
    }).trim();
    console.error(`   ✅ ${out.length} 字`);
    return out;
  } catch (err) {
    console.error(`   ⚠️ Diff 批 ${batchIdx + 1} 失敗，等 60s 重試...`);
    execSync('node -e "setTimeout(()=>{},60000)"', { timeout: 65000, shell: true });
    try {
      const out = llmExec('', {
        input:     prompt, encoding: 'utf8', timeout: 600000,
        maxBuffer: 20 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], shell: true
      }).trim();
      console.error(`   ✅ 重試成功 ${out.length} 字`);
      return out;
    } catch (err2) {
      console.error(`   ❌ Diff 批 ${batchIdx + 1} 重試失敗`);
      return null;
    }
  }
}

// 掃 training_output 裡有 diff_report.json 的影片（不受 holdout 限制——diff 是 AI 已知的影片，不是訓練資料洩漏）
const diffVideos = fs.readdirSync(TRAINING_DIR).filter(d => {
  const dir = path.join(TRAINING_DIR, d);
  try { return fs.statSync(dir).isDirectory() &&
    fs.existsSync(path.join(dir, '2_分析', 'diff_report.json')); } catch { return false; }
});
console.error(`\n🔎 找到 ${diffVideos.length} 支影片有 diff_report.json，批次分析 AI 偏差...`);

const diffBatches = [];
for (let i = 0; i < diffVideos.length; i += perBatch) diffBatches.push(diffVideos.slice(i, i + perBatch));

const diffReports = [];
for (let i = 0; i < diffBatches.length; i++) {
  const r = runDiffBatch(diffBatches[i], i, diffBatches.length);
  if (r) diffReports.push({ batch: i + 1, videos: diffBatches[i], report: r });
  if (i < diffBatches.length - 1) {
    console.error(`   ⏳ 等待 90s...`);
    execSync('node -e "setTimeout(()=>{},90000)"', { timeout: 95000, shell: true });
  }
}
console.error(`📊 Diff 分析：${diffReports.length}/${diffBatches.length} 批完成`);

// 存 diff 批量報告（除錯用）
if (diffReports.length > 0) {
  const diffOutFile = outFile.replace(/\.md$/, '_diff_batches.md');
  fs.writeFileSync(diffOutFile, diffReports.map(r =>
    `\n\n=== Diff 批 ${r.batch}（${r.videos.join(', ')}）===\n\n${r.report}`
  ).join('\n'));
  console.error(`📄 Diff 報告: ${diffOutFile}`);
}

// ── Step B: 合併前快照（增量模式才做）──
if (incremental && fs.existsSync(outFile)) {
  const snapshotPath = outFile.replace(/\.md$/, '_snapshot_' + Date.now() + '.md');
  fs.copyFileSync(outFile, snapshotPath);
  console.error('📸 守則快照: ' + path.basename(snapshotPath));

  // 只保留最近 5 個快照，清理舊的
  const dir      = path.dirname(outFile);
  const base     = path.basename(outFile, '.md');
  const snapshots = fs.readdirSync(dir)
    .filter(f => f.startsWith(base + '_snapshot_') && f.endsWith('.md'))
    .map(f => ({ name: f, ts: parseInt(f.replace(base + '_snapshot_', '').replace('.md', '')) || 0 }))
    .sort((a, b) => b.ts - a.ts);
  if (snapshots.length > 5) {
    for (const old of snapshots.slice(5)) {
      fs.unlinkSync(path.join(dir, old.name));
      console.error('🗑️  清理舊快照: ' + old.name);
    }
  }
}

// ── Step B: 合併 ──
const existingGuide = (incremental && fs.existsSync(outFile))
  ? fs.readFileSync(outFile, 'utf8').trim()
  : null;

const diffSection = diffReports.length > 0
  ? `\n\n---\n\n## AI 偏差紀錄（${diffReports.length} 批，基於使用者實際修正）\n\n` +
    diffReports.map(r => `=== Diff 批 ${r.batch} ===\n\n${r.report}`).join('\n\n')
  : '';

let mergePrompt;
if (incremental && existingGuide) {
  console.error(`\n🔀 增量合併：${reports.length} 份新批報告 + 現有守則${diffReports.length > 0 ? ' + ' + diffReports.length + ' 份 AI 偏差報告' : ''}...`);
  mergePrompt = `你是剪輯研究員，正在更新一位 YouTuber 的「敘事層剪輯守則」。

以下是**現有守則**（基於先前的訓練影片）：

${existingGuide}

---

以下是**新增影片（${videos.length} 支）的新批次觀察**：

${reports.map(r => `=== 批 ${r.batch} ===\n\n${r.report}`).join('\n\n')}
${diffSection}

---

請輸出**更新後的完整守則**：
1. **強化**有新證據支持的規則（更新信心統計、補充例子）
2. **細化**被新資料修正的規則（調整觸發條件或邊界）
3. **新增**新影片中出現的新規則（若確實是新模式）
4. **保留**舊守則中仍有效的所有規則（不要刪掉沒被新資料反駁的規則）
5. **格式與原版相同**，信心統計更新為「出現於 X 批次（含新增）」
6. **若有 AI 偏差紀錄**，在守則末尾新增或更新「## AI 常犯的錯」段落，列出 AI 習慣性過度刪除或漏刪的模式，與正向規則分開

直接輸出完整守則，不要說明你做了什麼改動。`;
} else {
  console.error(`\n🔀 全量合併 ${reports.length} 份批報告為 narrative style guide${diffReports.length > 0 ? '（含 ' + diffReports.length + ' 份 AI 偏差）' : ''}...`);
  mergePrompt = `你是剪輯研究員。以下是同一位 YouTuber 的 ${reports.length} 份**敘事層剪輯風格觀察**（每份基於規則層清理後的 X→人工最終版 Y 的差異分析，共 ${videos.length} 支影片）。

請合併成一份**敘事層專屬守則（narrative style guide）**：

## 合併原則
1. 跨批次穩定的規則（≥${Math.ceil(reports.length / 2)} 份）→「核心敘事規則」
2. 條件性規則 → 標明觸發條件
3. 去除矛盾，降信心或合併描述
4. 每條規則最多 2 個最具代表性的例子
5. 每條規則必須能指導 AI 做出具體的刪/留決定
6. **若有 AI 偏差紀錄**，在守則末尾獨立列「## AI 常犯的錯」段落

## 使用場景
注入給 AI 做規則層之後的第二遍敘事剪輯。聚焦在「段落或觀點層級」的刪除決策。

## 輸出格式

# 敘事層剪輯守則（narrative style guide）

## 核心敘事規則

### 規則 1: <名稱>
**現象**: ...
**刪除時機**: ...
**保留時機**: ...
**信心**: 出現於 X/${reports.length} 批次
**例子**: ...

## 條件性規則

### 規則 N: ...

## 整體哲學
<5-8 句>

## AI 常犯的錯（若有偏差紀錄才輸出此段）

### 過度刪除模式 1: <名稱>
**現象**: AI 習慣刪...
**正確做法**: 應保留，因為...

### 漏刪模式 1: <名稱>
**現象**: AI 不會刪...
**正確做法**: 應刪除，因為...

## 各批次觀察

` + reports.map(r => `\n\n=== 批 ${r.batch} ===\n\n${r.report}`).join('\n') + diffSection;
}

const fullMerge = (incremental && existingGuide) ? mergePrompt
  : mergePrompt; // 全量模式 prompt 已含批次內容

console.error(`📤 合併 prompt ${fullMerge.length} 字...`);

const mergeStart = Date.now();
let guide;
try {
  guide = llmExec('', {
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

fs.writeFileSync(outFile, guide);
console.error(`\n✅ Narrative style guide: ${outFile}（${guide.length} 字，${mergeElapsed}s）`);

const ruleCount = (guide.match(/^### 規則 \d/gm) || []).length;
console.error(`📊 抽到 ${ruleCount} 條規則`);

// 更新已處理清單
const allProcessed = [...new Set([...processedRecord.processed, ...videos])];
saveProcessed(allProcessed);
console.error(`📋 已處理清單更新：共 ${allProcessed.length} 支`);

// 守則更新完成後，自動跑 holdout F1 量測
const holdoutScript = path.join(SCRIPT_DIR, 'measure_holdout_f1.js');
if (fs.existsSync(holdoutScript)) {
  console.error('\n🔒 啟動 holdout F1 量測...');
  try {
    execSync(`node "${holdoutScript}"`, {
      cwd: SCRIPT_DIR, stdio: ['pipe', process.stderr, process.stderr], shell: true, timeout: 600000
    });
  } catch (e) {
    if (e.status === 2) {
      console.error('⚠️ Holdout F1 退步，請查看 holdout_f1_history.jsonl');
    } else {
      console.error('⚠️ holdout F1 量測失敗:', e.message.slice(0, 100));
    }
  }
}
