#!/usr/bin/env node
/**
 * 量測純規則層 F1（規則改動前後對比用）
 *
 * 用法: node measure_rules_f1.js <video_name> [video_name2 ...]
 *
 * 對每支:
 *   1. 跑 auto_select_rules.js → auto_selected_measure.json (不覆蓋原 auto_selected.json)
 *   2. compare_transcriptions 得到 F1
 *   3. 印出表
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

const videos = process.argv.slice(2);
if (videos.length === 0) {
  console.error('用法: node measure_rules_f1.js <video_name> [...]');
  process.exit(1);
}

const results = [];
for (const name of videos) {
  const dir      = path.join(TRAINING_DIR, name);
  const subs     = path.join(dir, '1_轉錄', 'subtitles_words.json');
  const edited   = path.join(dir, '2_分析', 'edited_words.json');
  const measOut  = path.join(dir, '2_分析', 'auto_selected_measure.json');
  if (!fs.existsSync(subs) || !fs.existsSync(edited)) {
    console.error(`❌ ${name}: 缺檔，跳過`);
    continue;
  }
  try {
    execSync(`node auto_select_rules.js "${subs}" "${measOut}"`, {
      cwd: SCRIPT_DIR, encoding: 'utf8', shell: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = execSync(
      `node compare_transcriptions.js "${subs}" "${edited}" "${measOut}"`,
      { cwd: SCRIPT_DIR, encoding: 'utf8', shell: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const r = JSON.parse(stdout);
    results.push({
      name,
      f1Raw:    r.accuracy.f1,
      f1Filt:   r.accuracy_filtered.f1,
      precFilt: r.accuracy_filtered.precision,
      recFilt:  r.accuracy_filtered.recall,
      aiCount:  r.aiCount,
      userCount: r.userCount
    });
  } catch (err) {
    console.error(`❌ ${name}: ${err.message}`);
  }
}

console.log('\n影片                  F1(原)  F1(過濾)  P(過)   R(過)   #預測  #真');
console.log('---------------------------------------------------------------------');
for (const r of results) {
  console.log(
    r.name.padEnd(20, ' ') +
    '  ' + (r.f1Raw*100).toFixed(1).padStart(5) + '%' +
    '  ' + (r.f1Filt*100).toFixed(1).padStart(5) + '%' +
    '   ' + (r.precFilt*100).toFixed(1).padStart(5) + '%' +
    '  ' + (r.recFilt*100).toFixed(1).padStart(5) + '%' +
    '  ' + String(r.aiCount).padStart(5) +
    '  ' + String(r.userCount).padStart(5)
  );
}
const avg = results.reduce((s, r) => s + r.f1Filt, 0) / Math.max(results.length, 1);
console.log('---------------------------------------------------------------------');
console.log(`平均 F1(過濾): ${(avg*100).toFixed(2)}%（${results.length} 支）`);
