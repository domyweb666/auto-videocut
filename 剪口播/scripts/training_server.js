#!/usr/bin/env node
/**
 * 批量訓練可視化儀表板
 *
 * 功能：
 * 1. 掃描目錄找 video+SRT 配對
 * 2. 管理訓練清單（增刪）
 * 3. 啟動批量訓練並即時顯示進度
 * 4. 可視化訓練結果（各規則精確率/召回率、靜音分佈圖、影片對比表）
 *
 * 用法: node training_server.js [port]
 * 預設: port=8900
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { parseAutoSelected } = require('./parse_auto_selected'); // 從退役 generate_review.js 抽出（audit #12）
const buildReviewDoc = require('./generate_review_doc'); // 純白文稿版審核頁（取代深色版，舊版保留備援）
const convertAiToIndices = require('./convert_ai_to_indices'); // 句級 sentences.json → 字級 {indices,reasons}

// 把 AI 句級結果（sentences.json）轉成審核頁吃的字級 auto_selected.json 並寫檔。
// 8900 流程的 AI 判斷寫在句級 sentences.json，但審核頁 / 匯出讀字級 auto_selected.json，
// 缺這一步會導致「AI 跑了但審核頁零標記」。另外把重錄（exact/fuzzy）與咳嗽併進預選（見下），
// 匯出端不再默默加料（WYSIWYG）。回傳 {indices, reasons}，全部沒東西（或缺檔）回 null。
function writeAutoSelectedFromSentences(workDir) {
  try {
    const sentPath = path.join(workDir, '1_轉錄', 'sentences.json');
    const subsPath = path.join(workDir, '1_轉錄', 'subtitles_words.json');
    if (!fs.existsSync(subsPath)) return null;
    const words = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
    let indices = [], reasons = {}, hasAI = false;
    const pairs = {}; // rangeKey → {start,end}＝該刪除段對應「保留的那個 take」時間段（審核頁對照顯示用）
    if (fs.existsSync(sentPath)) {
      const phrases = JSON.parse(fs.readFileSync(sentPath, 'utf8'));
      if (Array.isArray(phrases) && phrases.some(s => s && s.aiDelete)) {
        ({ indices, reasons } = convertAiToIndices(phrases, words));
        hasAI = true;
      }
    }
    const autoAdded = autoContentPreselect(workDir, words, indices, reasons, pairs);
    if (!hasAI && !autoAdded) return null; // 什麼標記都沒有 → 不寫（審核頁無預選）
    const analysisDir = path.join(workDir, '2_分析');
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, 'auto_selected.json'),
                     JSON.stringify({ indices, reasons, pairs }, null, 2), 'utf8');
    return { indices, reasons, pairs };
  } catch (e) {
    console.error('⚠️ writeAutoSelectedFromSentences 失敗:', e.message);
    return null;
  }
}

// 內容層自動決策 → 審核頁預選（WYSIWYG，2026-07-02 使用者指令：「審核頁怎麼改，匯出就怎麼呈現」）。
// 重錄（exact/fuzzy）與咳嗽不再由匯出端默默併入時間段——全部映射成字級 indices 進
// auto_selected.json，審核頁看得到、可取消；匯出端只執行使用者核可的清單。
// 原地改 indices/reasons；回傳併入段數；任何失敗回 0（不影響既有標記）。

// 把時間段映射成字級 indices 併入選取集；每段記一條 reason（range key）。
// keepOf（選配）回傳該段對應「保留 take」的時間範圍 → 記進 pairs，審核頁點到刪除段時同步高亮保留段
function preselectSegs(words, segs, sel, reasons, reasonOf, pairs, keepOf) {
  let n = 0;
  for (const r of segs) {
    const hit = [];
    words.forEach((w, i) => {
      if (!w || typeof w.start !== 'number' || typeof w.end !== 'number') return;
      const ov = Math.min(w.end, r.end) - Math.max(w.start, r.start);
      if (ov <= 0) return;
      // gap 元素沾到就算；文字 word 要蓋過 40% 時長才算（避免邊界字被誤標）
      if (w.isGap ? ov > 0.05 : ov / Math.max(w.end - w.start, 0.01) >= 0.4) hit.push(i);
    });
    if (!hit.length) continue;
    if (hit.every(i => sel.has(i))) continue; // 已被標過（如 AI 句級已刪）→ 不重複記
    hit.forEach(i => sel.add(i));
    const key = `${hit[0]}-${hit[hit.length - 1]}`;
    if (!reasons[key]) reasons[key] = reasonOf(r);
    if (pairs && keepOf) { const kp = keepOf(r); if (kp) pairs[key] = { start: +kp.start.toFixed(2), end: +kp.end.toFixed(2) }; }
    n++;
  }
  return n;
}

function autoContentPreselect(workDir, words, indices, reasons, pairs) {
  try {
    const cfg = readTrainingConfig();
    const sel = new Set(indices);
    let added = 0;

    // 1) 重錄 exact＋fuzzy — 訊號源：whisper_words（舊管線）或 subtitles_words（ddc off 逐字稿）
    const rt = cfg.retake || {};
    if (rt.enabled !== false) {
      const src = resolveRetakeSource(workDir);
      if (src) {
        const { detectRetakes, detectRetakesFuzzy } = require('./detect_retakes.js');
        const wraw = JSON.parse(fs.readFileSync(src.path, 'utf8'));
        const warr = Array.isArray(wraw) ? wraw : (wraw.words || wraw.segments || []);
        // 保留 take 緊跟在刪除段之後，長度≈刪除段（供審核頁對照高亮；粗估即可）
        const keepAfter = r => ({ start: r.end, end: r.end + Math.min(Math.max(r.end - r.start, 0.5), 6) });
        added += preselectSegs(words, detectRetakes(warr), sel, reasons,
          r => `重錄take：刪「${r.phrase}」留後一次`, pairs, keepAfter);
        if (rt.fuzzy_preselect !== false) {
          let corrected = '';
          const cPath = path.join(workDir, '1_轉錄', 'corrected_text.txt');
          if (fs.existsSync(cPath)) corrected = fs.readFileSync(cPath, 'utf8');
          // 無校正稿（新 BytePlus 流程）時，講稿 reference.txt 是排比/重錄判別證據，
          // 同時讓遠距層重新啟用（detect_retakes 的 refMergeEvidence，次數差+scripted 守門）
          let referenceText = '';
          const rPath = path.join(workDir, '1_轉錄', 'reference.txt');
          if (fs.existsSync(rPath)) referenceText = fs.readFileSync(rPath, 'utf8');
          // fuzzy 的保留 take 也從刪除段結尾起算，時長按「保留字數/刪除字數」比例粗估
          const keepFuzzy = r => {
            const ratio = r.phrase && r.next ? r.next.length / Math.max(r.phrase.length, 1) : 1;
            const len = Math.min(Math.max((r.end - r.start) * ratio, 0.5), 6);
            return { start: r.end, end: r.end + len };
          };
          added += preselectSegs(words, detectRetakesFuzzy(warr, corrected, { ...(rt.fuzzy_opts || {}), referenceText }), sel, reasons,
            r => `疑似重錄(相似${Math.round(r.sim * 100)}%${r.evidence.endsWith('-far') ? '，隔碎片' : ''}${r.evidence.startsWith('reference') ? '，講稿佐證' : ''})：刪「${r.phrase}」留「${r.next}」`, pairs, keepFuzzy);
        }
      }
    }

    // 2) 咳嗽/清喉（ML conf ≥ 門檻，外擴 pad）— 過去在匯出端 buildRefined 默默併入，現改上審核頁
    const cm = cfg.cough_ml || {};
    if (cm.enabled !== false) {
      const coughPath = path.join(workDir, '2_分析', 'cough_ml.json');
      if (fs.existsSync(coughPath)) {
        const minConf = cm.min_confidence ?? 0.55;
        const pad = cm.pad_sec ?? 0.08;
        const coughs = JSON.parse(fs.readFileSync(coughPath, 'utf8'))
          .filter(c => (c.confidence ?? 0) >= minConf)
          .map(c => ({ start: Math.max(0, c.start - pad), end: c.end + pad, _label: c.label, _conf: c.confidence }));
        added += preselectSegs(words, coughs, sel, reasons,
          r => `${r._label === 'Throat clearing' ? '清喉' : '咳嗽/雜音'}(ML 信心${Math.round((r._conf || 0) * 100)}%)`);
      }
    }

    // 3) 語意重複建議（嵌入向量，低信心層）— 只讀 prepareArtifacts 背景產出的快取，
    //    絕不現算（審核頁載入會同步走到這裡，模型編碼可達數十秒）。
    //    抓「字面差異大但語意相同」的遠距重複（bigram/LCS 候選對層看不見的），
    //    刪較短句、理由標明低信心，審核頁可取消。
    const se = cfg.semantic_embed || {};
    if (se.enabled !== false) {
      const semPath = path.join(workDir, '2_分析', 'semantic_pairs.json');
      if (fs.existsSync(semPath)) {
        try {
          const cands = JSON.parse(fs.readFileSync(semPath, 'utf8')) || [];
          const maxN = se.max_pairs ?? 8;
          let n = 0;
          for (const c of cands) {  // detect_redundancy 已按相似度降序
            if (n >= maxN) break;
            if (!c || !c.sent_a || !c.sent_b) continue;
            const del = String(c.sent_a.text).length <= String(c.sent_b.text).length ? c.sent_a : c.sent_b;
            const keep = del === c.sent_a ? c.sent_b : c.sent_a;
            if (sel.has(del.startIdx) || sel.has(keep.startIdx)) continue; // 任一側已被刪 → 不疊加
            const hit = [];
            for (let k = del.startIdx; k <= del.endIdx && k < words.length; k++) hit.push(k);
            if (!hit.length || hit.every(k => sel.has(k))) continue;
            hit.forEach(k => sel.add(k));
            const key = `${hit[0]}-${hit[hit.length - 1]}`;
            if (!reasons[key]) reasons[key] = `語意重複建議(嵌入${Math.round((c.similarity || 0) * 100)}%，低信心請確認)：與「${String(keep.text).slice(0, 15)}…」重複，刪較短`;
            // 語意配對的保留句有精確字級範圍 → 直接記時間（審核頁對照高亮）
            if (pairs && words[keep.startIdx] && words[Math.min(keep.endIdx, words.length - 1)]) {
              pairs[key] = { start: +words[keep.startIdx].start.toFixed(2), end: +words[Math.min(keep.endIdx, words.length - 1)].end.toFixed(2) };
            }
            n++; added += 1;
          }
          if (n) console.log(`🧠 語意重複建議（嵌入）預選 ${n} 段`);
        } catch (e) { console.warn('[語意建議] 解析失敗(略過):', (e.message || '').split('\n')[0]); }
      }
    }

    if (added) {
      const sorted = [...sel].sort((a, b) => a - b);
      indices.length = 0;
      sorted.forEach(i => indices.push(i));
      console.log(`🏷️ 自動內容預選 ${added} 段（重錄/咳嗽；審核頁可取消，匯出端不再自動併入）`);
    }
    return added;
  } catch (e) {
    console.warn('[自動內容預選] 失敗(略過):', (e.message || '').split('\n')[0]);
    return 0;
  }
}

// 估算匯出時苦工層（壓平/吸附/刀口原子化）會「額外」扣掉的秒數（給審核頁「剪後」顯示）。
// audit #14：舊做法自己掃 silences 疊加 (len−target)——重複扣「已在刪除段內」的靜音、
// 沒套兩段式壓平與文意分流 → 高估。改為 refine_segments 乾跑（與匯出同一套邏輯），
// 取「refined 總刪除 − 內容刪除」的差值。任何一步失敗 → 回 0（估算是資訊性的，不擋頁面）。
function estimateSilenceRemovalSec(workDir, words, autoSelectedIdx) {
  try {
    const cfg = readTrainingConfig();
    if ((cfg.pause_flatten || {}).enabled === false) return 0;
    const subsPath = path.join(workDir, '1_轉錄', 'subtitles_words.json');
    const audioPath = path.join(workDir, '1_轉錄', 'audio.mp3');
    const analysisDir = path.join(workDir, '2_分析');
    const art = {
      rms: path.join(analysisDir, 'audio_rms.json'),
      sil: path.join(analysisDir, 'silences.json'),
      ok: fs.existsSync(audioPath) && fs.existsSync(subsPath),
    };
    if (!art.ok) return 0;
    if (!fs.existsSync(art.sil)) {
      try {
        fs.mkdirSync(analysisDir, { recursive: true });
        require('child_process').execFileSync('node', [path.join(SCRIPT_DIR, 'detect_silences.js'), audioPath, art.sil], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
      } catch (_) {}
    }
    if (!fs.existsSync(art.sil)) return 0;
    // 預選 indices → 內容刪除段：與審核頁 segs() 同規則（相鄰間隔 <0.05s 即併）
    const idx = Array.from(autoSelectedIdx || []).filter(i => words && words[i]).sort((a, b) => a - b);
    const content = [];
    for (const i of idx) {
      const w = words[i];
      const last = content[content.length - 1];
      if (last && w.start - last.end < 0.05) last.end = Math.max(last.end, w.end);
      else content.push({ start: w.start, end: w.end });
    }
    const refinedPath = buildRefined(subsPath, content, art, workDir, 'delete_segments.estimate.refined.json');
    if (!refinedPath) return 0;
    let refined = JSON.parse(fs.readFileSync(refinedPath, 'utf8'));
    refined = Array.isArray(refined) ? refined : (refined.segments || []);
    const sum = a => a.reduce((t, s) => t + Math.max(0, s.end - s.start), 0);
    return Math.max(0, sum(refined) - sum(content));
  } catch (_) { return 0; }
}

// 純白簡潔版剪輯頁（取代舊深色 CUT_HTML；無影片預覽，丟檔→處理→審核）
const CUT_DOC_HTML = `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>剪輯影片</title>
<style>
  body{margin:0;background:#f3f2ee;color:#2c2c2a;font-family:-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;}
  .wrap{max-width:560px;margin:48px auto;padding:0 16px;}
  h1{font-size:20px;font-weight:600;margin:0 0 4px;}
  .sub{font-size:13px;color:#888;margin:0 0 22px;}
  .card{background:#fff;border:1px solid #e3e1d9;border-radius:12px;padding:24px 26px;}
  label{display:block;font-size:13px;color:#5f5e5a;margin:0 0 6px;}
  .row{display:flex;gap:8px;margin-bottom:18px;}
  input[type=text],textarea{width:100%;box-sizing:border-box;background:#fff;border:1px solid #d3d1c7;border-radius:8px;padding:10px 12px;font-size:14px;color:#2c2c2a;font-family:inherit;}
  textarea{resize:vertical;min-height:84px;margin-bottom:18px;}
  button{border-radius:8px;font-size:14px;padding:10px 16px;cursor:pointer;border:1px solid #d3d1c7;background:#fff;color:#444441;}
  button:hover{background:#f1efe8;}
  .btn-go{width:100%;background:#2c2c2a;color:#fff;border:none;font-weight:600;padding:12px;}
  .btn-go:disabled{opacity:.5;cursor:not-allowed;}
  #progress{margin-top:22px;display:none;}
  .pbar{height:8px;background:#eee;border-radius:4px;overflow:hidden;}
  .pfill{height:100%;background:#2c2c2a;width:0%;transition:width .3s;}
  .pstep{font-size:13px;color:#5f5e5a;margin:10px 0 0;}
  .plog{font-size:12px;color:#9a988f;margin-top:6px;white-space:pre-wrap;max-height:120px;overflow:auto;line-height:1.6;}
  #done{display:none;margin-top:22px;text-align:center;}
  .btn-review{background:#185FA5;color:#fff;border:none;padding:12px 28px;font-weight:600;font-size:15px;}
  .err{color:#A32D2D;font-size:13px;margin-top:14px;white-space:pre-wrap;}
</style></head><body>
<div class="wrap">
  <h1>剪輯影片</h1>
  <p class="sub">丟影片（直接拖進視窗也行）、貼講稿（選填），按開始。中間機器全包，跑完去審核。</p>
  <div class="card">
    <label>影片路徑</label>
    <div class="row">
      <input type="text" id="videoInput" placeholder="貼上影片路徑、點瀏覽，或直接把檔案拖進來">
      <button onclick="browse()" style="white-space:nowrap;">瀏覽</button>
    </div>
    <div id="dropHint" style="display:none;border:2px dashed #185FA5;border-radius:8px;padding:10px;text-align:center;font-size:13px;color:#185FA5;margin-bottom:14px;">放開以上傳影片</div>
    <div id="upProg" style="display:none;font-size:12.5px;color:#5f5e5a;margin:0 0 14px;">上傳中… <span id="upPct">0%</span>（會複製一份到 cut_work/_uploads/）</div>
    <label>參考文稿（選填，講稿/大綱即可）— 有貼的話，審核時會標出疑似聽錯的字</label>
    <textarea id="refInput" placeholder="貼上這支影片的講稿或大綱；留空則直接辨識"></textarea>
    <button class="btn-go" id="goBtn" onclick="start()">開始處理</button>
    <div id="progress">
      <div class="pbar"><div class="pfill" id="pfill"></div></div>
      <p class="pstep" id="pstep">準備中…</p>
      <div class="plog" id="plog"></div>
    </div>
    <div id="done"><button id="rerunBtn" onclick="rerunAI()" style="margin-right:8px;">🔄 重新 AI 分析</button><button class="btn-review" onclick="openReview()">前往審核 →</button></div>
    <div class="err" id="err"></div>
  </div>
</div>
<script>
var baseName='';
function browse(){fetch('/api/native-browse').then(function(r){return r.json()}).then(function(d){if(d.path)document.getElementById('videoInput').value=d.path}).catch(function(e){alert('browse failed: '+e.message)});}
function fail(m){document.getElementById('err').textContent='✗ '+m;document.getElementById('goBtn').disabled=false;}
function start(){
  var vp=document.getElementById('videoInput').value.trim();
  if(!vp){alert('請先選影片');return;}
  baseName=vp.split(/[\\\\/]/).pop().replace(/\\.[^.]+$/,'');
  document.getElementById('err').textContent='';
  document.getElementById('done').style.display='none';
  document.getElementById('goBtn').disabled=true;
  document.getElementById('progress').style.display='block';
  fetch('/api/process-video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoPath:vp,referenceText:document.getElementById('refInput').value})})
    .then(function(r){return r.json()}).then(function(d){if(d.error){fail(d.error);return;}poll();}).catch(function(e){fail(e.message)});
}
function poll(){
  fetch('/api/cut-status').then(function(r){return r.json()}).then(function(s){
    document.getElementById('pfill').style.width=(s.progress||0)+'%';
    document.getElementById('pstep').textContent=(s.step||'')+' '+(s.progress||0)+'%';
    if(s.log&&s.log.length)document.getElementById('plog').textContent=s.log.slice(-4).join('\\n');
    if(s.error){fail(s.error);return;}
    if(s.running===false){document.getElementById('pstep').textContent='完成 100%';document.getElementById('pfill').style.width='100%';document.getElementById('done').style.display='block';document.getElementById('goBtn').disabled=false;return;}
    setTimeout(poll,1000);
  }).catch(function(){setTimeout(poll,1500);});
}
function rerunAI(){
  if(!confirm('重新完整跑一次 AI 分析？會覆蓋目前這支的 AI 刪除標記（重新從頭判斷）。字幕與音檔不會重轉。'))return;
  document.getElementById('done').style.display='none';
  document.getElementById('err').textContent='';
  document.getElementById('goBtn').disabled=true;
  document.getElementById('progress').style.display='block';
  document.getElementById('pstep').textContent='重新 AI 分析中…';
  fetch('/api/rerun-ai',{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error){fail(d.error);return;}poll();}).catch(function(e){fail(e.message)});
}
function openReview(){if(baseName)window.open('/review/'+encodeURIComponent(baseName),'_blank');}
// ── 拖放上傳：瀏覽器拿不到本機檔案路徑，只能把位元組複製一份進 cut_work/_uploads/ ──
var dragDepth=0;
document.addEventListener('dragover',function(e){e.preventDefault();});
document.addEventListener('dragenter',function(e){e.preventDefault();dragDepth++;document.getElementById('dropHint').style.display='block';});
document.addEventListener('dragleave',function(e){dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)document.getElementById('dropHint').style.display='none';});
document.addEventListener('drop',function(e){
  e.preventDefault();dragDepth=0;document.getElementById('dropHint').style.display='none';
  var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
  if(!f)return;
  if(!/\\.(mp4|mov|mkv|avi|flv|webm|m4v)$/i.test(f.name)){alert('請丟影片檔（mp4/mov/mkv…）');return;}
  var xhr=new XMLHttpRequest();
  xhr.open('POST','/api/upload-video?name='+encodeURIComponent(f.name));
  document.getElementById('upProg').style.display='block';
  xhr.upload.onprogress=function(ev){if(ev.lengthComputable)document.getElementById('upPct').textContent=Math.round(ev.loaded/ev.total*100)+'%';};
  xhr.onload=function(){
    document.getElementById('upProg').style.display='none';
    try{var d=JSON.parse(xhr.responseText);if(d.path){document.getElementById('videoInput').value=d.path;}else{alert('上傳失敗：'+(d.error||xhr.status));}}
    catch(err){alert('上傳失敗：'+err.message);}
  };
  xhr.onerror=function(){document.getElementById('upProg').style.display='none';alert('上傳失敗（連線錯誤）');};
  xhr.send(f);
});
</script></body></html>`;

// ── 匯出後驗證：呼叫 verify_export.js，回傳解析後結果（永不 throw，驗證問題不阻斷匯出）──
// extra = { srt, subtitles, silences }：有給 srt+subtitles 就多跑「逐字對帳」（SRT 文字 vs 保留字，FAIL 級）
function runVerify(outputFile, inputFile, deleteSegmentsPath, tag = '', extra = {}) {
  try {
    const verifyScript = path.join(__dirname, 'verify_export.js');
    if (!fs.existsSync(verifyScript)) return null;
    const vArgs = [verifyScript, '--output', outputFile, '--input', inputFile, '--delete', deleteSegmentsPath, '--json'];
    if (extra.srt && extra.subtitles) {
      vArgs.push('--srt', extra.srt, '--subtitles', extra.subtitles);
      if (extra.silences) vArgs.push('--silences', extra.silences);
    }
    let stdout;
    try {
      stdout = execFileSync(
        'node',
        vArgs,
        { encoding: 'utf8' }
      );
    } catch (e) {
      // verify_export 在有 FAIL 時退出碼 2，execFileSync 會 throw，但 stdout 仍含完整 JSON
      stdout = e.stdout;
    }
    const result = JSON.parse(stdout);
    const fails = result.checks.filter(c => c.level === 'fail');
    const warns = result.checks.filter(c => c.level === 'warn');
    if (fails.length)      console.error(`❌ ${tag}匯出驗證 FAIL：${fails.map(c => `${c.name} — ${c.msg}`).join('; ')}`);
    else if (warns.length) console.warn (`⚠️ ${tag}匯出驗證警示：${warns.map(c => `${c.name} — ${c.msg}`).join('; ')}`);
    else                   console.log  (`✅ ${tag}匯出驗證全數通過`);
    return result;
  } catch (err) {
    console.error(`⚠️ ${tag}匯出驗證無法執行（不影響匯出）：${err.message}`);
    return null;
  }
}

const PORT = process.argv[2] || 8900;
const SCRIPT_DIR = __dirname;

// 統一讀 repo 根目錄的 training_config.json。
// ⚠️ config 在 SCRIPT_DIR 的上一層——過去多處直接 join(SCRIPT_DIR,...) 讀 = 永遠 ENOENT 被
// catch 吞掉 → 整份 config 靜默失效、跑內建預設（實例：咳嗽門檻調 0.45 從沒生效，
// conf=0.549 的清喉一直用預設 0.55 卡在門檻外）。所有讀取一律走這個 helper。
function readTrainingConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '..', 'training_config.json'), 'utf8')); }
  catch (_) { return {}; }
}

// ── 苦工層精修 orchestration（停頓壓平/切點吸附/咳嗽/音訊分句）共用工具 ──
// 8900 是唯一服務器（剪輯 + 審核 + 訓練）；舊的 8899 review_server 已退役移除。
// 慢步驟（RMS 序列 / 音訊靜音 / 咳嗽 ML）非阻塞、結果快取；refine 本身快、同步。
// 設計分流：原始 delete_segments=內容訊號；refined=苦工(落刀/SRT/verify)。任何步驟失敗皆降級用原始切點，不擋出片。
function prepareArtifacts(workDir, subsPath, audioPath, analysisDir, cb) {
  const art = {
    rms: path.join(analysisDir, 'audio_rms.json'),
    sil: path.join(analysisDir, 'silences.json'),
    cough: path.join(analysisDir, 'cough_ml.json'),
    sem: path.join(analysisDir, 'semantic_pairs.json'),
    ok: false,
  };
  try { fs.mkdirSync(analysisDir, { recursive: true }); } catch (_) {}
  if (!audioPath || !fs.existsSync(audioPath) || !fs.existsSync(subsPath)) { cb(art); return; }
  art.ok = true;
  const cfg = readTrainingConfig();
  const coughEnabled = (cfg.cough_ml || {}).enabled !== false;
  const steps = []; // [cmd, args, saveStdoutTo?]
  if (!fs.existsSync(art.rms))
    steps.push(['python', [path.join(SCRIPT_DIR, 'extract_audio_features.py'), audioPath, subsPath, path.join(analysisDir, 'audio_features.json'), '--dump-series', art.rms]]);
  if (!fs.existsSync(art.sil))
    steps.push(['node', [path.join(SCRIPT_DIR, 'detect_silences.js'), audioPath, art.sil]]);
  if (coughEnabled && !fs.existsSync(art.cough))
    steps.push(['python', [path.join(SCRIPT_DIR, 'detect_coughs_ml.py'), audioPath, art.cough, '--thr', '0.2']]);
  // 語意重複建議（嵌入向量，低信心層）：從 AI 保留句建 sentences.txt →
  // detect_redundancy.py（sentence-transformers，缺依賴自動退 3-gram）→ 快取 semantic_pairs.json。
  // 放這裡（背景）而非 autoContentPreselect（審核頁載入會同步觸發）——模型編碼可達數十秒。
  const semCfg = cfg.semantic_embed || {};
  if (semCfg.enabled !== false && !fs.existsSync(art.sem)) {
    try {
      const sentPath = path.join(workDir, '1_轉錄', 'sentences.json');
      if (fs.existsSync(sentPath)) {
        const phr = JSON.parse(fs.readFileSync(sentPath, 'utf8'));
        const minLen = semCfg.min_len ?? 10;
        const lines = [];
        phr.forEach((p, si) => {
          if (!p || p.aiDelete) return;
          const wis = p.wordIndices || [];
          if (!wis.length) return;
          const text = String(p.displayText || p.text || '').replace(/[|\r\n]/g, '').trim();
          if (text.length < minLen) return;
          lines.push(si + '|' + wis[0] + '-' + wis[wis.length - 1] + '|' + text);
        });
        if (lines.length >= 2) {
          const txt = path.join(analysisDir, 'semantic_sentences.txt');
          fs.writeFileSync(txt, lines.join('\n'), 'utf8');
          steps.push(['python', [path.join(SCRIPT_DIR, 'detect_redundancy.py'), txt,
            String(semCfg.threshold ?? 0.9), String(semCfg.min_gap ?? 3), String(semCfg.max_gap ?? 40)],
            art.sem]);
        }
      }
    } catch (e) { console.warn('[8900 精修] 語意建議前置失敗(略過):', (e.message || '').split('\n')[0]); }
  }
  const { execFile } = require('child_process');
  let i = 0;
  const next = () => {
    if (i >= steps.length) { cb(art); return; }
    const [c, a, saveTo] = steps[i++];
    // timeout 防呆：語意/咳嗽首跑要下載模型，網路壞掉時別讓整條鏈掛死（正常跑遠低於此值）
    execFile(c, a, { maxBuffer: 50 * 1024 * 1024, timeout: 600000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout) => {
      if (err) console.warn('[8900 精修] 步驟失敗(略過):', (err.message || '').split('\n')[0]);
      else if (saveTo) { try { fs.writeFileSync(saveTo, stdout); } catch (e2) { console.warn('[8900 精修] 落檔失敗:', e2.message); } }
      next();
    });
  };
  next();
}

// 用 art（rms/silences）把「內容刪除段」精修成 refined 檔。同步、快。回傳路徑或 null（降級）。
// 註：咳嗽已改由 autoContentPreselect 進審核頁預選（WYSIWYG），此處不再默默併入。
function buildRefined(subsPath, contentSegments, art, workDir, outBase) {
  try {
    if (!art.ok) return null;
    const content = (contentSegments || []).map(s => ({ start: s.start, end: s.end }));
    const { execFileSync } = require('child_process');
    const contentFile = path.join(workDir, outBase.replace(/\.refined\.json$/, '.content.json'));
    fs.writeFileSync(contentFile, JSON.stringify(content, null, 2));
    const refined = path.join(workDir, outBase);
    execFileSync('node', [path.join(SCRIPT_DIR, 'refine_segments.js'), subsPath, contentFile, art.rms, art.sil, refined], { stdio: 'pipe' });
    return fs.existsSync(refined) ? refined : null;
  } catch (e) {
    console.warn('[8900 精修] refine 失敗，用原始切點:', (e.message || '').split('\n')[0]);
    return null;
  }
}

// 重錄訊號源解析：舊流程（gpt-4o 校正）用校正前的 whisper_words.json；
// 新流程（byteplus --ddc off）沒有 whisper_words，但 subtitles_words 本身就是未清理逐字稿，
// 重錄都看得到 → 直接當 fallback。兩者都缺才放棄（明確 log，不再靜默 no-op）。
function resolveRetakeSource(workDir) {
  const whisperPath = path.join(workDir, '1_轉錄', 'whisper_words.json');
  if (fs.existsSync(whisperPath)) return { path: whisperPath, label: 'whisper_words（校正前）' };
  const subsPath = path.join(workDir, '1_轉錄', 'subtitles_words.json');
  if (fs.existsSync(subsPath)) return { path: subsPath, label: 'subtitles_words（ddc off 逐字稿）' };
  return null;
}

// （舊 mergeRetakes 已移除：重錄改由 autoContentPreselect 進審核頁預選，
//   匯出端不再默默併入時間段——WYSIWYG，使用者核可什麼就剪什麼。）


/**
 * 由 videoName（不含副檔名）反查它的原始影片路徑與 cut_work 目錄。
 * 先看 cutState（最近一次處理的影片），再從 batchState.items 找。
 */
function findVideoForName(videoName) {
  // 安全（audit P2#8）：videoName 只能是單純檔名，含路徑分隔符或 .. 一律拒絕，
  // 否則 fallback 的 path.join 會被 ../ 穿越到 cut_work 之外。
  if (!videoName || /[\\/]/.test(videoName) || videoName.includes('..')) return null;
  if (cutState.videoPath) {
    const bn = path.basename(cutState.videoPath).replace(/\.[^/.]+$/, '');
    if (bn === videoName) {
      return { videoPath: cutState.videoPath, workDir: cutState.workDir };
    }
  }
  for (const item of (batchState && batchState.items) || []) {
    const bn = path.basename(item.videoPath).replace(/\.[^/.]+$/, '');
    if (bn === videoName) {
      return {
        videoPath: item.videoPath,
        workDir: path.join(process.cwd(), 'cut_work', bn),
      };
    }
  }
  // fallback：cut_work/<name>/ 存在但 batch 已被清掉，至少能服務字幕/AI
  const fallbackWork = path.join(process.cwd(), 'cut_work', videoName);
  if (fs.existsSync(fallbackWork)) {
    return { videoPath: null, workDir: fallbackWork };
  }
  return null;
}


// 剪輯狀態
let cutState = {
  running: false,
  step: '',
  videoPath: null,
  workDir: null,
  subtitlesPath: null,
  autoSelectedPath: null,
  outputPath: null,
  log: [],
  error: null
};

// 匯出進度狀態（審核頁匯出改成非同步，讓前端輪詢百分比）
let exportState = { running: false, progress: 0, step: '', videoName: '', result: null, error: null };

// Git Bash 路徑偵測：env 覆寫 → 常見安裝路徑 → 由 git.exe 位置反推。
// 不可用 PATH 上的裸 'bash'（Windows 會解析成 System32 的 WSL bash，吃不了 C:/ 路徑）。
let _bashBinCache = null;
function resolveBashBin() {
  if (_bashBinCache) return _bashBinCache;
  if (process.platform !== 'win32') return (_bashBinCache = 'bash');
  const candidates = [
    process.env.GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null,
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return (_bashBinCache = c); } catch (_) {} }
  try {
    const git = require('child_process').execFileSync('where.exe', ['git.exe'], { stdio: 'pipe' })
      .toString().split(/\r?\n/)[0].trim();
    if (git) {
      const b = path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe');
      if (fs.existsSync(b)) return (_bashBinCache = b);
    }
  } catch (_) {}
  return (_bashBinCache = 'C:\\Program Files\\Git\\bin\\bash.exe');
}

function startCutProcess(videoPath, referenceText) {
  const baseName = path.basename(videoPath).replace(/\.[^/.]+$/, '');
  const workDir = path.join(process.cwd(), 'cut_work', baseName);
  const transcribeDir = path.join(workDir, '1_轉錄');
  const analysisDir = path.join(workDir, '2_分析');
  fs.mkdirSync(transcribeDir, { recursive: true });
  fs.mkdirSync(analysisDir, { recursive: true });

  // 前台貼的參考文稿 → 存成 reference.txt，後面 flag_against_reference.js 用它標「疑似聽錯」高亮
  if (referenceText && referenceText.trim()) {
    fs.writeFileSync(path.join(transcribeDir, 'reference.txt'), referenceText.trim(), 'utf8');
  }

  cutState = {
    running: true,
    step: '提取音頻',
    progress: 0,
    startTime: Date.now(),
    videoPath,
    workDir,
    subtitlesPath: path.join(transcribeDir, 'subtitles_words.json'),
    sentencesPath: path.join(transcribeDir, 'sentences.json'),
    autoSelectedPath: path.join(analysisDir, 'auto_selected.json'),
    outputPath: null,
    outputPathB: null,
    log: [],
    error: null
  };

  // 非同步執行（不阻塞事件迴圈，進度條才能即時更新）
  const { execFile } = require('child_process');
  const runCmd = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    if (opts.stdio === 'inherit') {
      if (child.stdout) child.stdout.pipe(process.stdout);
      if (child.stderr) child.stderr.pipe(process.stderr);
    }
  });

  (async () => {
    try {
      // Step 1: 提取音頻 (0-10%)
      cutState.step = '提取音頻';
      cutState.progress = 2;
      cutState.log.push('🎵 提取音頻...');
      const audioPath = path.join(transcribeDir, 'audio.mp3');
      if (!fs.existsSync(audioPath)) {
        // -ac 1 單聲道：openai/whisper 設定為單聲道，立體聲來源會被誤讀成兩倍長 → 轉錄全錯
        await runCmd('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'libmp3lame', '-q:a', '2', audioPath]);
      }
      cutState.progress = 10;

      // Step 2+3: BytePlus Seed Speech 一次出文字+字級時間碼 (10-65%)
      // --ddc off：要逐字原稿（含口水詞+時間碼），刪除全交給後面可審核的 pipeline 階段。
      // DDC(語義順滑)只刪口水詞、不刪重複句，實測 5 分鐘僅刪 1 個「嗯」，開了反而讓贅字失去時間碼、剪不掉。
      cutState.step = '語音轉錄';
      cutState.progress = 12;
      cutState.log.push('🎙️ BytePlus Seed Speech 轉錄（逐字，DDC off）...');
      if (!fs.existsSync(cutState.subtitlesPath)) {
        await runCmd('python', [path.join(SCRIPT_DIR, 'byteplus_transcribe.py'), 'audio.mp3', cutState.subtitlesPath, '--ddc', 'off'], {
          cwd: transcribeDir,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          timeout: 900000
        });
      }

      // Step 3.1: 套用常犯辨識錯字修正表（回饋迴路，不用講稿也生效）
      const corrTable = path.join(SCRIPT_DIR, '..', '用户习惯', '錯字修正表.json');
      if (fs.existsSync(corrTable)) {
        try {
          await runCmd('node', [path.join(SCRIPT_DIR, 'apply_corrections.js'), cutState.subtitlesPath, corrTable], {
            cwd: transcribeDir,
            env: { ...process.env },
            timeout: 60000
          });
        } catch (e) {
          cutState.log.push('⚠️ 套用錯字表失敗: ' + e.message);
        }
      }

      // Step 3.2: 有講稿就標出疑似聽錯（辨識 vs 講稿同音字）→ 審核介面黃底高亮，防「說 a 變 b 沒人發現」
      const refDoc = path.join(transcribeDir, 'reference.txt');
      if (fs.existsSync(refDoc)) {
        cutState.log.push('🔎 比對講稿，標記疑似聽錯...');
        try {
          await runCmd('node', [path.join(SCRIPT_DIR, 'flag_against_reference.js'), cutState.subtitlesPath, refDoc], {
            cwd: transcribeDir,
            env: { ...process.env },
            timeout: 120000
          });
        } catch (e) {
          cutState.log.push('⚠️ 講稿比對失敗（略過高亮）: ' + e.message);
        }
      }
      cutState.progress = 63;

      // Step 3.5: 抽聲學特徵（重複句「留講得圓滿那句」用，非無腦留後句）— 失敗不阻斷，退回留後句
      cutState.log.push('🔊 抽取聲學特徵（篤定度選 take）...');
      try {
        const featFile = path.join(transcribeDir, 'audio_features.json');
        if (!fs.existsSync(featFile)) {
          await runCmd('python', [path.join(SCRIPT_DIR, 'extract_audio_features.py'), 'audio.mp3', 'subtitles_words.json', 'audio_features.json'], {
            cwd: transcribeDir,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            timeout: 300000
          });
        }
      } catch (featErr) {
        cutState.log.push('⚠️ 聲學特徵抽取失敗（退回留後句）: ' + featErr.message);
      }
      cutState.progress = 65;

      // Step 4: AI 智慧分析（兩階段：潤飾 + 剪輯, 65-95%）
      cutState.step = 'AI 標記';
      cutState.progress = 68;
      const polishedPath = cutState.sentencesPath.replace(/\.json$/, '.polished.json');

      // 已有完整 AI 結果 → 直接跳過整段 AI 階段，**保留使用者已剪過的編輯**
      // 判斷標準：sentences.json 存在 + 至少有一個 aiDelete=true 的句子（代表 AI 真的跑過）
      let skipAI = false;
      if (fs.existsSync(cutState.sentencesPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(cutState.sentencesPath, 'utf8'));
          if (Array.isArray(existing) && existing.some(s => s.aiDelete === true)) {
            skipAI = true;
            const delCount = existing.filter(s => s.aiDelete).length;
            cutState.log.push(`♻️ 偵測到先前 AI 分析結果（${delCount} 句已標記），跳過 AI 重跑保留編輯`);
            cutState.log.push('  → 若想完整重跑 AI，請按介面上的「🔄 重新 AI 分析」按鈕');
            cutState.progress = 95;
          }
        } catch (_) { /* 解析失敗就視為沒有，照常跑 AI */ }
      }
      if (skipAI) { /* 跳過整段 AI block */ } else
      try {
        // 4a: 潤飾（加標點）— 用 haiku 省 token，純機械任務不需要 sonnet
        cutState.step = 'AI 標點';
        cutState.progress = 68;
        cutState.log.push('🖊️ [1/5] Claude AI 加標點中（haiku）...');
        await runCmd('node', [path.join(SCRIPT_DIR, 'ai_polish.js'), '--model', 'haiku', cutState.subtitlesPath, polishedPath], {
          timeout: 600000
        });
        cutState.progress = 75;

        // 4b: 剪輯判斷
        const serverConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '..', 'training_config.json'), 'utf8')); } catch(_) { return {}; } })();
        const usePairMode = serverConfig.use_pair_mode ?? false;
        if (usePairMode) {
          const cutInputPath  = polishedPath.replace(/\.json$/, '_cut_input.json');
          const outlinePath   = polishedPath.replace(/\.json$/, '_outline.json');

          // 4b-0: 意圖層（實驗 A）— 整集大綱
          cutState.step = 'AI 大綱';
          cutState.progress = 76;
          cutState.log.push('🗺️ [2/5] Claude 整集大綱分析中（Sonnet）...');
          try {
            await runCmd('node', [path.join(SCRIPT_DIR, 'ai_outline.js'), polishedPath, outlinePath], { timeout: 180000 });
            cutState.progress = 80;
          } catch (outlineErr) {
            cutState.log.push('⚠️ 意圖層分析失敗（繼續執行）: ' + outlineErr.message);
          }

          // 4b-1: 規則前置過濾（不算 AI step，吞在「AI 候選對」階段內顯示）
          cutState.step = 'AI 候選對';
          cutState.progress = 81;
          cutState.log.push('🔍 [3/5a] 規則前置過濾（adjacent_repeat / take_group / silence / 幻覺）...');
          const prefilterArgs = [path.join(SCRIPT_DIR, 'phrase_prefilter.js'), polishedPath, cutInputPath];
          if (fs.existsSync(outlinePath))              prefilterArgs.push('--outline-file', outlinePath);
          if (cutState.subtitlesPath && fs.existsSync(cutState.subtitlesPath))
                                                       prefilterArgs.push('--words-file', cutState.subtitlesPath);
          const featFile1 = path.join(transcribeDir, 'audio_features.json');
          if (fs.existsSync(featFile1))                prefilterArgs.push('--audio-features', featFile1);
          await runCmd('node', prefilterArgs, { timeout: 120000 });
          cutState.progress = 83;

          // 4b-2: AI 候選對判斷
          cutState.log.push('✂️ [3/5b] Claude 候選對 AI 判斷中（Sonnet）...');
          const pairsArgs = [path.join(SCRIPT_DIR, 'ai_cut_pairs.js'), cutInputPath, cutState.sentencesPath];
          if (fs.existsSync(outlinePath)) pairsArgs.push('--outline-file', outlinePath);
          await runCmd('node', pairsArgs, { timeout: 600000 });
          cutState.progress = 86;

          // 4b-3: 整稿潤稿 reviewer（Sonnet 看完整粗剪稿）
          cutState.step = 'AI 潤稿';
          cutState.progress = 87;
          cutState.log.push('🪄 [4/5] Claude reviewer 整稿潤稿中（Sonnet）...');
          try {
            const reviewerArgs = [
              path.join(SCRIPT_DIR, 'ai_polish_review.js'),
              '--pass', 'review',
              '--model', 'sonnet',
              cutState.sentencesPath,
            ];
            if (fs.existsSync(outlinePath)) reviewerArgs.push('--outline-file', outlinePath);
            await runCmd('node', reviewerArgs, { timeout: 600000 });
            cutState.progress = 90;
          } catch (revErr) {
            cutState.log.push('⚠️ reviewer 失敗（不阻塞，繼續）: ' + revErr.message);
          }

          // 4b-4: 整稿審核 audit（Sonnet 嚴格二讀）
          cutState.step = 'AI 二讀';
          cutState.progress = 91;
          cutState.log.push('🔍 [5/5] Claude audit 嚴格二讀中（Sonnet）...');
          try {
            const auditArgs = [
              path.join(SCRIPT_DIR, 'ai_polish_review.js'),
              '--pass', 'audit',
              '--model', 'sonnet',
              cutState.sentencesPath,
            ];
            if (fs.existsSync(outlinePath)) auditArgs.push('--outline-file', outlinePath);
            await runCmd('node', auditArgs, { timeout: 600000 });
            cutState.progress = 93;
          } catch (audErr) {
            cutState.log.push('⚠️ audit 失敗（不阻塞，繼續）: ' + audErr.message);
          }

          // 4b-5: 句中雜音清理（嗯/呃/欸這類）— 極快、無 AI、保守
          cutState.log.push('📐 [後處理] 句中 filler 清理...');
          try {
            await runCmd('node', [path.join(SCRIPT_DIR, 'inline_filler_trim.js'),
                                  cutState.sentencesPath, cutState.subtitlesPath],
                         { timeout: 30000 });
          } catch (fillerErr) {
            cutState.log.push('⚠️ inline filler 失敗（不阻塞）: ' + fillerErr.message);
          }
        } else {
          cutState.log.push('✂️ [2/2] Claude AI 剪輯判斷中（重錄/語氣詞/停頓）...');
          await runCmd('node', [path.join(SCRIPT_DIR, 'ai_cut.js'), polishedPath, cutState.sentencesPath], { timeout: 600000 });
        }

        // 驗證 AI 分析結果
        if (fs.existsSync(cutState.sentencesPath)) {
          const sentData = JSON.parse(fs.readFileSync(cutState.sentencesPath, 'utf8'));
          const hasAI = sentData.some(s => s.displayText || s.aiDelete);
          if (hasAI) {
            cutState.log.push('✅ AI 分析完成（兩階段）');
          } else {
            cutState.log.push('⚠️ AI 分析完成但未生效（缺少標點和刪除標記），可嘗試「重新 AI 分析」');
          }
        } else {
          cutState.log.push('⚠️ AI 分析未產生輸出');
        }
        cutState.progress = 95;
      } catch (aiErr) {
        cutState.log.push('⚠️ AI 分析失敗: ' + aiErr.message);
        cutState.log.push('💡 可在頁面上點擊「重新 AI 分析」按鈕重試');
      }

      // 句級 sentences.json → 字級 2_分析/auto_selected.json（審核頁與匯出實際讀這個）
      const autoRes = writeAutoSelectedFromSentences(workDir);
      if (autoRes) {
        cutState.log.push(`🏷️ 已產出刪除標記 ${autoRes.indices.length} 字 / ${Object.keys(autoRes.reasons).length} 段（auto_selected.json）`);
      } else {
        cutState.log.push('⚠️ 未產出 auto_selected.json（AI 無刪除標記或缺檔），審核頁將無預選');
      }

      // 背景備妥苦工件（靜音/RMS/咳嗽 ML）→ 審核完匯出時 buildRefined 就吃得到；咳嗽偵測較慢故不阻塞「完成」。
      // idempotent：prepareArtifacts 會跳過已存在的檔。缺了也只是匯出時降級不套咳嗽/吸附，不影響審核。
      cutState.log.push('🔧 背景偵測靜音/咳嗽（匯出時會用到，不影響現在審核）...');
      try {
        prepareArtifacts(workDir, cutState.subtitlesPath, path.join(transcribeDir, 'audio.mp3'), analysisDir, (art) => {
          if (art && art.ok) {
            console.log(`🔧 [${baseName}] 苦工件就緒（silences/rms/cough）`);
            // 咳嗽偵測比 AI 分析晚完成 → 就緒後刷新預選，審核頁重載就看得到咳嗽標記
            try { writeAutoSelectedFromSentences(workDir); } catch (_) {}
          }
        });
      } catch (_) {}

      cutState.step = '完成';
      cutState.progress = 100;
      cutState.log.push('✅ 處理完成，請審核刪除標記');
      cutState.running = false;
    } catch (err) {
      cutState.error = err.message;
      cutState.step = '失敗';
      cutState.log.push('❌ ' + err.message);
      cutState.running = false;
    }
  })();
}

// ── 批次處理佇列 ──
const BATCH_QUEUE_FILE = path.join(SCRIPT_DIR, 'batch_queue.json');

let batchState = {
  running: false,
  currentIndex: -1,
  items: [],       // { id, videoPath, status, startedAt, completedAt, error }
  log: [],
};


// 恢復佇列（重新啟動伺服器時讀取）
try {
  if (fs.existsSync(BATCH_QUEUE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(BATCH_QUEUE_FILE, 'utf8'));
    if (saved.items && Array.isArray(saved.items)) {
      // 重置 running 狀態（重啟後還原成 pending / error）
      saved.items.forEach(item => { if (item.status === 'running') item.status = 'interrupted'; });
      batchState.items = saved.items;
      batchState.log   = (saved.log || []).slice(-50);
    }
  }
} catch (_) {}




const server = http.createServer((req, res) => {
  // 安全（audit P2#8）：不送 CORS header（同源頁面不需要，送 * 等於把 API 開放給任何網頁）。
  // Host 檢查擋 DNS rebinding：惡意網頁把自己網域 rebind 到 127.0.0.1 就能繞過同源限制，
  // 但它的 Host header 不會是 localhost。
  const reqHost = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (reqHost !== 'localhost' && reqHost !== '127.0.0.1' && reqHost !== '[::1]') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ────────────────────────────────────────────────
  // 批次審核相關路由（獨立區塊，便於後續維護）
  // ────────────────────────────────────────────────

  // GET /api/native-browse — 跳出 Windows 原生選檔視窗，回傳選到的影片路徑
  if (req.method === 'GET' && req.url === '/api/native-browse') {
    const { execFile } = require('child_process');
    // 指定初始目錄到本機的 cut_work（挑片的地方），讓對話框直接開在本機快速路徑，
    // 避免預設去枚舉「最近/網路位置」而卡十幾二十秒。找不到就退回 cwd。
    // 註：不設 AutoUpgradeEnabled=$false，保留現代 Explorer 風格對話框（速度靠 InitialDirectory）。
    let initDir = path.join(process.cwd(), 'cut_work');
    if (!fs.existsSync(initDir)) initDir = process.cwd();
    const initDirPs = initDir.replace(/'/g, "''"); // PS 單引號字串內的單引號要 double
    const ps = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.OpenFileDialog; $f.Title='Select video'; $f.InitialDirectory='" + initDirPs + "'; $f.RestoreDirectory=$true; $f.Filter='Video|*.mp4;*.mov;*.mkv;*.avi;*.flv;*.webm;*.m4v|All files|*.*'; if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Out.Write($f.FileName) }";
    execFile('powershell', ['-STA', '-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ path: (stdout || '').trim() }));
    });
    return;
  }


  // GET /review/<videoName> — 動態產生並回傳該影片的 review.html
  if (req.method === 'GET' && req.url.startsWith('/review/')) {
    try {
      const videoName = decodeURIComponent(req.url.replace('/review/', '').split('?')[0]);
      if (!videoName) {
        res.writeHead(400); res.end('缺少影片名稱'); return;
      }
      const ctx = findVideoForName(videoName);
      if (!ctx) {
        res.writeHead(404); res.end('找不到影片：' + videoName); return;
      }
      const subsPath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
      const autoPath = path.join(ctx.workDir, '2_分析', 'auto_selected.json');
      if (!fs.existsSync(subsPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('該影片尚未產出字幕檔（subtitles_words.json）');
        return;
      }
      const words = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
      // auto_selected.json 不存在或過期（上游 sentences/cough_ml/字幕比它新）→ 即時重產。
      // 修兩件事：「AI 跑了但審核頁零標記」＋「咳嗽/重錄偵測晚於分析完成，舊頁面看不到新預選」。
      try {
        const _mt = p => { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } };
        const autoM = _mt(autoPath);
        const upstream = Math.max(
          _mt(path.join(ctx.workDir, '1_轉錄', 'sentences.json')),
          _mt(path.join(ctx.workDir, '2_分析', 'cough_ml.json')),
          _mt(path.join(ctx.workDir, '2_分析', 'semantic_pairs.json')),
          _mt(subsPath));
        if (!autoM || autoM < upstream) writeAutoSelectedFromSentences(ctx.workDir);
      } catch (_) {}
      let autoSelected = [], autoReasons = {}, autoPairs = {};
      if (fs.existsSync(autoPath)) {
        const raw = JSON.parse(fs.readFileSync(autoPath, 'utf8'));
        const parsed = parseAutoSelected(raw);
        autoSelected = parsed.autoSelected;
        autoReasons = parsed.autoReasons;
        if (raw && raw.pairs) autoPairs = raw.pairs; // rangeKey → 保留 take 時間段（對照高亮）
      }
      const enc = encodeURIComponent(videoName);
      const html = buildReviewDoc(words, autoSelected, autoReasons, {
        cutApiPath: `/api/cut/${enc}`,
        silenceRemovalSec: estimateSilenceRemovalSec(ctx.workDir, words, autoSelected),
        pairs: autoPairs,
        audioUrl: fs.existsSync(path.join(ctx.workDir, '1_轉錄', 'audio.mp3')) ? `/review-audio/${enc}` : '',
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('產生審核頁失敗：' + err.message);
    }
    return;
  }


  // GET /review-audio/<videoName> — 審核頁段落試聽用音訊（支援 Range，<audio> seek 需要）。
  // 只服務工作目錄內的 audio.mp3（固定路徑組合，無使用者輸入路徑 → 無穿越面）。
  if (req.method === 'GET' && req.url.startsWith('/review-audio/')) {
    try {
      const nm = decodeURIComponent(req.url.replace('/review-audio/', '').split('?')[0]);
      const ctx = findVideoForName(nm);
      const audioPath = ctx && path.join(ctx.workDir, '1_轉錄', 'audio.mp3');
      if (!audioPath || !fs.existsSync(audioPath)) { res.writeHead(404); res.end('no audio'); return; }
      const stat = fs.statSync(audioPath);
      if (req.headers.range) {
        const m = req.headers.range.replace('bytes=', '').split('-');
        const start = parseInt(m[0], 10) || 0;
        const end = m[1] ? parseInt(m[1], 10) : stat.size - 1;
        res.writeHead(206, {
          'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1,
        });
        fs.createReadStream(audioPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(audioPath).pipe(res);
      }
    } catch (err) { res.writeHead(500); res.end(err.message); }
    return;
  }

  // POST /api/seam-coldread/<videoName> — 接縫冷讀（審核頁按需觸發）
  // 收前端「當前保留狀態」（deletedIndices＝目前勾選要刪的字），把保留稿串起丟 Claude 冷讀，
  // 回傳接縫疑慮清單給前端當黃色波浪線覆蓋層。純建議：不寫回 auto_selected（避免被 mtime 重產
  // 覆蓋，也不會誤導 WYSIWYG 匯出）；只落一份 seam_coldread.json 供診斷。
  if (req.method === 'POST' && req.url.startsWith('/api/seam-coldread/')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const videoName = decodeURIComponent(req.url.replace('/api/seam-coldread/', '').split('?')[0]);
        const ctx = findVideoForName(videoName);
        if (!ctx) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '影片未註冊：' + videoName })); return; }
        const cfg = readTrainingConfig().seam_coldread || {};
        if (cfg.enabled === false) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ seams: [], meta: { disabled: true } })); return; }
        const subsPath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
        if (!fs.existsSync(subsPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺字幕檔' })); return; }
        const parsed = JSON.parse(body || '{}');
        const deletedIndices = Array.isArray(parsed) ? parsed : (parsed.deletedIndices || parsed.indices || []);
        const analysisDir = path.join(ctx.workDir, '2_分析');
        fs.mkdirSync(analysisDir, { recursive: true });
        const inputPath = path.join(analysisDir, 'seam_input.json');
        fs.writeFileSync(inputPath, JSON.stringify(deletedIndices));
        const args = [path.join(SCRIPT_DIR, 'seam_coldread.js'), subsPath, inputPath, '--json', '--model', String(cfg.model || 'sonnet')];
        if (cfg.min_seam_sec != null) args.push('--min-sec', String(cfg.min_seam_sec));
        if (cfg.min_seam_chars != null) args.push('--min-chars', String(cfg.min_seam_chars));
        console.log(`🔍 [${videoName}] 接縫冷讀（保留字 ${deletedIndices.length} 刪，Claude ${cfg.model || 'sonnet'}）...`);
        const { execFile } = require('child_process');
        execFile('node', args, { maxBuffer: 20 * 1024 * 1024, timeout: 320000, env: { ...process.env } }, (err, stdout) => {
          let out = null;
          try { out = JSON.parse(stdout); } catch (_) {}
          if (err && !out) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ seams: [], meta: { error: (err.message || '').split('\n')[0] } }));
            return;
          }
          out = out || { seams: [], meta: {} };
          try { fs.writeFileSync(path.join(analysisDir, 'seam_coldread.json'), JSON.stringify(out, null, 2)); } catch (_) {}
          console.log(`🔍 [${videoName}] 接縫冷讀完成：接縫 ${(out.meta || {}).totalSeams || 0}、疑慮 ${(out.seams || []).length}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /api/cut/<videoName> — 對指定影片執行剪輯
  if (req.method === 'POST' && req.url.startsWith('/api/cut/')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        // 並發防護：一次只允許一個匯出（兩個分頁/連按兩次會寫同一輸出檔，成品損壞）
        if (exportState.running) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `已有匯出進行中（${exportState.videoName}），請等它完成` }));
          return;
        }
        const videoName = decodeURIComponent(req.url.replace('/api/cut/', '').split('?')[0]);
        const ctx = findVideoForName(videoName);
        if (!ctx) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '影片未註冊：' + videoName }));
          return;
        }
        if (!ctx.videoPath || !fs.existsSync(ctx.videoPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到原始影片檔' }));
          return;
        }

        const parsed = JSON.parse(body || '{}');
        let deleteList, exportOptions, deletedIndices = null;
        if (Array.isArray(parsed)) {
          deleteList = parsed; exportOptions = {};
        } else {
          deleteList = parsed.deleteList || parsed.segments || [];
          exportOptions = parsed.exportOptions || {};
          if (Array.isArray(parsed.deletedIndices)) deletedIndices = parsed.deletedIndices;
        }

        // 審核頁的字級刪除選集 → 落檔，供 SRT/TXT 用「index 選字」對齊審核頁文稿（避免時間重疊 >50%
        // 反推在重錄 take 密集處翻掉短邊界字：多一個「長」、掉一個「病」）。沒帶就退回舊發音區判斷。
        let deleteIndicesFile = null;
        if (deletedIndices && deletedIndices.length) {
          try {
            deleteIndicesFile = path.join(ctx.workDir, 'delete_indices.json');
            fs.writeFileSync(deleteIndicesFile, JSON.stringify(deletedIndices));
          } catch (e) { console.warn(`[${videoName}] delete_indices 落檔失敗(SRT/TXT 退回發音區判斷):`, (e.message || '').split('\n')[0]); deleteIndicesFile = null; }
        }

        // WYSIWYG：不再在匯出端併入重錄/咳嗽——它們已由 autoContentPreselect 進審核頁預選，
        // 使用者看到並核可的 deleteList 就是最終內容決策（refine 只做壓平/吸附等苦工）。

        // 審稿記分卡：diff「AI 預選 vs 使用者最終勾選」按偵測器記帳（橋接前的原始勾選，
        // 取消勾選＝該偵測器誤刪、手動補刪＝整體漏刪）。純記帳不影響匯出，失敗靜默。
        // 看報表：node review_scorecard.js --report
        try {
          const _scSubs = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
          const _scAuto = path.join(ctx.workDir, '2_分析', 'auto_selected.json');
          if (fs.existsSync(_scSubs) && fs.existsSync(_scAuto)) {
            const _scWords = JSON.parse(fs.readFileSync(_scSubs, 'utf8'));
            const _scParsed = parseAutoSelected(JSON.parse(fs.readFileSync(_scAuto, 'utf8')));
            const { buildScorecard, appendScorecard } = require('./review_scorecard');
            const card = buildScorecard(_scWords, _scParsed.autoSelected, _scParsed.autoReasons, deleteList);
            appendScorecard(videoName, ctx.workDir, card);
            const rej = Object.values(card.categories).reduce((t, c) => t + c.rejected, 0);
            console.log(`📊 [${videoName}] 記分卡：退回 ${rej} 字、手動補刪 ${card.missed.words} 字（${card.missed.sec}s）`);
          }
        } catch (e) { console.warn(`[${videoName}] 記分卡失敗(略過):`, (e.message || '').split('\n')[0]); }

        // 梳齒橋接（audit #4）：審核頁 gap 元素不可選，逐字手動刪除會在字間留 0.2~0.3s 殘 gap，
        // 剪完首尾相接串成死空氣。相鄰刪除段之間只剩 gap/靜音（無發音字）→ 併成一段。失敗降級原清單。
        try {
          const _bridgeSubs = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
          if (deleteList.length >= 2 && fs.existsSync(_bridgeSubs)) {
            const bridgeGapDeletes = require(path.join(SCRIPT_DIR, 'bridge_gap_deletes.js'));
            const bridged = bridgeGapDeletes(deleteList, JSON.parse(fs.readFileSync(_bridgeSubs, 'utf8')));
            if (bridged.length < deleteList.length) console.log(`🌉 [${videoName}] gap 橋接：${deleteList.length} 段 → ${bridged.length} 段`);
            deleteList = bridged;
          }
        } catch (e) { console.warn(`[${videoName}] gap 橋接失敗，使用原始清單:`, (e.message || '').split('\n')[0]); }

        // 將 delete_segments.json 寫進該影片的工作目錄
        const deleteSegmentsPath = path.join(ctx.workDir, 'delete_segments.json');
        fs.writeFileSync(deleteSegmentsPath, JSON.stringify(deleteList, null, 2));
        console.log(`📝 [${videoName}] 保存 ${deleteList.length} 個刪除片段`);

        // ── 套用苦工層精修（停頓壓平/切點吸附/咳嗽）→ 與初始自動剪同一套，讓「審核後匯出」也吃到 pause_flatten ──
        // 重點：pause_flatten 只信「音訊實測靜音」(silences.json)，缺檔就現場用 detect_silences.js 補產；
        // 絕不退回 STT gap 亂壓（STT 字間隔看不到真實停頓，會誤砍一大段）。任何一步失敗 → 降級用原始切點，不擋出片。
        const _subsPath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
        const _audioPath = path.join(ctx.workDir, '1_轉錄', 'audio.mp3');
        const _analysisDir = path.join(ctx.workDir, '2_分析');
        const _art = {
          rms: path.join(_analysisDir, 'audio_rms.json'),
          sil: path.join(_analysisDir, 'silences.json'),
          cough: path.join(_analysisDir, 'cough_ml.json'),
          ok: fs.existsSync(_audioPath) && fs.existsSync(_subsPath),
        };
        let cutDeleteFile = deleteSegmentsPath;
        if (_art.ok) {
          try {
            fs.mkdirSync(_analysisDir, { recursive: true });
            if (!fs.existsSync(_art.sil))
              require('child_process').execFileSync('node', [path.join(SCRIPT_DIR, 'detect_silences.js'), _audioPath, _art.sil], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
          } catch (e) { console.warn(`[${videoName}] detect_silences 失敗，匯出不套停頓壓平:`, (e.message || '').split('\n')[0]); }
          // 只有拿到「非空的音訊實測靜音」才套精修；否則維持原始切點（不讓 refine 內部退回 STT gap）
          let hasAudioSil = false;
          try { const _s = JSON.parse(fs.readFileSync(_art.sil, 'utf8')); hasAudioSil = (Array.isArray(_s) ? _s : (_s.silences || [])).length > 0; } catch (_) {}
          if (hasAudioSil) {
            const _refined = buildRefined(_subsPath, deleteList, _art, ctx.workDir, 'delete_segments.refined.json');
            if (_refined) { cutDeleteFile = _refined; console.log(`✨ [${videoName}] 已套用停頓壓平/切點吸附/咳嗽（匯出用 refined）`); }
          } else {
            console.log(`ℹ️ [${videoName}] 無音訊實測靜音，匯出維持原始切點（不套停頓壓平）`);
          }
        }

        // ── 剪映草稿匯出（真無損）：不跑 ffmpeg，生成剪映草稿引用原片＋剪點，SRT 掛字幕軌 ──
        // 使用者成品本來就要進剪映後製 → 草稿路徑零重編碼、秒級完成、剪點還能微調。
        if (exportOptions.jianying) {
          const jyName = String(exportOptions.exportName || '').replace(/[\\/:*?"<>|]/g, '').trim()
            || `${path.basename(ctx.videoPath).replace(/\.[^/.]+$/, '')}_剪`;
          exportState = { running: true, progress: 10, step: '生成剪映草稿', videoName, result: null, error: null };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          try {
            // 最終刪除清單（與 ffmpeg 落刀同一套 MERGE_GAP 合併）→ 取補集＝保留段
            const { mergeDeleteSegments } = require('./merge_delete_segments');
            const delRaw = JSON.parse(fs.readFileSync(cutDeleteFile, 'utf8'));
            const merged = mergeDeleteSegments(Array.isArray(delRaw) ? delRaw : (delRaw.segments || []));
            const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
              '-show_entries', 'stream=width,height,r_frame_rate', '-show_entries', 'format=duration',
              '-of', 'json', 'file:' + ctx.videoPath], { encoding: 'utf8' });
            const pj = JSON.parse(probe);
            const vDur = parseFloat(pj.format.duration);
            const vs = (pj.streams && pj.streams[0]) || {};
            const fr = String(vs.r_frame_rate || '30/1').split('/');
            const fps = Math.round((+fr[0] / (+fr[1] || 1)) || 30);
            // 補集＝保留段；一律夾在 [0, vDur] 內（刪除清單若超出素材時長，剪映會拒收超界段）
            const keeps = [];
            let cur = 0;
            for (const s of merged) {
              if (cur >= vDur - 0.01) break;
              if (s.start > cur + 0.01) keeps.push({ start: cur, end: Math.min(s.start, vDur) });
              cur = Math.max(cur, s.end);
            }
            if (vDur > cur + 0.01) keeps.push({ start: cur, end: vDur });
            for (const k of keeps) k.end = Math.min(k.end, vDur);
            const keepsFile = path.join(ctx.workDir, 'jianying_keeps.json');
            fs.writeFileSync(keepsFile, JSON.stringify(keeps, null, 2));
            // SRT：理想時間軸（無 timeline_map），與草稿逐段拼接的時間軸完全一致
            exportState.step = '產字幕'; exportState.progress = 40;
            let jySrt = '';
            try {
              const srtScript = path.join(SCRIPT_DIR, 'generate_cut_srt.js');
              const subsP = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
              jySrt = path.join(ctx.workDir, 'jianying_draft.srt');
              execFileSync('node', [srtScript, subsP, cutDeleteFile, jySrt, '--silences', _art.sil,
                ...(deleteIndicesFile ? ['--delete-indices', deleteIndicesFile] : [])], { stdio: 'pipe' });
            } catch (e) { console.warn(`[${videoName}] 草稿 SRT 失敗(草稿仍出、無字幕軌):`, (e.message || '').split('\n')[0]); jySrt = ''; }
            exportState.step = '寫入剪映草稿'; exportState.progress = 70;
            const jyCfg = (readTrainingConfig().jianying) || {};
            const pyArgs = [path.join(SCRIPT_DIR, 'export_jianying_draft.py'),
              '--video', ctx.videoPath, '--keeps', keepsFile, '--name', jyName,
              '--width', String(vs.width || 1920), '--height', String(vs.height || 1080), '--fps', String(fps)];
            if (jySrt && fs.existsSync(jySrt)) pyArgs.push('--srt', jySrt);
            if (jyCfg.draft_folder) pyArgs.push('--draft-folder', jyCfg.draft_folder);
            const out = execFileSync('python', pyArgs, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
            const jr = JSON.parse(out.trim().split(/\r?\n/).pop());
            if (!jr.ok) throw new Error(jr.error || '草稿生成失敗');
            exportState.result = {
              output: jr.draftPath, jianying: true, segments: jr.segments,
              originalDuration: vDur.toFixed(1), newDuration: (jr.durationSec || 0).toFixed(1),
              srt: jySrt || null, txt: null,
            };
            exportState.step = '完成'; exportState.progress = 100; exportState.running = false;
            console.log(`🎬 [${videoName}] 剪映草稿完成 → ${jr.draftPath}（${jr.segments} 段）`);
          } catch (err) {
            const msg = (err.stdout || '') + (err.message || '');
            let clean = msg;
            try { const j = JSON.parse(String(err.stdout || '').trim().split(/\r?\n/).pop()); if (j && j.error) clean = j.error; } catch (_) {}
            exportState.error = '剪映草稿失敗：' + clean.slice(0, 300);
            exportState.running = false; exportState.progress = 100;
            console.error(`❌ [${videoName}] 剪映草稿失敗:`, clean.split('\n')[0]);
          }
          return;
        }

        const container = (exportOptions.container || 'mp4').toLowerCase();
        const mainExt = exportOptions.audioOnly ? 'mp3' : container;
        const baseName = path.basename(ctx.videoPath).replace(/\.[^/.]+$/, '');
        // 成品名稱：使用者取名（濾掉路徑分隔與 Windows 非法字元），留空＝<影片名>_cut
        const exportName = String(exportOptions.exportName || '').replace(/[\\/:*?"<>|]/g, '').trim() || `${baseName}_cut`;
        // 輸出資料夾：使用者指定且存在則用之，否則預設影片工作目錄；
        // 一律在其下建「成品名稱」同名子資料夾，mp4/srt/txt/timeline_map 收攏一起，不再散一地
        let outBase = ctx.workDir;
        if (exportOptions.outputDir && typeof exportOptions.outputDir === 'string') {
          const od = exportOptions.outputDir.trim();
          try { if (od && fs.existsSync(od) && fs.statSync(od).isDirectory()) outBase = od; } catch (_) {}
        }
        const outDir = path.join(outBase, exportName);
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
        const shellOutputFile = path.join(outDir, `${exportName}.${container}`);
        const finalOutputFile = path.join(outDir, `${exportName}.${mainExt}`);

        const env = {
          ...process.env,
          CUT_CODEC: exportOptions.codec || '',
          CUT_RESOLUTION: exportOptions.resolution || '',
          CUT_BITRATE_MODE: exportOptions.bitrate || 'recommended',
          CUT_FPS: exportOptions.fps || '',
          CUT_CONTAINER: container,
          CUT_AUDIO_ONLY: exportOptions.audioOnly ? '1' : '0',
          CUT_EXPORT_GIF: exportOptions.gif ? '1' : '0',
          CUT_LOSSLESS: exportOptions.lossless ? '1' : '0',  // 原畫質：影片 CRF17 近無損 + 音訊複製(真無損)
        };
        console.log(`🎬 [${videoName}] 匯出 → ${outDir}`, { container, audioOnly: env.CUT_AUDIO_ONLY === '1', lossless: env.CUT_LOSSLESS === '1' });

        const scriptPath = path.join(SCRIPT_DIR, 'cut_video.sh');
        // Windows 用 Git Bash 全路徑，避免 PATH 上的 bash 解析成 WSL bash（吃不了 C:/ 路徑會直接失敗）
        const bashBin = resolveBashBin();

        // ── 非同步落刀：串流 stdout 解析 PROGRESS=N/TOTAL → exportState.progress，前端輪詢 /api/export-status ──
        exportState = { running: true, progress: 2, step: '準備', videoName, result: null, error: null };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        const child = spawn(bashBin, [
          scriptPath.replace(/\\/g, '/'),
          ctx.videoPath.replace(/\\/g, '/'),
          cutDeleteFile.replace(/\\/g, '/'),   // refined（含停頓壓平）或降級回原始切點
          shellOutputFile.replace(/\\/g, '/'),
        ], { cwd: outDir, env });
        exportState.step = '剪輯中';
        let cutErr = '';
        // 開跑前就算好預估輸出長度（原片長 − refined 刪除總長），供單趟路徑用 ffmpeg time= 換算百分比。
        // 不靠 stdout 的「预计输出时长」——那行 pipe 下 block-buffered，會到結束才 flush。
        let expDur = 0;
        try {
          const origDur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'file:' + ctx.videoPath], { encoding: 'utf8' }).trim()) || 0;
          let delSum = 0;
          try { const _dl = JSON.parse(fs.readFileSync(cutDeleteFile, 'utf8')); const _arr = Array.isArray(_dl) ? _dl : (_dl.segments || _dl.deleteList || []); for (const s of _arr) delSum += Math.max(0, (s.end - s.start)); } catch (_) {}
          expDur = Math.max(0, origDur - delSum);
        } catch (_) {}
        child.stdout.on('data', chunk => {
          const text = chunk.toString();
          process.stdout.write(text);
          for (const ln of text.split(/[\r\n]+/)) {
            const m = ln.match(/PROGRESS=(\d+)\/(\d+)/); // 多段平行路徑
            if (m && +m[2] > 0) { exportState.progress = Math.min(92, 5 + Math.floor((+m[1] / +m[2]) * 85)); exportState.step = `剪輯片段 ${m[1]}/${m[2]}`; }
          }
        });
        child.stderr.on('data', c => {
          const text = c.toString();
          cutErr += text; process.stderr.write(c);
          // 單趟重編碼路徑：ffmpeg 進度(time=)寫在 stderr，用「预计输出时长」換算百分比
          if (expDur > 0) {
            const t = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
            if (t && t.length) {
              const last = t[t.length - 1].match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
              const sec = (+last[1]) * 3600 + (+last[2]) * 60 + parseFloat(last[3]);
              exportState.progress = Math.min(92, 5 + Math.floor((sec / expDur) * 85));
              exportState.step = '編碼中';
            }
          }
        });
        child.on('error', e => { exportState.error = 'cut_video.sh 啟動失敗：' + e.message; exportState.running = false; exportState.progress = 100; });
        child.on('close', code => {
          try {
            if (code !== 0) { exportState.error = (cutErr.slice(-300) || ('exit ' + code)); exportState.running = false; exportState.progress = 100; return; }
            const outputFile = fs.existsSync(finalOutputFile) ? finalOutputFile : shellOutputFile;
            exportState.step = '產字幕/驗證'; exportState.progress = 94;
            // 自動產出 SRT 字幕（音訊匯出模式不產 SRT）
            let srtFile = null;
            if (!exportOptions.audioOnly) {
              try {
                const srtScript = path.join(SCRIPT_DIR, 'generate_cut_srt.js');
                const subtitlesPath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
                srtFile = outputFile.replace(/\.[^/.]+$/, '.srt');
                if (fs.existsSync(srtScript) && fs.existsSync(subtitlesPath))
                  execFileSync('node', [srtScript, subtitlesPath, cutDeleteFile, srtFile, '--silences', _art.sil,
                    ...(deleteIndicesFile ? ['--delete-indices', deleteIndicesFile] : [])], { stdio: 'pipe' });
              } catch (srtErr) { console.error(`⚠️ [${videoName}] SRT 失敗:`, srtErr.message); srtFile = null; }
            }
            // 純文字文稿 TXT（依標點分段，跟審核頁文稿一致；音檔匯出也產，文稿一樣有用）
            let txtFile = null;
            try {
              const txtScript = path.join(SCRIPT_DIR, 'generate_cut_txt.js');
              const subtitlesPath = path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json');
              txtFile = outputFile.replace(/\.[^/.]+$/, '.txt');
              if (fs.existsSync(txtScript) && fs.existsSync(subtitlesPath))
                execFileSync('node', [txtScript, subtitlesPath, cutDeleteFile, txtFile,
                  ...(deleteIndicesFile ? ['--delete-indices', deleteIndicesFile] : [])], { stdio: 'pipe' });
            } catch (txtErr) { console.error(`⚠️ [${videoName}] TXT 失敗:`, txtErr.message); txtFile = null; }
            const originalDuration = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'file:' + ctx.videoPath], { encoding: 'utf8' }).trim());
            const newDuration = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'file:' + outputFile], { encoding: 'utf8' }).trim());
            const deletedDuration = originalDuration - newDuration;
            // 逐字對帳：SRT 文字 vs 保留字（同一份 subtitles/刪除檔/靜音），一字之差 = FAIL
            const verify = runVerify(outputFile, ctx.videoPath, cutDeleteFile, `[${videoName}] `, {
              srt: srtFile,
              subtitles: path.join(ctx.workDir, '1_轉錄', 'subtitles_words.json'),
              silences: _art.sil,
            });
            exportState.result = {
              output: outputFile, srt: srtFile, txt: txtFile,
              originalDuration: originalDuration.toFixed(2), newDuration: newDuration.toFixed(2),
              deletedDuration: deletedDuration.toFixed(2),
              savedPercent: ((deletedDuration / originalDuration) * 100).toFixed(1),
              verify,
            };
            exportState.step = '完成'; exportState.progress = 100; exportState.running = false;
            console.log(`✅ [${videoName}] 匯出完成 → ${outputFile}`);
          } catch (e) {
            exportState.error = e.message; exportState.running = false; exportState.progress = 100;
          }
        });
      } catch (err) {
        console.error('❌ /api/cut/<name> 失敗:', err.message);
        exportState = { running: false, progress: 100, step: '', videoName: '', result: null, error: err.message };
        if (!res.headersSent) { // 若已回 {ok:true}（非同步落刀階段）就不再重複回應
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      }
    });
    return;
  }

  // GET /api/export-status — 審核頁匯出進度輪詢
  if (req.method === 'GET' && req.url === '/api/export-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(exportState));
    return;
  }

  // GET /api/native-browse-folder — 跳出 Windows 原生選資料夾視窗，回傳選到的資料夾
  if (req.method === 'GET' && req.url === '/api/native-browse-folder') {
    const { execFile } = require('child_process');
    let initDir = path.join(process.cwd(), 'output');
    if (!fs.existsSync(initDir)) initDir = process.cwd();
    const initDirPs = initDir.replace(/'/g, "''");
    // OpenFileDialog + ValidateNames=false = 檔案總管式介面選資料夾（FolderBrowserDialog 是老樹狀 UI，難用）：
    // 使用者走進目標資料夾按「開啟」，取 FileName 的 dirname 當結果
    const ps = "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.OpenFileDialog; $f.Title='走進要匯出的資料夾後按「開啟」'; $f.InitialDirectory='" + initDirPs + "'; $f.ValidateNames=$false; $f.CheckFileExists=$false; $f.CheckPathExists=$true; $f.FileName='選擇此資料夾'; if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Out.Write([System.IO.Path]::GetDirectoryName($f.FileName)) }";
    execFile('powershell', ['-STA', '-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ path: (stdout || '').trim() }));
    });
    return;
  }


  // ── 首頁：直接給剪輯影片頁（不再用雙卡片選擇頁；訓練頁仍可從 /train 進） ──
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CUT_DOC_HTML);
    return;
  }


  // ── 剪輯介面 ──
  if (req.url === '/cut' || req.url === '/cut.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CUT_DOC_HTML);
    return;
  }


  // ── API: 拖放上傳影片（瀏覽器拿不到本機路徑，只能收位元組 → 存 cut_work/_uploads/）──
  if (req.method === 'POST' && req.url.startsWith('/api/upload-video')) {
    try {
      const q = new URL(req.url, 'http://localhost');
      const rawName = path.basename(q.searchParams.get('name') || 'upload.mp4').replace(/[\\/:*?"<>|]/g, '');
      if (!/\.(mp4|mov|mkv|avi|flv|webm|m4v)$/i.test(rawName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '只收影片檔' })); return;
      }
      const upDir = path.join(process.cwd(), 'cut_work', '_uploads');
      fs.mkdirSync(upDir, { recursive: true });
      let dest = path.join(upDir, rawName);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(upDir, rawName.replace(/(\.[^.]+)$/, `_${n}$1`));
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on('finish', () => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ path: dest }));
        console.log(`📥 拖放上傳 → ${dest}`);
      });
      ws.on('error', e => { try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch (_) {} });
      req.on('error', () => { try { ws.destroy(); fs.unlinkSync(dest); } catch (_) {} });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API: 剪輯 - 提取音頻+轉錄+標記 ──
  if (req.method === 'POST' && req.url === '/api/process-video') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { videoPath, referenceText } = JSON.parse(body);
        if (!videoPath || !fs.existsSync(videoPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '找不到影片: ' + videoPath }));
          return;
        }
        if (cutState.running) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '剪輯進行中' }));
          return;
        }
        startCutProcess(videoPath, referenceText);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '處理已啟動' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── API: 剪輯狀態 ──
  if (req.method === 'GET' && req.url === '/api/cut-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cutState));
    return;
  }







  // ── API: 重新執行 AI 分析（/api/rerun-ai 用目前 cutState；/api/rerun-ai/<name> 針對指定影片重建 cutState，供審核頁重跑）──
  if (req.method === 'POST' && (req.url === '/api/rerun-ai' || req.url.startsWith('/api/rerun-ai/'))) {
    if (req.url.startsWith('/api/rerun-ai/')) {
      if (cutState.running) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '正在處理中' })); return; }
      const nm = decodeURIComponent(req.url.replace('/api/rerun-ai/', '').split('?')[0]);
      const ctx = nm && findVideoForName(nm);
      if (!ctx) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '找不到影片：' + nm })); return; }
      const _td = path.join(ctx.workDir, '1_轉錄');
      cutState = {
        running: false, step: '', progress: 0, startTime: Date.now(),
        videoPath: ctx.videoPath, workDir: ctx.workDir,
        subtitlesPath: path.join(_td, 'subtitles_words.json'),
        sentencesPath: path.join(_td, 'sentences.json'),
        autoSelectedPath: path.join(ctx.workDir, '2_分析', 'auto_selected.json'),
        outputPath: null, outputPathB: null, log: [], error: null,
      };
    }
    if (!cutState.subtitlesPath || !fs.existsSync(cutState.subtitlesPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '無字幕檔案，請先處理影片' }));
      return;
    }
    if (cutState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '正在處理中' }));
      return;
    }

    // 完整重跑（2026-07-02 使用者指令）：「重新 AI 分析」= 從語音辨識重新開始，不吃轉錄快取。
    // 清掉轉錄與 AI 產物後直接走 startCutProcess 完整管線（沿用既有 audio.mp3，音訊由影片決定性產生）。
    // 保留：audio.mp3、reference.txt（使用者講稿）、silences/audio_rms/cough_ml（純音訊苦工件，與轉錄無關）。
    // 也清 whisper_words/corrected_text（舊管線殘留）——留著會讓重錄偵測吃到過期訊號源。
    if (!cutState.videoPath || !fs.existsSync(cutState.videoPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '找不到原始影片檔，無法完整重跑：' + (cutState.videoPath || '(未設定)') }));
      return;
    }
    try {
      const td = path.join(cutState.workDir, '1_轉錄');
      const WIPE = new Set(['subtitles_words.json', 'volcengine_result.json', 'whisper_result.json',
                            'whisper_words.json', 'corrected_text.txt']);
      for (const f of fs.readdirSync(td)) {
        if (WIPE.has(f) || /^sentences.*\.json$/.test(f)) {
          try { fs.unlinkSync(path.join(td, f)); } catch (_) {}
        }
      }
      try { fs.unlinkSync(path.join(cutState.workDir, '2_分析', 'auto_selected.json')); } catch (_) {}
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '清除舊轉錄失敗：' + e.message }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, full: true }));
    startCutProcess(cutState.videoPath, null); // reference.txt 已在磁碟，疑似聽錯高亮步驟會自動吃
    return;
  }



  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
\u{1F3AF} Auto VideoCut \u5DF2\u555F\u52D5
\u{1F4CD} \u5730\u5740: http://localhost:${PORT}
\u{1F4C2} \u5DE5\u4F5C\u76EE\u9304: ${process.cwd()}

\u{2702}\u{FE0F}  \u526A\u8F2F\u5F71\u7247: http://localhost:${PORT}/
  `);
});

