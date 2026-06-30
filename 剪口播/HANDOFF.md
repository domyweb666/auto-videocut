# HANDOFF — 剪口播（2026-06-30）

下個對話接手先讀這份 + memory（byteplus-seedasr-api、videocut-direction-2026-06）。

## 這個 session 做完的（都已 commit / push）

1. **轉錄引擎換 BytePlus Seed Speech**（取代 gpt-4o+whisper）→ `scripts/byteplus_transcribe.py`。端點/認證/熱詞結論見 memory `byteplus-seedasr-api`。金鑰在 `scripts/.env` 的 `BYTEPLUS_API_KEY`。
2. **Phase 0 退役 F1/訓練層**：改碼門檻從 L1 F1 改成 L2+L4（`rules/01-test-before-modify.md`、`testing.md`、`CLAUDE.md`）。
3. **Phase 4 疑似聽錯標記**：`scripts/flag_against_reference.js`（NW 對齊辨識稿 vs `reference.txt`，pinyin-pro 判同音字 → `_suspect`+`_refHint`）。**有講稿才跑**。
4. **Phase 3 下架訓練 UI**：`training_server.js` 的 `train-bar` 整塊 `display:none`。
5. **Phase 1 回饋迴路**：`scripts/apply_corrections.js` + `用户习惯/錯字修正表.json` + `用户习惯/回饋紀錄.md`（路由表：哪種回報改哪個機器讀的規則檔）。
6. **白底文稿審核頁** `scripts/generate_review_doc.js`（模組 `buildReviewDoc(words, autoSelected, autoReasons, {cutApiPath})`）：純白、無影片無聲音、標點分段、橘/紅刪除線、紅底線疑似聽錯、N 鍵跳疑點、一鍵匯出。已接進 8900 `/review/<name>`（取代舊 `buildReviewHtml`）。
7. **原生選檔** `GET /api/native-browse`（PowerShell OpenFileDialog，回傳路徑）。
8. **白色簡潔 /cut 頁** `training_server.js` 的 `CUT_DOC_HTML` const（無影片預覽、丟檔→處理→進度→前往審核）。

## 還沒做（下一步，最重要）

**真實端到端測試還沒跑通確認。** 使用者正要拿一支影片從 `/cut` 跑完整條（處理→審核→匯出），尚未回報結果。下個對話第一件事：問測試結果，或一起跑一支影片，盯這幾個新接點會不會卡：
- BytePlus 轉錄（base64 本機檔，長影片要看 timeout）
- `apply_corrections` 套錯字表（目前表是空的）
- `flag_against_reference`（要有 `reference.txt` 才會標）
- **AI 分析階段**（`auto_select_rules` + `ai_cut_pairs`）— 這塊沒動，但要確認沒被連帶影響
- `/cut` 進度輪詢（靠 `cutState.running===false` 判完成）+ 前往審核連結（`/review/<basename>`）+ 白底審核頁 + 匯出 `POST /api/cut/<name>`

## 環境狀態（重要）

- **8900 training_server 目前在背景跑**（我用 `Start-Process node training_server.js` 啟動，cwd=scripts）。改了碼要重啟才生效：找 port 8900 的 PID → `Stop-Process` → 重新 `Start-Process`。
- 8899 review_server 也還開著（我拿來預覽白底版的，可關）。
- 使用者實際走 **8900**：`/cut` 處理 → 「🔍 審核」按鈕 → `/review/<name>`。

## 舊版備援（未刪，可 revert）

`generate_review.js`（深色審核）、`CUT_HTML`（深色 /cut，const 還在只是路由沒指它）、`transcribe_pipeline.py`（gpt-4o+whisper）、`google_transcribe.py`、`openai_transcribe.py` 都保留。

## 整體計畫

`重構計畫_介面三格化.md`（三格介面 + 退役 F1 + 回饋迴路，全 Phase 標完成）。
