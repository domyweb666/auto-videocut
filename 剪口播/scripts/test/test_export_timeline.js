// L3 單元測試 — export_timeline.js（EDL/FCPXML 非破壞性匯出的純函式層）
// 跑法: node --test scripts/test/test_export_timeline.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildKeeps, secToTc, toEDL, toFCPXML } = require('../export_timeline.js');

test('buildKeeps：刪除段補集、夾邊界、忽略 <10ms 碎段', () => {
  const keeps = buildKeeps([{ start: 2, end: 4 }, { start: 8, end: 9 }], 10);
  assert.deepEqual(keeps, [
    { start: 0, end: 2 },
    { start: 4, end: 8 },
    { start: 9, end: 10 },
  ]);
  // 開頭就刪：不產生零長度段
  assert.deepEqual(buildKeeps([{ start: 0, end: 3 }], 10), [{ start: 3, end: 10 }]);
  // 刪到片尾：尾段不出現
  assert.deepEqual(buildKeeps([{ start: 8, end: 10 }], 10), [{ start: 0, end: 8 }]);
  // 沒刪任何東西：整片一段
  assert.deepEqual(buildKeeps([], 10), [{ start: 0, end: 10 }]);
});

test('secToTc：NDF 時碼換算（30fps 與 25fps）', () => {
  assert.equal(secToTc(0, 30), '00:00:00:00');
  assert.equal(secToTc(1.5, 30), '00:00:01:15');
  assert.equal(secToTc(61, 30), '00:01:01:00');
  assert.equal(secToTc(3600, 30), '01:00:00:00');
  assert.equal(secToTc(1.5, 25), '00:00:01:13'); // 1.5*25=37.5 → round 38 幀 = 1s 13f
});

test('secToTc：幀四捨五入不進位錯誤', () => {
  // 29.97 → 30 基底；0.999s * 30 = 29.97 → 30 幀 = 整秒進位
  assert.equal(secToTc(0.999, 29.97), '00:00:01:00');
});

test('toEDL：CMX3600 結構、record 連續、CRLF', () => {
  const keeps = [{ start: 1, end: 3 }, { start: 5, end: 6 }];
  const edl = toEDL(keeps, { fps: 30, title: '測試片', clipName: 'raw.mp4' });
  const lines = edl.split('\r\n');
  assert.equal(lines[0], 'TITLE: 測試片');
  assert.equal(lines[1], 'FCM: NON-DROP FRAME');
  // 事件 1：src 1s→3s，rec 0s→2s
  assert.match(edl, /001 {2}AX {7}B {5}C {8}00:00:01:00 00:00:03:00 00:00:00:00 00:00:02:00/);
  // 事件 2：src 5s→6s，rec 從 2s 接續（不留洞）
  assert.match(edl, /002 {2}AX {7}B {5}C {8}00:00:05:00 00:00:06:00 00:00:02:00 00:00:03:00/);
  assert.match(edl, /\* FROM CLIP NAME: raw\.mp4/);
});

test('toFCPXML：幀對齊有理數、asset-clip 數量、offset 連續', () => {
  const keeps = [{ start: 0, end: 2 }, { start: 4, end: 5.5 }];
  const xml = toFCPXML(keeps, {
    fpsNum: 30000, fpsDen: 1001, width: 1920, height: 1080,
    videoPath: 'E:\\影片\\原片.mp4', title: '成品', durationSec: 10,
  });
  assert.match(xml, /<fcpxml version="1\.9">/);
  assert.match(xml, /frameDuration="1001\/30000s"/);
  assert.equal((xml.match(/<asset-clip /g) || []).length, 2);
  // 第一段 0~2s：60 幀 → offset 0、duration 60*1001/30000
  assert.match(xml, /offset="0\/30000s" start="0\/30000s" duration="60060\/30000s"/);
  // 第二段 offset 接在第一段之後（60 幀）
  assert.match(xml, /offset="60060\/30000s"/);
  // 中文路徑進 file URL 也要合法（不含未轉義反斜線）
  assert.match(xml, /src="file:\/\/\//);
});

test('toFCPXML：標題與檔名 XML 轉義', () => {
  const xml = toFCPXML([{ start: 0, end: 1 }], {
    fpsNum: 30, fpsDen: 1, width: 1280, height: 720,
    videoPath: 'C:\\a\\b&c<d>.mp4', title: 'A&B "引號"', durationSec: 5,
  });
  assert.match(xml, /name="A&amp;B &quot;引號&quot;"/);
  assert.match(xml, /b&amp;c&lt;d&gt;\.mp4/);
  assert.ok(!/name="[^"]*<[^"]*"/.test(xml));
});

test('整數 fps（30/1）的 frameDuration 與時間值', () => {
  const xml = toFCPXML([{ start: 1, end: 2 }], {
    fpsNum: 30, fpsDen: 1, width: 1920, height: 1080,
    videoPath: 'x.mp4', title: 't', durationSec: 3,
  });
  assert.match(xml, /frameDuration="1\/30s"/);
  assert.match(xml, /start="30\/30s" duration="30\/30s"/);
});
