#!/usr/bin/env node
/**
 * compare_layers.js — 看一支影片各層 AI 各刪了多少
 *
 * 兩種用法：
 *   1. CLI：node compare_layers.js <影片資料夾或 sentences.json>
 *   2. require('./compare_layers').analyze(sentencesPath, analysisDir) → JSON
 */

const fs   = require('fs');
const path = require('path');

// ── 核心分析函式（可被 server 重用）──
function analyze(sentencesPath, analysisDir) {
  if (!fs.existsSync(sentencesPath)) {
    return { error: 'sentences.json 不存在: ' + sentencesPath };
  }
  let sentences;
  try {
    sentences = JSON.parse(fs.readFileSync(sentencesPath, 'utf8'));
  } catch (e) {
    return { error: 'sentences.json 解析失敗: ' + e.message };
  }
  if (!Array.isArray(sentences)) {
    return { error: 'sentences.json 格式錯誤（應為陣列）' };
  }

  const byCategory = {};
  const detailsByCategory = {};
  let totalDeleted = 0, totalKept = 0, totalGapDelete = 0;

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.aiDelete) {
      totalDeleted++;
      const cat = s.deleteCategory || 'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      detailsByCategory[cat] = detailsByCategory[cat] || [];
      detailsByCategory[cat].push({
        id: i,
        text: (s.displayText || s.text || '').slice(0, 60),
        reason: (s.deleteReason || '').slice(0, 100),
      });
    } else {
      totalKept++;
    }
    if (s.gapDelete && !s.aiDelete) totalGapDelete++;
  }

  const totalDuration = sentences.reduce((sum, s) => {
    if (s.aiDelete) return sum;
    return sum + ((s.endTime || 0) - (s.startTime || 0));
  }, 0);
  const originalDuration = sentences.reduce((sum, s) => sum + ((s.endTime || 0) - (s.startTime || 0)), 0);

  // 撈 log 摘要
  const logs = [];
  const logFiles = [
    { name: 'ai_cut_pairs',     file: 'ai_cut_pairs_log.txt' },
    { name: 'ai_polish_review', file: 'ai_polish_review_log.txt' },
    { name: 'ai_polish_audit',  file: 'ai_polish_audit_log.txt' },
  ];
  for (const l of logFiles) {
    const p = path.join(analysisDir, l.file);
    if (!fs.existsSync(p)) {
      logs.push({ name: l.name, exists: false });
      continue;
    }
    const content = fs.readFileSync(p, 'utf8');
    const m1 = content.match(/輸入候選對：(\d+)/);
    const m2 = content.match(/delete_earlier.*?：(\d+)/);
    const m3 = content.match(/keep_both.*?：(\d+)/);
    const m4 = content.match(/實際套用：(\d+)/);
    const m5 = content.match(/粗剪稿長度：(\d+) 句/);
    const m6 = content.match(/reviewer 建議刪除：(\d+)/);
    let summary = '';
    if (m1) summary = `候選對 ${m1[1]}，delete_earlier ${m2 ? m2[1] : '?'}，keep_both ${m3 ? m3[1] : '?'}`;
    else if (m5) summary = `粗剪稿 ${m5[1]} 句，建議刪 ${m6 ? m6[1] : '?'}，套用 ${m4 ? m4[1] : '?'}`;
    logs.push({ name: l.name, exists: true, summary, path: p });
  }

  return {
    totalSentences: sentences.length,
    totalKept,
    totalDeleted,
    totalGapDelete,
    originalDurationSec: originalDuration,
    keptDurationSec: totalDuration,
    savedPercent: originalDuration > 0 ? ((1 - totalDuration / originalDuration) * 100) : 0,
    byCategory,
    detailsByCategory,
    logs,
  };
}

// ── 路徑解析（兩種用法共用）──
function resolvePaths(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return {
      sentencesPath: path.join(target, '1_轉錄', 'sentences.json'),
      analysisDir:   path.join(target, '2_分析'),
    };
  }
  if (stat.isFile()) {
    const parent = path.dirname(target);
    const analysisDir = path.basename(parent) === '1_轉錄'
      ? path.join(path.dirname(parent), '2_分析')
      : parent;
    return { sentencesPath: target, analysisDir };
  }
  return null;
}

module.exports = { analyze, resolvePaths };

// ── CLI 模式 ──
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('用法: node compare_layers.js <影片資料夾或 sentences.json>');
    process.exit(1);
  }
  const paths = resolvePaths(target);
  if (!paths) { console.error('❌ 找不到: ' + target); process.exit(1); }

  const r = analyze(paths.sentencesPath, paths.analysisDir);
  if (r.error) { console.error('❌ ' + r.error); process.exit(1); }

  const dim   = s => `\x1b[2m${s}\x1b[0m`;
  const bold  = s => `\x1b[1m${s}\x1b[0m`;
  const green = s => `\x1b[32m${s}\x1b[0m`;
  const red   = s => `\x1b[31m${s}\x1b[0m`;
  const yellow = s => `\x1b[33m${s}\x1b[0m`;

  console.log(bold('\n═══════════════════════════════════════════════════════'));
  console.log(bold(' 各層 AI 刪除分布'));
  console.log(bold('═══════════════════════════════════════════════════════\n'));

  console.log(`總句子數：${r.totalSentences}`);
  console.log(`保留：${green(r.totalKept)}（${(r.totalKept / r.totalSentences * 100).toFixed(1)}%）`);
  console.log(`刪除：${red(r.totalDeleted)}（${(r.totalDeleted / r.totalSentences * 100).toFixed(1)}%）`);
  console.log(`原始：${(r.originalDurationSec / 60).toFixed(1)} 分鐘 → 保留：${(r.keptDurationSec / 60).toFixed(1)} 分鐘（省 ${r.savedPercent.toFixed(0)}%）\n`);

  const labels = {
    pause: '停頓 (gap rule)',
    filler: '語氣詞 (filler rule)',
    repeat: '重複 (rule + ai_cut_pairs)',
    ai_pair: 'ai_cut_pairs (AI 候選對)',
    whisper_hallucination: 'Whisper 幻覺',
    take_group: '重複 take group (rule)',
    adjacent_repeat: '相鄰重複 (rule)',
    reviewer: yellow('reviewer (整稿潤稿)'),
    audit: yellow('audit (嚴格二讀)'),
  };

  console.log(bold('各 deleteCategory 分布：'));
  const sorted = Object.entries(r.byCategory).sort((a, b) => b[1] - a[1]);
  const tot = sorted.reduce((s, [, c]) => s + c, 0);
  for (const [cat, count] of sorted) {
    const label = labels[cat] || cat;
    const pct = (count / tot * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(count / tot * 30));
    console.log(`  ${label.padEnd(36, ' ')} ${String(count).padStart(4)} (${pct.padStart(5)}%) ${dim(bar)}`);
  }

  for (const focusCat of ['reviewer', 'audit']) {
    const items = r.detailsByCategory[focusCat] || [];
    if (items.length === 0) continue;
    console.log(bold(`\n${labels[focusCat]} 詳細：`));
    for (const it of items.slice(0, 20)) {
      console.log(`  ${dim('[' + it.id + ']')} ${it.text}`);
      console.log(`    ${dim('→ ' + it.reason)}`);
    }
    if (items.length > 20) console.log(dim(`  …還有 ${items.length - 20} 句`));
  }

  console.log(bold('\n各層 AI log：'));
  for (const l of r.logs) {
    if (!l.exists) {
      console.log(`  ${dim(l.name.padEnd(20))} ${dim('(無 log)')}`);
    } else {
      console.log(`  ${l.name.padEnd(20)} ${l.summary || dim('(已跑)')}`);
    }
  }
  console.log('');
}
