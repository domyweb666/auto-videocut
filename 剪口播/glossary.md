# 剪口播 — 術語表

新 session 或新成員第一次接觸這個專案時，先讀這份。

---

| 術語 | 定義 | 出現在哪 |
|------|------|----------|
| **口播** | 人物對著鏡頭說話的影片類型（vlog/教學/說書），沒有 B-roll 遮蓋，口誤剪輯要求高 | 整個專案 |
| **idx** | `subtitles_words.json` 的陣列索引，是全 pipeline 操作的唯一 key。注意：行號 ≠ idx | 所有腳本 |
| **isGap** | `subtitles_words.json` 中的靜音段標記（`isGap: true`），不含文字但有時間戳 | `subtitles_words.json`、`auto_select_rules.js` |
| **auto_selected** | AI 建議的刪除 idx 集合（`auto_selected.json`），使用者可在審核 UI 修改 | `2_分析/auto_selected.json` |
| **userSelected** | 使用者在審核 UI 確認/修改後的最終刪除 idx 集合，傳給 `execute-cut` | `review_server.js` |
| **abIndices** | A/B 對比模式的 B 版索引，等同於「未修改的 AI 原始建議」 | `review_server.js` |
| **deleteIndices** | 泛稱「要刪除的 idx 列表」，在 SRT 反向對齊語境下特指從字幕反推的結果 | `srt_reverse_align.js` |
| **candidate pair / 候選對** | 兩個語意相似的句子組合，用來讓 AI 判斷是否為重複口誤 | `ai_cut_pairs.js`、`training_config.json` |
| **gap** | 靜音段（同 isGap），在審核 UI 上顯示為橘色標記 | `review.html`、`review_server.js` |
| **trim / silenceKeepSecs** | 剪掉靜音時保留的緩衝時間（0–1.5s），避免剪得太緊 | `training_config.json`、action bar slider |
| **VAD** | Voice Activity Detection（語音活動偵測），用 ffmpeg `silencedetect` 實現；Whisper 備用路徑的前置分段步驟 | `whisper_transcribe.sh` |
| **F1** | 分類模型的 F1 分數（2×P×R/(P+R)），此處指「AI 刪除建議 vs 使用者實際刪除」的吻合程度。目前基線 96.83% | `ai_evaluate_training.js`、`compare_transcriptions.js` |
| **few-shot** | 把最近幾筆真實案例注入 prompt，讓 AI 的判斷符合使用者風格 | `ai_cut_pairs.js`（讀 user_corrections.jsonl 最近 5 筆） |
| **保護詞 / protected words** | 永遠不能刪的詞（例如連接詞「但是」「就是說」），存在 `用戶習慣/10-保留連接詞.md` | `validate_selection.js`、`review_server.js` |
| **SRT 反向對齊** | 從人工剪輯好的 SRT 字幕反推 deleteIndices，用來快速導入歷史剪輯資料做訓練 | `srt_reverse_align.js` |
| **A/B 對比模式** | 同一支影片同時輸出 A 版（使用者修改後）和 B 版（AI 原始建議），方便比較效果 | `review_server.js`、匯出 modal |
| **sanity check** | 匯出前的合理性檢查：顯示「將刪除 X%（Ym→Zm）」，>50% 或保留 <30s 顯示橘色警示 | 匯出 modal |
| **waveform** | 音波圖，`GET /api/waveform` 用 ffmpeg astats 產生 RMS 陣列，前端 canvas 繪製 | `review_server.js`、`review.html` |
| **batch_queue** | 批次處理佇列，`batch_queue.json` 持久化，伺服器重啟可恢復 | `review_server.js`、`batch_queue.json` |
| **diff_report.json** | 記錄「AI 建議」vs「使用者最終選擇」的差異，是訓練回饋的原始資料 | `2_分析/diff_report.json` |
| **NVENC** | NVIDIA 硬體 H.264 編碼器，`cut_video.sh` 優先使用，無 NVIDIA 顯卡時 fallback 到 libx264 | `cut_video.sh` |
| **lossless / CUT_LOSSLESS** | 環境變數，設為 1 時 `cut_video.sh` 改用 stream copy（不重新編碼），速度快但幀邊界不精確 | `cut_video.sh` |
| **training_config.json** | 所有可調參數的唯一來源（靜音閾值、重複句前綴長度等），每次 pipeline 都載入 | `training_config.json` |
