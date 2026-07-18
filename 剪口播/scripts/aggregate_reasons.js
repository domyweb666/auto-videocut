#!/usr/bin/env node
/**
 * aggregate_reasons.js — 繞圈模式聚合（跨影片的錄影前提詞紀律）
 *
 * 每支影片剪完，2_分析/auto_selected.json 的 reasons 已經是一本「判決帳本」——
 * 每一段被剪掉的東西都標了理由。這支工具把多支影片的帳本聚在一起，統計你最常在
 * 哪一種「重複／繞圈」上面繞（整句重錄？換句話說再講一遍？講完又繞回來？），
 * 附上你自己講過的例子，產出一頁錄影前提詞紀律。剪得快不如講的時候少繞。
 *
 * 純聚合＋渲染是純函式（可單元測試）；掃檔是薄薄一層 IO。
 *
 * 用法：node aggregate_reasons.js [--roots dir1,dir2] [--out 報告.md] [--all]
 *   --roots  逗號分隔的掃描根目錄（預設：資料工作區 cwd ＋ 程式碼 repo）
 *   --out    報告輸出路徑（預設：<repo>/錄影前提詞紀律.md）
 *   --all    連非繞圈類（卡頓/語助詞/咳嗽/靜音）也列進明細表
 */

const fs = require('fs');
const path = require('path');
const { classifyReason } = require('./reason_taxonomy');

// ── 純函式：從一份 auto_selected + subtitles 抽出刪除記錄 ──
// autoRaw：auto_selected.json 解析後物件（{indices,reasons} 或陣列）
// words：同影片 subtitles_words.json（可為 null；有的話能取完整刪除文字與秒數）
function collectRecords(autoRaw, words, videoName) {
  const out = [];
  if (!autoRaw || Array.isArray(autoRaw) || !autoRaw.reasons) return out; // 純陣列無理由 → 無法分類
  for (const [key, reason] of Object.entries(autoRaw.reasons)) {
    let a, b;
    if (key.indexOf('-') > 0) { const p = key.split('-'); a = +p[0]; b = +p[1]; }
    else { a = b = +key; }
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const cls = classifyReason(reason);
    let text = '', seconds = 0;
    if (words && words.length) {
      let t = '';
      for (let i = a; i <= b && i < words.length; i++) {
        if (words[i] && !words[i].isGap && words[i].text) t += words[i].text;
      }
      text = t;
      const wa = words[a], wb = words[Math.min(b, words.length - 1)];
      if (wa && wb && typeof wa.start === 'number' && typeof wb.end === 'number') seconds = Math.max(0, wb.end - wa.start);
    }
    if (!text) text = extractSnippet(reason); // 沒字幕就從理由裡撈引號內文
    out.push({ video: videoName, reason: String(reason), family: cls.key, label: cls.label,
      circling: cls.circling, template: cls.template, text, seconds: +seconds.toFixed(2) });
  }
  return out;
}

function extractSnippet(reason) {
  const m = String(reason || '').match(/「([^」]*)」|"([^"]*)"|“([^”]*)”/);
  return m ? (m[1] || m[2] || m[3] || '') : '';
}

// ── 純函式：聚合多支影片的記錄 ──
function aggregate(records) {
  const byFamily = {};   // key → { key, label, circling, count, seconds, videos:Set, examples:[], templates:{} }
  const videos = new Set();
  for (const r of records) {
    videos.add(r.video);
    const f = byFamily[r.family] || (byFamily[r.family] = {
      key: r.family, label: r.label, circling: r.circling,
      count: 0, seconds: 0, videos: new Set(), examples: [], templates: {},
    });
    f.count++;
    f.seconds += r.seconds || 0;
    f.videos.add(r.video);
    f.templates[r.template] = (f.templates[r.template] || 0) + 1;
    const ex = (r.text || '').trim();
    if (ex && ex.length >= 2 && !f.examples.some(e => e.text === ex)) f.examples.push({ text: ex, video: r.video });
  }
  const families = Object.values(byFamily).map(f => ({
    key: f.key, label: f.label, circling: f.circling,
    count: f.count, seconds: +f.seconds.toFixed(1), videoCount: f.videos.size,
    examples: f.examples.sort((a, b) => b.text.length - a.text.length).slice(0, 6),
    topTemplates: Object.entries(f.templates).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([t, c]) => ({ template: t, count: c })),
  }));
  families.sort((a, b) => (b.circling - a.circling) || (b.count - a.count));
  const circling = families.filter(f => f.circling);
  const totals = {
    videos: videos.size,
    deletions: records.length,
    circlingDeletions: records.filter(r => r.circling).length,
    circlingSeconds: +records.filter(r => r.circling).reduce((t, r) => t + (r.seconds || 0), 0).toFixed(1),
  };
  return { families, circling, totals };
}

// ── 純函式：渲染成 Markdown（錄影前提詞紀律）──
function renderMarkdown(summary, opts = {}) {
  const { families, circling, totals } = summary;
  const { FAMILY_BY_KEY } = require('./reason_taxonomy');
  const showAll = opts.all;
  const secStr = s => s >= 60 ? `${(s / 60).toFixed(1)} 分` : `${Math.round(s)} 秒`;
  const L = [];
  L.push('# 錄影前提詞紀律');
  L.push('');
  if (!totals.deletions) {
    L.push('還沒有可聚合的資料——掃到的 `auto_selected.json` 都沒有帶理由，或還沒剪過影片。');
    L.push('剪過幾支之後再回來跑，這頁就會長出你最常繞的幾種模式。');
    return L.join('\n');
  }
  L.push(`統計 ${totals.videos} 支影片、被剪掉 ${totals.deletions} 段，其中重複與繞圈類 ${totals.circlingDeletions} 段（約 ${secStr(totals.circlingSeconds)}）。`);
  L.push('下面按出現次數排，每一種附上你自己講過的例子。錄之前掃一眼，從源頭少講幾句，比剪得快更省。');
  L.push('');

  if (circling.length) {
    L.push('## 你最常繞的幾種');
    L.push('');
    circling.forEach((f, i) => {
      L.push(`### ${i + 1}. ${f.label}　（${f.count} 次 · ${f.videoCount} 支影片 · 約 ${secStr(f.seconds)}）`);
      const tip = (FAMILY_BY_KEY[f.key] || {}).tip;
      if (tip) L.push(`- 紀律：${tip}`);
      if (f.examples.length) {
        L.push('- 你講過的例子：');
        f.examples.slice(0, 5).forEach(e => L.push(`  - 「${e.text.slice(0, 40)}${e.text.length > 40 ? '…' : ''}」`));
      }
      L.push('');
    });
  } else {
    L.push('_這批影片沒有偵測到重複／繞圈類的刪除。_');
    L.push('');
  }

  const rows = showAll ? families : families.filter(f => f.circling);
  L.push('## 明細表');
  L.push('');
  L.push('| 類別 | 繞圈? | 次數 | 影片數 | 總時長 |');
  L.push('|------|:----:|----:|-----:|------:|');
  rows.forEach(f => L.push(`| ${f.label} | ${f.circling ? '是' : '—'} | ${f.count} | ${f.videoCount} | ${secStr(f.seconds)} |`));
  if (!showAll) L.push('');
  if (!showAll) L.push('_只列繞圈類；加 `--all` 連卡頓／語助詞／咳嗽／靜音也列。_');
  L.push('');
  return L.join('\n');
}

// ── IO：掃描根目錄找 2_分析/auto_selected.json ──
function findAutoSelectedFiles(roots) {
  const found = [];
  const SKIP = new Set(['node_modules', '.git', '_uploads', 'legacy']);
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.name === 'auto_selected.json' && path.basename(dir) === '2_分析') {
        found.push(path.join(dir, e.name));
      }
    }
  };
  for (const r of roots) walk(r, 0);
  // 依 realpath 去重：預設根目錄可能經由目錄 junction 與實體路徑指到同一棵樹，
  // 不解實體路徑會把同一份 auto_selected.json 算兩次。
  const seen = new Set(), uniq = [];
  for (const f of found) {
    let rp; try { rp = fs.realpathSync(f); } catch (_) { rp = f; }
    if (!seen.has(rp)) { seen.add(rp); uniq.push(f); }
  }
  return uniq;
}

// 從 <work>/2_分析/auto_selected.json 反推影片名與同影片 subtitles_words.json
function loadOne(autoPath) {
  const workDir = path.dirname(path.dirname(autoPath)); // …/<work>
  const videoName = path.basename(workDir);
  let autoRaw = null, words = null;
  try { autoRaw = JSON.parse(fs.readFileSync(autoPath, 'utf8')); } catch (_) { return null; }
  const subsPath = path.join(workDir, '1_轉錄', 'subtitles_words.json');
  if (fs.existsSync(subsPath)) { try { words = JSON.parse(fs.readFileSync(subsPath, 'utf8')); } catch (_) {} }
  return { videoName, autoRaw, words };
}

function run(opts) {
  const roots = opts.roots;
  const files = findAutoSelectedFiles(roots);
  const records = [];
  const scanned = [];
  for (const f of files) {
    const one = loadOne(f);
    if (!one) continue;
    const recs = collectRecords(one.autoRaw, one.words, one.videoName);
    if (recs.length) { records.push(...recs); scanned.push({ video: one.videoName, deletions: recs.length, hasWords: !!one.words }); }
  }
  const summary = aggregate(records);
  const md = renderMarkdown(summary, opts);
  return { summary, md, scanned, files };
}

module.exports = { collectRecords, aggregate, renderMarkdown, findAutoSelectedFiles, extractSnippet, run };

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const REPO = path.join(__dirname, '..');
  let roots = null, outPath = path.join(REPO, '錄影前提詞紀律.md'), all = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--roots' && args[i + 1]) roots = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
    else if (args[i] === '--all') all = true;
  }
  if (!roots) {
    // 預設：資料工作區（cwd，有 output/ cut_work/）＋ 程式碼 repo（有 training_output/ cut_work/ fixture）
    roots = [...new Set([process.cwd(), REPO])];
  }
  const { summary, md, scanned, files } = run({ roots, all });
  fs.writeFileSync(outPath, md, 'utf8');
  console.error(`📂 掃描根目錄：\n  ${roots.join('\n  ')}`);
  console.error(`📄 找到 ${files.length} 份 auto_selected.json，其中 ${scanned.length} 份帶理由`);
  scanned.forEach(s => console.error(`   - ${s.video}：${s.deletions} 段${s.hasWords ? '' : '（無字幕，例子從理由撈）'}`));
  console.error(`📊 聚合：${summary.totals.videos} 支影片 / ${summary.totals.deletions} 段刪除 / 繞圈類 ${summary.totals.circlingDeletions} 段`);
  console.error(`✅ 已寫出：${outPath}`);
}
