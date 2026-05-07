#!/usr/bin/env node
/**
 * Holdout F1 量測 — layered 模式對 holdout 影片的真實泛化基準
 *
 * 讀 narrative_style_guide_holdout.json，對每支影片：
 *   1. 確保 polished.json 存在（若無則跑 ai_polish）
 *   2. 重跑 ai_narrative_pass（吃當前 narrative_style_guide.md）
 *   3. 對 layered 算 F1
 *
 * 輸出：
 *   - stdout：簡明對比表
 *   - training_output/holdout_f1_history.jsonl：一行一筆，含時間、avg F1、各支 F1
 *
 * 用法: node measure_holdout_f1.js
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR    = __dirname;
const TRAINING_DIR  = path.join(SCRIPT_DIR, 'training_output');
const HOLDOUT_FILE  = path.join(TRAINING_DIR, 'narrative_style_guide_holdout.json');
const HISTORY_FILE  = path.join(TRAINING_DIR, 'holdout_f1_history.jsonl');

if (!fs.existsSync(HOLDOUT_FILE)) {
  console.error('❌ 找不到 holdout 清單：' + HOLDOUT_FILE);
  process.exit(1);
}
const holdout = JSON.parse(fs.readFileSync(HOLDOUT_FILE, 'utf8')).holdout || [];
if (holdout.length === 0) {
  console.error('❌ holdout 清單為空');
  process.exit(1);
}

console.error(`🔒 Holdout F1 量測：${holdout.length} 支影片\n`);

const results = [];
for (const name of holdout) {
  console.error(`\n──── ${name} ────`);
  const dir         = path.join(TRAINING_DIR, name);
  const subsPath    = path.join(dir, '1_轉錄', 'subtitles_words.json');
  const editPath    = path.join(dir, '2_分析', 'edited_words.json');
  const polishPath  = path.join(dir, '2_分析', 'polished.json');
  const rulesAuto   = path.join(dir, '2_分析', 'auto_selected.json');
  const layeredAuto = path.join(dir, '2_分析', 'auto_selected_layered.json');

  if (!fs.existsSync(subsPath) || !fs.existsSync(editPath) || !fs.existsSync(rulesAuto)) {
    console.error(`  ❌ 缺檔，跳過`);
    results.push({ name, error: 'missing_files' });
    continue;
  }

  try {
    if (!fs.existsSync(polishPath)) {
      console.error(`  📝 跑 ai_polish...`);
      execSync(`node ai_polish.js "${subsPath}" "${polishPath}"`, {
        cwd: SCRIPT_DIR, stdio: 'pipe', shell: true
      });
    }

    console.error(`  🤖 跑 ai_narrative_pass...`);
    execSync(`node ai_narrative_pass.js "${polishPath}" "${subsPath}" "${rulesAuto}" "${layeredAuto}"`, {
      cwd: SCRIPT_DIR, stdio: 'pipe', shell: true
    });

    const stdout = execSync(
      `node compare_transcriptions.js "${subsPath}" "${editPath}" "${layeredAuto}"`,
      { cwd: SCRIPT_DIR, encoding: 'utf8', shell: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const report = JSON.parse(stdout);
    const f1     = report.accuracy_filtered.f1;
    const prec   = report.accuracy_filtered.precision;
    const rec    = report.accuracy_filtered.recall;
    console.error(`  ✅ F1=${(f1*100).toFixed(2)}% (P=${(prec*100).toFixed(1)}% R=${(rec*100).toFixed(1)}%)`);
    results.push({ name, f1Filt: f1, precFilt: prec, recFilt: rec });
  } catch (err) {
    console.error(`  ❌ 執行失敗: ${err.message.slice(0, 100)}`);
    results.push({ name, error: 'exec_error', message: err.message.slice(0, 200) });
  }
}

const valid = results.filter(r => typeof r.f1Filt === 'number');
const avgF1 = valid.length > 0 ? valid.reduce((s, r) => s + r.f1Filt, 0) / valid.length : 0;

console.log('\n\n========== Holdout F1 結果 ==========');
console.log('影片名稱'.padEnd(16, ' ') + ' | F1     | P      | R');
console.log('-'.repeat(50));
for (const r of results) {
  if (r.error) {
    console.log(r.name.padEnd(16, ' ') + ` | ❌ ${r.error}`);
  } else {
    console.log(r.name.padEnd(16, ' ') +
      ` | ${(r.f1Filt*100).toFixed(2)}% | ${(r.precFilt*100).toFixed(1)}% | ${(r.recFilt*100).toFixed(1)}%`);
  }
}
console.log('-'.repeat(50));
console.log(`平均 F1：${(avgF1*100).toFixed(2)}%（${valid.length}/${holdout.length} 支成功）`);

// 比對前一筆 history 看趨勢
let prev = null;
if (fs.existsSync(HISTORY_FILE)) {
  const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length > 0) {
    try { prev = JSON.parse(lines[lines.length - 1]); } catch {}
  }
}
let regression = false;
let trendNote  = '';
if (prev && typeof prev.avgF1 === 'number') {
  const delta = (avgF1 - prev.avgF1) * 100;
  trendNote = `（與上次 ${(prev.avgF1*100).toFixed(2)}% 比較：${delta >= 0 ? '+' : ''}${delta.toFixed(2)} 點）`;
  console.log(`趨勢：${trendNote}`);
  if (delta < -0.5) {
    regression = true;
    console.log(`⚠️ 退步 > 0.5 點，標記為 regression`);
  }
}

// 寫入 history
const entry = {
  timestamp: new Date().toISOString(),
  avgF1,
  successCount: valid.length,
  totalCount: holdout.length,
  perVideo: results.map(r => ({ name: r.name, f1: r.f1Filt ?? null, error: r.error })),
  regression,
  prevAvgF1: prev?.avgF1 ?? null
};
fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
console.log(`\n📄 已記錄到 ${HISTORY_FILE}`);

if (regression) process.exit(2); // exit code 2 表退步，前端可偵測
