# 剪口播 — 測試策略

> 配合規則 01：修改前先跑測試建立基線，修改後對比確認無回歸。

---

## 測試三層

### L1 — 煙霧測試（F1）⚠️ 已退役（2026-06-30）

F1 / 訓練層已退役，**不再是改碼門檻**。改碼門檻改用 L2（輸出 diff）+ L4（成品驗證），見規則 `rules/01-test-before-modify.md`。

`ai_evaluate_training.js` 腳本與訓練資料保留未刪，但不再要求每次修改前後跑。換 BytePlus 引擎後舊 F1 基線（96.83%）已半失效。

---

### L2 — 回歸測試（修改 pipeline 核心時必跑）

核心腳本定義：`ai_cut_pairs.js`、`auto_select_rules.js`、`generate_subtitles.js`、`cut_video.sh`、`review_server.js`

```bash
cd <本 repo>/scripts

# 用 cut_work/ 下的已有 fixture 比對輸出
node compare_transcriptions.js \
  "<資料工作區>/cut_work/<批次名>/2_分析/auto_selected.json" \
  <新跑出的 auto_selected.json>
```

**通過門檻**：輸出差異 = 0（無意外新增或移除的 idx）
**若有差異**：用 `diff_report.json` 確認每個差異是預期行為還是回歸

目前可用的 fixture 批次：
- `cut_work/2026-03-03 22-40-35/` — 有 `delete_segments.json`（黃金答案）
- `cut_work/2026-03-03 23-00-42/`
- `cut_work/2026-03-04 00-03-10/`

---

### L3 — 單元測試（修改純函式時）

現有測試檔（在 `scripts/` 根目錄，直接 `node <檔名>` 跑）：
- `refine_segments.test.js` — 停頓壓平/切點吸附/刀口原子化/文意分流（25 案例）
- `detect_retakes.test.js` — 重錄 exact/fuzzy/遠距/near-exact/幻覺守門（19 案例）
- `merge_delete_segments.test.js` — MERGE_GAP 合併（12 案例）

```bash
cd scripts
node refine_segments.test.js; node detect_retakes.test.js; node merge_delete_segments.test.js
```

純函式候選（尚未覆蓋）：`srt_reverse_align.js`、`compare_transcriptions.js`、`rule_utils.js`、`kept_words.js`

---

### L4 — 匯出後成品驗證（每次匯出自動跑）

`verify_export.js` 在每次剪輯匯出後由 `review_server.js` / `training_server.js` 自動呼叫，
驗證「成品本身」是否符合預期（前三層驗證的是 AI 判斷與分析輸出，這層驗證實際 ffmpeg 產物）。

```bash
# 也可手動單獨跑（任何 _cut.mp4 都行）
node verify_export.js --output <cut.mp4> --input <原片> --delete <delete_segments.json> \
  [--srt <cut.srt> --subtitles <subtitles_words.json> --silences <silences.json>]
```

| 檢查 | 等級 | 門檻 |
|------|------|------|
| 時長對帳（keepSegs 預計 vs ffprobe 實際） | **FAIL** | 落差 > 0.5s |
| 殘留長靜音（silencedetect 掃成品） | WARN | -30dB / > 1.5s（排除頭尾 1.2s） |
| 音畫漂移（video 流 vs audio 流時長） | **FAIL**（2026-07-03 由 WARN 升級） | 差 > 0.3s |
| 逐字對帳（SRT 文字 vs 保留字，2026-07-03 新增） | **FAIL** | 一字之差即 FAIL |

**逐字對帳（2026-07-03）**：SRT 實檔文字必須等於用同一份 subtitles_words + 刪除清單
（`kept_words.js` 規則：發音區被刪 >50% 才丟字）算出的保留字串。抓接線層 bug——SRT 用到舊
刪除檔、外部改過 SRT、去留規則不同源。`kept_words.js` 是「哪些字算保留」的**單一事實來源**，
`generate_cut_srt.js` / `generate_cut_txt.js` / `verify_export.js` / `refine_segments.js`
（Step C 刀口原子化）四個消費者共用。training_server 匯出時自動帶 `--srt/--subtitles/--silences`。

**timeline_map（2026-07-02）**：成品每個保留段實際長度 ≠ 理想長度（單趟路徑 concat filter
每段推進 max(影片段長, 音訊段長)，影片長受 frame 邊界/VFR 抖動；多段路徑 frame 進位 + AAC
priming），段數一多累積成秒級——這是物理現象不是 bug。`cut_video.sh` 匯出後由
`build_timeline_map.js` 在成品旁落地 `<成品名>.timeline_map.json`（理想 src → 成品 dst 分段
映射，映射總長 == ffprobe 實測）。有 map 時：時長對帳改比「**預測(Σ每段推進) vs 實測**」
（仍能抓真 concat bug，如 AAC priming 累積靜音），「理想 vs 實測」降為 info；
`generate_cut_srt.js` 自動吃 map 校正字幕時間戳（無 map 退回理想時間軸，行為同舊版）。

**退出碼**：0 = 通過（含 warn）／2 = 有 FAIL／3 = `--strict` 下有 warn。
**advisory**：驗證問題只記 log、塞進 API 回應，**不阻斷**已完成的匯出（成品已產出，由人決定要不要重剪）。
門檻常數集中在 `verify_export.js` 檔頭（`TOL_DURATION` / `SILENCE_MIN` / `AV_DRIFT_TOL`）。
**MERGE_GAP 單一來源**（2026-07-02，audit P0#1）：時長對帳的刪除段合併規則不再自帶複製品，
改 require `merge_delete_segments.js` —— 與 `cut_video.sh`（落地 `*.final.json`）、
`generate_cut_srt.js`、`generate_cut_txt.js` 四個消費者同一份實作。
對應單元測試：`node merge_delete_segments.test.js`（12 案例，含 SRT 端到端不漂移驗證）。

---

## 測試觸發決策表

| 修改類型 | L1 | L2 | L3 |
|----------|----|----|-----|
| 任何修改 | ✅ 必跑 | — | — |
| 修改 pipeline 核心腳本 | ✅ | ✅ | — |
| 修改純函式模組 | ✅ | — | ✅ |
| 只改 UI（review_server 前端） | ✅ | — | — |
| 修改 training_config.json | ✅ | — | — |
| 修改 `verify_export.js` 或匯出後驗證接線 | — | L4 手動跑一次成品驗證即可 | — |

---

## 尚未覆蓋的盲區

- `cut_video.sh` 的實際剪輯輸出 → **L4 已部分覆蓋**（時長對帳 / 殘留靜音 / 音畫漂移），但畫面內容正確性仍靠人工
- `detect_redundancy.py` 的語意重複準確率（依賴 sentence-transformers）
- waveform API 的 RMS 值正確性

這些盲區已知，未自動化，靠 SKILL.md 的人工驗證步驟覆蓋。
