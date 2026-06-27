const fs=require('fs'), path=require('path'), {execFileSync}=require('child_process');
const T='training_output';
const names=['作文排毒','seo編輯','擬態變裝','刺蝟3問','展示具體場景','受眾思維','讀前','挑書邏輯'];
function run(pa,out,subs,feat,ol){
  const a=[ 'phrase_prefilter.js', pa, out, '--words-file', subs ];
  if(ol) a.push('--outline-file',ol);
  if(feat) a.push('--audio-features',feat);
  execFileSync('node',a,{stdio:'ignore'});
  return JSON.parse(fs.readFileSync(out,'utf8'));
}
let totFlip=0, totAdj=0;
for(const n of names){
  const v=path.join(T,n);
  const pa=path.join(v,'2_分析','polished_A.json');
  const subs=path.join(v,'1_轉錄','subtitles_words.json');
  const feat=path.join(v,'1_轉錄','audio_features.json');
  const olp=path.join(v,'2_分析','outline.json');
  const ol=fs.existsSync(olp)?olp:null;
  if(!fs.existsSync(pa)){console.log(n,'NO polished_A');continue;}
  const off=run(pa,'_t/_off.json',subs,null,ol);
  const on =run(pa,'_t/_on.json',subs,feat,ol);
  const aOff=off.ruleDeletions.filter(d=>d.rule==='adjacent_repeat');
  const aOn =on.ruleDeletions.filter(d=>d.rule==='adjacent_repeat');
  // 對應同一組重複：用 reason 前綴的「前N字」配對，比 phraseIdx
  const offIdx=aOff.map(d=>d.phraseIdx).sort((x,y)=>x-y);
  const onIdx =aOn.map(d=>d.phraseIdx).sort((x,y)=>x-y);
  let flips=0;
  // 逐一比：ON 有但 OFF 沒有的 phraseIdx = 翻盤刪了不同段
  const offSet=new Set(offIdx);
  for(const d of aOn){ if(!offSet.has(d.phraseIdx)) flips++; }
  totFlip+=flips; totAdj+=aOn.length;
  console.log(`${n.padEnd(8)} adjacent=${aOn.length}  翻盤=${flips}  ${flips>0?'★':''}`);
  if(flips>0){ aOn.filter(d=>!offSet.has(d.phraseIdx)).forEach(d=>console.log('     翻:',d.reason)); }
}
console.log(`\n總計：adjacent_repeat ${totAdj} 個，P1 翻盤 ${totFlip} 個`);
