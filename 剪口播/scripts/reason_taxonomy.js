#!/usr/bin/env node
/**
 * reason_taxonomy.js — 刪除理由字串的分類法（單一真相）
 *
 * pipeline 各層產出的 reason 字串格式散在 phrase_prefilter / auto_select_rules /
 * ai_cut_pairs / convert_ai_to_indices / training_server。這個模組把它們歸成幾個
 * 「家族」，並標出哪些家族屬於「繞圈／重複」（＝可以靠錄影紀律從源頭減少的），
 * 供 aggregate_reasons.js 聚合成錄影前提詞清單。
 *
 * 只做分類，不做 IO。純函式，可單元測試。
 */

// 家族定義（順序＝比對優先序，先具體後泛用；label 給人看，circling＝可靠錄影紀律減少的重複類）
const FAMILIES = [
  { key: 'silence',       label: '靜音停頓',   circling: false, tip: '' },
  { key: 'retake',        label: '整句重錄',   circling: true,
    tip: '講錯或不滿意時，別把整句從頭重講一次；停一下、接著把後半句講完就好，剪的時候才不用二選一。' },
  { key: 'retake_fuzzy',  label: '近似重錄',   circling: true,
    tip: '同一句用「差不多的話」再講一次（換兩三個字），錄的當下不容易察覺；開口前先把這句想完整。' },
  { key: 'repeat',        label: '逐字重複',   circling: true,
    tip: '同一段話一字不差又講一次，多半是找話頭時的墊句；寧可沉默兩秒再開口，不要用重複填空檔。' },
  { key: 'intra_repeat',  label: '句內重複',   circling: true,
    tip: '一句話中間某幾個字重來（「這個…這個方法」），是邊想邊講的痕跡；放慢語速能少一大半。' },
  { key: 'semantic',      label: '語意繞圈',   circling: true,
    tip: '同一個論點換個說法再講一遍（意思一樣、字不一樣）。一個論點講一次最有力，第二次通常是稀釋。' },
  { key: 'ai_pair',       label: '敘事級重複', circling: true,
    tip: '整段論述在稿子後面又繞回來講一次。錄之前先把大綱點條列出來，講過的點打勾，不回頭。' },
  { key: 'abandoned',     label: '放棄重來',   circling: true,
    tip: '開了頭覺得不對就換句開場（「所以…那個…其實我想說的是」）。想好第一句再按錄影。' },
  { key: 'stutter',       label: '卡頓',       circling: false,
    tip: '「那個那個」「就就就」這種卡頓詞；跟緊張與語速有關，錄前深呼吸、放慢會少很多。' },
  { key: 'filler',        label: '語助詞',     circling: false,
    tip: '嗯、呃、就是說這類墊詞；量大的話值得刻意練習「用停頓取代語助詞」。' },
  { key: 'cough',         label: '咳嗽清喉',   circling: false, tip: '' },
  { key: 'hallucination', label: '辨識幻覺',   circling: false, tip: '' },
  { key: 'other',         label: '其他',       circling: false, tip: '' },
];

const FAMILY_BY_KEY = Object.fromEntries(FAMILIES.map(f => [f.key, f]));

// 比對規則（順序敏感：先具體再泛用）。每條 { re, key }
const RULES = [
  { re: /^靜音|靜音\s*[\d.]+\s*s/,               key: 'silence' },
  { re: /疑似重錄/,                               key: 'retake_fuzzy' },
  { re: /重複Take|重錄take|重錄/,                 key: 'retake' },
  { re: /相鄰重複|重複句|長片段重複/,            key: 'repeat' },
  { re: /句內重複|intra_phrase_repeat/,          key: 'intra_repeat' },
  { re: /語意重複|語意繞圈/,                      key: 'semantic' },   // 含 "AI: 語意重複…"
  // filler 要排在泛用 ^AI: 前面，否則 AI:inline_filler / AI:pause 會被誤判成敘事級繞圈
  { re: /連續語氣詞|語氣詞|口語贅詞|inline_filler|語助詞|pause/, key: 'filler' },
  { re: /^AI[:：]/,                               key: 'ai_pair' },     // 其餘 AI 對判決（後者不完整/保留前者…）
  { re: /放棄句首|放棄重來|放棄/,                key: 'abandoned' },
  { re: /殘句/,                                   key: 'abandoned' },
  { re: /話語標記開頭/,                           key: 'filler' },      // 開場語助詞歸語助詞
  { re: /卡頓|short_stutter|短句重複|短單元/,     key: 'stutter' },
  { re: /咳嗽|清喉|雜音/,                         key: 'cough' },
  { re: /幻覺/,                                   key: 'hallucination' },
];

/**
 * 分類一條 reason 字串。
 * @returns {{ key, label, circling, tip, template }}
 */
function classifyReason(reason) {
  const r = String(reason == null ? '' : reason).trim();
  let key = 'other';
  for (const rule of RULES) {
    if (rule.re.test(r)) { key = rule.key; break; }
  }
  const fam = FAMILY_BY_KEY[key] || FAMILY_BY_KEY.other;
  return { key, label: fam.label, circling: fam.circling, tip: fam.tip, template: normalizeTemplate(r) };
}

/**
 * 把一條 reason 正規化成「樣板」——抽掉具體數值/引號內文/括號 id，
 * 讓「重複Take(2次): 「甲」」與「重複Take(3次): 「乙」」歸成同一個樣板，
 * 才能統計「這種模式出現幾次」。
 */
function normalizeTemplate(reason) {
  let t = String(reason == null ? '' : reason).trim();
  // 引號內文（中英雙引號）→ …
  t = t.replace(/「[^」]*」/g, '「…」')
       .replace(/"[^"]*"/g, '"…"')
       .replace(/“[^”]*”/g, '「…」');
  // (N次) / （N次）
  t = t.replace(/[(（]\s*\d+\s*次\s*[)）]/g, '(N次)');
  // 秒數 X.Xs
  t = t.replace(/\d+(?:\.\d+)?\s*s\b/g, 'Xs');
  // 百分比
  t = t.replace(/\d+\s*%/g, 'N%');
  // 保留第N次
  t = t.replace(/保留第\s*\d+\s*次/g, '保留第N次');
  // 括號內的純 id（如 P1 / P12）壓成 …；含中文的括號（如「(N次)」「（連接詞開頭…）」）保留
  t = t.replace(/[(（][^)）]*[)）]/g, m => /[一-鿿]/.test(m) ? m : '（…）');
  // 收斂多餘空白
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

module.exports = { classifyReason, normalizeTemplate, FAMILIES, FAMILY_BY_KEY };
