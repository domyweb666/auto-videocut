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

## 測試觸發決策表

| 修改類型 | L1 | L2 | L3 |
|----------|----|----|-----|
| 任何修改 | ✅ 必跑 | — | — |
| 修改 pipeline 核心腳本 | ✅ | ✅ | — |
| 修改純函式模組 | ✅ | — | ✅ |
| 只改 UI（review_server 前端） | ✅ | — | — |
| 修改 training_config.json | ✅ | — | — |

---

## 尚未覆蓋的盲區

- `cut_video.sh` 的實際剪輯輸出（需要真實影片，不易自動化）
- `detect_redundancy.py` 的語意重複準確率（依賴 sentence-transformers）
- waveform API 的 RMS 值正確性

這些盲區已知，未自動化，靠 SKILL.md 的人工驗證步驟覆蓋。
