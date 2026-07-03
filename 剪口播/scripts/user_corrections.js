#!/usr/bin/env node
/**
 * user_corrections.js — 匯出時把「AI 預選 vs 使用者最終勾選」的落差寫成 few-shot 負例庫。
 *
 * 這條回饋迴路 2026-07-03 瘦身砍 execute-cut 時斷了（只剩 ai_cut_pairs / ai_polish_review 在讀
 * training_output/user_corrections.jsonl，沒人寫）。重新接回匯出：
 *   - falsePositives＝AI 預選要刪、你卻留下的（AI 多刪）→ ai_cut_pairs/reviewer「這類傾向保留」
 *   - falseNegatives＝你手動刪、AI 沒抓到的（AI 漏刪）→「這類傾向刪」
 * 用審核頁的字級 index 選集算（deletedIndices），比時間重疊精確。連續 index 併成詞組當例子。
 *
 * 模組用：const { buildCorrections, appendCorrections } = require('./user_corrections');
 */
const fs = require('fs');
const path = require('path');

const CORR_FILE = path.join(__dirname, 'training_output', 'user_corrections.jsonl');

// 把一串（可能不連續的）字級 index 併成詞組例子；中間只隔 gap 的仍算同一詞組。
function groupRuns(idxList, words, autoReasons) {
  const sorted = [...idxList].sort((a, b) => a - b);
  const runs = [];
  let cur = null;
  for (const i of sorted) {
    const w = words[i];
    if (!w || w.isGap) continue;
    if (cur) {
      let bridge = true; // cur.last+1..i-1 若全是 gap → 同一詞組
      for (let j = cur.last + 1; j < i; j++) { if (!words[j] || !words[j].isGap) { bridge = false; break; } }
      if (bridge) { cur.text += (w.text || ''); cur.last = i; continue; }
      runs.push(cur); cur = null;
    }
    cur = { text: (w.text || ''), first: i, last: i, reason: (autoReasons && autoReasons[i]) || '' };
  }
  if (cur) runs.push(cur);
  // 去標點後至少 2 字才當例子（單字/純標點沒有 few-shot 價值）
  return runs.filter(r => r.text.replace(/[，。！？、；：\s]/g, '').length >= 2);
}

/**
 * @param {Array} words subtitles_words.json
 * @param {number[]} autoSelected AI 預選字級 index
 * @param {number[]} deletedIndices 使用者最終刪除字級 index（審核頁選集）
 * @param {Object} autoReasons index → reason（parse_auto_selected 展開後）
 * @returns {{falsePositives:Array,falseNegatives:Array}}
 */
function buildCorrections(words, autoSelected, deletedIndices, autoReasons) {
  const preSet = new Set(autoSelected || []);
  const finSet = new Set(deletedIndices || []);
  const fpIdx = [...preSet].filter(i => !finSet.has(i) && words[i] && !words[i].isGap); // AI 刪、你留
  const fnIdx = [...finSet].filter(i => !preSet.has(i) && words[i] && !words[i].isGap); // 你刪、AI 沒抓
  const falsePositives = groupRuns(fpIdx, words, autoReasons).map(r => ({ text: r.text, reason: String(r.reason || '').slice(0, 80) }));
  const falseNegatives = groupRuns(fnIdx, words, null).map(r => ({ text: r.text }));
  return { falsePositives, falseNegatives };
}

/** 有落差才 append（完全吻合不記）。回傳寫入的 record 或 null。 */
function appendCorrections(videoName, corr, file) {
  if (!corr || (!corr.falsePositives.length && !corr.falseNegatives.length)) return null;
  const rec = { ts: new Date().toISOString(), videoName, ...corr };
  const dst = file || CORR_FILE;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.appendFileSync(dst, JSON.stringify(rec) + '\n');
  } catch (_) { return null; }
  return rec;
}

module.exports = { buildCorrections, appendCorrections, groupRuns, CORR_FILE };
