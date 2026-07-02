# legacy/ — 退役腳本歸檔

2026-07-03 依缺陷審查 #12 歸檔。這些腳本屬於已退役的 F1 訓練/自動優化層
（2026-06-30 定案退役，見 rules/01 與 memory 的 videocut-direction-2026-06），
或已被證偽的實驗（ai_full_edit 實測 F1=4.86%）。

| 檔案 | 原用途 |
|------|--------|
| batch_train.js / aggregate_training.js | 批次訓練與統計聚合 |
| auto_optimize.js / autoresearch.js | 自動優化迴路 |
| ai_evaluate_training.js | L1 F1 煙霧測試（已退役門檻） |
| ai_skills_autoresearch.js | 技能自動研究 |
| align_corrected.js | gpt-4o 校正稿 NW 對齊（校正層已整個移除，無呼叫者） |
| ai_full_edit.js / compare_full_edit_f1.js / compare_layered_f1.js | 整段 AI 編輯實驗與三方對比 |
| generate_review.js | 舊深色審核頁（53KB；唯一活函式 parseAutoSelected 已抽到 ../parse_auto_selected.js） |

注意：歸檔後檔案內的相對 require（如 `./compare_transcriptions`）不再解析，
這些腳本**不能直接執行**。要復活請 `git mv` 回 scripts/ 並修 require 路徑。
