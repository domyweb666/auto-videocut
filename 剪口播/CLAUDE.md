# 剪口播 — 程式碼 Repo 規則

> 資料工作區在 `E:\自動剪輯\`，本目錄是**程式碼與設定**。

---

## 強制規則（同 `E:\自動剪輯\rules\`）

所有 `E:\自動剪輯\rules\*.md` 視同本檔的強制規則，每次開工前必須讀取。

快速摘要：
1. **重大變更前先 git 備份** — `git add -A && git commit -m "backup before <change>"`
2. **修改前先跑 L1 煙霧測試** — `node scripts/ai_evaluate_training.js --sample 8`（F1 ≥ 96%）
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
   google_transcribe.py / whisper_transcribe.sh
   輸入: audio.mp3
   輸出: google_result.json → subtitles_words.json

2. 分析
   generate_subtitles.js → auto_select_rules.js → ai_cut_pairs.js
   輸入: subtitles_words.json + training_config.json + 用户习惯/
   輸出: auto_selected.json（含 reasons）+ 口誤分析.md

3. 審核 UI
   generate_review.js + review_server.js（port 8899）
   輸入: subtitles_words.json + auto_selected.json + 原片
   輸出: review.html（使用者在瀏覽器確認/修改）

4. 匯出
   cut_video.sh（ffmpeg NVENC）
   輸入: 使用者 userSelected + subtitles_words.json
   輸出: _cut.mp4 + _cut.srt + user_corrections.jsonl（訓練資料）

5. 訓練回饋閉環
   apply_feedback.js → training_server.js（port 8900）
   輸入: diff_report.json + user_corrections.jsonl
   輸出: training_config.json（更新）+ training_output/training_report.md
```

---

## 關鍵腳本速查

| 腳本 | 用途 |
|------|------|
| `ai_cut_pairs.js` | 核心 AI 分析：讀 few-shot 候選對，判斷刪/留 |
| `ai_evaluate_training.js` | 訓練評估（--sample N --use-pair-mode），產出 F1 |
| `compare_transcriptions.js` | 對照兩份轉錄結果，計算 per-category P/R/F1 |
| `review_server.js` | 審核 UI 服務器（port 8899），支援 Range 請求 |
| `training_server.js` | 訓練看板服務器（port 8900） |
| `cut_video.sh` | ffmpeg 幀級精確剪輯，自動偵測原片參數 |
| `srt_reverse_align.js` | 反向 SRT 對齊：從字幕推算 deleteIndices |
| `apply_feedback.js` | 將使用者修正寫回 training_config.json |
| `batch_train.js` | 批次訓練協調器 |
| `detect_redundancy.py` | 語意重複偵測（sentence-transformers / 3-gram fallback） |

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

## 目前狀態基線（2026-04-24）

- 合併 F1：**96.83%**
- 已完成：Sprint 1–3 共 11 項功能（VAD、候選對、waveform、保護詞、SRT 反向、A/B、批次）
- git 已有 origin/main，每次重大變更前先 commit

---

## 常見問題

**Q: review_server.js 為何不能用 python -m http.server 替代？**
A: 影片播放依賴 HTTP Range 請求（206 Partial Content），python 簡易服務器不支援。→ ADR-006

**Q: auto_selected.json 讀到 object 還是 array？**
A: 兩格式向下兼容：是陣列 → 直接用；是物件 → 讀 `.indices`。所有腳本都處理了這個分歧。

**Q: 靜音閾值在哪調？**
A: `training_config.json` → `silence.threshold`（目前 1.85s）。不要直接改，讓 `apply_feedback.js` 自動微調。
