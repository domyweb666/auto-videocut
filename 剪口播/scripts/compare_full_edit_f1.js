#!/usr/bin/env node
/**
 * 對比新模式（ai_full_edit）與規則模式的 F1
 *
 * 用法: node compare_full_edit_f1.js <video_name> [video_name2 ...]
 *
 * 對每支影片：
 *   1. 確保 polished.json 存在（若無則跑 ai_polish）
 *   2. 跑 ai_full_edit → auto_selected_full.json
 *   3. 對 auto_selected.json (rules) 與 auto_selected_full.json (new) 各跑 compare_transcriptions
 *   4. 印出 F1 對比表
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

const videos = process.argv.slice(2);
if (videos.length === 0) {
  console.error('用法: node compare_full_edit_f1.js <video_name> [video_name2 ...]');
  process.exit(1);
}

const results = [];

for (const name of videos) {
  console.error(`\n========================================`);
  console.error(`🎬 ${name}`);
  console.error(`========================================`);

  const dir       = path.join(TRAINING_DIR, name);
  const subsPath  = path.join(dir, '1_轉錄', 'subtitles_words.json');
  const editPath  = path.join(dir, '2_分析', 'edited_words.json');
  const polishPath = path.join(dir, '2_分析', 'polished.json');
  const rulesAuto  = path.join(dir, '2_分析', 'auto_selected.json');
  const fullAuto   = path.join(dir, '2_分析', 'auto_selected_full.json');

  if (!fs.existsSync(subsPath) || !fs.existsSync(editPath) || !fs.existsSync(rulesAuto)) {
    console.error(`❌ 缺檔，跳過`);
    continue;
  }

  try {
    // 1. polish if needed (retry once on failure)
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
          console.error(`   ⚠️ polish 第 ${attempt} 次失敗，${attempt < 2 ? '重試中...' : '放棄'}`);
        }
      }
      if (!polishOk) { console.error(`❌ ${name}: ai_polish 失敗，跳過`); continue; }
    } else {
      console.error(`✅ polished.json 已存在`);
    }

    // 2. full edit
    console.error(`🤖 跑 ai_full_edit...`);
    execSync(`node ai_full_edit.js "${polishPath}" "${subsPath}" "${fullAuto}"`, {
      cwd: SCRIPT_DIR, stdio: 'inherit', shell: true
    });

    // 對齊失敗時 F1 沒意義，標記為 skipped
    const fullJson = JSON.parse(fs.readFileSync(fullAuto, 'utf8'));
    if (fullJson.alignment_warnings && fullJson.alignment_warnings.length > 0) {
      console.error(`❌ ${name}: full_edit 對齊失敗，F1 跳過`);
      results.push({ name, error: 'alignment_failed', warnings: fullJson.alignment_warnings });
      continue;
    }

  // 3. compare both
  function evalF1(autoPath, label) {
    // compare_transcriptions.js 輸出 JSON 到 stdout、log 到 stderr
    const stdout = execSync(
      `node compare_transcriptions.js "${subsPath}" "${editPath}" "${autoPath}"`,
      { cwd: SCRIPT_DIR, encoding: 'utf8', shell: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const report = JSON.parse(stdout);
    // 順便存一份方便除錯
    const saveTo = path.join(path.dirname(autoPath), `diff_report_${label}.json`);
    fs.writeFileSync(saveTo, JSON.stringify(report, null, 2));
    return {
      label,
      f1Raw:    report.accuracy.f1,
      f1Filt:   report.accuracy_filtered.f1,
      precRaw:  report.accuracy.precision,
      recRaw:   report.accuracy.recall,
      precFilt: report.accuracy_filtered.precision,
      recFilt:  report.accuracy_filtered.recall,
      aiCount:  report.aiCount,
      userCount: report.userCount
    };
  }

  console.error(`📊 評估 rules 模式...`);
  const rulesEval = evalF1(rulesAuto, 'rules');

  console.error(`📊 評估 full_edit 模式...`);
  const fullEval = evalF1(fullAuto, 'full_edit');

    results.push({ name, rules: rulesEval, full: fullEval });
  } catch (err) {
    console.error(`❌ ${name}: 執行錯誤 ${err.message}`);
    results.push({ name, error: 'exec_error', message: err.message });
  }
}

// ── 輸出比較表 ──
console.log('\n\n');
console.log('================== F1 對比 ==================');
console.log('影片                  模式        F1(原)  F1(過濾)  P(過)   R(過)   #預測');
console.log('---------------------------------------------------------------------------');
const valid = results.filter(r => r.rules && r.full);
const errored = results.filter(r => r.error);
for (const r of valid) {
  const nm = r.name.padEnd(20, ' ');
  const fmt = (e) => `${(e.f1Raw*100).toFixed(1).padStart(5)}%  ${(e.f1Filt*100).toFixed(1).padStart(5)}%   ${(e.precFilt*100).toFixed(1).padStart(5)}%  ${(e.recFilt*100).toFixed(1).padStart(5)}%  ${String(e.aiCount).padStart(5)}`;
  console.log(`${nm}  rules     ${fmt(r.rules)}`);
  console.log(`${' '.repeat(20)}  full_edit ${fmt(r.full)}`);
  const delta = (r.full.f1Filt - r.rules.f1Filt) * 100;
  const sign = delta >= 0 ? '+' : '';
  console.log(`${' '.repeat(20)}  Δ F1(過) ${sign}${delta.toFixed(1)} 點`);
  console.log('');
}
for (const r of errored) {
  console.log(`${r.name.padEnd(20, ' ')}  ❌ ${r.error}${r.message ? ': ' + r.message.slice(0, 50) : ''}`);
}

if (valid.length === 0) {
  console.log('沒有有效結果可平均。');
  process.exit(1);
}

// 平均
const avgRulesF1 = valid.reduce((s, r) => s + r.rules.f1Filt, 0) / valid.length;
const avgFullF1  = valid.reduce((s, r) => s + r.full.f1Filt,  0) / valid.length;
console.log('---------------------------------------------------------------------------');
console.log(`平均 F1(過濾): rules=${(avgRulesF1*100).toFixed(2)}%  full_edit=${(avgFullF1*100).toFixed(2)}%  Δ=${((avgFullF1-avgRulesF1)*100).toFixed(2)} 點`);

// JSON 摘要
const summary = {
  videos: results,
  valid_count: valid.length,
  errored_count: errored.length,
  averages: {
    rules_f1_filtered:    avgRulesF1,
    full_edit_f1_filtered: avgFullF1,
    delta_pp:              (avgFullF1 - avgRulesF1) * 100
  }
};
fs.writeFileSync(path.join(TRAINING_DIR, 'full_edit_f1_comparison.json'), JSON.stringify(summary, null, 2));
console.log(`\n📄 詳細結果: training_output/full_edit_f1_comparison.json`);
