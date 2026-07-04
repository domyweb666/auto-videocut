#!/usr/bin/env node
/**
 * eval_layer_report.js — 黃金集分層歸因：AI 每一層下的刀 vs 使用者實際剪輯，逐層算命中/誤刪。
 *
 * 讀 eval_golden.js 的產物（零 AI 成本，可反覆跑）：
 *   eval_sentences_raw.json  候選對層剛判完（review/audit 前）
 *   eval_sentences.json      review/audit + filler 清理後（最終）
 *   eval_auto_selected.json  字級索引
 *   eval_diff_report.json    與使用者成品的對照（FP/FN 字級清單）
 *
 * 歸因邏輯：
 *   - 每個 AI 刪除字 → 追到它所屬 phrase 的 deleteCategory（哪一層下的刀）
 *   - raw 沒刪、final 有刪 → 歸因 review/audit（整稿潤稿層加刪）
 *   - raw 有刪、final 沒刪 → review/audit 撤刪（單獨統計）
 *   - FP = 該字使用者實際保留；TP = 使用者也刪了
 *
 * 用法: node eval_layer_report.js [影片1,影片2,...]（不給＝讀 eval_golden_report.json 的 perVideo）
 */
const fs   = require('fs');
const path = require('path');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

let names = process.argv[2] ? process.argv[2].split(',').map(s => s.trim()) : null;
if (!names) {
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, 'eval_golden_report.json'), 'utf8'));
    names = rep.perVideo.map(v => v.name);
  } catch (e) { console.error('❌ 讀不到 eval_golden_report.json，請指定影片名'); process.exit(1); }
}

const layers = {};          // category → { del, tp, fp }
const revoked = { del: 0 }; // review/audit 撤刪
function bump(cat, isTP) {
  if (!layers[cat]) layers[cat] = { del: 0, tp: 0, fp: 0 };
  layers[cat].del++;
  layers[cat][isTP ? 'tp' : 'fp']++;
}

let videosDone = 0;
for (const name of names) {
  const dir = path.join(TRAINING_DIR, name, '2_分析');
  const need = ['eval_sentences_raw.json', 'eval_sentences.json', 'eval_auto_selected.json', 'eval_diff_report.json'];
  if (need.some(f => !fs.existsSync(path.join(dir, f)))) { console.error(`⚠️ ${name}: eval 產物不全，跳過`); continue; }

  const raw   = JSON.parse(fs.readFileSync(path.join(dir, 'eval_sentences_raw.json'), 'utf8'));
  const fin   = JSON.parse(fs.readFileSync(path.join(dir, 'eval_sentences.json'), 'utf8'));
  const sel   = JSON.parse(fs.readFileSync(path.join(dir, 'eval_auto_selected.json'), 'utf8'));
  const diff  = JSON.parse(fs.readFileSync(path.join(dir, 'eval_diff_report.json'), 'utf8'));

  // 字級 FP 集合（AI 刪、使用者留）；其餘 AI 刪除字視為 TP
  const fpIdx = new Set((diff.falsePositives || []).map(w => w.idx));
  const aiIdx = new Set(sel.indices || []);

  // phrase → 字級歸因：final 的刪除 phrase 決定 category；raw 沒刪的＝review/audit 加刪
  const wordCat = new Map();
  for (let pi = 0; pi < fin.length; pi++) {
    const p = fin[pi], r = raw[pi];
    const finDel = !!(p.aiDelete || p.gapDelete);
    const rawDel = !!(r && (r.aiDelete || r.gapDelete));
    if (finDel) {
      let cat = p.aiDelete ? (p.deleteCategory || 'ai_unknown') : 'silence_gap';
      if (!rawDel) cat = 'review_audit(加刪)';
      for (const wi of (p.wordIndices || [])) wordCat.set(wi, cat);
    } else if (Array.isArray(p.wordDeleteIdx) && p.wordDeleteIdx.length > 0) {
      // 部分刪除（二段手術 ai_pair_part / 規則G）：reason 前綴＝層別
      const cat = String(p.wordDeleteReason || 'word_partial').split(':')[0].trim() + '(部分)';
      const wis = p.wordIndices || [];
      for (const li of p.wordDeleteIdx) { if (wis[li] != null) wordCat.set(wis[li], cat); }
      if (rawDel) revoked.del += Math.max(0, (r.wordIndices || []).length - p.wordDeleteIdx.length);
    } else if (rawDel) {
      revoked.del += (r.wordIndices || []).length;
    }
  }

  for (const wi of aiIdx) {
    const cat = wordCat.get(wi) || 'filler_trim/其他';
    bump(cat, !fpIdx.has(wi));
  }
  videosDone++;
}

console.log(`\n📊 分層歸因（${videosDone} 支影片，字級）— AI 每層的刀 vs 你的實際剪輯`);
console.log('─'.repeat(72));
console.log('層別                        AI刪字數   你也刪(TP)  你其實留(FP)  該層精確率');
const rows = Object.entries(layers).sort((a, b) => b[1].fp - a[1].fp);
for (const [cat, s] of rows) {
  const p = s.del ? (s.tp / s.del * 100).toFixed(1) : '—';
  console.log(`${cat.padEnd(26)} ${String(s.del).padStart(8)} ${String(s.tp).padStart(11)} ${String(s.fp).padStart(12)} ${String(p).padStart(10)}%`);
}
if (revoked.del > 0) console.log(`\nreview/audit 撤刪（候選對層想刪、被二讀救回）：${revoked.del} 字`);
console.log('\n讀法：FP 最大的層＝跟你剪輯差異最大的層（優先調它）；精確率低的層在誤刪。');
