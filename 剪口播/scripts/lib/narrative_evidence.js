/**
 * narrative_evidence.js — 敘事層共用純函式
 *
 * 給 ai_narrative_cut.js（決策）與 ai_review_cut.js（審核）共用：
 * 把 subtitles_words.json 組裝成「帶時間戳＋停頓＋已刪標記」的證據文稿。
 *
 * 設計原因（2026-07-18，取代 polished 稿路線）：
 * 重錄判斷最可靠的證據是「語意重複 × 長停頓」交叉，停頓資訊只存在原始
 * 時間戳裡；餵洗過的 polished 稿等於把證據先擦掉（ai_full_edit F1=4.86% 的
 * 三個死因之一）。同時輸出改成「idx 範圍決策」，不再讓 AI 重抄全文靠對齊反推。
 */

'use strict';

/** 分句：沿用 SKILL.md 4.3 邏輯 — 音訊實測靜音（≥0.5s）優先當句界，isGap ≥0.5s 也切 */
function buildSentences(words, silences) {
  const sil = (silences || []).filter(s => (s.end - s.start) >= 0.5);
  const breakAfter = new Set();
  const real = words.map((w, i) => ({ w, i })).filter(x => !x.w.isGap);
  for (const s of sil) {
    let hit = -1;
    for (const { w, i } of real) {
      if (w.start <= s.start + 0.05) hit = i; else break;
    }
    if (hit >= 0) breakAfter.add(hit);
  }

  const sentences = [];
  let curr = { text: '', startIdx: -1, endIdx: -1 };
  const push = () => {
    if (curr.text.length > 0) {
      sentences.push({
        n: sentences.length,
        startIdx: curr.startIdx,
        endIdx: curr.endIdx,
        text: curr.text,
        start: words[curr.startIdx].start,
        end: words[curr.endIdx].end
      });
    }
    curr = { text: '', startIdx: -1, endIdx: -1 };
  };

  words.forEach((w, i) => {
    const isLongGap = w.isGap && (w.end - w.start) >= 0.5;
    if (isLongGap) {
      push();
    } else if (!w.isGap) {
      if (curr.startIdx === -1) curr.startIdx = i;
      curr.text += w.text;
      curr.endIdx = i;
      if (breakAfter.has(i)) push();
    }
  });
  push();
  return sentences;
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

/**
 * 組證據文稿。每句一行：
 *   S3|345-378|1:23.4-1:29.1|文字（被刪字包在〔刪:…〕）
 * 句與句之間停頓 ≥0.5s 加一行：
 *   ⏸ 4.2s
 * delSet 可傳空 Set（決策模式＝標規則層已刪；審核模式＝標最終刪除）。
 */
function buildTranscript(words, sentences, delSet, delLabel) {
  const label = delLabel || '刪';
  const lines = [];
  let prev = null;
  for (const s of sentences) {
    if (prev) {
      const pause = s.start - prev.end;
      if (pause >= 0.5) lines.push(`⏸ ${pause.toFixed(1)}s`);
    }
    let text = '';
    let inDel = false;
    for (let i = s.startIdx; i <= s.endIdx; i++) {
      const w = words[i];
      if (!w || w.isGap || !w.text) continue;
      const d = delSet.has(i);
      if (d && !inDel) { text += `〔${label}:`; inDel = true; }
      if (!d && inDel) { text += '〕'; inDel = false; }
      text += w.text;
    }
    if (inDel) text += '〕';
    lines.push(`S${s.n}|${s.startIdx}-${s.endIdx}|${fmtTime(s.start)}-${fmtTime(s.end)}|${text}`);
    prev = s;
  }
  return lines.join('\n');
}

/** 從 Claude 輸出裡撈 JSON（容忍 ``` 包裝與前後贅字） */
function parseAiJson(raw) {
  let t = String(raw || '').trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('輸出中找不到 JSON 物件');
  }
  return JSON.parse(t.slice(first, last + 1));
}

/**
 * 驗證 + 吸附 AI 回傳的刪除範圍到句界（句子原子性：不接受半句刀口）。
 * 回傳 { ranges: [{start,end,type,reason,snapped}], warnings: [] }；無效項丟進 warnings 不進 ranges。
 */
function validateDeletions(deletions, words, sentences) {
  const warnings = [];
  const ranges = [];
  if (!Array.isArray(deletions)) return { ranges, warnings: ['deletions 不是陣列'] };

  for (const d of deletions) {
    const start = Number(d.start), end = Number(d.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end
        || start < 0 || end >= words.length) {
      warnings.push(`無效範圍略過: ${JSON.stringify(d)}`);
      continue;
    }
    // 吸附到「有交集的句子」的整句聯集
    const hit = sentences.filter(s => s.endIdx >= start && s.startIdx <= end);
    if (hit.length === 0) {
      warnings.push(`範圍 ${start}-${end} 沒有覆蓋任何句子，略過`);
      continue;
    }
    const snapStart = hit[0].startIdx;
    const snapEnd = hit[hit.length - 1].endIdx;
    const snapped = (snapStart !== start || snapEnd !== end);
    if (snapped) warnings.push(`範圍 ${start}-${end} 吸附至句界 ${snapStart}-${snapEnd}`);
    ranges.push({
      start: snapStart, end: snapEnd,
      type: String(d.type || '敘事'),
      reason: String(d.reason || ''),
      snapped
    });
  }
  return { ranges, warnings };
}

/** 範圍展開成 idx 陣列（含範圍內 gap，SKILL 4.5「整段含 gap 全刪」慣例） */
function expandRanges(ranges) {
  const set = new Set();
  for (const r of ranges) {
    for (let i = r.start; i <= r.end; i++) set.add(i);
  }
  return set;
}

/**
 * 合併：最終刪除 = 規則層 ∪ 敘事層。
 * reasons 沿用審核頁格式（key 為 idx 或 "start-end"），敘事層冠 [敘事] 前綴。
 */
function mergeSelections(rulesIndices, rulesReasons, ranges) {
  const set = new Set(rulesIndices);
  const reasons = Object.assign({}, rulesReasons || {});
  let added = 0;
  for (const r of ranges) {
    for (let i = r.start; i <= r.end; i++) {
      if (!set.has(i)) { set.add(i); added++; }
    }
    reasons[`${r.start}-${r.end}`] = `[敘事] ${r.type}：${r.reason}`.trim();
  }
  return {
    indices: Array.from(set).sort((a, b) => a - b),
    reasons,
    added
  };
}

/** 敘事層新增刪除的字數比（只算非 gap 字，分母 = 規則層後殘餘字數） */
function additionRatio(words, rulesSet, narrativeSet) {
  let residual = 0, added = 0;
  words.forEach((w, i) => {
    if (w.isGap || !w.text) return;
    if (rulesSet.has(i)) return;
    residual++;
    if (narrativeSet.has(i)) added++;
  });
  return residual === 0 ? 0 : added / residual;
}

module.exports = {
  buildSentences,
  buildTranscript,
  parseAiJson,
  validateDeletions,
  expandRanges,
  mergeSelections,
  additionRatio,
  fmtTime
};
