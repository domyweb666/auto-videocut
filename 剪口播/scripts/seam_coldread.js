#!/usr/bin/env node
/**
 * seam_coldread.js — 接縫冷讀（剪後保留稿的連貫性體檢）
 *
 * 問題：pipeline 只能刪不能改。刪掉一句之後，前後兩句直接接起來——verify_export.js
 * 只驗物理層（時長對帳/殘留靜音/逐字對帳），沒有任何一站在問「這個接口讀起來通不通」。
 * 指代斷裂（「這個方法」的先行詞被剪掉）、邏輯跳接、話題突兀，目前只能靠人用耳朵抓。
 *
 * 這支腳本把「使用者審核後實際要保留的字」串成一份冷讀稿，在每個剪接縫插 ⟦n⟧ 標記，
 * 丟給 Claude 用陌生讀者視角挑出接不順的縫，回標成審核頁可見的「接縫疑慮」黃色波浪線。
 * 純建議層：只會叫你「救回某句被剪的」或「確認接受」，永遠不會自動刪任何東西。
 *
 * 設計：偵測/組稿/解析都是純函式（可單元測試，不花 AI 額度）；呼叫 Claude 的部分抽成
 * 可注入的 callClaude（沿用 ai_cut_pairs.js 的 `claude -p -` 慣例）。
 *
 * 模組用：const { coldReadSeams } = require('./seam_coldread');
 *         const { seams } = coldReadSeams(words, deletedIndices, { model:'sonnet' });
 * CLI 用：node seam_coldread.js <subtitles_words.json> <deleted_indices.json> [--json] [--model sonnet]
 *         deleted_indices.json ＝ [12,13,14,...] 或 { deletedIndices:[...] }
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

// ── 偵測接縫（純函式）──
// 保留字之間有「達門檻的刪除」＝一個接縫。逐字元桶模型下，刪掉一兩個口水字不算接縫
// （不會斷句意），只有整句/整段被剪掉才值得冷讀。
function buildSeams(words, deletedSet, opts = {}) {
  const minSec = opts.minSeamSec != null ? opts.minSeamSec : 0.4;
  const minChars = opts.minSeamChars != null ? opts.minSeamChars : 4;
  const isContent = w => w && !w.isGap && w.text && String(w.text).trim();

  const kept = [];
  for (let i = 0; i < words.length; i++) {
    if (deletedSet.has(i)) continue;
    if (isContent(words[i])) kept.push(i);
  }

  const seams = [];
  for (let n = 0; n < kept.length - 1; n++) {
    const a = kept[n], b = kept[n + 1];
    if (b === a + 1) continue; // 中間沒東西
    let delChars = 0, delDur = 0, delStart = null, delEnd = null;
    const delIdxs = [];
    for (let j = a + 1; j < b; j++) {
      const w = words[j];
      if (!w || !deletedSet.has(j)) continue; // 沒被刪的 gap（保留的靜音）不算接縫
      delIdxs.push(j);
      delDur += Math.max(0, (w.end - w.start) || 0);
      if (delStart == null) delStart = w.start;
      delEnd = w.end;
      if (isContent(w)) delChars++;
    }
    if (!delIdxs.length) continue;                       // 中間全是保留的靜音 → 非接縫
    if (delChars < minChars && delDur < minSec) continue; // 只刪掉零星口水字 → 不會斷句意
    seams.push({
      beforeIdx: a, afterIdx: b, delIdxs,
      delChars, delDur: +delDur.toFixed(2),
      delStart, delEnd,
    });
  }
  seams.forEach((s, i) => { s.seamNo = i + 1; });
  return seams;
}

// 取某個保留字往前/往後的鄰近保留文字（給 UI 顯示接縫上下文）
function keptContext(words, deletedSet, idx, dir, maxChars) {
  const isContent = w => w && !w.isGap && w.text && String(w.text).trim();
  let out = '';
  const step = dir < 0 ? -1 : 1;
  for (let j = idx; j >= 0 && j < words.length; j += step) {
    if (deletedSet.has(j) || !isContent(words[j])) continue;
    if (step < 0) out = words[j].text + out; else out += words[j].text;
    if (out.length >= maxChars) break;
  }
  return out;
}

function deletedText(words, delIdxs) {
  return delIdxs.map(j => (words[j] && !words[j].isGap ? (words[j].text || '') : '')).join('');
}

// ── 組冷讀稿（純函式）──
// 保留字依序串起，剪接縫處插 ⟦n⟧。回傳 { prompt, keptText }。
function buildColdReadPrompt(words, deletedSet, seams, opts = {}) {
  const seamByAfter = new Map(seams.map(s => [s.afterIdx, s]));
  const isContent = w => w && !w.isGap && w.text && String(w.text).trim();
  let keptText = '';
  for (let i = 0; i < words.length; i++) {
    if (deletedSet.has(i) || !isContent(words[i])) continue;
    const s = seamByAfter.get(i);
    if (s) keptText += `⟦${s.seamNo}⟧`;
    keptText += words[i].text;
  }
  const prompt = COLD_READ_TEMPLATE.replace('{{TEXT}}', keptText);
  return { prompt, keptText };
}

const COLD_READ_TEMPLATE = `你是一個「陌生讀者」，只讀得到剪輯後保留下來的口播逐字稿。稿子裡我用 ⟦數字⟧ 標出每一個「剪接縫」——那是原本有一段話被剪掉、前後兩句被接起來的位置。

你的工作：站在完全沒看過原片的觀眾角度，逐一判斷每個 ⟦數字⟧ 接縫「接起來順不順」。只挑出真正會讓觀眾卡住的接縫，其餘一律當作沒問題。

會讓觀眾卡住的三種情況：
1. 指代斷裂：接縫後出現「這個方法／他／那件事／剛剛說的」這類指稱詞，但它指的東西在保留稿裡從沒出現過（先行詞被剪掉了）。
2. 邏輯跳接：接縫前後是因果或轉折關係，但中間的推論被剪掉，變成沒頭沒尾的跳躍。
3. 話題突兀：接縫前後在講兩件不相干的事，中間的過渡被剪掉，硬切。

不要雞蛋裡挑骨頭。口播本來就口語、會跳，只有「觀眾真的會聽不懂或覺得斷掉」才算。標點、語氣、贅字、句子完不完整都不是你要管的。

只輸出 JSON，格式如下（沒問題的接縫不用列）：
{"1":{"break":true,"type":"指代斷裂","concern":"「這個方法」前面沒交代是哪個方法"},"3":{"break":true,"type":"話題突兀","concern":"從情緒直接跳到決策，中間沒有過渡"}}

type 只能是「指代斷裂」「邏輯跳接」「話題突兀」三選一。concern 用一句話講清楚哪裡斷、為什麼，不要客套。

以下是保留稿（⟦數字⟧＝接縫）：
---
{{TEXT}}`;

// ── 解析 Claude 回傳（純函式）──
function parseJSON(raw) {
  const s = String(raw || '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

const VALID_TYPES = new Set(['指代斷裂', '邏輯跳接', '話題突兀']);

function parseColdReadResponse(raw, seams) {
  const json = parseJSON(raw);
  if (!json || typeof json !== 'object') return [];
  const bySeamNo = new Map(seams.map(s => [s.seamNo, s]));
  const flagged = [];
  for (const [k, v] of Object.entries(json)) {
    const no = Number(k);
    const seam = bySeamNo.get(no);
    if (!seam || !v || v.break !== true) continue;
    const type = VALID_TYPES.has(v.type) ? v.type : '接縫疑慮';
    const concern = String(v.concern || '').trim() || '接起來可能不順，建議聽一次';
    flagged.push({ ...seam, type, concern });
  }
  flagged.sort((a, b) => a.seamNo - b.seamNo);
  return flagged;
}

// ── 呼叫 Claude（沿用 ai_cut_pairs.js 的 CLI 慣例）──
function callClaudeCLI(prompt, model) {
  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const modelFlag = model ? ` --model ${model}` : '';
  const out = llmExec(modelFlag, {
    input: prompt,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });
  return out.trim();
}

// ── 主流程（偵測 → 組稿 → 呼叫 → 解析 → 補上下文）──
function coldReadSeams(words, deletedIndices, opts = {}) {
  const deletedSet = new Set(deletedIndices || []);
  const seams = buildSeams(words, deletedSet, opts);
  const meta = { totalSeams: seams.length, flagged: 0 };
  if (!seams.length) return { seams: [], meta };

  const { prompt } = buildColdReadPrompt(words, deletedSet, seams, opts);
  const callClaude = opts.callClaude || callClaudeCLI;
  let raw = '';
  try {
    raw = callClaude(prompt, opts.model || 'sonnet');
  } catch (e) {
    return { seams: [], meta: { ...meta, error: (e.message || '').split('\n')[0] } };
  }

  const flagged = parseColdReadResponse(raw, seams).map(s => ({
    seamNo: s.seamNo,
    afterIdx: s.afterIdx,
    beforeIdx: s.beforeIdx,
    delIdxs: s.delIdxs,
    delStart: s.delStart,
    delEnd: s.delEnd,
    type: s.type,
    concern: s.concern,
    beforeText: keptContext(words, deletedSet, s.beforeIdx, -1, 24),
    afterText: keptContext(words, deletedSet, s.afterIdx, 1, 24),
    delText: deletedText(words, s.delIdxs).slice(0, 60),
  }));
  meta.flagged = flagged.length;
  return { seams: flagged, meta };
}

module.exports = {
  buildSeams,
  buildColdReadPrompt,
  parseColdReadResponse,
  coldReadSeams,
  keptContext,
  deletedText,
  COLD_READ_TEMPLATE,
};

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  let asJson = false, model = 'sonnet';
  const opt = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') asJson = true;
    else if (args[i] === '--model' && args[i + 1]) model = args[++i];
    else if (args[i] === '--min-sec' && args[i + 1]) opt.minSeamSec = Number(args[++i]);
    else if (args[i] === '--min-chars' && args[i + 1]) opt.minSeamChars = Number(args[++i]);
    else pos.push(args[i]);
  }
  const subsFile = pos[0];
  const idxFile = pos[1];
  if (!subsFile || !idxFile) {
    console.error('用法: node seam_coldread.js <subtitles_words.json> <deleted_indices.json> [--json] [--model sonnet]');
    process.exit(1);
  }
  try {
    const words = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
    const rawIdx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    const deletedIndices = Array.isArray(rawIdx) ? rawIdx : (rawIdx.deletedIndices || rawIdx.indices || []);
    const result = coldReadSeams(words, deletedIndices, { model, ...opt });
    if (asJson) {
      process.stdout.write(JSON.stringify(result));
    } else {
      console.error(`接縫總數 ${result.meta.totalSeams}，標出疑慮 ${result.meta.flagged}`);
      for (const s of result.seams) {
        console.error(`  ⟦${s.seamNo}⟧ ${s.type}：${s.concern}`);
        console.error(`     …${s.beforeText} ┊ ${s.afterText}…（剪掉：${s.delText}）`);
      }
      if (result.meta.error) console.error('⚠️ ' + result.meta.error);
    }
  } catch (e) {
    if (asJson) process.stdout.write(JSON.stringify({ seams: [], meta: { error: e.message } }));
    else console.error('❌ ' + e.message);
    process.exit(1);
  }
}
