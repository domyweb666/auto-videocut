# 剪口播 — 測試策略

> 配合規則 01：修改前先跑測試建立基線，修改後對比確認無回歸。

---

## 測試三層

### L1 — 煙霧測試（所有修改必跑）

```bash
cd "C:\Users\fcharlie\.claude\skills\videocut-skills\剪口播\scripts"
node ai_evaluate_training.js --sample 8 --use-pair-mode
```

**通過門檻**：合併 F1 ≥ 96%（基線 96.83%）
**耗時**：約 30–60 秒
**用途**：快速確認 AI 判斷能力沒有退化

記錄格式（寫入 commit message 或告知使用者）：
```
修改前 F1: 96.83%
修改後 F1: 96.85%  ✅ 通過
```

若 F1 下降 > 0.5%（< 96.33%）：停下，告知使用者，不繼續合入。

---

### L2 — 回歸測試（修改 pipeline 核心時必跑）

核心腳本定義：`ai_cut_pairs.js`、`auto_select_rules.js`、`generate_subtitles.js`、`cut_video.sh`、`review_server.js`

```bash
cd "C:\Users\fcharlie\.claude\skills\videocut-skills\剪口播\scripts"

# 用 cut_work/ 下的已有 fixture 比對輸出
node compare_transcriptions.js \
  "E:/自動剪輯/cut_work/2026-03-03 22-40-35/2_分析/auto_selected.json" \
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

目前尚未建立 `scripts/test/` 目錄。

純函式候選（適合寫 node:test）：
- `srt_reverse_align.js` — 反向對齊邏輯
- `compare_transcriptions.js` — F1 計算邏輯
- `rule_utils.js` — 規則工具函式

**建立方式**（當規則 01 觸發時）：
```bash
mkdir scripts/test
# 建 scripts/test/srt_reverse_align.test.js 等
node --test scripts/test/
```

---

### L4 — 匯出後成品驗證（每次匯出自動跑）

`verify_export.js` 在每次剪輯匯出後由 `review_server.js` / `training_server.js` 自動呼叫，
驗證「成品本身」是否符合預期（前三層驗證的是 AI 判斷與分析輸出，這層驗證實際 ffmpeg 產物）。

```bash
# 也可手動單獨跑（任何 _cut.mp4 都行）
node verify_export.js --output <cut.mp4> --input <原片> --delete <delete_segments.json>
```

| 檢查 | 等級 | 門檻 |
|------|------|------|
| 時長對帳（keepSegs 預計 vs ffprobe 實際） | **FAIL** | 落差 > 0.5s |
| 殘留長靜音（silencedetect 掃成品） | WARN | -30dB / > 1.5s（排除頭尾 1.2s） |
| 音畫漂移（video 流 vs audio 流時長） | WARN | 差 > 0.3s |

**退出碼**：0 = 通過（含 warn）／2 = 有 FAIL／3 = `--strict` 下有 warn。
**advisory**：驗證問題只記 log、塞進 API 回應，**不阻斷**已完成的匯出（成品已產出，由人決定要不要重剪）。
門檻常數集中在 `verify_export.js` 檔頭（`TOL_DURATION` / `SILENCE_MIN` / `AV_DRIFT_TOL`）。

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
