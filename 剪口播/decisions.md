# 剪口播 — 架構決策記錄（ADR）

> 這裡記錄的是「看起來奇怪但刻意為之」的設計決策。
> 看到相關代碼時不要自動重構，先讀這裡的原因。

---

## ADR-001：程式碼放 skills/，資料放 E:\自動剪輯\

**決策**：程式碼與設定在 `C:\...\skills\videocut-skills\剪口播\`；cut_work/ 和 output/ 在 `E:\自動剪輯\`。

**原因**：
- `E:\自動剪輯\` 是媒體製作工作目錄，影片大檔案不應進 git
- skills/ 是 Claude Code Skill 管理的位置，方便版本控制與 skill 路由
- 分離讓 git 只追蹤程式碼，不被大檔案污染

**影響**：每次開 session 需要確認工作目錄，CLAUDE.md 的入口導覽解決這個問題。

---

## ADR-002：silenceKeepSecs 用全域變數，不做 per-video

**決策**：`training_config.json` 的 `silence.threshold` 是全域參數，不針對單支影片調整。

**原因**：
- per-video 參數會讓訓練回饋資料碎片化，難以統計趨勢
- 使用者的影片錄製環境穩定（同一個麥克風、同一個房間），全域參數收斂後就夠用
- `apply_feedback.js` 的保守策略（單支影片 ±0.1s）就是為了讓全域參數慢慢收斂

**若需特例**：在 `用户习惯/` 新增個別影片設定，由腳本讀取覆蓋。

---

## ADR-003：A/B 對比模式用 abIndices，不開獨立 session

**決策**：A/B 對比在同一個 `execute-cut` 請求內完成，A 版用 `userSelected`，B 版用 `abIndices`（AI 原始建議）。

**原因**：
- 兩路影片的時間戳來源相同（同一份 `subtitles_words.json`），不需要兩次轉錄
- 避免重開 session 帶來的狀態管理複雜度
- B 版只是「使用者沒修改 AI 建議」的假設場景，用 abIndices 重新跑剪輯即可

**限制**：A/B 無法對比不同轉錄結果（那需要兩次完整 pipeline）。

---

## ADR-004：訓練回饋走 user_corrections.jsonl，不用資料庫

**決策**：使用者的修正記錄以 JSONL 追加寫入，不建 SQLite 或其他 DB。

**原因**：
- 影片數量有限（幾十支），JSONL 完全夠用且易讀易備份
- 不想為了少量資料引入 DB 依賴
- `ai_cut_pairs.js` 只讀最近 5 筆做 few-shot，不需要複雜查詢

**若資料量增加到 1000+ 支**：才考慮 SQLite。

---

## ADR-005：匯出支援 CUT_LOSSLESS=1 無損模式

**決策**：設定環境變數 `CUT_LOSSLESS=1` 可讓 `cut_video.sh` 改用 stream copy（-c copy）。

**原因**：
- 重編碼速度慢（NVENC 也要幾分鐘），測試 pipeline 時不需要高品質輸出
- 無損模式的幀邊界可能不精確（因 keyframe 位置），正式輸出時不用
- 用環境變數而非參數，是為了不改動 SKILL.md 的呼叫指令

---

## ADR-006：review_server.js 必須用，不能用 python http.server

**決策**：審核 UI 的靜態服務器固定使用 `review_server.js`，不接受其他替代。

**原因**：
- 影片播放需要 HTTP 206 Partial Content（Range 請求）支援
- `python3 -m http.server` 回傳完整 200，瀏覽器無法 seek 影片
- Node.js http 模組原生支援 Range，review_server.js 已實作

**注意**：啟動時不要用 shell 後台（`&`），用 `run_in_background` 參數讓 Claude 在背景處理。

---

## ADR-007：候選對模式（pair mode），不逐字掃描

**決策**：AI 分析以「候選對」（sentence pair）為單位，而非逐字或逐句推送給 AI。

**原因**：
- 逐字：token 數極高，一支 10 分鐘影片約 3000+ 字
- 候選對：用嵌入向量預篩後，通常只有 10–30 組，token 消耗降低 90%+
- 準確率實測：pair mode F1 = 96.83%，不比逐句模式差

**限制**：候選對相似度閾值（目前 0.30）若設太高，會漏掉某些口誤。`training_config.json` 的 `candidate_pair.similarity` 可調整。

---

## ADR-008：匯出後加 verify_export.js 驗證層，不靠人眼把關

**決策**：`cut_video.sh` 匯出成品後，由 `verify_export.js` 自動跑三項檢查（時長對帳 / 殘留長靜音 / 音畫漂移），結果接進 `review_server.js`、`training_server.js`，異常標記給使用者複查。

**原因**：
- pipeline 原本「匯出 → 直接進訓練」中間沒有成品自我驗證，剪壞了只能靠人從頭看才發現
- 借鑑 video-autopilot-kit/`delivery_qa.py` 的「匯出後自動 QA」模式，但**只取適用口播的檢查**：它那套頻閃 / 圖片黑邊是 CapCut 視覺合成缺陷，口播大頭影片不適用，故捨棄
- 三項檢查對應口播真正的缺陷型態：時長對不上＝concat/編碼 bug、殘留長靜音＝漏剪、音畫漂移＝剪接點 A/V drift
- silencedetect 在此是**驗收**用途（掃成品殘留），不是規劃用途（規劃階段已由 `silence.threshold` 處理），兩者不衝突

**邊界**：
- 時長對帳 = FAIL（會擋）；殘留靜音、音畫漂移 = WARN（標記不擋，因可能是刻意停頓）
- 獨立 CLI，可 `node verify_export.js --output ... --json` 單獨跑；`--json` 供 server 解析
- 容忍值：時長 ±0.5s、A/V 0.3s、殘留靜音門檻 1.5s（對齊 delivery_qa）

**不抄的部分**：video-autopilot-kit 的 `meta-lessons.md`（靜態 102 條給人讀）刻意不引入——`用户习惯/` + 訓練閉環已是其進化版（自動回灌 `training_config.json`），抄它是降級。
