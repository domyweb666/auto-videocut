#!/usr/bin/env node
/**
 * 純白文稿式審核頁（無影片無聲音）→ review.html
 * 像在改一份逐字稿：點字切刪、拖曳整段、紅底線標疑似聽錯、N 鍵跳疑點、一鍵匯出。
 * 沿用既有匯出契約：POST /api/cut { deleteList:[{start,end}], exportOptions:{} }
 *
 * 用法: node generate_review_doc.js <subtitles_words.json> [auto_selected.json]
 */
const fs = require('fs');

const subtitlesFile = process.argv[2] || 'subtitles_words.json';
const autoFile = process.argv[3] || 'auto_selected.json';
if (!fs.existsSync(subtitlesFile)) { console.error('❌ 找不到', subtitlesFile); process.exit(1); }

const words = JSON.parse(fs.readFileSync(subtitlesFile, 'utf8'));

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
let auto = { set: [], reasons: {} };
if (fs.existsSync(autoFile)) { try { auto = parseAuto(JSON.parse(fs.readFileSync(autoFile, 'utf8'))); } catch (_) {} }

const DATA = JSON.stringify(words);
const AUTO = JSON.stringify(auto.set);
const REASONS = JSON.stringify(auto.reasons);

const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>審核定稿</title>
<style>
  body{margin:0;background:#f3f2ee;color:#2c2c2a;font-family:-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;}
  .bar{max-width:640px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:16px 12px;}
  .bar .title{font-size:15px;font-weight:600;}
  .bar .stat{font-size:13px;color:#5f5e5a;}
  .bar button{border-radius:8px;font-size:13px;padding:6px 12px;cursor:pointer;}
  .btn-risk{background:#fff;border:1px solid #d3d1c7;color:#444441;}
  .btn-export{background:#2c2c2a;border:none;color:#fff;}
  .legend{max-width:640px;margin:0 auto 8px;display:flex;gap:18px;font-size:12px;color:#888;padding:0 12px;}
  .chip{display:inline-block;width:18px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:4px;}
  #doc{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e3e1d9;border-radius:8px;padding:44px 52px;font-size:17px;line-height:2.0;min-height:300px;}
  #doc .para{margin:0 0 1.1em;}
  #doc .para:last-child{margin-bottom:0;}
  .word{cursor:pointer;border-radius:3px;padding:1px 1px;}
  .word:hover{background:#f1efe8;}
  .word.ai{background:#FAEEDA;color:#854F0B;}
  .word.del{text-decoration:line-through;color:#b4b2a9;background:transparent;}
  .word.suspect{box-shadow:inset 0 -3px 0 #E24B4A;}
  .word.ring{outline:2px solid #185FA5;outline-offset:2px;}
  .gap{color:#cdcbc2;cursor:pointer;font-size:12px;}
  .gap.del{color:#E24B4A;}
  .hint{max-width:640px;margin:12px auto 48px;font-size:12px;color:#9a988f;padding:0 12px;}
  #ov{display:none;position:fixed;inset:0;background:rgba(255,255,255,.82);align-items:center;justify-content:center;font-size:15px;color:#444;}
</style></head><body>
<div class="bar">
  <span class="title">審核定稿</span>
  <span style="flex:1"></span>
  <span class="stat">原 <span id="statOrig">0:00</span> &rarr; 剪後 <b id="statAfter">0:00</b></span>
  <button class="btn-risk" onclick="nextRisk()">下一疑點 <span id="riskCount"></span></button>
  <button class="btn-export" onclick="doExport()">匯出</button>
</div>
<div class="legend">
  <span><span class="chip" style="background:#FAEEDA"></span>AI建議刪</span>
  <span><span style="text-decoration:line-through;color:#b4b2a9">刪</span> 確認刪</span>
  <span><span class="chip" style="box-shadow:inset 0 -4px 0 #E24B4A"></span>疑似聽錯</span>
</div>
<div id="doc"></div>
<div class="hint">點字＝切換刪除，拖曳＝整段標記。紅底線＝疑似聽錯，滑過看講稿正確字。按「下一疑點」或 N 鍵逐一檢查 AI 動過、沒把握的地方。</div>
<div id="ov">匯出中，請稍候…</div>
<script>
var words=${DATA},autoSelected=new Set(${AUTO}),autoReasons=${REASONS};
var selected=new Set(autoSelected),doc=document.getElementById('doc'),wordEl=[];
function cls(i){var w=words[i];if(w.isGap)return 'gap'+(selected.has(i)?' del':'');var c='word';if(selected.has(i))c+=' del';else if(autoSelected.has(i))c+=' ai';if(w._suspect)c+=' suspect';return c;}
function render(){doc.innerHTML='';wordEl=[];var para=document.createElement('p');para.className='para';var plen=0;function flush(){if(para.childNodes.length)doc.appendChild(para);para=document.createElement('p');para.className='para';plen=0;}for(var i=0;i<words.length;i++){var w=words[i];if(w.isGap){wordEl[i]=null;continue;}var el=document.createElement('span');el.className=cls(i);el.dataset.idx=i;el.textContent=w.text;var tip=autoReasons[i]||'';if(w._suspect)tip=(tip?tip+' | ':'')+'\\u26a0 \\u7591\\u4f3c\\u807d\\u932f\\uff0c\\u8b1b\\u7a3f\\u662f\\u300c'+(w._refHint||'?')+'\\u300d';if(tip)el.title=tip;para.appendChild(el);wordEl[i]=el;plen+=(w.text||'').length;if(/[\\u3002\\uff01\\uff1f][\\u300d\\u300f"']?$/.test(w.text)&&plen>=50)flush();}flush();updateStats();}
var dragActive=false,dragStart=0,dragMode='add';
doc.addEventListener('mousedown',function(e){var t=e.target.closest('[data-idx]');if(!t)return;e.preventDefault();var i=+t.dataset.idx;dragActive=true;dragStart=i;dragMode=selected.has(i)?'remove':'add';apply(i,i);});
doc.addEventListener('mousemove',function(e){if(!dragActive)return;var t=e.target.closest('[data-idx]');if(!t)return;apply(dragStart,+t.dataset.idx);});
document.addEventListener('mouseup',function(){if(dragActive){dragActive=false;updateStats();}});
function apply(a,b){var lo=Math.min(a,b),hi=Math.max(a,b);for(var j=lo;j<=hi;j++){if(!words[j])continue;if(dragMode==='add')selected.add(j);else selected.delete(j);if(wordEl[j])wordEl[j].className=cls(j);}}
function segs(){var arr=Array.from(selected).sort(function(a,b){return a-b}).map(function(i){return{s:words[i].start,e:words[i].end}});var m=[];arr.forEach(function(g){if(!m.length||g.s-m[m.length-1].e>=0.05)m.push({s:g.s,e:g.e});else m[m.length-1].e=g.e;});return m;}
function fmt(s){s=Math.max(0,Math.round(s));return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);}
function updateStats(){var total=words.length?words[words.length-1].end:0;var del=segs().reduce(function(a,g){return a+(g.e-g.s)},0);document.getElementById('statOrig').textContent=fmt(total);document.getElementById('statAfter').textContent=fmt(total-del);buildRiskSpots();}
var riskSpots=[],riskPos=-1;
function buildRiskSpots(){riskSpots=[];var run=false;for(var i=0;i<words.length;i++){var w=words[i],r=w&&!w.isGap&&(w._suspect||autoSelected.has(i));if(r&&!run){riskSpots.push(i);run=true;}else if(!r)run=false;}var c=document.getElementById('riskCount');if(c)c.textContent=riskSpots.length?('0/'+riskSpots.length):'（無）';}
function nextRisk(){if(!riskSpots.length)return;riskPos=(riskPos+1)%riskSpots.length;var el=wordEl[riskSpots[riskPos]];if(el){el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.add('ring');setTimeout(function(){el.classList.remove('ring');},1500);}document.getElementById('riskCount').textContent=(riskPos+1)+'/'+riskSpots.length;}
document.addEventListener('keydown',function(e){if((e.key==='n'||e.key==='N')&&!/INPUT|TEXTAREA/.test((document.activeElement||{}).tagName||'')){e.preventDefault();nextRisk();}});
function doExport(){var dl=segs().map(function(g){return{start:g.s,end:g.e};});if(!confirm('確認匯出？將刪減 '+dl.length+' 段'))return;var ov=document.getElementById('ov');ov.style.display='flex';fetch('/api/cut',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deleteList:dl,exportOptions:{}})}).then(function(r){return r.json();}).then(function(d){ov.style.display='none';if(d.success)alert('完成！\\n輸出：'+d.output+'\\n原 '+fmt(d.originalDuration)+' → 新 '+fmt(d.newDuration));else alert('失敗：'+(d.error||'未知'));}).catch(function(e){ov.style.display='none';alert('錯誤：'+e.message);});}
render();
</script></body></html>`;

fs.writeFileSync('review.html', html);
console.error('✅ 已生成 review.html（純白文稿版，' + words.length + ' 元素，AI標記 ' + auto.set.length + '）');
