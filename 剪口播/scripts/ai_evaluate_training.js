#!/usr/bin/env node
/**
 * AI 評估執行器 — 對訓練影片跑 AI 分析 + 比對，計算 F1
 *
 * 用法: node ai_evaluate_training.js [選項]
 *   --force            強制重新計算所有影片（忽略快取）
 *   --video <name>     只評估指定影片
 *   --sample <n>       從所有影片中挑選 n 支代表性樣本（預設 0=全部）
 *   --concurrency <n>  同時執行幾支影片（預設 3，因為 Claude Code 不是 API 不受 rate limit）
 *
 * 快取位置：training_output/<name>/2_分析/
 *   ai_sentences.json      — AI 原始輸出（phrases）
 *   ai_auto_selected.json  — word-level indices
 *   ai_diff_report.json    — F1 比對結果
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT_DIR   = __dirname;
const TRAINING_DIR = path.join(SCRIPT_DIR, 'training_output');

// ── 解析參數 ──
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const key = process.argv[i].slice(2);
    args[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
      ? process.argv[++i]
      : true;
  }
}

const force        = !!args.force;
const onlyVideo    = args.video || null;
const SAMPLE       = parseInt(args.sample)      || 0;
const CONCURRENCY  = parseInt(args.concurrency) || 3;
const EVAL_MODEL   = args.model || '';                    // cut 階段用（需要語意判斷，預設空=claude 預設）
const POLISH_MODEL = args['polish-model'] || 'haiku';     // polish 階段用（純機械，預設 haiku 省 token）
const USE_PAIR_MODE = !!args['use-pair-mode'];             // 新管線：規則前置 + 候選對 AI 判斷

const convertAiToIndices = require('./convert_ai_to_indices');

// ── 收集訓練影片清單 ──
const allVideos = [];
if (fs.existsSync(TRAINING_DIR)) {
  for (const dir of fs.readdirSync(TRAINING_DIR)) {
    if (dir === 'node_modules' || dir.startsWith('.')) continue;
    const fullDir = path.join(TRAINING_DIR, dir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    const subsPath    = path.join(fullDir, '1_轉錄', 'subtitles_words.json');
    const editedPath  = path.join(fullDir, '2_分析', 'edited_words.json');
    const analysisDir = path.join(fullDir, '2_分析');
    if (!fs.existsSync(subsPath) || !fs.existsSync(editedPath)) continue;
    allVideos.push({ name: dir, subsPath, editedPath, analysisDir });
  }
}

if (allVideos.length === 0) {
  console.error('❌ 找不到任何訓練數據，請先完成訓練流程');
  process.exit(1);
}

// ── 過濾 / 取樣 ──
let videos = onlyVideo
  ? allVideos.filter(v => v.name === onlyVideo)
  : allVideos;

if (onlyVideo && videos.length === 0) {
  console.error(`❌ 找不到指定影片: ${onlyVideo}`);
  process.exit(1);
}

if (!onlyVideo && SAMPLE > 0 && SAMPLE < videos.length) {
  videos = selectRepresentativeSample(videos, SAMPLE);
}

// ── 代表性取樣：按規則引擎 F1 分層抽樣 ──
function selectRepresentativeSample(all, n) {
  // 嘗試讀取 autoresearch_report 取得各影片 F1 排序
  let f1Map = {};
  try {
    const ar = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, 'autoresearch_report.json'), 'utf8'));
    for (const v of (ar.perVideo || [])) f1Map[v.name] = v.f1;
  } catch (e) {}

  // 按 F1 排序（低到高），平均分成 n 段各取一支
  const sorted = [...all].sort((a, b) => (f1Map[a.name] || 0.95) - (f1Map[b.name] || 0.95));
  const step = sorted.length / n;
  const sample = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(Math.round(i * step + step / 2), sorted.length - 1);
    sample.push(sorted[idx]);
  }
  return sample;
}

console.log(`🎬 AI 評估: ${videos.length}/${allVideos.length} 支影片`);
if (SAMPLE > 0) console.log(`   📊 代表性取樣 ${SAMPLE} 支`);
console.log(`   ⚡ 並行數: ${CONCURRENCY}`);
console.log(`   💡 快取: ${force ? '強制重新計算' : '使用快取（如已存在）'}`);
console.log('');

// ── 並行執行器（concurrency pool） ──
async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i](i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── 執行單支影片 ──
function runExecFile(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function processVideo(video, slot) {
  const { name, subsPath, editedPath, analysisDir } = video;
  const polishedAPath      = path.join(analysisDir, 'polished_A.json');
  const polishedBPath      = path.join(path.dirname(subsPath), 'polished_B.json'); // 1_轉錄/
  const cutInputPath       = path.join(analysisDir, 'cut_input.json');             // pair-mode 用
  const aiSentencesPath        = path.join(analysisDir, 'ai_sentences.json');
  const aiAutoSelectedPath     = path.join(analysisDir, 'ai_auto_selected.json');
  const aiDiffReportPath       = path.join(analysisDir, 'ai_diff_report.json');
  const autoSelectedPath       = path.join(analysisDir, 'auto_selected.json');
  const combinedPath           = path.join(analysisDir, 'combined_auto_selected.json');
  const combinedDiffReportPath = path.join(analysisDir, 'combined_diff_report.json');

  const log = (msg) => console.log(`[slot${slot + 1}] ${name}: ${msg}`);
  const polishModelArgs = POLISH_MODEL ? ['--model', POLISH_MODEL] : [];
  const cutModelArgs    = EVAL_MODEL   ? ['--model', EVAL_MODEL]   : [];
  const execOpts        = { timeout: 1800000, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' };

  // ── Step 0.5: 確保 polished_B 存在（快取 B 側的潤飾結果，供未來比對使用）──
  if (!fs.existsSync(polishedBPath)) {
    log('📝 首次生成 polished_B（潤飾 B 文稿，供快取）...');
    try {
      await runExecFile('node', [
        path.join(SCRIPT_DIR, 'ai_polish.js'), ...polishModelArgs, editedPath, polishedBPath
      ], execOpts);
      log('✅ polished_B 已生成');
    } catch (err) {
      log(`⚠️ polished_B 生成失敗（非致命，繼續評估）: ${err.message}`);
      // 非致命：polished_B 只是快取，評估仍用 edited_words.json
    }
  }

  // ── 檢查快取（polish 和 cut 分開判斷，因為 autoresearch 只改 cut skill）──
  const subsMtime = fs.statSync(subsPath).mtimeMs;

  // polish 只在 subtitles 更新時重跑（不跟 --force 走）→ autoresearch 反覆評估時能大幅省 token
  const needsPolish = !fs.existsSync(polishedAPath)
    || fs.statSync(polishedAPath).mtimeMs < subsMtime;

  // cut 跟 --force 走（skills / prompt 可能改了）
  const needsCut = force || needsPolish
    || !fs.existsSync(aiSentencesPath)
    || fs.statSync(aiSentencesPath).mtimeMs < fs.statSync(polishedAPath).mtimeMs;

  const needsConvert = needsCut
    || !fs.existsSync(aiAutoSelectedPath)
    || fs.statSync(aiAutoSelectedPath).mtimeMs < fs.statSync(aiSentencesPath).mtimeMs;
  const needsCompare = needsConvert
    || !fs.existsSync(aiDiffReportPath)
    || fs.statSync(aiDiffReportPath).mtimeMs < fs.statSync(aiAutoSelectedPath).mtimeMs;

  // combined 是否需要計算（即使 AI 部分有快取）
  const needsCombinedCalc = fs.existsSync(autoSelectedPath) && fs.existsSync(aiAutoSelectedPath)
    && (!fs.existsSync(combinedDiffReportPath)
        || fs.statSync(combinedDiffReportPath).mtimeMs < fs.statSync(aiAutoSelectedPath).mtimeMs);

  if (!needsPolish && !needsCut && !needsConvert && !needsCompare && !needsCombinedCalc) {
    log('✅ 使用快取');
    try {
      const report = JSON.parse(fs.readFileSync(aiDiffReportPath, 'utf8'));
      const af = report.accuracy_filtered || report.accuracy || {};
      let combined = null;
      if (fs.existsSync(combinedDiffReportPath)) {
        try {
          const cr = JSON.parse(fs.readFileSync(combinedDiffReportPath, 'utf8'));
          const cf = cr.accuracy_filtered || cr.accuracy || {};
          combined = { f1: cf.f1||0, precision: cf.precision||0, recall: cf.recall||0, fp: cf.fp||0, fn: cf.fn||0 };
        } catch (e) {}
      }
      return { name, f1: af.f1||0, precision: af.precision||0, recall: af.recall||0, fp: af.fp||0, fn: af.fn||0, combined, cached: true };
    } catch (e) {
      log(`⚠️ 快取讀取失敗: ${e.message}`);
      return null;
    }
  }

  // ── Step 1a: 潤飾（用便宜的模型，因為是純機械任務）──
  if (needsPolish) {
    log(`🖊️ [1/2] 潤飾 A 文稿（${POLISH_MODEL || 'default'}）...`);
    try {
      await runExecFile('node', [
        path.join(SCRIPT_DIR, 'ai_polish.js'), ...polishModelArgs, subsPath, polishedAPath
      ], execOpts);
      log('✅ 潤飾完成');
    } catch (err) {
      log(`❌ 潤飾失敗: ${err.message}`);
      return null;
    }
  } else {
    log('⚡ polished_A 快取命中，跳過潤飾');
  }

  // ── Step 1b: 剪輯判斷（用主模型，需要語意理解）──
  if (needsCut) {
    if (USE_PAIR_MODE) {
      // 新管線：意圖層 + 規則前置過濾 + 候選對 AI 判斷
      const outlinePath = path.join(analysisDir, 'outline.json');

      // Step outline: 整集意圖層（ai_outline.js）
      log(`🗺️ [2a/4] 整集大綱分析（意圖層）...`);
      try {
        await runExecFile('node', [
          path.join(SCRIPT_DIR, 'ai_outline.js'), polishedAPath, outlinePath
        ], execOpts);
        log('✅ 意圖層完成');
      } catch (err) {
        log(`⚠️ 意圖層失敗（非致命，繼續評估）: ${err.message.slice(0, 80)}`);
      }

      log(`🔍 [2b/4] 規則前置過濾...`);
      try {
        const preArgs = [path.join(SCRIPT_DIR, 'phrase_prefilter.js'), polishedAPath, cutInputPath];
        if (fs.existsSync(outlinePath)) preArgs.push('--outline-file', outlinePath);
        preArgs.push('--words-file', subsPath);
        await runExecFile('node', preArgs, execOpts);
        log('✅ 前置過濾完成');
      } catch (err) {
        log(`❌ 前置過濾失敗: ${err.message}`);
        return null;
      }
      log(`✂️ [2c/4] 候選對 AI 判斷（${EVAL_MODEL || 'default'}）...`);
      try {
        const pairsArgs = [path.join(SCRIPT_DIR, 'ai_cut_pairs.js'), ...cutModelArgs, cutInputPath, aiSentencesPath];
        if (fs.existsSync(outlinePath)) pairsArgs.push('--outline-file', outlinePath);
        await runExecFile('node', pairsArgs, execOpts);
        log('✅ AI 對判斷完成');

        // Step 2d: 字詞手術（暫停 — P=11% 無法提升 F1，等待更好的方案）
        // const surgeryArgs = [path.join(SCRIPT_DIR, 'ai_word_surgery.js'), ...cutModelArgs, aiSentencesPath,
        //   '--words-file', subsPath];
        // await runExecFile('node', surgeryArgs, execOpts);
        log('⏭️  [2d/4] 字詞手術已暫停（P 不足）');
      } catch (err) {
        log(`❌ AI 對判斷失敗: ${err.message}`);
        return null;
      }
    } else {
      // 舊管線：全局掃描
      log(`✂️ [2/2] 剪輯判斷 A 文稿（${EVAL_MODEL || 'default'}）...`);
      try {
        await runExecFile('node', [
          path.join(SCRIPT_DIR, 'ai_cut.js'), ...cutModelArgs, polishedAPath, aiSentencesPath
        ], execOpts);
        log('✅ 剪輯判斷完成');
      } catch (err) {
        log(`❌ 剪輯判斷失敗: ${err.message}`);
        return null;
      }
    }
  }

  // ── Step 2: 轉換格式 ──
  if (needsConvert) {
    try {
      const phrases = JSON.parse(fs.readFileSync(aiSentencesPath, 'utf8'));
      const words   = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
      const { indices, reasons } = convertAiToIndices(phrases, words);
      fs.writeFileSync(aiAutoSelectedPath, JSON.stringify({ indices, reasons }, null, 2));
      log(`🔄 轉換完成 (${indices.length} 個索引)`);
    } catch (err) {
      log(`❌ 格式轉換失敗: ${err.message}`);
      return null;
    }
  }

  // ── Step 3: AI 比對 ──
  let aiStats = null;
  if (needsCompare) {
    try {
      const { stdout } = await runExecFile('node', [
        path.join(SCRIPT_DIR, 'compare_transcriptions.js'),
        subsPath, editedPath, aiAutoSelectedPath
      ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
      const report = JSON.parse(stdout.trim());
      fs.writeFileSync(aiDiffReportPath, JSON.stringify(report, null, 2));
      const af = report.accuracy_filtered || report.accuracy || {};
      aiStats = { f1: af.f1||0, precision: af.precision||0, recall: af.recall||0, fp: af.fp||0, fn: af.fn||0 };
      log(`📊 AI: F1=${(af.f1*100).toFixed(1)}% P=${(af.precision*100).toFixed(1)}% R=${(af.recall*100).toFixed(1)}% FP=${af.fp} FN=${af.fn}`);
    } catch (err) {
      log(`❌ 比對失敗: ${err.message}`);
      return null;
    }
  } else {
    try {
      const report = JSON.parse(fs.readFileSync(aiDiffReportPath, 'utf8'));
      const af = report.accuracy_filtered || report.accuracy || {};
      aiStats = { f1: af.f1||0, precision: af.precision||0, recall: af.recall||0, fp: af.fp||0, fn: af.fn||0 };
    } catch (e) { return null; }
  }

  // ── Step 4: 合併 F1（規則引擎 ∪ AI pair 判斷）──
  let combined = null;
  if (fs.existsSync(autoSelectedPath) && fs.existsSync(aiAutoSelectedPath)) {
    const needsCombined = needsCompare
      || !fs.existsSync(combinedDiffReportPath)
      || fs.statSync(combinedDiffReportPath).mtimeMs < fs.statSync(aiAutoSelectedPath).mtimeMs;
    if (needsCombined) {
      try {
        const ruleData = JSON.parse(fs.readFileSync(autoSelectedPath, 'utf8'));
        const aiData   = JSON.parse(fs.readFileSync(aiAutoSelectedPath, 'utf8'));
        const mergedIdx = [...new Set([...ruleData.indices, ...aiData.indices])].sort((a, b) => a - b);
        fs.writeFileSync(combinedPath, JSON.stringify(
          { indices: mergedIdx, reasons: { ...ruleData.reasons, ...aiData.reasons } }, null, 2));
        const { stdout: cs } = await runExecFile('node', [
          path.join(SCRIPT_DIR, 'compare_transcriptions.js'),
          subsPath, editedPath, combinedPath
        ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
        const cr = JSON.parse(cs.trim());
        fs.writeFileSync(combinedDiffReportPath, JSON.stringify(cr, null, 2));
        const cf = cr.accuracy_filtered || cr.accuracy || {};
        combined = { f1: cf.f1||0, precision: cf.precision||0, recall: cf.recall||0, fp: cf.fp||0, fn: cf.fn||0,
                     categoryStats: cr.categoryStats || {} };
        log(`🔀 合併: F1=${(cf.f1*100).toFixed(1)}% P=${(cf.precision*100).toFixed(1)}% R=${(cf.recall*100).toFixed(1)}% FP=${cf.fp} FN=${cf.fn}`);
      } catch (err) {
        log(`⚠️ 合併計算失敗: ${err.message}`);
      }
    } else {
      try {
        const cr = JSON.parse(fs.readFileSync(combinedDiffReportPath, 'utf8'));
        const cf = cr.accuracy_filtered || cr.accuracy || {};
        combined = { f1: cf.f1||0, precision: cf.precision||0, recall: cf.recall||0, fp: cf.fp||0, fn: cf.fn||0,
                     categoryStats: cr.categoryStats || {} };
      } catch (e) {}
    }
  }

  return { name, ...aiStats, combined };
}

// ── 主流程 ──
(async () => {
  const tasks = videos.map((video, i) => (slot) => processVideo(video, slot));
  const rawResults = await runPool(tasks, CONCURRENCY);
  const results = rawResults.filter(Boolean);

  if (results.length === 0) {
    console.error('\n❌ 沒有任何成功的評估結果');
    process.exit(1);
  }

  // ── 彙總 ──
  let totalTP = 0, totalFP = 0, totalFN = 0;
  let combTP = 0, combFP = 0, combFN = 0;
  let hasCombined = false;
  for (const r of results) {
    const tp = r.precision > 0 ? Math.round(r.fp / (1 / r.precision - 1)) : 0;
    totalTP += tp;
    totalFP += r.fp;
    totalFN += r.fn;
    if (r.combined) {
      hasCombined = true;
      const ctp = r.combined.precision > 0 ? Math.round(r.combined.fp / (1 / r.combined.precision - 1)) : 0;
      combTP += ctp;
      combFP += r.combined.fp;
      combFN += r.combined.fn;
    }
  }
  const overallP  = totalTP > 0 ? totalTP / (totalTP + totalFP) : 0;
  const overallR  = totalTP > 0 ? totalTP / (totalTP + totalFN) : 0;
  const overallF1 = (overallP + overallR > 0) ? 2 * overallP * overallR / (overallP + overallR) : 0;
  const avgF1     = results.reduce((s, r) => s + r.f1, 0) / results.length;
  const skipped   = results.filter(r => r.cached).length;

  const combP  = combTP > 0 ? combTP / (combTP + combFP) : 0;
  const combR  = combTP > 0 ? combTP / (combTP + combFN) : 0;
  const combF1 = (combP + combR > 0) ? 2 * combP * combR / (combP + combR) : 0;
  const combAvgF1 = hasCombined
    ? results.filter(r => r.combined).reduce((s, r) => s + r.combined.f1, 0) / results.filter(r => r.combined).length
    : null;

  const report = {
    timestamp: new Date().toISOString(),
    videos:    results.length,
    skipped,
    forced:    force,
    sample:    SAMPLE > 0 ? SAMPLE : null,
    concurrency: CONCURRENCY,
    overall:         { f1: overallF1, precision: overallP, recall: overallR, fp: totalFP, fn: totalFN },
    overallCombined: hasCombined ? { f1: combF1, precision: combP, recall: combR, fp: combFP, fn: combFN } : null,
    avgF1,
    avgCombinedF1: combAvgF1,
    perVideo: results.sort((a, b) => (a.combined?.f1 ?? a.f1) - (b.combined?.f1 ?? b.f1))
  };

  const reportPath = path.join(TRAINING_DIR, 'ai_evaluation_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n' + '═'.repeat(60));
  console.log('📊 評估彙總（規則引擎 + AI pair 合併）');
  console.log('═'.repeat(60));
  console.log(`  影片數:     ${results.length} (快取: ${skipped}, 失敗: ${videos.length - results.length})`);

  if (hasCombined) {
    console.log(`\n  ★ 合併 F1:  ${(combF1 * 100).toFixed(2)}%  ← 真正的系統指標`);
    console.log(`  合併精確率: ${(combP * 100).toFixed(2)}%`);
    console.log(`  合併召回率: ${(combR * 100).toFixed(2)}%`);
    console.log(`  合併 FP:    ${combFP} | 合併 FN: ${combFN}`);
  }
  console.log(`\n  AI pair F1: ${(overallF1 * 100).toFixed(2)}%（僅 pair 模組貢獻，不含規則引擎）`);
  console.log(`  AI 精確率:  ${(overallP * 100).toFixed(2)}%`);
  console.log(`  AI 召回率:  ${(overallR * 100).toFixed(2)}%`);

  // 對比規則引擎 → 顯示 AI 的增益
  try {
    const ar = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, 'autoresearch_report.json'), 'utf8'));
    const ruleF1 = ar.final.f1;
    console.log('\n  ──────────────────────────────────');
    console.log(`  規則引擎 F1: ${(ruleF1 * 100).toFixed(2)}%`);
    if (hasCombined) {
      const gain = combF1 - ruleF1;
      console.log(`  合併 F1:     ${(combF1 * 100).toFixed(2)}%`);
      console.log(`  AI 增益:     ${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(2)}pp`);
    }
  } catch (e) {}

  // ── 分類細分（彙總所有影片的 categoryStats）──
  const globalCatStats = {};
  for (const r of results) {
    const cats = r.combined?.categoryStats || {};
    for (const [cat, s] of Object.entries(cats)) {
      if (!globalCatStats[cat]) globalCatStats[cat] = { tp: 0, fp: 0, fn: 0 };
      globalCatStats[cat].tp += s.tp || 0;
      globalCatStats[cat].fp += s.fp || 0;
      globalCatStats[cat].fn += s.fn || 0;
    }
  }
  const hasCats = Object.keys(globalCatStats).length > 0;
  if (hasCats) {
    console.log('\n  ── 分類細分（合併 FP/FN 來源）──');
    const catOrder = ['silence', 'take_group', 'adjacent_repeat', 'stutter', 'ai_pair', 'repeated_sentence', 'unclassified'];
    const allCats = [...new Set([...catOrder, ...Object.keys(globalCatStats)])];
    for (const cat of allCats) {
      const s = globalCatStats[cat];
      if (!s || (s.tp === 0 && s.fp === 0 && s.fn === 0)) continue;
      const p = s.tp > 0 ? s.tp / (s.tp + s.fp) : 0;
      const r2 = s.tp > 0 ? s.tp / (s.tp + s.fn) : 0;
      const f = (p + r2 > 0) ? 2 * p * r2 / (p + r2) : 0;
      const label = cat.padEnd(18);
      console.log(`  ${label} P=${(p*100).toFixed(0).padStart(3)}% R=${(r2*100).toFixed(0).padStart(3)}% F1=${(f*100).toFixed(0).padStart(3)}%  FP=${String(s.fp).padStart(3)} FN=${String(s.fn).padStart(3)}`);
    }
  }

  const sortedByWorst = [...results].sort((a, b) => (a.combined?.f1 ?? a.f1) - (b.combined?.f1 ?? b.f1));
  console.log('\n最差影片（按合併 F1）:');
  for (const v of sortedByWorst.slice(0, 5)) {
    const cLine = v.combined ? ` | 合併 F1=${(v.combined.f1*100).toFixed(1)}%` : '';
    console.log(`  ${v.name}: AI F1=${(v.f1 * 100).toFixed(1)}%${cLine} FP=${v.combined?.fp??v.fp} FN=${v.combined?.fn??v.fn}`);
  }
  console.log(`\n📄 報告: ${reportPath}`);
})();
