#!/usr/bin/env node
// bridge_gap_deletes 單元測試（audit #4 梳齒死氣橋接）
const bridgeGapDeletes = require('../bridge_gap_deletes');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + '\n     got:  ' + g + '\n     want: ' + w); fail++; }
}
const W = (start, end, text, isGap) => ({ start, end, text, isGap: !!isGap });
const S = (start, end) => ({ start, end });

// 典型梳齒：逐字刪一句話，字間有 gap 元素
{
  const words = [
    W(0.0, 0.3, '我'), W(0.3, 0.5, '', true), W(0.5, 0.8, '們'),
    W(0.8, 1.1, '', true), W(1.1, 1.4, '走'), W(1.4, 3.0, '', true), W(3.0, 3.4, '好'),
  ];
  const dl = [S(0.0, 0.3), S(0.5, 0.8), S(1.1, 1.4)];
  eq('梳齒三段（字間 gap）併成一段', bridgeGapDeletes(dl, words), [S(0.0, 1.4)]);
}
// 間隙內有發音字 → 不橋接
{
  const words = [W(0.0, 0.5, '刪'), W(0.5, 1.0, '留'), W(1.0, 1.5, '刪')];
  const dl = [S(0.0, 0.5), S(1.0, 1.5)];
  eq('間隙有發音字不併', bridgeGapDeletes(dl, words), [S(0.0, 0.5), S(1.0, 1.5)]);
}
// 間隙完全無元素（純靜音、連 gap 元素都沒有）→ 橋接
{
  const words = [W(0.0, 0.5, 'A'), W(2.0, 2.5, 'B')];
  const dl = [S(0.0, 0.5), S(2.0, 2.5)];
  eq('間隙無任何元素也併', bridgeGapDeletes(dl, words), [S(0.0, 2.5)]);
}
// 長轉場 gap（2s+）在兩刪除段之間 → 一樣併（與 execute-cut gap 擴展一致）
{
  const words = [W(0.0, 1.0, '句尾'), W(1.0, 3.5, '', true), W(3.5, 4.5, '句首')];
  const dl = [S(0.0, 1.0), S(3.5, 4.5)];
  eq('長 gap 也橋接', bridgeGapDeletes(dl, words), [S(0.0, 4.5)]);
}
// 邊界毛邊：發音字只重疊 20ms（< 30ms EPS）→ 視為毛邊，照併
{
  const words = [W(0.0, 0.52, 'A'), W(1.0, 1.5, 'B')];
  const dl = [S(0.0, 0.5), S(0.54, 1.5)];
  eq('30ms 內毛邊重疊不擋橋接', bridgeGapDeletes(dl, words), [S(0.0, 1.5)]);
}
// 重疊/相接段直接併
{
  const words = [W(0.0, 2.0, 'A')];
  const dl = [S(0.0, 1.0), S(0.8, 1.5), S(1.5, 2.0)];
  eq('重疊與相接直接併', bridgeGapDeletes(dl, words), [S(0.0, 2.0)]);
}
// 無序輸入先排序
{
  const words = [W(0.0, 0.3, 'A'), W(0.3, 0.6, '', true), W(0.6, 0.9, 'B'), W(0.9, 1.2, '', true), W(1.2, 1.5, 'C')];
  const dl = [S(1.2, 1.5), S(0.0, 0.3), S(0.6, 0.9)];
  eq('無序輸入正確排序後併', bridgeGapDeletes(dl, words), [S(0.0, 1.5)]);
}
// 附加欄位（reason）保留在首段
{
  const words = [W(0.0, 0.3, 'A'), W(0.3, 0.6, '', true), W(0.6, 0.9, 'B')];
  const dl = [{ start: 0.0, end: 0.3, reason: '手動' }, S(0.6, 0.9)];
  eq('附加欄位保留', bridgeGapDeletes(dl, words), [{ start: 0.0, end: 0.9, reason: '手動' }]);
}
// 單段/空輸入原樣
{
  eq('單段不動', bridgeGapDeletes([S(0, 1)], []), [S(0, 1)]);
  eq('空清單回空', bridgeGapDeletes([], []), []);
  eq('非陣列回空', bridgeGapDeletes(null, []), []);
}
// 保留字剛好貼齊間隙邊緣（word.start == prev.end）且蓋滿間隙 → 不併
{
  const words = [W(0.0, 0.5, 'A'), W(0.5, 1.0, '留著'), W(1.0, 1.5, 'B')];
  const dl = [S(0.0, 0.5), S(1.0, 1.5)];
  eq('貼齊邊緣的保留字擋住橋接', bridgeGapDeletes(dl, words), [S(0.0, 0.5), S(1.0, 1.5)]);
}

console.log(`\n結果: ${pass} 通過, ${fail} 失敗`);
process.exit(fail ? 1 : 0);
