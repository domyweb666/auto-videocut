const fs=require('fs'), path=require('path'), {execFileSync}=require('child_process');
const T='training_output';
const names=['作文排毒','seo編輯','擬態變裝','刺蝟3問','展示具體場景','受眾思維','讀前','挑書邏輯'];
function prefilter(pa,out,subs,feat,ol){
  const a=['phrase_prefilter.js',pa,out,'--words-file',subs];
  if(ol)a.push('--outline-file',ol); if(feat)a.push('--audio-features',feat);
  execFileSync('node',a,{stdio:'ignore'});
  return JSON.parse(fs.readFileSync(out,'utf8'));
}
// 把 prefilter 輸出的「強制刪除」轉成字索引集 {indices,reasons}
function toIndices(ci){
  const indices=new Set(), reasons={};
  for(const d of (ci.ruleDeletions||[])){
    const ph=ci.phrases[d.phraseIdx]; if(!ph)continue;
    for(const wi of ph.wordIndices){ indices.add(wi); reasons[wi]=d.reason; }
  }
  for(const g of (ci.gapDeletions||[])){
    const wi=g.wordIdx ?? g.idx; if(wi!=null){ indices.add(wi); reasons[wi]=g.reason||'silence'; }
  }
  return {indices:[...indices].sort((a,b)=>a-b),reasons};
}
function compareGold(subs,edited,sel){
  fs.writeFileSync('_t/_sel.json',JSON.stringify(sel));
  const out=execFileSync('node',['compare_transcriptions.js',subs,edited,'_t/_sel.json'],{encoding:'utf8',maxBuffer:1e8});
  return JSON.parse(out.trim());
}
let agg={off:{fp:0,fn:0,tp:0},on:{fp:0,fn:0,tp:0}};
console.log('影片            OFF(fp/fn/f1)        ON(fp/fn/f1)       Δfp');
for(const n of names){
  const v=path.join(T,n);
  const pa=path.join(v,'2_分析','polished_A.json');
  const subs=path.join(v,'1_轉錄','subtitles_words.json');
  const edited=path.join(v,'2_分析','edited_words.json');
  const edited2=path.join(v,'2_分析','edited_words.json');
  const ed=fs.existsSync(edited)?edited:(fs.existsSync(edited2)?edited2:null);
  const feat=path.join(v,'1_轉錄','audio_features.json');
  const olp=path.join(v,'2_分析','outline.json'); const ol=fs.existsSync(olp)?olp:null;
  if(!ed){console.log(n,'❌ 找不到 edited_words.json');continue;}
  const ciOff=prefilter(pa,'_t/_off.json',subs,null,ol);
  const ciOn =prefilter(pa,'_t/_on.json',subs,feat,ol);
  const rOff=compareGold(subs,ed,toIndices(ciOff));
  const rOn =compareGold(subs,ed,toIndices(ciOn));
  const aOff=rOff.accuracy_filtered, aOn=rOn.accuracy_filtered;
  agg.off.fp+=aOff.fp;agg.off.fn+=aOff.fn;agg.off.tp+=aOff.tp;
  agg.on.fp+=aOn.fp;agg.on.fn+=aOn.fn;agg.on.tp+=aOn.tp;
  const dfp=aOn.fp-aOff.fp;
  console.log(`${n.padEnd(8)} ${String(aOff.fp).padStart(3)}/${String(aOff.fn).padStart(3)}/${(aOff.f1*100).toFixed(1).padStart(5)}   ${String(aOn.fp).padStart(3)}/${String(aOn.fn).padStart(3)}/${(aOn.f1*100).toFixed(1).padStart(5)}   ${dfp>0?'+':''}${dfp}`);
}
function f1(a){const p=a.tp/(a.tp+a.fp),r=a.tp/(a.tp+a.fn);return 2*p*r/(p+r);}
console.log('\n=== 合計（規則前置層 vs gold）===');
console.log(`OFF: fp=${agg.off.fp} fn=${agg.off.fn} tp=${agg.off.tp} F1=${(f1(agg.off)*100).toFixed(2)}%`);
console.log(`ON : fp=${agg.on.fp} fn=${agg.on.fn} tp=${agg.on.tp} F1=${(f1(agg.on)*100).toFixed(2)}%`);
console.log(`Δ : fp ${agg.on.fp-agg.off.fp}, fn ${agg.on.fn-agg.off.fn}, F1 ${((f1(agg.on)-f1(agg.off))*100).toFixed(2)}pp`);
