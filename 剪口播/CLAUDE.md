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
├── 用户习惯/           ← 使用者偏好規則（10-保留連接詞.md 等）
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
   ＋機械偵測層：detect_retakes（exact/fuzzy 重錄）、detect_coughs_ml、detect_redundancy（語意重複）
   （auto_select_rules.js 已標 legacy，僅訓練層用；見 規則引擎盤點_2026-07.md）
   輸入: subtitles_words.json + training_config.json + 用户习惯/
   輸出: auto_selected.json（含 reasons；所有內容決策進審核頁預選＝WYSIWYG）

3. 審核 UI
   generate_review_doc.js + training_server.js（port 8900，路由 /review/<name>）
   輸入: subtitles_words.json + auto_selected.json
   輸出: 純白文稿審核頁（使用者在瀏覽器確認/修改後匯出）

4. 匯出
   /api/cut/<name> → gap 橋接（bridge_gap_deletes）→ refine_segments（壓平/吸附/刀口原子化）→ cut_video.sh
   輸出: <成品名>/ 子資料夾（mp4 + srt + txt + timeline_map.json）

5. （已退役 2026-06-30）訓練回饋閉環
   F1/自動優化層退役；回饋改「口頭回報 → 規則檔（用户习惯/）」。退役腳本在 scripts/legacy/
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
| `refine_segments.js` | 苦工層：停頓壓平/切點吸附/刀口原子化 |
| `bridge_gap_deletes.js` | 手動刪除梳齒橋接（audit #4） |
| `merge_delete_segments.js` | MERGE_GAP 合併唯一實作（ffmpeg/SRT/TXT/verify 四方共用） |
| `cut_video.sh` | ffmpeg 幀級精確剪輯，自動偵測原片參數；落地 timeline_map.json |
| `verify_export.js` | 成品驗證（時長對帳/殘留靜音/逐字對帳） |
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
| `用户习惯/10-保留連接詞.md` | 永遠不刪的詞；`validate_selection.js` 會校驗 |

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
