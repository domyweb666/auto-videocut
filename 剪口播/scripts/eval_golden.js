#!/usr/bin/env node
/**
 * eval_golden.js — 黃金集評測器：對 training_output 的使用者成品標準答案，
 * 重跑「與 8900 產線完全同鏈」的 AI 分析，量測誤刪(FP)/漏刪(FN)。
 *
 * 與 legacy/ai_evaluate_training.js 的差異：
 *   - 鏈補齊 2026-07 產線新增的三步：ai_polish_review(review) → (audit) → inline_filler_trim
 *   - 模型跟產線一致且明確：polish=haiku, outline=sonnet, pairs=opus(可 --pairs-model 覆蓋), review/audit=sonnet
 *   - 輸出檔一律 eval_ 前綴，不覆蓋 legacy 舊資產（ai_sentences.json 等）
 *   - 不再合併舊規則引擎 auto_selected（已 stale）；本工具只量 AI 內容判斷鏈
 *
 * 用法: node eval_golden.js [--videos a,b,c] [--sample n] [--force] [--concurrency n]
 *                           [--pairs-model opus] [--skip-review]
 *   --force        重跑 AI（候選對/潤稿/二讀）；不加則吃快取
 *   --skip-review  跳過 review/audit 兩步（A/B 對照用）
 *
 * 報告: training_output/eval_golden_report.json + eval_golden_history.jsonl
 */
const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const key = process.argv[i].slice(2);
    args[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
  }
}
const FORCE       = !!args.force;
const ONLY        = args.videos ? String(args.videos).split(',').map(s => s.trim()).filter(Boolean) : null;
const SAMPLE      = parseInt(args.sample) || 0;
const CONCURRENCY = parseInt(args.concurrency) || 3;
const PAIRS_MODEL = args['pairs-model'] || 'opus';
const SKIP_REVIEW = !!args['skip-review'];

const convertAiToIndices = require('./convert_ai_to_indices');

// ── 收集影片 ──
const allVideos = [];
for (const dir of fs.existsSync(TRAINING_DIR) ? fs.readdirSync(TRAINING_DIR) : []) {
  const fullDir = path.join(TRAINING_DIR, dir);
  if (!fs.statSync(fullDir).isDirectory()) continue;
  const subsPath   = path.join(fullDir, '1_轉錄', 'subtitles_words.json');
  const editedPath = path.join(fullDir, '2_分析', 'edited_words.json');
  if (!fs.existsSync(subsPath) || !fs.existsSync(editedPath)) continue;
  allVideos.push({ name: dir, subsPath, editedPath, analysisDir: path.join(fullDir, '2_分析') });
}
if (!allVideos.length) { console.error('❌ training_output 沒有帶標準答案的影片'); process.exit(1); }

let videos = ONLY ? allVideos.filter(v => ONLY.includes(v.name)) : allVideos;
if (ONLY && videos.length !== ONLY.length) {
  const found = new Set(videos.map(v => v.name));
  console.error('⚠️ 找不到: ' + ONLY.filter(n => !found.has(n)).join(', '));
}
if (!ONLY && SAMPLE > 0 && SAMPLE < videos.length) {
  // 均勻取樣：按轉錄檔大小排序後等距抽，涵蓋長短片
  const sorted = [...videos].sort((a, b) => fs.statSync(a.subsPath).size - fs.statSync(b.subsPath).size);
  const step = sorted.length / SAMPLE;
  videos = Array.from({ length: SAMPLE }, (_, i) => sorted[Math.floor(i * step + step / 2)]);
}
console.log(`🎯 黃金集評測：${videos.length} 支（pairs=${PAIRS_MODEL}${SKIP_REVIEW ? ', 無 review/audit' : ''}, 並行 ${CONCURRENCY}）\n`);

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, cmdArgs, { timeout: 1800000, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8', ...opts },
      (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }));
  });
}
async function runPool(tasks, n) {
  const results = new Array(tasks.length); let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](i % n); }
  }));
  return results;
}
const mtime = f => fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;

// ── FN 分帳：機械性（碎念/短碎片，AI 該追）vs 編輯性（整段內容取捨，只做建議層）──
const FILLERS = ['你知道', '然後', '就是', '那個', '這個', '所以', '等等', '其實', '反正', '的話',
                 '那', '就', '嗯', '呃', '欸', '啊', '喔', '嘛', '對'].sort((a, b) => b.length - a.length);
function fillerCoverage(text) {
  let covered = 0, i = 0;
  while (i < text.length) {
    const tok = FILLERS.find(t => text.startsWith(t, i));
    if (tok) { covered += tok.length; i += tok.length; } else i++;
  }
  return covered / Math.max(1, text.length);
}
function splitFN(report) {
  const fns = (report.falseNegatives || []).filter(x => !x.isGap && x.text !== '[靜音]');
  const spans = [];
  let cur = null;
  for (const w of fns.sort((a, b) => a.idx - b.idx)) {
    if (cur && w.idx - cur.lastIdx <= 2) { cur.text += w.text; cur.lastIdx = w.idx; cur.n++; }
    else { if (cur) spans.push(cur); cur = { text: w.text, lastIdx: w.idx, n: 1 }; }
  }
  if (cur) spans.push(cur);
  let mech = 0, edit = 0;
  for (const s of spans) {
    if (s.n <= 12 || fillerCoverage(s.text) >= 0.4) mech += s.n; else edit += s.n;
  }
  return { mechFN: mech, editFN: edit };
}

async function processVideo(video, slot) {
  const { name, subsPath, editedPath, analysisDir } = video;
  const polishedPath   = path.join(analysisDir, 'polished_A.json');
  const outlinePath    = path.join(analysisDir, 'eval_outline.json');
  const cutInputPath   = path.join(analysisDir, 'eval_cut_input.json');
  const rawSentPath    = path.join(analysisDir, 'eval_sentences_raw.json');   // cut_pairs 原始輸出
  const sentencesPath  = path.join(analysisDir, 'eval_sentences.json');       // review/audit/filler 後
  const autoSelPath    = path.join(analysisDir, 'eval_auto_selected.json');
  const diffPath       = path.join(analysisDir, 'eval_diff_report.json');
  const log = m => console.log(`[${slot + 1}] ${name}: ${m}`);

  try {
    // 1. 標點（純機械，永久快取；沿用既有 polished_A）
    if (mtime(polishedPath) < mtime(subsPath)) {
      log('🖊️ 標點（haiku）...');
      await run('node', [path.join(SCRIPT_DIR, 'ai_polish.js'), '--model', 'haiku', subsPath, polishedPath]);
    }
    // 2. 大綱（ai_outline 內建 hash+model 快取，重跑不花額度）
    log('🗺️ 大綱（sonnet）...');
    try { await run('node', [path.join(SCRIPT_DIR, 'ai_outline.js'), '--model', 'sonnet', polishedPath, outlinePath]); }
    catch (e) { log('⚠️ 大綱失敗（繼續）: ' + String(e.message).slice(0, 80)); }

    // 3. 規則前置過濾（零 AI 成本，永遠重跑 → 門檻調整立即生效）
    const preArgs = [path.join(SCRIPT_DIR, 'phrase_prefilter.js'), polishedPath, cutInputPath,
                     '--words-file', subsPath];
    if (fs.existsSync(outlinePath)) preArgs.push('--outline-file', outlinePath);
    const feat = path.join(path.dirname(subsPath), 'audio_features.json');
    if (fs.existsSync(feat)) preArgs.push('--audio-features', feat);
    await run('node', preArgs);

    // 4. 候選對 AI 判斷（ai_cut_pairs 內建 hash+model 快取；--force 由這層之後接手）
    const needCut = FORCE || mtime(rawSentPath) < mtime(cutInputPath) || !fs.existsSync(rawSentPath);
    if (needCut) {
      log(`✂️ 候選對（${PAIRS_MODEL}）...`);
      const pa = [path.join(SCRIPT_DIR, 'ai_cut_pairs.js'), '--model', PAIRS_MODEL, cutInputPath, rawSentPath];
      if (fs.existsSync(outlinePath)) pa.push('--outline-file', outlinePath);
      await run('node', pa);
    } else log('⚡ 候選對快取命中');

    // 5+6. 整稿潤稿 + 嚴格二讀（產線同款，sonnet；在複本上跑避免污染候選對快取）
    const needReview = needCut || mtime(sentencesPath) < mtime(rawSentPath);
    if (needReview) {
      fs.copyFileSync(rawSentPath, sentencesPath);
      if (!SKIP_REVIEW) {
        for (const pass of ['review', 'audit']) {
          log(`🪄 ${pass}（sonnet）...`);
          try {
            const ra = [path.join(SCRIPT_DIR, 'ai_polish_review.js'), '--pass', pass, '--model', 'sonnet', sentencesPath];
            if (fs.existsSync(outlinePath)) ra.push('--outline-file', outlinePath);
            await run('node', ra);
          } catch (e) { log(`⚠️ ${pass} 失敗（繼續）: ` + String(e.message).slice(0, 80)); }
        }
      }
      // 7. 句中 filler 清理（零 AI）
      try { await run('node', [path.join(SCRIPT_DIR, 'inline_filler_trim.js'), sentencesPath, subsPath]); }
      catch (e) { log('⚠️ filler 清理失敗（繼續）'); }
    } else log('⚡ review/audit 快取命中');

    // 8. 轉字級索引 → 9. 對照標準答案
    const phrases = JSON.parse(fs.readFileSync(sentencesPath, 'utf8'));
    const words   = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
    const { indices, reasons } = convertAiToIndices(phrases, words);
    fs.writeFileSync(autoSelPath, JSON.stringify({ indices, reasons }, null, 2));
    const { stdout } = await run('node', [path.join(SCRIPT_DIR, 'compare_transcriptions.js'),
      subsPath, editedPath, autoSelPath], { timeout: 120000 });
    const report = JSON.parse(stdout.trim());
    fs.writeFileSync(diffPath, JSON.stringify(report, null, 2));
    const a = report.accuracy_filtered || report.accuracy || {};
    const { mechFN, editFN } = splitFN(report);
    log(`📊 F1=${(a.f1 * 100).toFixed(1)}% P=${(a.precision * 100).toFixed(1)}% R=${(a.recall * 100).toFixed(1)}% FP=${a.fp} FN=${a.fn}（機械 ${mechFN}／編輯 ${editFN}）`);
    return { name, f1: a.f1 || 0, precision: a.precision || 0, recall: a.recall || 0,
             fp: a.fp || 0, fn: a.fn || 0, mechFN, editFN, categoryStats: report.categoryStats || {} };
  } catch (err) {
    log('❌ 失敗: ' + String(err.message).split('\n')[0]);
    return null;
  }
}

(async () => {
  const results = (await runPool(videos.map(v => s => processVideo(v, s)), CONCURRENCY)).filter(Boolean);
  if (!results.length) { console.error('❌ 全數失敗'); process.exit(1); }

  let TP = 0, FP = 0, FN = 0, MECH = 0, EDIT = 0;
  const cats = {};
  for (const r of results) {
    TP += r.precision > 0 ? Math.round(r.fp / (1 / r.precision - 1)) : 0;
    FP += r.fp; FN += r.fn; MECH += r.mechFN || 0; EDIT += r.editFN || 0;
    for (const [c, s] of Object.entries(r.categoryStats)) {
      if (!cats[c]) cats[c] = { tp: 0, fp: 0, fn: 0 };
      cats[c].tp += s.tp || 0; cats[c].fp += s.fp || 0; cats[c].fn += s.fn || 0;
    }
  }
  const P = TP ? TP / (TP + FP) : 0, R = TP ? TP / (TP + FN) : 0;
  const F1 = (P + R) ? 2 * P * R / (P + R) : 0;

  console.log('\n' + '═'.repeat(56));
  console.log(`📊 黃金集彙總（${results.length} 支, pairs=${PAIRS_MODEL}${SKIP_REVIEW ? ', 無review' : ''}）`);
  console.log(`   F1=${(F1 * 100).toFixed(2)}%  精確率=${(P * 100).toFixed(2)}%（誤刪率 ${(100 - P * 100).toFixed(2)}%）  召回率=${(R * 100).toFixed(2)}%`);
  console.log(`   FP(AI刪你留)=${FP} 字  FN(你刪AI沒抓)=${FN} 字`);
  console.log(`   FN 分帳（非靜音）：機械性 ${MECH} 字（AI 該追的 KPI）／編輯性 ${EDIT} 字（整段取捨，建議層即可）`);
  const catRows = Object.entries(cats).filter(([, s]) => s.tp + s.fp + s.fn > 0);
  if (catRows.length) {
    console.log('   ── 分類細分 ──');
    for (const [c, s] of catRows.sort((a, b) => b[1].fp - a[1].fp)) {
      const cp = s.tp ? s.tp / (s.tp + s.fp) : 0;
      console.log(`   ${c}: P=${(cp * 100).toFixed(0)}% (tp=${s.tp} fp=${s.fp} fn=${s.fn})`);
    }
  }

  const report = {
    timestamp: new Date().toISOString(), pairsModel: PAIRS_MODEL, skipReview: SKIP_REVIEW,
    videos: results.length,
    overall: { f1: F1, precision: P, recall: R, fp: FP, fn: FN, mechFN: MECH, editFN: EDIT },
    categoryStats: cats,
    perVideo: results.sort((a, b) => a.f1 - b.f1),
  };
  fs.writeFileSync(path.join(TRAINING_DIR, 'eval_golden_report.json'), JSON.stringify(report, null, 2));
  fs.appendFileSync(path.join(TRAINING_DIR, 'eval_golden_history.jsonl'), JSON.stringify({
    ts: report.timestamp, pairsModel: PAIRS_MODEL, skipReview: SKIP_REVIEW, videos: results.length,
    f1: F1, p: P, r: R, fp: FP, fn: FN, mechFN: MECH, editFN: EDIT,
  }) + '\n');
  console.log('\n📄 報告: training_output/eval_golden_report.json（FP/FN 明細在各影片 2_分析/eval_diff_report.json）');
})();
