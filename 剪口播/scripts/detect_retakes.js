#!/usr/bin/env node
/**
 * detect_retakes.js — 從「校正前的原始 whisper 轉錄」抓連續重錄(false-start / 立即重複 take)。
 *
 * 為什麼吃 whisper_words.json 而不是 subtitles_words.json：
 *   轉錄 pipeline 會用 reference.txt 做 gpt-4o 校正，把重複 take 合併成一次，
 *   再 NW 對齊成 subtitles_words.json（字幕/文稿乾淨、只有一次）。但剪輯決策層也吃這份
 *   乾淨稿 → 對重複 take 視而不見 → 重複語音從沒進刪除清單 → 「影片有重複、字幕沒有」。
 *   whisper_words.json 是校正前的原始辨識，保留了重複、時間戳同一條時間軸，是唯一看得到重錄的訊號源。
 *
 * 判準（保守，供全自動落刀用）：一個 k-gram(k≥MINLEN) 在很近的距離內(gap≤MAXGAP 字)立即再出現，
 *   即視為「講者重講」。刪掉前一個 take(false-start)，保留後一個(通常是乾淨版)。
 *
 * 用法: node detect_retakes.js <whisper_words.json> [out.json]
 * 輸出: [{ start, end, phrase, repeat }]  (時間段=要刪的 false-start；時間軸同原片)
 */
const fs = require('fs');

const MINLEN = 4;    // 最短重複錨點字數（太短易誤判正常疊字/語助）
const MAXK = 12;     // 最長錨點
const MAXGAP = 8;    // 兩個 take 之間允許的字距（只抓「立即」重錄，避免砍到正常呼應）
const MAX_TAKE = 40; // false-start 上限字數（超過視為兩段不同內容剛好開頭雷同，不砍）
const PREFIX_RATIO = 0.6; // 兩個 take 的「共同前綴」需佔 false-start 至少這比例，才算重錄。
                          // 這關是把「重錄」和「排比句」分開的關鍵：
                          //   重錄「口頭警告作為警告|口頭警告作為處罰」→ 共同前綴幾乎整段(高)。
                          //   排比「想像成是你自己|想像成是造物主」→ 只有錨點重複、隨即岔開(低)，剔除。

function normText(s) {
  return String(s || '').replace(/[\s，。、！？；：,.!?…"「」』（）()]/g, '');
}

// 字級序列：每個 char 記 {ch, start, end}（跳過 gap 元素，只看真的講出來的字）
function buildCharSeq(words) {
  const seq = [];
  for (const w of words) {
    if (w && w.isGap) continue;
    const t = normText(w.text || w.word || '');
    for (const ch of t) seq.push({ ch, start: w.start, end: w.end });
  }
  return seq;
}

function detectRetakes(words) {
  const seq = buildCharSeq(words);
  const S = seq.map(x => x.ch).join('');
  const results = [];

  // 收集所有「相鄰重複對」——不跨 k 互斥，交給後面 merge 併起來。
  // 這樣三連 take（A A A）會被拆成 [A→A]+[A→A] 兩對，merge 後成一段大刪除、只留最後一個 A，
  // 不會像「先長後短 consume」那樣把開頭短碎片漏掉。
  for (let k = MAXK; k >= MINLEN; k--) {
    const idx = new Map();
    for (let i = 0; i + k <= S.length; i++) {
      const g = S.substr(i, k);
      if (!idx.has(g)) idx.set(g, []);
      idx.get(g).push(i);
    }
    for (const [g, pos] of idx) {
      for (let a = 0; a < pos.length - 1; a++) {
        const p1 = pos[a], p2 = pos[a + 1];
        const gap = p2 - (p1 + k);
        if (gap < 0 || gap > MAXGAP) continue;        // 只抓立即重錄
        const takeLen = p2 - p1;                      // false-start 字數
        if (takeLen > MAX_TAKE) continue;
        // 共同前綴長度：從 p1、p2 同步往後比，直到岔開。重錄→接近整段；排比→只到錨點尾。
        let cp = 0; while (p1 + cp < p2 && S[p1 + cp] === S[p2 + cp]) cp++;
        if (cp < takeLen * PREFIX_RATIO) continue;    // 前綴太短 → 是排比/巧合開頭，不是重錄
        results.push({
          start: seq[p1].start,
          end: seq[p2].start,                         // 刪到「後一個 take 起點」為止
          phrase: S.slice(p1, p2),
          repeat: g,
        });
      }
    }
  }

  // 合併重疊 / 排序
  results.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const r of results) {
    const prev = merged[merged.length - 1];
    if (prev && r.start <= prev.end + 0.05) {
      prev.end = Math.max(prev.end, r.end);
      if (r.phrase.length > prev.phrase.length) prev.phrase = r.phrase; // 留最具代表的一段，不堆疊
    } else merged.push({ ...r });
  }
  return merged.filter(r => r.end > r.start);
}

// ── Fuzzy 層（審核頁預選用，不供全自動落刀）──────────────────────────────
// exact 層抓不到的三種近似重錄：兩完整 take 中間隔碎片（gap 超過 MAXGAP）、
// 共同前綴略低於 PREFIX_RATIO、後一 take 換了一兩個字。
// 光靠相似度分不開重錄與排比句（實測兩者都落在 sim≈0.55），所以主要證據改用校正稿：
// 拿兩個 take 的開頭各 PROBE_LEN 字去校正稿找——「兩個都找得到」＝它們是兩句都被保留的
// 不同內容（排比句/短錨點誤配），不標；「只找得到一個或都找不到」＝校正稿把兩次合併成
// 一次了（gpt-4o 甚至會把兩個 take 的字樣混拼成一句，所以不能只查 false-start 那邊），標。
// 註 1：不能只數錨點出現次數——3 字短錨點會被別處的真重錄「借」走次數差，誤把無辜句配成對。
// 註 2：whisper 聽錯會讓兩個 probe 都 miss → 仍算證據（有 sim+相鄰錨點守門，預選層可接受）。
// 無校正稿時退回高相似度門檻。
const FUZZY = {
  MINLEN: 3,          // 錨點放寬到 3（1 字差的 take 最長共同子串可能只有 3 字）
  MAXK: 12,
  MAXGAP: 25,         // 允許兩 take 之間夾破碎的 false-start 碎片
  MIN_TAKE: 5,
  MAX_TAKE: 45,
  SIM_CAND: 0.45,     // 有校正稿合併證據時的相似度下限
  SIM_SOLO: 0.62,     // 無校正稿證據時，單靠相似度要達到這門檻
  MIN_RESIDUAL: 0.6,  // 減去 exact 已涵蓋範圍後，殘段至少要這麼長（秒）才值得標
  PROBE_LEN: 10,      // 拿 false-start 前幾個字去校正稿查存在（太短會撞到 take 間共同前綴）
};

// Levenshtein 相似度（0~1）
function levSim(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * @param {Array} words 校正前 whisper_words（同 detectRetakes）
 * @param {string} correctedText gpt-4o 校正後全文（可空字串＝無校正稿）
 * @returns [{ start, end, phrase, next, sim, evidence }]
 *   時間段＝疑似 false-start（已剔除 exact 層涵蓋的部分）；evidence:
 *   'corrected-merge'＝校正稿合併證據、'high-sim'＝純高相似度。
 */
function detectRetakesFuzzy(words, correctedText, opts = {}) {
  const o = { ...FUZZY, ...opts };
  const seq = buildCharSeq(words);
  const S = seq.map(x => x.ch).join('');
  const C = normText(correctedText);

  const cands = [];
  for (let k = o.MAXK; k >= o.MINLEN; k--) {
    const idx = new Map();
    for (let i = 0; i + k <= S.length; i++) {
      const g = S.substr(i, k);
      if (!idx.has(g)) idx.set(g, []);
      idx.get(g).push(i);
    }
    for (const [g, pos] of idx) {
      for (let a = 0; a < pos.length - 1; a++) {
        const p1 = pos[a], p2 = pos[a + 1];
        const gap = p2 - (p1 + k);
        if (gap < 0 || gap > o.MAXGAP) continue;
        const takeLen = p2 - p1;
        if (takeLen < o.MIN_TAKE || takeLen > o.MAX_TAKE) continue;
        const A = S.substr(p1, takeLen), B = S.substr(p2, takeLen);
        const sim = levSim(A, B);
        if (sim < o.SIM_CAND) continue;
        // 兩個 take 開頭都在校正稿 → 兩句不同內容都被留下 → 不是重錄；否則＝被合併 → 證據
        const probeA = A.slice(0, Math.min(A.length, o.PROBE_LEN));
        const probeB = B.slice(0, Math.min(B.length, o.PROBE_LEN));
        const merged = !!C && !(C.includes(probeA) && C.includes(probeB));
        if (sim < o.SIM_SOLO && !merged) continue;
        cands.push({
          start: seq[p1].start, end: seq[p2].start,
          phrase: A, next: B, sim,
          evidence: merged ? 'corrected-merge' : 'high-sim',
        });
      }
    }
  }

  cands.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const r of cands) {
    const prev = merged[merged.length - 1];
    if (prev && r.start <= prev.end + 0.05) {
      prev.end = Math.max(prev.end, r.end);
      if (r.sim > prev.sim) { prev.sim = r.sim; prev.phrase = r.phrase; prev.next = r.next; prev.evidence = r.evidence; }
    } else merged.push({ ...r });
  }

  // 減去 exact 層已自動剪的範圍（避免重複標），殘段太短就丟
  const exact = detectRetakes(words);
  const out = [];
  for (const f of merged) {
    let segs = [{ start: f.start, end: f.end }];
    for (const e of exact) {
      const next = [];
      for (const s of segs) {
        if (e.end <= s.start || e.start >= s.end) { next.push(s); continue; }
        if (e.start > s.start + 0.01) next.push({ start: s.start, end: e.start });
        if (e.end < s.end - 0.01) next.push({ start: e.end, end: s.end });
      }
      segs = next;
    }
    for (const s of segs) {
      if (s.end - s.start >= o.MIN_RESIDUAL) out.push({ ...f, start: s.start, end: s.end });
    }
  }
  return out;
}

module.exports = { detectRetakes, detectRetakesFuzzy };

// ── CLI（僅直接執行時跑；被 require 時不動作）──
if (require.main === module) {
  const inFile = process.argv[2];
  const outFile = process.argv[3] || '';
  if (!inFile) { console.error('用法: node detect_retakes.js <whisper_words.json> [out.json]'); process.exit(1); }
  const words = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const arr = Array.isArray(words) ? words : (words.words || words.segments || []);
  const retakes = detectRetakes(arr);
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(retakes, null, 2));
    console.error(`✅ 重錄偵測: ${retakes.length} 段 → ${outFile}`);
  } else {
    console.log(JSON.stringify(retakes, null, 2));
  }
  for (const r of retakes) console.error(`  🔁 [${r.start.toFixed(2)}~${r.end.toFixed(2)}] "${r.phrase}"`);
}
