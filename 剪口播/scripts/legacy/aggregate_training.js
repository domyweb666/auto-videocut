#!/usr/bin/env node
/**
 * 匯總多支影片的訓練報告，產出統計分析和規則更新建議
 *
 * 用法: node aggregate_training.js <diff_report1.json> [diff_report2.json] ...
 *   或: node aggregate_training.js --dir <reports_directory>
 *
 * 輸出:
 *   training_report.md  - 人可讀的統計報告
 *   rule_updates.json   - 機器可讀的規則建議
 */

const fs = require('fs');
const path = require('path');

// ── 解析參數 ──
let reportFiles = [];
if (process.argv[2] === '--dir') {
  const dir = process.argv[3];
  if (!dir || !fs.existsSync(dir)) {
    console.error('用法: node aggregate_training.js --dir <reports_directory>');
    process.exit(1);
  }
  reportFiles = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f.startsWith('diff_report'))
    .map(f => path.join(dir, f));
} else {
  reportFiles = process.argv.slice(2).filter(f => fs.existsSync(f));
}

if (reportFiles.length === 0) {
  console.error('❌ 未找到任何報告檔案');
  process.exit(1);
}

console.error(`📊 讀取 ${reportFiles.length} 份報告...`);

// ── 讀取所有報告 ──
const reports = reportFiles.map(f => {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  data._file = path.basename(f);
  return data;
});

// ── 匯總統計 ──
const aggregate = {
  videoCount: reports.length,
  totalAiMarked: 0,
  totalUserDeleted: 0,
  totalFP: 0,
  totalFN: 0,
  totalTP: 0,
  categoryStats: {},
  silenceAnalysis: {
    distributions: {},
    maxKeptDurations: [],
  },
  perVideo: []
};

for (const report of reports) {
  const fp = report.falsePositives?.length || 0;
  const fn = report.falseNegatives?.length || 0;
  const tp = report.truePositiveCount || (report.aiCount - fp);

  aggregate.totalAiMarked += report.aiCount || 0;
  aggregate.totalUserDeleted += report.userCount || 0;
  aggregate.totalFP += fp;
  aggregate.totalFN += fn;
  aggregate.totalTP += tp;

  // 每支影片摘要
  aggregate.perVideo.push({
    file: report._file,
    srt: report.srtFile || 'unknown',
    matchRate: report.matchRate,
    precision: report.accuracy?.precision,
    recall: report.accuracy?.recall,
    f1: report.accuracy?.f1,
    fp, fn, tp
  });

  // 合併分類統計
  if (report.categoryStats) {
    for (const [cat, stats] of Object.entries(report.categoryStats)) {
      if (!aggregate.categoryStats[cat]) {
        aggregate.categoryStats[cat] = { tp: 0, fp: 0, fn: 0, videoCount: 0 };
      }
      aggregate.categoryStats[cat].tp += stats.tp || 0;
      aggregate.categoryStats[cat].fp += stats.fp || 0;
      aggregate.categoryStats[cat].fn += stats.fn || 0;
      aggregate.categoryStats[cat].videoCount++;
    }
  }

  // 合併靜音分析
  if (report.silenceAnalysis) {
    if (report.silenceAnalysis.maxKeptDuration) {
      aggregate.silenceAnalysis.maxKeptDurations.push(report.silenceAnalysis.maxKeptDuration);
    }
    if (report.silenceAnalysis.distribution) {
      for (const [bucket, counts] of Object.entries(report.silenceAnalysis.distribution)) {
        if (!aggregate.silenceAnalysis.distributions[bucket]) {
          aggregate.silenceAnalysis.distributions[bucket] = { kept: 0, deleted: 0 };
        }
        aggregate.silenceAnalysis.distributions[bucket].kept += counts.kept || 0;
        aggregate.silenceAnalysis.distributions[bucket].deleted += counts.deleted || 0;
      }
    }
  }
}

// ── 計算各規則的精確率、召回率 ──
const rulePerformance = {};
for (const [cat, stats] of Object.entries(aggregate.categoryStats)) {
  const precision = stats.tp / (stats.tp + stats.fp) || 0;
  const recall = stats.tp / (stats.tp + stats.fn) || 0;
  const f1 = 2 * precision * recall / (precision + recall) || 0;
  const sampleCount = stats.tp + stats.fp + stats.fn;

  rulePerformance[cat] = {
    precision: Math.round(precision * 1000) / 10,
    recall: Math.round(recall * 1000) / 10,
    f1: Math.round(f1 * 1000) / 10,
    tp: stats.tp,
    fp: stats.fp,
    fn: stats.fn,
    sampleCount,
    videoCount: stats.videoCount,
    confidence: sampleCount >= 20 ? 'high' : sampleCount >= 10 ? 'medium' : 'low'
  };
}

// ── 規則名稱映射 ──
const RULE_NAMES = {
  'silence': '靜音段處理',
  'repeated_sentence': '重複句偵測',
  'incomplete_sentence': '殘句偵測',
  'stutter': '卡頓詞',
  'filler_word': '語氣詞',
  'intra_repeat': '句內重複',
  'self_correction': '重說糾正',
  'consecutive_filler': '連續語氣詞',
  'semantic_redundancy': '語意重複',
  'unclassified': '未分類',
};

// ── 生成規則更新建議 ──
const ruleUpdates = {};

// 靜音閾值建議
if (aggregate.silenceAnalysis.distributions) {
  const dist = aggregate.silenceAnalysis.distributions;
  const buckets = Object.keys(dist).sort((a, b) => parseFloat(a) - parseFloat(b));

  // 找出使用者大量保留的靜音區間 → 建議提高閾值
  for (const bucket of buckets) {
    const total = dist[bucket].kept + dist[bucket].deleted;
    const keepRate = dist[bucket].kept / total;
    if (keepRate > 0.5 && parseFloat(bucket) >= 0.8) {
      // 使用者保留了超過一半，建議不要刪這個區間
      const newThreshold = (parseFloat(bucket) + 0.2).toFixed(1);
      ruleUpdates['3-静音段处理'] = {
        field: 'threshold',
        current: '>=1.0s',
        recommended: `>=${newThreshold}s`,
        confidence: total >= 10 ? 'high' : 'medium',
        evidence: `${bucket}s 區間: ${dist[bucket].kept} kept / ${dist[bucket].deleted} deleted (保留率 ${(keepRate * 100).toFixed(0)}%)`
      };
      break;
    }
  }
}

// 其他規則建議
for (const [cat, perf] of Object.entries(rulePerformance)) {
  if (cat === 'unclassified' || cat === 'silence') continue;
  const ruleName = Object.entries(RULE_NAMES).find(([k]) => k === cat)?.[0] || cat;

  if (perf.fp > 5 && perf.precision < 70) {
    ruleUpdates[ruleName] = {
      issue: 'precision_low',
      current_precision: `${perf.precision}%`,
      fp_count: perf.fp,
      confidence: perf.confidence,
      evidence: `${perf.fp} false positives in ${perf.videoCount} videos`
    };
  }
  if (perf.fn > 5 && perf.recall < 60) {
    ruleUpdates[ruleName] = {
      ...(ruleUpdates[ruleName] || {}),
      issue_recall: 'recall_low',
      current_recall: `${perf.recall}%`,
      fn_count: perf.fn,
      confidence: perf.confidence,
      evidence_recall: `${perf.fn} false negatives in ${perf.videoCount} videos`
    };
  }
}

// ── 規則覆蓋率 ──
const ALL_RULES = ['silence', 'repeated_sentence', 'incomplete_sentence', 'stutter',
  'filler_word', 'intra_repeat', 'self_correction', 'consecutive_filler', 'semantic_redundancy'];
const coveredRules = ALL_RULES.filter(r => rulePerformance[r]?.sampleCount >= 5);
const uncoveredRules = ALL_RULES.filter(r => !rulePerformance[r] || rulePerformance[r].sampleCount < 5);

// ── 生成 training_report.md ──
const overallPrecision = aggregate.totalTP / (aggregate.totalTP + aggregate.totalFP) || 0;
const overallRecall = aggregate.totalTP / (aggregate.totalTP + aggregate.totalFN) || 0;
const overallF1 = 2 * overallPrecision * overallRecall / (overallPrecision + overallRecall) || 0;

let md = `# 批次訓練報告

## 總覽

| 指標 | 值 |
|------|------|
| 影片數 | ${reports.length} |
| 規則覆蓋率 | ${coveredRules.length}/${ALL_RULES.length} |
| 整體精確率 | ${(overallPrecision * 100).toFixed(1)}% |
| 整體召回率 | ${(overallRecall * 100).toFixed(1)}% |
| 整體 F1 | ${(overallF1 * 100).toFixed(1)}% |

## 各影片表現

| 影片 | 匹配率 | 精確率 | 召回率 | F1 | FP | FN |
|------|--------|--------|--------|------|------|------|
`;

for (const v of aggregate.perVideo) {
  md += `| ${v.srt} | ${v.matchRate?.toFixed(1) || '-'}% | ${((v.precision || 0) * 100).toFixed(1)}% | ${((v.recall || 0) * 100).toFixed(1)}% | ${((v.f1 || 0) * 100).toFixed(1)}% | ${v.fp} | ${v.fn} |\n`;
}

md += `\n## 各規則表現\n\n`;

for (const [cat, perf] of Object.entries(rulePerformance).sort((a, b) => b[1].sampleCount - a[1].sampleCount)) {
  const name = RULE_NAMES[cat] || cat;
  const status = perf.confidence === 'high' ? '✅ 數據充足' :
                 perf.confidence === 'medium' ? '🟡 數據中等' : '⚠️ 數據不足';

  md += `### ${name} ${status}\n`;
  md += `- 精確率: ${perf.precision}% | 召回率: ${perf.recall}% | F1: ${perf.f1}%\n`;
  md += `- 樣本數: ${perf.sampleCount} (TP=${perf.tp} FP=${perf.fp} FN=${perf.fn})\n`;
  md += `- 出現在 ${perf.videoCount}/${reports.length} 支影片\n`;

  if (ruleUpdates[cat]) {
    const update = ruleUpdates[cat];
    if (update.recommended) {
      md += `- 📌 建議：${update.field} 從 ${update.current} 調整為 ${update.recommended}\n`;
    }
    if (update.issue === 'precision_low') {
      md += `- 📌 問題：精確率偏低，${update.fp_count} 個誤標\n`;
    }
    if (update.issue_recall === 'recall_low') {
      md += `- 📌 問題：召回率偏低，${update.fn_count} 個漏標\n`;
    }
  }
  md += '\n';
}

// 靜音分佈
if (Object.keys(aggregate.silenceAnalysis.distributions).length > 0) {
  md += `## 靜音時長分佈\n\n`;
  md += `| 時長區間 | 使用者保留 | 使用者刪除 | 保留率 |\n`;
  md += `|----------|-----------|-----------|--------|\n`;

  const buckets = Object.keys(aggregate.silenceAnalysis.distributions)
    .sort((a, b) => parseFloat(a) - parseFloat(b));
  for (const bucket of buckets) {
    const d = aggregate.silenceAnalysis.distributions[bucket];
    const total = d.kept + d.deleted;
    const keepRate = total > 0 ? (d.kept / total * 100).toFixed(0) : '-';
    md += `| ${bucket}s | ${d.kept} | ${d.deleted} | ${keepRate}% |\n`;
  }
  md += '\n';

  if (aggregate.silenceAnalysis.maxKeptDurations.length > 0) {
    const avgMax = aggregate.silenceAnalysis.maxKeptDurations
      .reduce((a, b) => a + b, 0) / aggregate.silenceAnalysis.maxKeptDurations.length;
    md += `使用者保留的靜音最長平均: ${avgMax.toFixed(2)}s\n\n`;
  }
}

// 未覆蓋規則
if (uncoveredRules.length > 0) {
  md += `## 需要更多數據的規則\n\n`;
  for (const r of uncoveredRules) {
    const name = RULE_NAMES[r] || r;
    const count = rulePerformance[r]?.sampleCount || 0;
    md += `- **${name}**: 僅 ${count} 個樣本（建議再訓練 ${Math.max(3, Math.ceil((5 - count) / 2))} 支影片）\n`;
  }
  md += '\n';
}

md += `---\n\n生成時間: ${new Date().toISOString()}\n`;

// ── 寫入檔案 ──
fs.writeFileSync('training_report.md', md);
fs.writeFileSync('rule_updates.json', JSON.stringify(ruleUpdates, null, 2));

console.error(`✅ 已生成:`);
console.error(`   training_report.md (${reports.length} 支影片統計)`);
console.error(`   rule_updates.json (${Object.keys(ruleUpdates).length} 條建議)`);
console.error(`   規則覆蓋率: ${coveredRules.length}/${ALL_RULES.length}`);
if (uncoveredRules.length > 0) {
  console.error(`   ⚠️ 數據不足: ${uncoveredRules.map(r => RULE_NAMES[r] || r).join(', ')}`);
}
