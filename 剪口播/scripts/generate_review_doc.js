#!/usr/bin/env node
/**
 * 純白文稿式審核頁（無影片；可選段落音訊試聽）
 * 設計目標：從「掃全文逐字檢查」改成「逐決策檢查」——
 *   AI 動過的每個地方聚成一張決策卡，按類別分組、按信心分層：
 *   高信心（exact 重錄/高信心咳嗽/規則重複）預設你不用看；
 *   低信心（fuzzy 重錄/語意重複/AI 句級/低信心咳嗽）排進疑點佇列，N 逐一走、Y/X 裁決。
 *   重錄類決策聚焦時同步高亮「保留的那個 take」（對照著看最快）；P 試聽刪除段、O 試聽保留段。
 *
 * 沿用既有匯出契約：POST <cutApiPath> { deleteList:[{start,end}], exportOptions:{} }
 *
 * 模組用：const buildReviewDoc = require('./generate_review_doc');
 *         const html = buildReviewDoc(words, autoSelectedArr, autoReasons,
 *                        { cutApiPath, silenceRemovalSec, pairs, audioUrl });
 * CLI 用：node generate_review_doc.js <subtitles_words.json> [auto_selected.json]
 *
 * ⚠ rule 03：本檔是 Node 模板字串，瀏覽器要看到 \ 就得寫 \\。
 */
const fs = require('fs');

function parseAuto(raw) {
  const set = [], reasons = {};
  if (Array.isArray(raw)) {
    raw.forEach(x => { if (typeof x === 'number') set.push(x); else if (x && typeof x.idx === 'number') set.push(x.idx); });
  } else if (raw && raw.indices) {
    raw.indices.forEach(i => set.push(i));
    if (raw.reasons) for (const k of Object.keys(raw.reasons)) {
      if (k.indexOf('-') > 0) { const p = k.split('-'); for (let i = +p[0]; i <= +p[1]; i++) reasons[i] = raw.reasons[k]; }
      else reasons[k] = raw.reasons[k];
    }
  }
  return { set, reasons };
}

function buildReviewDoc(words, autoSet, autoReasons, opts) {
  opts = opts || {};
  const cutApiPath = opts.cutApiPath || '/api/cut';
  const silRemove = Number(opts.silenceRemovalSec) || 0; // 匯出時靜音壓平會扣掉的秒數（refine 乾跑估）
  const DATA = JSON.stringify(words);
  const AUTO = JSON.stringify(autoSet || []);
  const REASONS = JSON.stringify(autoReasons || {});
  const PAIRS = JSON.stringify(opts.pairs || {});
  const AUDIO = JSON.stringify(opts.audioUrl || '');
  return `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>審核定稿</title>
<style>
  body{margin:0;background:#f3f2ee;color:#2c2c2a;font-family:-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;padding-bottom:96px;}
  .bar{max-width:640px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:16px 12px;}
  .bar .title{font-size:15px;font-weight:600;}
  .bar .stat{font-size:13px;color:#5f5e5a;}
  .bar button{border-radius:8px;font-size:13px;padding:6px 12px;cursor:pointer;}
  .btn-risk{background:#fff;border:1px solid #d3d1c7;color:#444441;}
  .btn-export{background:#2c2c2a;border:none;color:#fff;}
  /* 決策摘要面板 */
  #panel{max-width:640px;margin:0 auto 10px;padding:0 12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
  .chip{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #d3d1c7;border-radius:16px;padding:4px 6px 4px 12px;font-size:12.5px;cursor:pointer;user-select:none;}
  .chip:hover{background:#f1efe8;}
  .chip .cnt{font-weight:700;}
  .chip .mini{border:none;background:#eeece5;border-radius:10px;padding:2px 7px;font-size:11px;cursor:pointer;color:#555;}
  .chip .mini:hover{background:#e0ddd2;}
  .chip.done{opacity:.45;}
  #panelHint{font-size:11.5px;color:#9a988f;width:100%;padding-left:2px;}
  .legend{max-width:640px;margin:0 auto 8px;display:flex;gap:16px;font-size:12px;color:#888;padding:0 12px;flex-wrap:wrap;}
  #doc{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e3e1d9;border-radius:8px;padding:44px 52px;font-size:17px;line-height:1.85;min-height:300px;}
  #doc .para{margin:0 0 1.5em;}
  #doc .para:last-child{margin-bottom:0;}
  .word{cursor:pointer;border-radius:3px;padding:1px 1px;}
  .word:hover{background:#f1efe8;}
  .word.aidel{color:#BA7517;text-decoration:line-through;text-decoration-thickness:2px;}
  .word.aidel.lowconf{background:#FCF3DC;}
  .word.del{color:#A32D2D;text-decoration:line-through;text-decoration-thickness:2px;}
  .word.aikeep{box-shadow:inset 0 -3px 0 #EF9F27;}
  .word.suspect{box-shadow:inset 0 -3px 0 #E24B4A;}
  .word.ring{outline:2px solid #185FA5;outline-offset:2px;}
  .word.pairhl{background:#DDEBF7;box-shadow:inset 0 -3px 0 #185FA5;}
  .hint{max-width:640px;margin:12px auto 48px;font-size:12px;color:#9a988f;padding:0 12px;line-height:1.7;}
  /* 聚焦決策的底部裁決列 */
  #dbar{display:none;position:fixed;left:0;right:0;bottom:0;background:#2c2c2a;color:#eee;z-index:40;}
  #dbarIn{max-width:640px;margin:0 auto;padding:10px 14px;display:flex;align-items:center;gap:10px;}
  #dbarCat{font-size:11px;background:#EF9F27;color:#2c2c2a;border-radius:4px;padding:2px 7px;font-weight:700;white-space:nowrap;}
  #dbarTxt{flex:1;font-size:12.5px;line-height:1.5;color:#ddd;max-height:3.2em;overflow:hidden;}
  #dbar button{border:1px solid #555;background:#3a3a38;color:#eee;border-radius:7px;padding:6px 11px;font-size:12.5px;cursor:pointer;white-space:nowrap;}
  #dbar button:hover{background:#4a4a47;}
  #dbar button.primary{background:#EF9F27;border:none;color:#2c2c2a;font-weight:700;}
  #ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);align-items:center;justify-content:center;font-size:14px;color:#333;z-index:50;}
  .ovbox{background:#fff;border-radius:14px;padding:22px 24px;width:420px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,.25);}
  .ovbox h3{font-size:16px;margin-bottom:14px;}
  .ovbox label{display:block;font-size:12px;color:#7a7770;margin:12px 0 4px;}
  .ovbox input[type=text],.ovbox select{width:100%;padding:8px 10px;border:1px solid #d3d1c7;border-radius:8px;font-size:14px;box-sizing:border-box;}
  .ovrow{display:flex;gap:8px;}.ovrow input{flex:1;}
  .ovrow button,.ovbtns button{border:1px solid #d3d1c7;background:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;}
  .ovbtns button.btn-export{background:#2c2c2a;color:#fff;border:none;} /* 不加這條會被上一行的 background:#fff 蓋掉 → 白字白底 */
  .ovchk{display:flex;align-items:center;gap:6px;margin-top:12px;font-size:13px;color:#444;}
  .ovbtns{display:flex;justify-content:flex-end;gap:8px;margin-top:20px;}
  .ovbar{height:10px;background:#eee;border-radius:6px;overflow:hidden;margin:14px 0 6px;}
  .ovfill{height:100%;width:0;background:#185FA5;transition:width .3s;}
  #ovPct{text-align:center;font-size:20px;font-weight:700;color:#185FA5;}
  #ovDone{margin-top:14px;font-size:13px;line-height:1.7;color:#444;}
</style></head><body>
<div class="bar">
  <span class="title">審核定稿</span>
  <span style="flex:1"></span>
  <span class="stat">原 <span id="statOrig">0:00</span> &rarr; 剪後 <b id="statAfter">0:00</b><span id="silHint" style="color:#9a988f;font-size:12px;margin-left:6px;"></span></span>
  <button class="btn-risk" onclick="nextRisk()">下一疑點 <span id="riskCount"></span></button>
  <button class="btn-risk" onclick="rerunAI()">🔄 重新 AI</button>
  <button class="btn-export" onclick="doExport()">匯出</button>
</div>
<div id="panel"></div>
<div class="legend">
  <span><span style="text-decoration:line-through;color:#BA7517">刪字</span> AI 建議刪（<span style="background:#FCF3DC;padding:0 3px;">米黃底</span>＝低信心，要看）</span>
  <span><span style="text-decoration:line-through;color:#A32D2D">刪字</span> 你刪除</span>
  <span><span style="background:#DDEBF7;padding:0 3px;">藍底</span> 對照：保留的那個 take</span>
  <span><span style="box-shadow:inset 0 -3px 0 #E24B4A;padding:0 3px;">紅線</span> 疑似聽錯</span>
</div>
<div id="doc"></div>
<div class="hint">點字＝切換刪除，拖曳＝整段標記。<b>N</b> 下一疑點（只排低信心決策＋疑似聽錯）；聚焦時 <b>Y</b>＝照刪、<b>X</b>＝留下、<b>P</b>＝試聽刪除段、<b>O</b>＝試聽保留段。上方面板可按類別跳轉或一鍵全收/全退。</div>
<audio id="aud" preload="none"></audio>
<div id="dbar"><div id="dbarIn">
  <span id="dbarCat"></span>
  <span id="dbarTxt"></span>
  <button onclick="playFocused(false)" id="dbarPlay">▶ 試聽 P</button>
  <button onclick="playFocused(true)" id="dbarPair">▶ 保留版 O</button>
  <button onclick="resolveFocused(false)">留下 X</button>
  <button class="primary" onclick="resolveFocused(true)">照刪 Y</button>
</div></div>
<div id="ov"><div class="ovbox">
  <div id="ovForm">
    <h3>匯出設定</h3>
    <label>成品名稱</label>
    <div class="ovrow"><input type="text" id="expName" placeholder="留空＝影片名_cut"></div>
    <label>輸出資料夾（會在其下建「成品名稱」子資料夾，影片/字幕/文稿收攏一起）</label>
    <div class="ovrow"><input type="text" id="expDir" placeholder="留空＝存到影片原資料夾"><button onclick="pickDir()">瀏覽</button></div>
    <label>格式</label>
    <select id="expFmt" onchange="fmtChanged()"><option value="jydraft">剪映草稿（真無損・秒級完成・直接進剪映）</option><option value="mp4">MP4（H.264，通用）</option><option value="mov">MOV</option><option value="mkv">MKV</option><option value="mp3">只要音檔（MP3）</option></select>
    <div id="jyHint" style="font-size:12px;color:#7a7770;margin-top:6px;line-height:1.6;">不重編碼：生成剪映草稿引用原始檔＋剪點，字幕掛在字幕軌。開剪映就看得到，剪點還能微調。</div>
    <label class="ovchk" id="losslessRow"><input type="checkbox" id="expLossless"> 原畫質（近無損，檔案較大）</label>
    <div class="ovbtns"><button onclick="closeOv()">取消</button><button class="btn-export" onclick="runExport()">開始匯出</button></div>
  </div>
  <div id="ovProg" style="display:none;">
    <h3 id="ovStep">匯出中…</h3>
    <div class="ovbar"><div class="ovfill" id="ovFill"></div></div>
    <div id="ovPct">0%</div>
    <div id="ovDone" style="display:none;"></div>
  </div>
</div></div>
<script>
var words=${DATA},autoSelected=new Set(${AUTO}),autoReasons=${REASONS},PAIRS=${PAIRS},AUDIO=${AUDIO};
var SIL_REMOVE=${silRemove};
var selected=new Set(autoSelected),doc=document.getElementById('doc'),wordEl=[];

// ── 決策分類：reason 前綴 → 類別＋信心層（hi=true 高信心，預設不進疑點佇列）──
function catOf(r){r=r||'';
  if(r.indexOf('\\u91cd\\u9304take')===0)return{k:'retake',label:'\\u91cd\\u9304',hi:true};        // 重錄take
  if(r.indexOf('\\u7591\\u4f3c\\u91cd\\u9304')===0)return{k:'fuzzy',label:'\\u7591\\u4f3c\\u91cd\\u9304',hi:false}; // 疑似重錄
  if(r.indexOf('\\u91cd\\u8907Take')===0||r.indexOf('\\u76f8\\u9130\\u91cd\\u8907')===0)return{k:'repeat',label:'\\u91cd\\u8907\\u53e5',hi:true}; // 重複Take/相鄰重複
  if(r.indexOf('\\u6e05\\u5589')===0||r.indexOf('\\u54b3\\u55fd')===0){                             // 清喉/咳嗽
    var m=r.match(/\\u4fe1\\u5fc3(\\d+)%/);var c=m?+m[1]:0;
    return{k:'cough',label:'\\u54b3\\u55fd\\u6e05\\u5589',hi:c>=80};}
  if(r.indexOf('\\u8a9e\\u610f\\u91cd\\u8907')===0)return{k:'semantic',label:'\\u8a9e\\u610f\\u91cd\\u8907',hi:false}; // 語意重複
  return{k:'ai',label:'AI \\u5224\\u65b7',hi:false};
}

// ── 把預選聚成決策卡：連續 index＋同 reason ＝ 一張卡 ──
// 純 gap 且無 reason 的群（隨句刪除的間隙）不建卡——沒東西可看、會污染疑點佇列。
var decisions=[],idx2dec={};
(function(){
  var sel=Array.from(autoSelected).sort(function(a,b){return a-b});
  var groups=[],cur=null;
  for(var s=0;s<sel.length;s++){
    var i=sel[s],r=autoReasons[i]||'';
    if(cur&&i===cur.to+1&&r===cur.reason){cur.to=i;}
    else{cur={from:i,to:i,reason:r,state:''};groups.push(cur);}
  }
  groups.forEach(function(d){
    var t='';for(var j2=d.from;j2<=d.to;j2++){if(words[j2]&&!words[j2].isGap)t+=(words[j2].text||'');}
    d.text=t;
    if(!d.text&&!d.reason)return; // 純 gap 空卡：跳過（刪除行為不變，只是不進面板/疑點）
    d.id=decisions.length;
    d.cat=catOf(d.reason);
    d.start=words[d.from]?words[d.from].start:0;
    d.end=words[d.to]?words[d.to].end:0;
    // 對照 pair：找 key 範圍與本決策相交的（key 是預選寫入時的 range）
    d.pair=null;
    for(var k in PAIRS){var p=k.split('-');if(+p[0]<=d.to&&+p[1]>=d.from){d.pair=PAIRS[k];break;}}
    for(var j=d.from;j<=d.to;j++)idx2dec[j]=d.id;
    decisions.push(d);
  });
})();

function cls(i){var w=words[i];if(w.isGap)return '';var c='word',sel=selected.has(i),ai=autoSelected.has(i);
  if(sel&&ai){c+=' aidel';var d=decisions[idx2dec[i]];if(d&&!d.cat.hi)c+=' lowconf';}
  else if(sel)c+=' del';else if(ai)c+=' aikeep';
  if(w._suspect)c+=' suspect';return c;}
function render(){doc.innerHTML='';wordEl=[];var para=document.createElement('p');para.className='para';var plen=0;function flush(){if(para.childNodes.length)doc.appendChild(para);para=document.createElement('p');para.className='para';plen=0;}for(var i=0;i<words.length;i++){var w=words[i];if(w.isGap){wordEl[i]=null;continue;}var el=document.createElement('span');el.className=cls(i);el.dataset.idx=i;el.textContent=w.text;var tip=autoReasons[i]||'';if(w._suspect)tip=(tip?tip+' | ':'')+'\\u26a0 \\u7591\\u4f3c\\u807d\\u932f\\uff0c\\u8b1b\\u7a3f\\u662f\\u300c'+(w._refHint||'?')+'\\u300d';if(tip)el.title=tip;para.appendChild(el);wordEl[i]=el;var t=w.text||'';plen+=t.length;if(/[\\u3002\\uff01\\uff1f][\\u300d\\u300f"']?$/.test(t)){if(plen>=16)flush();}else if(plen>=48&&/[\\uff0c\\u3001\\uff1b]$/.test(t))flush();}flush();updateStats();renderPanel();}

// ── 決策摘要面板 ──
function renderPanel(){
  var box=document.getElementById('panel');box.innerHTML='';
  var groups={};
  decisions.forEach(function(d){(groups[d.cat.k]=groups[d.cat.k]||{label:d.cat.label,hi:d.cat.hi,items:[]}).items.push(d);});
  var keys=Object.keys(groups);
  if(!keys.length){box.innerHTML='<span id="panelHint">AI \\u6c92\\u6709\\u9810\\u9078\\u4efb\\u4f55\\u522a\\u9664\\u3002</span>';return;}
  keys.sort(function(a,b){return groups[a].hi-groups[b].hi||groups[b].items.length-groups[a].items.length;});
  keys.forEach(function(k){
    var g=groups[k];
    var kept=g.items.filter(function(d){return d.from in idx2dec&&selected.has(d.from)}).length;
    var chip=document.createElement('span');chip.className='chip'+(kept===0?' done':'');
    chip.innerHTML='<span>'+g.label+(g.hi?'':' \\u26a0')+'</span><span class="cnt">'+kept+'/'+g.items.length+'</span>'+
      '<button class="mini" data-act="jump">\\u770b</button><button class="mini" data-act="all">\\u5168\\u6536</button><button class="mini" data-act="none">\\u5168\\u9000</button>';
    chip.querySelector('[data-act=jump]').onclick=function(e){e.stopPropagation();jumpCategory(k);};
    chip.querySelector('[data-act=all]').onclick=function(e){e.stopPropagation();setCategory(k,true);};
    chip.querySelector('[data-act=none]').onclick=function(e){e.stopPropagation();setCategory(k,false);};
    chip.onclick=function(){jumpCategory(k);};
    box.appendChild(chip);
  });
  var hint=document.createElement('span');hint.id='panelHint';
  hint.textContent='\\u26a0\\uff1d\\u4f4e\\u4fe1\\u5fc3\\uff08\\u5efa\\u8b70\\u9010\\u4e00\\u770b\\uff09\\uff1b\\u6c92\\u6a19 \\u26a0 \\u7684\\u985e\\u5225\\u901a\\u5e38\\u76f4\\u63a5\\u4fe1\\u4efb\\u5373\\u53ef';
  box.appendChild(hint);
}
var catPos={};
function jumpCategory(k){
  var items=decisions.filter(function(d){return d.cat.k===k});
  if(!items.length)return;
  catPos[k]=((catPos[k]===undefined?-1:catPos[k])+1)%items.length;
  focusDecision(items[catPos[k]].id);
}
function setCategory(k,on){
  decisions.forEach(function(d){if(d.cat.k!==k)return;
    for(var j=d.from;j<=d.to;j++){if(!words[j])continue;if(on)selected.add(j);else selected.delete(j);if(wordEl[j])wordEl[j].className=cls(j);}
    d.state=on?'y':'x';});
  clearFocus();updateStats();renderPanel();
}

// ── 聚焦與裁決 ──
var focusedId=-1,pairEls=[];
function focusDecision(id){
  clearFocus();
  var d=decisions[id];if(!d)return;focusedId=id;
  var el=wordEl[d.from]||wordEl[d.to];
  if(el){el.scrollIntoView({block:'center',behavior:'smooth'});}
  for(var j=d.from;j<=d.to;j++)if(wordEl[j])wordEl[j].classList.add('ring');
  // 對照高亮保留 take
  if(d.pair){words.forEach(function(w,i){if(!w||w.isGap||!wordEl[i])return;
    var ov=Math.min(w.end,d.pair.end)-Math.max(w.start,d.pair.start);
    if(ov>0&&ov/Math.max(w.end-w.start,0.01)>=0.4){wordEl[i].classList.add('pairhl');pairEls.push(i);}});}
  var bar=document.getElementById('dbar');bar.style.display='block';
  document.getElementById('dbarCat').textContent=d.cat.label+(d.cat.hi?'':' \\u26a0');
  document.getElementById('dbarTxt').textContent=(d.reason||('\\u522a\\u300c'+d.text.slice(0,20)+'\\u300d'))+'\\u3000['+fmt(d.start)+']';
  document.getElementById('dbarPlay').style.display=AUDIO?'':'none';
  document.getElementById('dbarPair').style.display=(AUDIO&&d.pair)?'':'none';
}
function clearFocus(){
  if(focusedId>=0){var d=decisions[focusedId];if(d)for(var j=d.from;j<=d.to;j++)if(wordEl[j])wordEl[j].classList.remove('ring');}
  pairEls.forEach(function(i){if(wordEl[i])wordEl[i].classList.remove('pairhl');});pairEls=[];
  focusedId=-1;document.getElementById('dbar').style.display='none';
}
function resolveFocused(keep){
  var d=decisions[focusedId];if(!d)return;
  for(var j=d.from;j<=d.to;j++){if(!words[j])continue;if(keep)selected.add(j);else selected.delete(j);if(wordEl[j])wordEl[j].className=cls(j);}
  d.state=keep?'y':'x';
  updateStats();renderPanel();nextRisk();
}
var aud=document.getElementById('aud'),audStop=0;
if(AUDIO)aud.src=AUDIO;
function playSeg(s,e){if(!AUDIO)return;audStop=e;aud.currentTime=Math.max(0,s);aud.play();}
aud.addEventListener('timeupdate',function(){if(audStop&&aud.currentTime>=audStop){aud.pause();audStop=0;}});
function playFocused(pair){
  var d=decisions[focusedId];if(!d)return;
  if(pair&&d.pair)playSeg(Math.max(0,d.pair.start-0.15),d.pair.end+0.15);
  else playSeg(Math.max(0,d.start-0.15),d.end+0.15);
}

// ── 點字/拖曳（沿用）──
var dragActive=false,dragStart=0,dragMode='add';
doc.addEventListener('mousedown',function(e){var t=e.target.closest('[data-idx]');if(!t)return;e.preventDefault();var i=+t.dataset.idx;dragActive=true;dragStart=i;dragMode=selected.has(i)?'remove':'add';apply(i,i);});
doc.addEventListener('mousemove',function(e){if(!dragActive)return;var t=e.target.closest('[data-idx]');if(!t)return;apply(dragStart,+t.dataset.idx);});
document.addEventListener('mouseup',function(){if(dragActive){dragActive=false;updateStats();renderPanel();}});
function apply(a,b){var lo=Math.min(a,b),hi=Math.max(a,b);for(var j=lo;j<=hi;j++){if(!words[j])continue;if(dragMode==='add')selected.add(j);else selected.delete(j);if(wordEl[j])wordEl[j].className=cls(j);}}
function segs(){var arr=Array.from(selected).sort(function(a,b){return a-b}).map(function(i){return{s:words[i].start,e:words[i].end}});var m=[];arr.forEach(function(g){if(!m.length||g.s-m[m.length-1].e>=0.05)m.push({s:g.s,e:g.e});else m[m.length-1].e=g.e;});return m;}
function fmt(s){s=Math.max(0,Math.round(s));return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);}
function updateStats(){var total=words.length?words[words.length-1].end:0;var del=segs().reduce(function(a,g){return a+(g.e-g.s)},0);var after=Math.max(0,total-del-SIL_REMOVE);document.getElementById('statOrig').textContent=fmt(total);document.getElementById('statAfter').textContent=(SIL_REMOVE>0?'\\u2248 ':'')+fmt(after);var sh=document.getElementById('silHint');if(sh)sh.textContent=SIL_REMOVE>0?('\\uff08\\u542b\\u58d3\\u975c\\u97f3 \\u2212'+fmt(SIL_REMOVE)+'\\uff09'):'';buildRiskSpots();}

// ── 疑點佇列：低信心決策 ＋ 疑似聽錯（不再把高信心也排進來）──
var riskSpots=[],riskPos=-1; // {dec:id} 或 {idx:i}
function buildRiskSpots(){
  riskSpots=[];
  decisions.forEach(function(d){if(!d.cat.hi&&!d.state)riskSpots.push({dec:d.id});});
  var run=false;
  for(var i=0;i<words.length;i++){var w=words[i],r=w&&!w.isGap&&w._suspect;
    if(r&&!run){if(idx2dec[i]===undefined)riskSpots.push({idx:i});run=true;}else if(!r)run=false;}
  riskSpots.sort(function(a,b){var pa=a.dec!==undefined?decisions[a.dec].from:a.idx;var pb=b.dec!==undefined?decisions[b.dec].from:b.idx;return pa-pb;});
  var c=document.getElementById('riskCount');if(c)c.textContent=riskSpots.length?('0/'+riskSpots.length):'\\uff08\\u7121\\uff09';
}
function nextRisk(){
  buildRiskSpots();
  if(!riskSpots.length){clearFocus();document.getElementById('riskCount').textContent='\\uff08\\u7121\\uff09';return;}
  riskPos=(riskPos+1)%riskSpots.length;
  var spot=riskSpots[riskPos];
  if(spot.dec!==undefined)focusDecision(spot.dec);
  else{clearFocus();var el=wordEl[spot.idx];if(el){el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.add('ring');setTimeout(function(){el.classList.remove('ring');},1500);}}
  document.getElementById('riskCount').textContent=(riskPos+1)+'/'+riskSpots.length;
}
document.addEventListener('keydown',function(e){
  if(/INPUT|TEXTAREA/.test((document.activeElement||{}).tagName||''))return;
  var k=e.key.toLowerCase();
  if(k==='n'){e.preventDefault();nextRisk();}
  else if(k==='y'&&focusedId>=0){e.preventDefault();resolveFocused(true);}
  else if(k==='x'&&focusedId>=0){e.preventDefault();resolveFocused(false);}
  else if(k==='p'&&focusedId>=0){e.preventDefault();playFocused(false);}
  else if(k==='o'&&focusedId>=0){e.preventDefault();playFocused(true);}
  else if(k==='escape'){clearFocus();}
});

function rerunAI(){
  var cp='${cutApiPath}';var rp=cp.indexOf('/api/cut/')===0?cp.replace('/api/cut/','/api/rerun-ai/'):'/api/rerun-ai';
  if(!confirm('\\u91cd\\u65b0\\u5b8c\\u6574\\u8dd1\\u4e00\\u6b21 AI \\u5206\\u6790\\uff1f\\u6703\\u8986\\u84cb\\u76ee\\u524d\\u7684 AI \\u522a\\u9664\\u6a19\\u8a18\\u3001\\u91cd\\u65b0\\u5f9e\\u982d\\u5224\\u65b7\\u3002\\u5b8c\\u6210\\u5f8c\\u9801\\u9762\\u6703\\u91cd\\u8f09\\u986f\\u793a\\u65b0\\u7d50\\u679c\\u3002'))return;
  var ov=document.getElementById('ov');ov.textContent='\\u91cd\\u65b0 AI \\u5206\\u6790\\u4e2d\\u2026';ov.style.display='flex';
  fetch(rp,{method:'POST'}).then(function(r){return r.json();}).then(function(d){
    if(d&&d.error){ov.style.display='none';alert('\\u5931\\u6557\\uff1a'+d.error);return;}poll();
  }).catch(function(e){ov.style.display='none';alert('\\u932f\\u8aa4\\uff1a'+e.message);});
  function poll(){fetch('/api/cut-status').then(function(r){return r.json();}).then(function(s){
    if(s&&s.step)ov.textContent='\\u91cd\\u65b0 AI \\u5206\\u6790\\u4e2d\\u2026 '+s.step+' '+(s.progress||0)+'%';
    if(s&&s.error){ov.style.display='none';alert('\\u5931\\u6557\\uff1a'+s.error);return;}
    if(s&&s.running===false){ov.textContent='\\u5b8c\\u6210\\uff0c\\u91cd\\u8f09\\u4e2d\\u2026';location.reload();return;}
    setTimeout(poll,1500);
  }).catch(function(){setTimeout(poll,2000);});}
}
function doExport(){document.getElementById('ovForm').style.display='block';document.getElementById('ovProg').style.display='none';document.getElementById('ov').style.display='flex';fmtChanged();}
function closeOv(){document.getElementById('ov').style.display='none';}
function pickDir(){fetch('/api/native-browse-folder').then(function(r){return r.json();}).then(function(d){if(d.path)document.getElementById('expDir').value=d.path;}).catch(function(e){alert('\\u9078\\u8cc7\\u6599\\u593e\\u5931\\u6557\\uff1a'+e.message);});}
function setBar(p){document.getElementById('ovFill').style.width=p+'%';document.getElementById('ovPct').textContent=p+'%';}
function expFail(m){document.getElementById('ovStep').textContent='\\u532f\\u51fa\\u5931\\u6557';var dn=document.getElementById('ovDone');dn.style.display='block';dn.innerHTML='\\u274c '+m+'<div style="margin-top:12px;text-align:right"><button onclick="closeOv()">\\u95dc\\u9589</button></div>';}
function fmtChanged(){
  var jy=document.getElementById('expFmt').value==='jydraft';
  document.getElementById('jyHint').style.display=jy?'':'none';
  document.getElementById('losslessRow').style.display=jy?'none':'flex';
  document.getElementById('expDir').disabled=jy; // 草稿寫進剪映草稿資料夾，不用選輸出位置
}
function runExport(){
  var dl=segs().map(function(g){return{start:g.s,end:g.e};});
  var fm=document.getElementById('expFmt').value;var audioOnly=(fm==='mp3');var jy=(fm==='jydraft');
  var opt={outputDir:document.getElementById('expDir').value.trim(),exportName:document.getElementById('expName').value.trim(),container:(audioOnly||jy)?'mp4':fm,audioOnly:audioOnly,jianying:jy,lossless:document.getElementById('expLossless').checked};
  document.getElementById('ovForm').style.display='none';document.getElementById('ovProg').style.display='block';
  document.getElementById('ovDone').style.display='none';document.getElementById('ovStep').textContent='\\u532f\\u51fa\\u4e2d\\u2026';setBar(0);
  fetch('${cutApiPath}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deleteList:dl,exportOptions:opt})}).then(function(r){return r.json();}).then(function(d){if(d&&d.error){expFail(d.error);return;}pollExport();}).catch(function(e){expFail(e.message);});
}
function pollExport(){fetch('/api/export-status').then(function(r){return r.json();}).then(function(s){
  if(s.step)document.getElementById('ovStep').textContent=s.step;setBar(s.progress||0);
  if(s.error){expFail(s.error);return;}
  if(s.running===false){setBar(100);
    if(s.result){var r=s.result;
      document.getElementById('ovStep').textContent=(r.jianying?'\\u526a\\u6620\\u8349\\u7a3f\\u5df2\\u5efa\\u7acb ':'\\u532f\\u51fa\\u5b8c\\u6210 ')+'\\u2705';
      var dn=document.getElementById('ovDone');dn.style.display='block';
      var body=r.jianying
        ? ('\\u8349\\u7a3f\\uff1a<code style="word-break:break-all">'+r.output+'</code><br>'+
           '\\u539f '+fmt(parseFloat(r.originalDuration))+' \\u2192 \\u65b0 '+fmt(parseFloat(r.newDuration))+'\\uff08'+(r.segments||'?')+' \\u6bb5\\uff09<br>'+
           '\\u958b\\u526a\\u6620\\u5c31\\u770b\\u5f97\\u5230\\uff1b\\u771f\\u7121\\u640d\\uff08\\u96f6\\u91cd\\u7de8\\u78bc\\uff09'+(r.srt?'\\uff0c\\u5b57\\u5e55\\u5df2\\u639b\\u5b57\\u5e55\\u8ecc':''))
        : ('\\u8f38\\u51fa\\uff1a<code style="word-break:break-all">'+r.output+'</code><br>\\u539f '+fmt(parseFloat(r.originalDuration))+' \\u2192 \\u65b0 '+fmt(parseFloat(r.newDuration))+(r.srt?'<br>\\u5df2\\u9644\\u5b57\\u5e55 .srt':'')+(r.txt?'<br>\\u5df2\\u9644\\u6587\\u7a3f .txt':''));
      dn.innerHTML=body+'<div style="margin-top:14px;text-align:right"><button class="btn-export" onclick="closeOv()">\\u5b8c\\u6210</button></div>';}
    return;}
  setTimeout(pollExport,1000);
}).catch(function(){setTimeout(pollExport,1500);});}
render();
</script></body></html>`;
}

module.exports = buildReviewDoc;
module.exports.buildReviewDoc = buildReviewDoc;
module.exports.parseAuto = parseAuto;

if (require.main === module) {
  const subtitlesFile = process.argv[2] || 'subtitles_words.json';
  const autoFile = process.argv[3] || 'auto_selected.json';
  if (!fs.existsSync(subtitlesFile)) { console.error('❌ 找不到', subtitlesFile); process.exit(1); }
  const words = JSON.parse(fs.readFileSync(subtitlesFile, 'utf8'));
  let auto = { set: [], reasons: {} }, pairs = {};
  if (fs.existsSync(autoFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
      auto = parseAuto(raw);
      if (raw && raw.pairs) pairs = raw.pairs;
    } catch (_) {}
  }
  fs.writeFileSync('review.html', buildReviewDoc(words, auto.set, auto.reasons, { cutApiPath: '/api/cut', pairs }));
  console.error('✅ 已生成 review.html（決策卡版，' + words.length + ' 元素，AI標記 ' + auto.set.length + '）');
}
