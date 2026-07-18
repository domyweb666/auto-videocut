#!/usr/bin/env node
/**
 * generate_editing_skills.js — 從訓練數據提煉個人化剪輯 Skills 文檔
 *
 * 分析所有訓練影片的 diff_report，找出使用者剪輯習慣的規律，
 * 用 Claude AI 提煉成結構化的 editing_skills.md，供 ai_sentencize.js 參考。
 *
 * 用法: node generate_editing_skills.js [--force]
 *   --force: 強制重新生成，忽略現有的 editing_skills.md
 *
 * 輸出: ../editing_skills.md（相對於 scripts/ 目錄）
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

const SCRIPT_DIR   = __dirname;
const ROOT_DIR     = path.join(SCRIPT_DIR, '..');
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');
const OUTPUT_PATH  = path.join(ROOT_DIR, 'editing_skills.md');
const HABITS_DIR   = path.join(ROOT_DIR, '用户习惯');

const force = process.argv.includes('--force');

// ── 檢查是否需要重新生成 ──
if (!force && fs.existsSync(OUTPUT_PATH)) {
  const skillsMtime = fs.statSync(OUTPUT_PATH).mtimeMs;
  // 如果 editing_skills.md 比所有 diff_report 都新，跳過
  let needsUpdate = false;
  if (fs.existsSync(TRAINING_DIR)) {
    for (const dir of fs.readdirSync(TRAINING_DIR)) {
      const diffPath = path.join(TRAINING_DIR, dir, '2_分析', 'diff_report.json');
      if (fs.existsSync(diffPath) && fs.statSync(diffPath).mtimeMs > skillsMtime) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    console.log('✅ editing_skills.md 已是最新，使用 --force 強制重新生成');
    process.exit(0);
  }
}

console.log('📊 開始分析訓練數據...');

// ── 讀取所有 diff_report ──
const videos = [];
if (fs.existsSync(TRAINING_DIR)) {
  for (const dir of fs.readdirSync(TRAINING_DIR)) {
    const fullDir = path.join(TRAINING_DIR, dir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    const diffPath = path.join(fullDir, '2_分析', 'diff_report.json');
    if (fs.existsSync(diffPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
        videos.push({ name: dir, report });
      } catch (e) {}
    }
  }
}
console.log(`📂 讀取 ${videos.length} 支訓練影片的 diff_report`);

if (videos.length === 0) {
  console.error('❌ 找不到任何訓練數據，請先完成訓練流程');
  process.exit(1);
}

// ── 讀取 style_summary.json（匯總統計） ──
let styleSummary = null;
const styleFile = path.join(TRAINING_DIR, 'style_summary.json');
if (fs.existsSync(styleFile)) {
  try { styleSummary = JSON.parse(fs.readFileSync(styleFile, 'utf8')); } catch (e) {}
}

// ── 讀取 autoresearch_report.json（最新優化結果） ──
let arReport = null;
const arFile = path.join(TRAINING_DIR, 'autoresearch_report.json');
if (fs.existsSync(arFile)) {
  try { arReport = JSON.parse(fs.readFileSync(arFile, 'utf8')); } catch (e) {}
}

// ── 匯總 FP/FN 統計 ──
const fpTextCounts = {};  // text → count
const fpRuleCounts = {};  // rule → count
const fnTextCounts = {};  // text → count
const silenceDist  = {};  // duration bucket → { kept, deleted }
let totalTP = 0, totalFP = 0, totalFN = 0;

for (const { name, report } of videos) {
  if (!report) continue;

  const af = report.accuracy_filtered || report.accuracy;
  if (af) {
    totalTP += af.tp || 0;
    totalFP += (af.fp || 0);
    totalFN += (af.fn || 0);
  }

  // FP patterns
  for (const fp of (report.falsePositives || [])) {
    if (fp.isGap) continue;  // 靜音 FP 單獨統計
    if (!fp.text || fp.text.length < 2) continue;
    fpTextCounts[fp.text] = (fpTextCounts[fp.text] || 0) + 1;
    const ruleKey = extractRuleKey(fp.reason || '');
    fpRuleCounts[ruleKey] = (fpRuleCounts[ruleKey] || 0) + 1;
  }

  // FN patterns
  for (const fn of (report.falseNegatives || [])) {
    if (fn.isGap) continue;
    if (!fn.text || fn.text.length < 2) continue;
    fnTextCounts[fn.text] = (fnTextCounts[fn.text] || 0) + 1;
  }

  // 靜音分布
  if (report.silenceAnalysis && report.silenceAnalysis.distribution) {
    for (const [bucket, counts] of Object.entries(report.silenceAnalysis.distribution)) {
      if (!silenceDist[bucket]) silenceDist[bucket] = { kept: 0, deleted: 0 };
      silenceDist[bucket].kept    += counts.kept    || 0;
      silenceDist[bucket].deleted += counts.deleted || 0;
    }
  }
}

function extractRuleKey(reason) {
  if (!reason) return 'unknown';
  if (reason.includes('重複Take') || reason.includes('Take')) return '重複Take';
  if (reason.includes('上下文靜音')) return '上下文靜音';
  if (reason.includes('語意重複')) return '語意重複';
  if (reason.includes('句內重複')) return '句內重複';
  if (reason.includes('重複句') || reason.includes('重複')) return '重複句';
  if (reason.includes('殘句')) return '殘句';
  if (reason.includes('口語贅詞')) return '口語贅詞';
  if (reason.includes('靜音')) return '靜音';
  return reason.slice(0, 12);
}

// 取 Top N
const topFPTexts = Object.entries(fpTextCounts)
  .sort((a, b) => b[1] - a[1])
  .filter(([, c]) => c >= 3)
  .slice(0, 20);

const topFNTexts = Object.entries(fnTextCounts)
  .sort((a, b) => b[1] - a[1])
  .filter(([, c]) => c >= 2)
  .slice(0, 20);

// 靜音分布排序
const silenceRows = Object.entries(silenceDist)
  .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
  .map(([dur, counts]) => {
    const total = counts.kept + counts.deleted;
    const keepRate = total > 0 ? Math.round(counts.kept / total * 100) : 0;
    return `  ${dur}s: 保留率 ${keepRate}% (保留 ${counts.kept}, 刪除 ${counts.deleted})`;
  });

// ── 讀取現有的 用户习惯/ 文件（給 AI 參考，避免重複） ──
const habitsContent = [];
const INCLUDE_HABITS = [
  '1-核心原则.md',
  '3-静音段处理.md',
  '20-剪輯偏好標準.md'
];
for (const file of INCLUDE_HABITS) {
  const p = path.join(HABITS_DIR, file);
  if (fs.existsSync(p)) {
    habitsContent.push(`### ${file}\n${fs.readFileSync(p, 'utf8')}`);
  }
}

// ── 準備 autoresearch FN 數據 ──
let arFNSection = '';
if (arReport && arReport.topFNWords) {
  const sorted = Object.entries(arReport.topFNWords)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w, c]) => `  「${w}」: ${c}次`)
    .join('\n');
  arFNSection = `\n## 規則引擎最常漏刪的詞（使用者刪了但規則沒抓到）:\n${sorted}`;
}

// ── 組裝 prompt ──
const prompt = `你是一位資深影片剪輯分析師。我有一位口播影片創作者，我需要你根據以下訓練數據，
寫出一份詳細的「個人剪輯風格說明書」(editing_skills.md)，供 AI 剪輯助理參考。

## 訓練數據概述
- 影片數量: ${videos.length} 支
- 整體準確率（規則引擎）: F1 ${arReport ? (arReport.final.f1 * 100).toFixed(1) + '%' : '~97%'}
- 總 TP: ${totalTP} | 總 FP: ${totalFP} | 總 FN: ${totalFN}

## FP 分析（規則引擎誤刪，使用者保留的內容）
最常見的誤刪規則:
${Object.entries(fpRuleCounts).sort((a,b) => b[1]-a[1]).slice(0,8).map(([k,v]) => `  ${k}: ${v}次`).join('\n')}

最常被誤刪的詞（規則刪了但使用者保留）:
${topFPTexts.map(([t, c]) => `  「${t}」: ${c}次`).join('\n') || '  （無顯著模式）'}
${arFNSection}

## FN 分析（規則引擎漏刪，使用者有刪的內容）
最常被漏刪的詞（使用者刪了但規則沒抓到，出現 ≥2 次）:
${topFNTexts.map(([t, c]) => `  「${t}」: ${c}次`).join('\n') || '  （無顯著文字模式）'}

## 靜音分布（使用者保留 vs 刪除的比例）
${silenceRows.join('\n')}

## 現有習慣文件（已知規則，請在 editing_skills.md 中整合並補充，不要重複）
${habitsContent.join('\n\n')}

---
## 背景說明（重要！）

這份 skills 文件將被 AI 剪輯助理直接使用。**根據實際測試，AI 的最大問題是刪太少（召回率只有 44%），而非刪太多。**

因此這份文件的核心任務是：**讓 AI 更積極刪除**，而不是讓它保守。

---
## 你的任務

根據以上數據，寫出一份詳細、可操作的 editing_skills.md，格式為 Markdown。

**要求**：
1. **核心原則要積極**：AI 的問題是刪太少（FN=1618），不是刪太多（FP=115）。原則應是「積極刪除重複和贅詞，保留有意義內容」，而不是「有疑慮就保留」
2. **重錄判斷要積極**：重錄（retake）是最大的刪除來源。前後語意相同就刪前段，不要求用詞一模一樣，語意模糊相似也要刪
3. **明確列出必刪模式**：根據 FN 數據，使用者系統性地刪除這些詞——「就是說」(37次)、「的時候」(13次)、「你可以」(12次)、「如果你」(7次)——出現在重複或贅餘脈絡時要刪
4. **靜音策略要具體**：根據靜音分布，給出精確閾值。≥1.85s 刪，但注意這不是主要 FN 來源
5. **FP 例外要精確**：只列出真正容易誤判的情況（如遞進說明、強調重複），不要過度擴大例外範圍
6. **水印識別**：「請不吝點贊訂閱轉發打賞支持」等段落全刪

格式範例：
\`\`\`markdown
# 個人剪輯風格說明書

## 核心原則
（積極刪除為主，保留為輔）

## 重錄（Retake）處理
### 判斷標準（積極版）
- ...
### 僅在以下情況才保留（例外要少）
- ...

## 必刪詞彙與模式
- ...
\`\`\`

請直接輸出 Markdown 內容，不要加任何說明。`;

console.log('\n🤖 送給 Claude AI 分析...');

let result;
try {
  const isWindows = process.platform === 'win32';
  const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

  result = llmExec('', {
    input: prompt,
    encoding: 'utf8',
    timeout: 300000, // 5 分鐘
    maxBuffer: 5 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });
} catch (err) {
  console.error('❌ Claude AI 呼叫失敗:', err.message);
  if (err.code === 'ENOENT' || (err.message && err.message.includes('ENOENT'))) {
    console.error('   請確認 Claude Code CLI 已安裝：claude --version');
  }
  process.exit(1);
}

if (!result || !result.trim()) {
  console.error('❌ Claude AI 回傳空內容');
  process.exit(1);
}

// 確保輸出是 Markdown（去除可能的程式碼塊包裝）
let content = result.trim();
if (content.startsWith('```markdown')) {
  content = content.slice('```markdown'.length).trim();
}
if (content.startsWith('```')) {
  content = content.slice(3).trim();
}
if (content.endsWith('```')) {
  content = content.slice(0, -3).trim();
}

// 加上生成時間戳
const header = `<!-- 由 generate_editing_skills.js 自動生成 -->
<!-- 生成時間: ${new Date().toISOString()} -->
<!-- 訓練影片: ${videos.length} 支 -->
<!-- 若要更新請執行: node scripts/generate_editing_skills.js --force -->

`;

fs.writeFileSync(OUTPUT_PATH, header + content, 'utf8');

console.log('\n✅ editing_skills.md 已生成！');
console.log(`📄 路徑: ${OUTPUT_PATH}`);
console.log(`📊 基於 ${videos.length} 支訓練影片`);
console.log('');
console.log('下一步：');
console.log('  1. 查看 editing_skills.md 確認內容合理');
console.log('  2. 重新剪輯一支影片測試效果');
console.log('  3. 如有疑問可手動編輯 editing_skills.md');
