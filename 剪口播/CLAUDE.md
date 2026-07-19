# 剪口播 — 程式碼 Repo 規則

> 資料工作區在 `E:\自動剪輯\`，本目錄是**程式碼與設定**。

---

## 強制規則（同 `E:\自動剪輯\rules\`）

所有 `E:\自動剪輯\rules\*.md` 視同本檔的強制規則，每次開工前必須讀取。

快速摘要：
1. **重大變更前先 git 備份** — `git add -A && git commit -m "backup before <change>"`
2. **改碼門檻：L2 回歸（輸出 diff=0）+ L4 成品驗證** — F1/訓練層已於 2026-06-30 退役，不再跑 L1 F1 煙霧測試。詳見 `重構計畫_介面三格化.md`
3. **新規則寫入 `E:\自動剪輯\rules\NN-主題.md`**，不改主 CLAUDE.md

---

## 目錄結構

```
剪口播/
├── CLAUDE.md           ← 本檔
├── SKILL.md            ← 完整使用流程（Skill 入口）
├── training_config.json ← 所有可調參數（source of truth）
├── training_manifest.json
├── design.md           ← Pipeline 架構圖與設計原因
├── testing.md          ← 測試三層策略
├── decisions.md        ← ADR（架構決策記錄）
├── glossary.md         ← 術語表
├── editing_skills.md   ← AI 學習到的剪輯規律
├── polishing_skills.md ← 潤稿規律
├── feedback_history.jsonl
├── scripts/            ← 所有 Node.js / Python / Bash 腳本
├── prompts/            ← AI prompt 模板
├── 用戶習慣/           ← 使用者偏好規則（10-保留連接詞.md 等）
├── training_output/    ← 訓練輸出（.gitignore 排除）
└── backups/            ← 手動備份快照
```

---

## Pipeline 五階段

```
1. 轉錄
   byteplus_transcribe.py（--ddc off 逐字稿；憑證見 scripts/.env）
   輸入: audio.mp3（必須單聲道 -ac 1 -ar 16000）
   輸出: subtitles_words.json（含 isGap）
   （google_transcribe.py / whisper 系列僅備援；reference.txt 只餵 flag_against_reference.js 高亮疑似聽錯，不改寫）

2. 分析
   ai_polish.js → phrase_prefilter.js → ai_cut_pairs.js → convert_ai_to_indices
   ＋機械偵測層：detect_retakes（exact/fuzzy 重錄）、detect_coughs_ml、detect_redundancy（語意重複）、
   vad_guard.py＋vad_hallucination.js（VAD 反幻覺守門：抓「音訊層沒人說話、STT 卻出字」，
   四層＝VAD 語音區→字級覆蓋率→黑名單/重複過濾→信心閘門，借鑑 arkiv；2026-07-16）
   （auto_select_rules.js 已標 legacy，僅訓練層用；見 規則引擎盤點_2026-07.md）
   輸入: subtitles_words.json + training_config.json + 用戶習慣/
   輸出: auto_selected.json（含 reasons；所有內容決策進審核頁預選＝WYSIWYG）

3. 審核 UI
   generate_review_doc.js + training_server.js（port 8900，路由 /review/<name>）
   輸入: subtitles_words.json + auto_selected.json
   輸出: 純白文稿審核頁（使用者在瀏覽器確認/修改後匯出）
   審核頁「🔍 接縫冷讀」按鈕：POST /api/seam-coldread/<name> → seam_coldread.js 把當前保留稿丟 Claude
   冷讀，標出剪接後接不順的縫（黃色波浪線）。純建議層＝只叫使用者救回被剪句或接受，絕不自動刪。

4. 匯出
   /api/cut/<name> → gap 橋接（bridge_gap_deletes）→ refine_segments（壓平/吸附/刀口原子化）→ cut_video.sh
   輸出: <成品名>/ 子資料夾（mp4 + srt + txt + timeline_map.json + edl + fcpxml）
   非破壞性時間軸（export_timeline.js，2026-07-16）：mp4 與剪映草稿兩條路徑都順手多產
   <成品名>.edl（CMX3600）＋ .fcpxml（1.9），引用原片＋剪點，Resolve/Premiere 匯入可微調每刀；
   失敗只記 log 不擋出片，timeline_export.enabled=false 可關
   ⭐ 三邊逐字一致：審核頁匯出帶 deletedIndices（字級選集），影片(refine Step C)、SRT、TXT 都以它為準——
   不再各自用「發音區 >50% 時間重疊」反推（重錄密集處會翻掉短邊界字：多「長」掉「病」）。
   SRT 斷句：預設讓 Claude 依意群斷行（subtitle_segment_llm.js，只斷不改字、去換行後逐字比對原稿，
   不符自動退回機械斷句；config.subtitle_llm.enabled=false 就純機械）；機械版照 domi-subtitle-format
   橫式長片（短行、只斷標點、去行末標點、頓號清單不拆）。剪映草稿：srt/txt 另存到使用者輸出資料夾。

5. 回饋閉環
   F1/自動優化層退役（2026-06-30）。輕量回饋：匯出時 user_corrections.js 把「AI 多刪你留(FP)/你補刪
   AI 沒抓(FN)」寫進 training_output/user_corrections.jsonl，下支 ai_cut_pairs(few-shot)＋ai_polish_review(負例庫)
   讀最近幾筆校準。另有口頭回報 → 規則檔（用戶習慣/）。退役訓練腳本在 scripts/legacy/
```

---

## 關鍵腳本速查

| 腳本 | 用途 |
|------|------|
| `training_server.js` | 唯一服務器（port 8900）：剪輯頁 `/` + 審核頁 `/review/<name>` + 匯出 `/api/cut/<name>`。2026-07-03 瘦身 7287→1291 行，訓練層/舊深色頁 API 已全數移除 |
| `ai_cut_pairs.js` | 核心 AI 分析：讀 few-shot 候選對，判斷刪/留 |
| `detect_retakes.js` | 重錄偵測（exact + fuzzy，含 whisper 幻覺守門） |
| `detect_coughs_ml.py` | 咳嗽/清喉 ML 分類（AST audioset） |
| `detect_redundancy.py` | 語意重複偵測（sentence-transformers / 3-gram fallback） |
| `vad_guard.py` | VAD 語音活動偵測（silero-vad onnx，CPU 數秒）→ 2_分析/vad_regions.json，反幻覺守門 L1 |
| `vad_hallucination.js` | 反幻覺守門 L2~L4 純函式：轉錄字 vs VAD 語音區交叉比對，信心閘門後進審核頁預選 |
| `export_timeline.js` | 非破壞性時間軸匯出：刪除段補集 → EDL（CMX3600）＋ FCPXML（1.9），兩條匯出路徑都順手產 |
| `refine_segments.js` | 苦工層：停頓壓平/切點吸附/刀口原子化 |
| `bridge_gap_deletes.js` | 手動刪除梳齒橋接（audit #4） |
| `merge_delete_segments.js` | MERGE_GAP 合併唯一實作（ffmpeg/SRT/TXT/verify 四方共用） |
| `cut_video.sh` | ffmpeg 幀級精確剪輯，自動偵測原片參數；落地 timeline_map.json |
| `verify_export.js` | 成品驗證（時長對帳/殘留靜音/逐字對帳） |
| `seam_coldread.js` | 接縫冷讀：保留稿丟 Claude 冷讀剪接縫（指代斷裂/邏輯跳接/話題突兀）；純函式+CLI，審核頁 /api/seam-coldread 呼叫 |
| `ai_narrative_cut.js` | 敘事層決策 v2（ADR-009）：吃原始時間戳證據文稿（停頓＝重錄證據）＋規則層已刪標記，輸出 idx 範圍決策聯集合併；留後刪前、>25% 中止 |
| `ai_review_cut.js` | 獨立審核員：對最終選集盲審（漏剪/錯剪/接縫），出 review_report.md/json，純建議不動刀 |
| `subtitle_segment_llm.js` | 字幕 LLM 意群斷行：保留稿丟 Claude 只斷行不改字（逐字驗證＝原稿才採用，不符退回機械）；generate_cut_srt `--llm-segment` 呼叫 |
| `aggregate_reasons.js` | 跨影片聚合 auto_selected 的刪除理由 → 錄影前提詞紀律.md（你最常繞的幾種重複，附自己講過的例子）。非 pipeline，離線工具 |
| `reason_taxonomy.js` | 刪除理由分類法（單一真相）：家族/是否繞圈/樣板正規化；aggregate_reasons 用 |
| `user_corrections.js` | 匯出時把 AI 預選 vs 你最終勾選的落差(FP/FN)寫進 user_corrections.jsonl（few-shot 回饋迴路，2026-07-04 接回） |
| `kept_words.js` | 「哪些字算保留」單一真相：`keptWordsByIndex`(index 為準)＋`isWordKept`(發音區 >50%，退回用) |
| `compare_transcriptions.js` | L2 回歸工具：對照兩份轉錄結果 |
| `scripts/legacy/` | 退役訓練層腳本歸檔（batch_train、ai_evaluate_training 等，見其 README） |

---

## 資料流關鍵檔案（Source of Truth）

| 檔案 | 說明 |
|------|------|
| `training_config.json` | 所有可調參數；每次剪輯後可自動微調 |
| `subtitles_words.json` | 字級字幕陣列，含 isGap 標記；pipeline 核心數據結構 |
| `auto_selected.json` | 刪除索引列表；支援 `[idx]` 或 `{indices, reasons}` 兩格式 |
| `user_corrections.jsonl` | 使用者修正記錄；`ai_cut_pairs.js` 讀最近 5 筆注入 few-shot |
| `用戶習慣/10-保留連接詞.md` | 永遠不刪的詞；`validate_selection.js` 會校驗 |

---

## 目前狀態基線（2026-07-03）

- F1 已退役（2026-06-30），改碼門檻＝L2 回歸 + L4 成品驗證 + L3 單元測試（8 套全綠）
- training_server.js 瘦身至 ~1300 行；舊深色頁（waveform/批次/保護詞 UI）與訓練層 API 已移除，退役腳本在 scripts/legacy/
- 缺陷審查 2026-07-02 十四條全數處置完畢（見 E:\自動剪輯\缺陷審查_2026-07-02.md）
- git 已有 origin/main，每次重大變更前先 commit

---

## 常見問題

**Q: 審核頁（training_server.js, 8900）為何不能用靜態檔案伺服器替代？**
A: 審核頁是動態產生（讀 auto_selected/subtitles 即時渲染），匯出/重跑 AI 都是 POST API；不是靜態頁。（舊答案的 Range 影片播放已隨深色頁移除）

**Q: auto_selected.json 讀到 object 還是 array？**
A: 兩格式向下兼容：是陣列 → 直接用；是物件 → 讀 `.indices`。所有腳本都處理了這個分歧。

**Q: 靜音閾值在哪調？**
A: `training_config.json` → `silence.threshold`（目前 1.85s）。不要直接改，讓 `apply_feedback.js` 自動微調。
