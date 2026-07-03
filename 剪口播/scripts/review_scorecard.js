#!/usr/bin/env node
/**
 * review_scorecard.js — 審稿記分卡：AI 預選 vs 使用者最終勾選的 diff 記帳
 *
 * 你每次審稿都在產生黃金標註：取消勾選＝該偵測器誤刪（precision 訊號）、
 * 手動補刪＝所有偵測器都漏（recall 訊號）。這些訊號以前匯出後就丟了。
 * 本模組在匯出時把 diff 按偵測器分類記帳，累積成 scorecard.jsonl——
 * 幾支影片之後就有數據可以校準各偵測器門檻（例如語意 0.9、fuzzy SIM 門檻）。
 *
 * 不是訓練層：零 AI 費用、不改任何行為，純記帳＋報表。
 *
 * 模組用：const { buildScorecard, appendScorecard } = require('./review_scorecard');
 * 報表用：node review_scorecard.js --report   （聚合 scorecard.jsonl 印各偵測器接受率）
 */
const fs = require('fs');
const path = require('path');

const SCORECARD_FILE = path.join(__dirname, 'scorecard.jsonl');

// reason 文字 → 偵測器類別（與 autoContentPreselect / writeAutoSelectedFromSentences 的理由格式對齊）
function categoryOf(reason) {
  const r = String(reason || '');
  if (r.startsWith('重錄take')) return 'retake_exact';
  if (r.startsWith('疑似重錄')) return 'retake_fuzzy';
  if (r.startsWith('重複Take')) return 'rule_repeat';
  if (r.startsWith('相鄰重複')) return 'rule_adjacent';
  if (r.startsWith('清喉') || r.startsWith('咳嗽')) return 'cough';
  if (r.startsWith('語意重複')) return 'semantic';
  // AI 層拆細（原本全歸 'ai'，看不出誰誤刪）：整稿二讀 reviewer/audit、候選對、放棄句首、殘句
  if (r.startsWith('reviewer')) return 'reviewer';
  if (r.startsWith('audit')) return 'audit';
  if (r.startsWith('放棄句首')) return 'abandon';
  if (r.startsWith('殘句')) return 'residual';
  if (/^(AI|A「|A『|A只|B「)/.test(r)) return 'aipair';
  if (!r) return 'aipair'; // 無 reason 多為句級 aiDelete
  return 'rule_other';
}

// 時間段清單 → 字級刪除集合（與 preselectSegs 同判準：字要被蓋 ≥40% 才算刪）
function segsToIndexSet(words, segs) {
  const del = new Set();
  for (const s of segs || []) {
    if (!s || !isFinite(s.start) || !isFinite(s.end)) continue;
    words.forEach((w, i) => {
      if (!w || typeof w.start !== 'number' || typeof w.end !== 'number') return;
      const ov = Math.min(w.end, s.end) - Math.max(w.start, s.start);
      if (ov <= 0) return;
      if (w.isGap ? ov > 0.05 : ov / Math.max(w.end - w.start, 0.01) >= 0.4) del.add(i);
    });
  }
  return del;
}

/**
 * @param {Array} words subtitles_words.json
 * @param {number[]} autoSelected 預選字級 indices
 * @param {Object} autoReasons index → reason（parse_auto_selected 展開後）
 * @param {Array<{start,end}>} finalDeleteList 使用者匯出的最終刪除時間段（橋接前的原始勾選）
 * @returns {Object} scorecard（只算非 gap 字；gap 跟著內容走，不計分）
 */
function buildScorecard(words, autoSelected, autoReasons, finalDeleteList) {
  const finalSet = segsToIndexSet(words, finalDeleteList);
  const preSet = new Set(autoSelected || []);
  const dur = i => Math.max(0, (words[i].end || 0) - (words[i].start || 0));

  const cats = {}; // cat → { preselected, accepted, rejected, preSec, acceptedSec }
  const cat = c => (cats[c] = cats[c] || { preselected: 0, accepted: 0, rejected: 0, preSec: 0, acceptedSec: 0 });
  for (const i of preSet) {
    const w = words[i];
    if (!w || w.isGap) continue;
    const c = cat(categoryOf(autoReasons[i]));
    c.preselected++; c.preSec += dur(i);
    if (finalSet.has(i)) { c.accepted++; c.acceptedSec += dur(i); }
    else c.rejected++;
  }
  // 漏刪：使用者手動補刪、預選沒抓到的（無法歸因到單一偵測器，整體記）
  let missedWords = 0, missedSec = 0;
  for (const i of finalSet) {
    const w = words[i];
    if (!w || w.isGap || preSet.has(i)) continue;
    missedWords++; missedSec += dur(i);
  }
  for (const c of Object.values(cats)) {
    c.acceptRate = c.preselected ? +(c.accepted / c.preselected).toFixed(3) : null;
    c.preSec = +c.preSec.toFixed(2); c.acceptedSec = +c.acceptedSec.toFixed(2);
  }
  return { categories: cats, missed: { words: missedWords, sec: +missedSec.toFixed(2) } };
}

/** 落檔：<workDir>/2_分析/review_scorecard.json（單片）＋ scripts/scorecard.jsonl（累積） */
function appendScorecard(videoName, workDir, card) {
  const rec = { ts: new Date().toISOString(), video: videoName, ...card };
  try { fs.writeFileSync(path.join(workDir, '2_分析', 'review_scorecard.json'), JSON.stringify(rec, null, 2)); } catch (_) {}
  try { fs.appendFileSync(SCORECARD_FILE, JSON.stringify(rec) + '\n'); } catch (_) {}
  return rec;
}

// ── 報表 CLI ──
function report() {
  if (!fs.existsSync(SCORECARD_FILE)) { console.log('（尚無記帳資料：剪一支影片並匯出後再來看）'); return; }
  const lines = fs.readFileSync(SCORECARD_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const agg = {}; let missedW = 0, missedS = 0;
  for (const rec of lines) {
    for (const [c, v] of Object.entries(rec.categories || {})) {
      const a = (agg[c] = agg[c] || { preselected: 0, accepted: 0, rejected: 0 });
      a.preselected += v.preselected; a.accepted += v.accepted; a.rejected += v.rejected;
    }
    if (rec.missed) { missedW += rec.missed.words; missedS += rec.missed.sec; }
  }
  console.log(`審稿記分卡（${lines.length} 支影片累積）`);
  console.log('偵測器          預選字  被接受  被退回  接受率');
  const NAMES = { retake_exact: '重錄(exact)', retake_fuzzy: '重錄(fuzzy)', rule_repeat: '重複Take規則', rule_adjacent: '相鄰重複規則', cough: '咳嗽/清喉', semantic: '語意重複', reviewer: '整稿二讀(reviewer)', audit: '嚴格二讀(audit)', aipair: 'AI候選對', abandon: '放棄句首', residual: '殘句', ai: 'AI(舊資料)', rule_other: '其他規則' };
  for (const [c, a] of Object.entries(agg).sort((x, y) => y[1].preselected - x[1].preselected)) {
    const rate = a.preselected ? Math.round(a.accepted / a.preselected * 100) + '%' : '—';
    console.log(`${(NAMES[c] || c).padEnd(12)}  ${String(a.preselected).padStart(5)}  ${String(a.accepted).padStart(5)}  ${String(a.rejected).padStart(5)}  ${rate.padStart(5)}`);
  }
  console.log(`漏刪（手動補）：${missedW} 字 / ${missedS.toFixed(1)}s`);
  console.log('\n讀法：接受率低的偵測器在誤刪（該收緊門檻）；漏刪多代表整體 recall 不足。');
}

module.exports = { buildScorecard, appendScorecard, categoryOf };

if (require.main === module) {
  if (process.argv.includes('--report')) report();
  else { console.error('用法: node review_scorecard.js --report'); process.exit(1); }
}
