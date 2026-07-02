#!/usr/bin/env node
/**
 * 三方 F1 對比: rules / full_edit / layered
 *
 * 用法: node compare_layered_f1.js <video_name> [video_name2 ...]
 *
 * 對每支影片：
 *   1. 確保 polished.json 存在（若無則跑 ai_polish）
 *   2. 跑 ai_full_edit → auto_selected_full.json（如尚未產出）
 *   3. 跑 ai_narrative_pass → auto_selected_layered.json
 *   4. 對 rules / full / layered 三份 auto_selected 各算 F1
 *   5. 印出對比表
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

const videos = process.argv.slice(2);
if (videos.length === 0) {
  console.error('用法: node compare_layered_f1.js <video_name> [video_name2 ...]');
  process.exit(1);
}

const results = [];

for (const name of videos) {
  console.error(`\n========================================`);
  console.error(`🎬 ${name}`);
  console.error(`========================================`);

  const dir          = path.join(TRAINING_DIR, name);
  const subsPath     = path.join(dir, '1_轉錄', 'subtitles_words.json');
  const editPath     = path.join(dir, '2_分析', 'edited_words.json');
  const polishPath   = path.join(dir, '2_分析', 'polished.json');
  const rulesAuto    = path.join(dir, '2_分析', 'auto_selected.json');
  const fullAuto     = path.join(dir, '2_分析', 'auto_selected_full.json');
  const layeredAuto  = path.join(dir, '2_分析', 'auto_selected_layered.json');

  if (!fs.existsSync(subsPath) || !fs.existsSync(editPath) || !fs.existsSync(rulesAuto)) {
    console.error(`❌ 缺檔（需要 subtitles_words/edited_words/auto_selected），跳過`);
    continue;
  }

  try {
    // 1. polish if needed (retry once)
    if (!fs.existsSync(polishPath)) {
      console.error(`📝 跑 ai_polish...`);
      let polishOk = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          execSync(`node ai_polish.js "${subsPath}" "${polishPath}"`, {
            cwd: SCRIPT_DIR, stdio: 'inherit', shell: true
          });
          polishOk = fs.existsSync(polishPath);
          if (polishOk) break;
        } catch (e) {
          console.error(`   ⚠️ polish 第 ${attempt} 次失敗`);
        }
      }
      if (!polishOk) { console.error(`❌ ${name}: ai_polish 失敗`); continue; }
    } else {
      console.error(`✅ polished.json 已存在`);
    }

    // 2. full_edit if not exists
    if (!fs.existsSync(fullAuto)) {
      console.error(`🤖 跑 ai_full_edit...`);
      execSync(`node ai_full_edit.js "${polishPath}" "${subsPath}" "${fullAuto}"`, {
        cwd: SCRIPT_DIR, stdio: 'inherit', shell: true
      });
    } else {
      console.error(`✅ auto_selected_full.json 已存在`);
    }

    // 3. layered (always re-run)
    console.error(`🤖 跑 ai_narrative_pass (layered)...`);
    execSync(`node ai_narrative_pass.js "${polishPath}" "${subsPath}" "${rulesAuto}" "${layeredAuto}"`, {
      cwd: SCRIPT_DIR, stdio: 'inherit', shell: true
    });

    // 對齊失敗檢查
    const layeredJson = JSON.parse(fs.readFileSync(layeredAuto, 'utf8'));
    if (layeredJson.alignment_warnings && layeredJson.alignment_warnings.length > 0) {
      console.error(`❌ ${name}: layered 對齊失敗，F1 跳過`);
      results.push({ name, error: 'alignment_failed', warnings: layeredJson.alignment_warnings });
      continue;
    }

    // 4. eval each
    function evalF1(autoPath, label) {
      const stdout = execSync(
        `node compare_transcriptions.js "${subsPath}" "${editPath}" "${autoPath}"`,
        { cwd: SCRIPT_DIR, encoding: 'utf8', shell: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const report = JSON.parse(stdout);
      fs.writeFileSync(
        path.join(path.dirname(autoPath), `diff_report_${label}.json`),
        JSON.stringify(report, null, 2)
      );
      return {
        label,
        f1Raw:    report.accuracy.f1,
        f1Filt:   report.accuracy_filtered.f1,
        precFilt: report.accuracy_filtered.precision,
        recFilt:  report.accuracy_filtered.recall,
        aiCount:  report.aiCount
      };
    }

    console.error(`📊 評估 rules ...`);   const rulesEval   = evalF1(rulesAuto, 'rules');
    console.error(`📊 評估 full ...`);    const fullEval    = evalF1(fullAuto,  'full');
    console.error(`📊 評估 layered ...`); const layeredEval = evalF1(layeredAuto,'layered');

    results.push({ name, rules: rulesEval, full: fullEval, layered: layeredEval, layeredJson });
  } catch (err) {
    console.error(`❌ ${name}: 執行錯誤 ${err.message}`);
    results.push({ name, error: 'exec_error', message: err.message });
  }
}

// ── 輸出比較表 ──
const valid   = results.filter(r => r.rules);
const errored = results.filter(r => r.error);

console.log('\n\n');
console.log('================== F1 三方對比 ==================');
console.log('影片                  模式        F1(原)  F1(過濾)  P(過)   R(過)   #預測');
console.log('---------------------------------------------------------------------------');
function fmt(e) {
  return `${(e.f1Raw*100).toFixed(1).padStart(5)}%  ${(e.f1Filt*100).toFixed(1).padStart(5)}%   ${(e.precFilt*100).toFixed(1).padStart(5)}%  ${(e.recFilt*100).toFixed(1).padStart(5)}%  ${String(e.aiCount).padStart(5)}`;
}
for (const r of valid) {
  console.log(`${r.name.padEnd(20, ' ')}  rules     ${fmt(r.rules)}`);
  console.log(`${' '.repeat(20)}  full      ${fmt(r.full)}`);
  console.log(`${' '.repeat(20)}  layered   ${fmt(r.layered)}`);
  const dvL = (r.layered.f1Filt - r.rules.f1Filt) * 100;
  const sgn = dvL >= 0 ? '+' : '';
  const layerStats = r.layeredJson?.stats || {};
  console.log(`${' '.repeat(20)}  Δ(layered vs rules) ${sgn}${dvL.toFixed(1)} 點 | AI 第二遍多刪 ${layerStats.narrative_deleted || '?'} word`);
  console.log('');
}
for (const r of errored) {
  console.log(`${r.name.padEnd(20, ' ')}  ❌ ${r.error}${r.message ? ': ' + r.message.slice(0, 60) : ''}`);
}

if (valid.length > 0) {
  const avg = (key) => valid.reduce((s, r) => s + r[key].f1Filt, 0) / valid.length;
  const avgRules   = avg('rules');
  const avgFull    = avg('full');
  const avgLayered = avg('layered');
  console.log('---------------------------------------------------------------------------');
  console.log(`平均 F1(過濾): rules=${(avgRules*100).toFixed(2)}%  full=${(avgFull*100).toFixed(2)}%  layered=${(avgLayered*100).toFixed(2)}%`);
  console.log(`              Δ(layered vs rules) = ${((avgLayered-avgRules)*100).toFixed(2)} 點`);

  const summary = {
    videos: results.map(r => ({
      name: r.name, error: r.error, rules: r.rules, full: r.full, layered: r.layered,
      layered_stats: r.layeredJson?.stats
    })),
    averages: {
      rules:   avgRules,
      full:    avgFull,
      layered: avgLayered,
      delta_layered_vs_rules_pp: (avgLayered - avgRules) * 100
    }
  };
  fs.writeFileSync(path.join(TRAINING_DIR, 'layered_f1_comparison.json'), JSON.stringify(summary, null, 2));
  console.log(`\n📄 詳細結果: training_output/layered_f1_comparison.json`);
}
