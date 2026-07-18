# auto-videocut 剪口播

把一鏡到底的口播毛片丟進去，AI 幫你剪掉吃螺絲、重錄、語氣詞、咳嗽和長靜音，你在瀏覽器裡逐字確認每一刀，然後匯出成品 mp4、SRT 字幕，以及可進 Resolve / Premiere / 剪映微調的時間軸檔。

這是我（多米）自己每支影片都在用的工具，開源出來給同樣錄口播的人。它是一套 Node + Python 腳本加一個本機網頁看板，環境要自己裝；AI 判斷花的是你自己的額度——Claude 訂閱、ChatGPT 訂閱、或自填 API key 三選一，在看板的「⚙️ AI 與金鑰設定」裡切換。金鑰只存你本機的 `scripts/.env`，這個專案不經手。

主力是 `剪口播/`。旁邊的 `字幕/`、`高清化/`、`安装/`、`自进化/` 是早期版本留下的輔助 skill，還能用但我沒在維護，說明以 `剪口播/` 為準。

## 運作方式

```
毛片 mp4
  → 轉錄成字級時間戳（BytePlus 或本機 Whisper）
  → AI 分析該刪什麼（重錄、語氣詞、語意重複、咳嗽、幻覺字）
  → 瀏覽器審核頁逐字確認（AI 只預選，你說了算）
  → ffmpeg 幀級剪輯匯出
```

匯出時 AI 預選和你最終勾選的落差會記下來，餵給下一支影片的 few-shot，越剪越貼你的習慣。

## 前置需求

| 需求 | 說明 |
|------|------|
| Node.js 18+ | 看板伺服器與大部分腳本 |
| ffmpeg | 需在 PATH 裡，剪輯與音訊處理都靠它 |
| AI 後端（三選一） | ① Claude 訂閱：`npm install -g @anthropic-ai/claude-code`，跑一次 `claude` 登入（預設）② ChatGPT 訂閱：`npm install -g @openai/codex`，跑 `codex login` ③ 自填 API：不用裝 CLI，開看板在「⚙️ AI 與金鑰設定」填端點與 key（anthropic / openai 協定都通） |
| Python 3.10+ | 轉錄與偵測腳本 |
| Bash（選用） | 只有「本機 Whisper 轉錄備援」用到；Windows 裝 Git Bash 即可。剪輯匯出已是純 Node，不需要 bash |

## 安裝

```bash
git clone https://github.com/domyweb666/auto-videocut.git
cd auto-videocut/剪口播/scripts
npm install
pip install -r requirements.txt
```

進階偵測（咳嗽 ML 分類、語意重複、VAD 反幻覺）需要另外裝，不裝也能剪，對應功能會退回簡單版或跳過：

```bash
pip install torch transformers librosa sentence-transformers onnxruntime
```

## 語音轉錄，二選一

- **BytePlus（預設）**：在 `剪口播/scripts/.env` 填 `BYTEPLUS_API_KEY=你的key`。
- **本機 Whisper（免 key）**：`pip install openai-whisper` 裝好即可——看板偵測到沒填 BytePlus key 會自動改走 Whisper，全程離線（CPU 慢很多，第一次會下載約 3GB 模型）。

## 啟動

```bash
cd 剪口播/scripts
node training_server.js
```

或用桌面版（Windows / macOS，內建同一個看板，不用開終端機）：從 [Releases](https://github.com/domyweb666/auto-videocut/releases) 下載，或自己打包：

```bash
cd app && npm install && npm run pack   # dist/ 下會出現免安裝版
```

桌面版一樣需要本機有 ffmpeg 和 Python（見前置需求），AI 與金鑰在看板的「⚙️ AI 與金鑰設定」裡填。

打開 http://localhost:8900，把影片拖進去，等 pipeline 跑完按「前往審核」。審核頁上刪除線是 AI 建議刪的，點字可以改主意，確認後按匯出，成品會出現在影片旁的子資料夾：

```
<成品名>/
├── <成品名>.mp4        剪好的影片
├── <成品名>.srt / .txt  字幕與逐字稿
├── <成品名>.edl / .fcpxml  時間軸（Resolve / Premiere 匯入可微調每一刀）
└── timeline_map.json    剪點對照表
```

## 調整成你的剪法

- `剪口播/用户习惯/`：規則檔，例如哪些連接詞永遠不准刪。直接改 md 檔就生效。
- `剪口播/training_config.json`：所有可調參數（靜音閾值、偵測開關）。

## 更多文件

- `剪口播/design.md`：pipeline 架構與每個設計的原因
- `剪口播/testing.md`：改碼前該跑的測試
- `剪口播/decisions.md`：架構決策記錄

`CLAUDE.md`、`SKILL.md`、`HANDOFF.md` 是作者搭配 Claude Code 開發用的工作檔，一般使用者看本檔就夠。

## 致謝

本專案的起點是 [Ceeon/videocut-skills](https://github.com/Ceeon/videocut-skills)（MIT）。剪口播的 pipeline 後來大幅重寫（換轉錄引擎、加機械偵測層、審核介面重做、非破壞性時間軸匯出），但骨架的想法來自原專案。

## 授權與聯絡

MIT，詳見 [LICENSE](LICENSE)。問題回報開 issue，或來 [domyweb.org/tools/auto-edit](https://domyweb.org/tools/auto-edit/) 找我。
