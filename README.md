# auto-videocut 剪口播

把一鏡到底的口播毛片丟進去，AI 幫你剪掉吃螺絲、重錄、語氣詞、咳嗽和長靜音，你在瀏覽器裡逐字確認每一刀，然後匯出成品 mp4、SRT 字幕，以及可進 Resolve / Premiere / 剪映微調的時間軸檔。

這是我（多米）自己每支影片都在用的工具，開源出來給同樣錄口播的人。我的影片是那種一鏡到底講 20 分鐘的說書口播，講錯就重講一次接著錄，以前光剪掉重錄段就要一兩個小時，現在 pipeline 跑完我只花幾分鐘在審核頁掃一遍。

先講清楚它是什麼：一套 Node + Python 腳本加一個本機網頁看板，環境要自己裝。AI 判斷花的是你自己的額度，Claude 訂閱、ChatGPT 訂閱、或自填 API key 三選一。金鑰只存你本機，這個專案不經手。

程式碼都在 `剪口播/`，桌面版的殼在 `app/`。

## 適合誰

- 錄口播、講課、說書影片，毛片是「講錯就重講、事後再剪」的人
- 願意花 20 分鐘裝環境，換之後每支影片省一小時的人

不適合：多人對談、有配樂的 vlog、需要花俏轉場的影片。這工具只做一件事——把一個人講話的毛片剪乾淨。

## 運作方式

```
毛片 mp4
  → 轉錄成字級時間戳（BytePlus 雲端 或 本機 Whisper）
  → AI 分析該刪什麼（重錄、語氣詞、語意重複、咳嗽、轉錄幻覺字）
  → 瀏覽器審核頁逐字確認（AI 只預選，你說了算）
  → ffmpeg 幀級剪輯匯出
```

設計上有一條鐵律：AI 永遠只是「預選」，所有刪除都以刪除線顯示在審核頁上，你點一下就能救回。所見即所得，不會有審核頁沒顯示、成品卻被剪掉的暗刀。

匯出時，AI 預選跟你最終勾選的落差會記下來，餵給下一支影片的 few-shot。用越多支，它越知道你的刪法。

## 前置需求

| 需求 | 用途 | 裝法與驗證 |
|------|------|-----------|
| Node.js 18+ | 看板伺服器、剪輯匯出 | [nodejs.org](https://nodejs.org) 下載安裝，`node -v` 有版號就對了 |
| ffmpeg | 抽音訊、剪輯、壓字幕 | Windows：[gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下載後把 bin 加進 PATH；Mac：`brew install ffmpeg`。驗證：終端機打 `ffmpeg -version` |
| Python 3.10+ | 轉錄與偵測腳本 | [python.org](https://python.org) 安裝，Windows 記得勾 Add to PATH。驗證：`python --version` |
| AI 後端（下面三選一） | 判斷哪些字該刪 | 見「AI 後端」一節 |
| Git Bash（選用） | 只有本機 Whisper 轉錄用到 | Windows 裝 [Git for Windows](https://git-scm.com) 就有；Mac 內建 bash 不用裝 |

## 安裝

```bash
git clone https://github.com/domyweb666/auto-videocut.git
cd auto-videocut/剪口播/scripts
npm install
pip install -r requirements.txt
```

`requirements.txt` 核心只有一個套件（requests）。進階偵測（咳嗽 ML 分類、語意重複、VAD 反幻覺）要另外裝 torch 那一票大傢伙，檔案裡有註解教你裝；不裝也能剪，對應功能會退回簡單版或跳過。

## AI 後端，三選一

pipeline 的刪不刪判斷全部走 AI。開看板後在剪輯頁的「⚙️ AI 與金鑰設定」選一種，按「測試 AI 連線」看到「成功」就通了：

- **Claude 訂閱**（預設）：`npm install -g @anthropic-ai/claude-code`，終端機跑一次 `claude` 登入你的 Claude Pro/Max 帳號。之後 AI 呼叫吃訂閱額度，不用 API key。
- **ChatGPT 訂閱**：`npm install -g @openai/codex`，跑 `codex login` 登入。同樣吃訂閱額度。
- **自填 API**：不裝任何 CLI，直接在設定頁填端點、模型、key。anthropic 協定（官方或相容中轉）和 openai 協定（DeepSeek、Groq、本地 Ollama 這些）都通。花的是 API 計費。

一支 20 分鐘影片的 AI 分析量不大，訂閱額度日常剪片綽綽有餘。

## 語音轉錄，二選一

- **BytePlus（我自己用的，建議）**：申請 [BytePlus](https://www.byteplus.com) 的 Seed Speech ASR，把 key 填進看板設定頁的「BytePlus 轉錄 Key」。20 分鐘影片雲端轉錄約一兩分鐘，字級時間碼準，這套 pipeline 的預設參數都是照它調的。
- **本機 Whisper（免 key、免註冊）**：`pip install openai-whisper` 裝好就行，看板偵測到沒填 BytePlus key 會自動改走 Whisper，全程離線。代價是慢——CPU 上 20 分鐘影片可能要跑半小時以上，第一次還會下載約 3GB 模型，長靜音處偶爾會冒幻覺字（pipeline 有守門層會抓，但不保證全抓到）。

我的建議：先用 Whisper 試一支，確定這工具合你的工作流，再去申請 BytePlus。Whisper 拿來試用夠了，拿來天天剪會等到不耐煩。

## 啟動與第一支影片

```bash
cd 剪口播/scripts
node training_server.js
```

打開 http://localhost:8900：

1. 把影片拖進去（或貼路徑）。有講稿的話貼到「參考文稿」欄，審核時會幫你把疑似聽錯的字標黃底
2. 按「開始處理」，等 pipeline 跑完（轉錄 + AI 分析，20 分鐘影片大約幾分鐘，Whisper 模式另計）
3. 按「前往審核」。頁面上刪除線是 AI 建議刪的，每一刀都附理由；點字可以改主意，救回或補刪都行。「🔍 接縫冷讀」會把剪完的稿子丟給 AI 冷讀一次，標出剪接後接不順的縫
4. 按匯出，選畫質選項（原畫質近無損 / 指定解析度 / H.265 / 純音訊 mp3 都有），成品出現在影片旁的子資料夾：

```
<成品名>/
├── <成品名>.mp4            剪好的影片
├── <成品名>.srt / .txt      字幕與逐字稿（跟成品逐字一致）
├── <成品名>.edl / .fcpxml   時間軸檔，Resolve / Premiere 匯入可微調每一刀
└── timeline_map.json        剪點對照表
```

匯出後有自動驗證（時長對帳、殘留靜音、逐字對帳），有問題會直接告訴你，不會讓你上傳完才發現破音。

## 調整成你的剪法

- `剪口播/用户习惯/`：規則檔，例如哪些連接詞永遠不准刪、語氣詞怎麼判。直接改 md 檔就生效
- `剪口播/training_config.json`：所有可調參數（靜音閾值、各偵測層開關）
- 匯出時的人工修正會自動累積成 few-shot 餵給下一支，不用手動做任何事

## 常見問題

**開始處理就報錯「找不到 ffmpeg」** —— ffmpeg 沒進 PATH。重開終端機再驗 `ffmpeg -version`，Windows 改完環境變數要重開視窗才生效。

**測試 AI 連線轉圈 40 秒然後失敗** —— 十之八九是 claude CLI 沒登入。終端機跑一次 `claude`，登入完再測。

**轉錄卡很久** —— Whisper 模式在 CPU 上就是這個速度，去倒杯水。趕時間就填 BytePlus key。

**8900 開不起來** —— 埠被佔了，通常是上一次的 server 沒關。關掉舊視窗或重開機。

**字幕是簡體？** —— 不會。轉錄引擎輸出簡體時 pipeline 會自動 OpenCC 轉繁，成品 SRT 是繁體。

## 桌面版

Windows / macOS 有 Electron 桌面版（同一個看板，不用開終端機）：從 [Releases](https://github.com/domyweb666/auto-videocut/releases) 下載，或自己打包：

```bash
cd app && npm install && npm run pack   # dist/ 下會出現免安裝版
```

桌面版一樣需要本機有 ffmpeg 和 Python，AI 與金鑰在看板的「⚙️ AI 與金鑰設定」裡填。

## 更多文件

- `剪口播/design.md`：pipeline 架構與每個設計的原因
- `剪口播/testing.md`：改碼前該跑的測試
- `剪口播/decisions.md`：架構決策記錄

`CLAUDE.md`、`SKILL.md` 是我搭配 Claude Code 開發用的工作檔，一般使用者看本檔就夠。

## 致謝

本專案的起點是 [Ceeon/videocut-skills](https://github.com/Ceeon/videocut-skills)（MIT）。剪口播的 pipeline 後來大幅重寫（換轉錄引擎、加機械偵測層、審核介面重做、非破壞性時間軸匯出），但骨架的想法來自原專案。

## 授權與聯絡

MIT，詳見 [LICENSE](LICENSE)。問題回報開 issue，或來 [domyweb.org/tools/auto-edit](https://domyweb.org/tools/auto-edit/) 找我。
