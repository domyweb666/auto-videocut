---
name: videocut:剪口播
description: 口播影片轉錄和口誤識別。生成審查稿和刪除任務清單。觸發詞：剪口播、處理影片、識別口誤
---

<!--
input: 影片檔案 (*.mp4, *.mkv)
output: subtitles_words.json、auto_selected.json、review.html、_cut.mp4、_cut.srt
pos: 轉錄+識別，到使用者網頁審核為止

架構守護者：一旦我被修改，請同步更新：
1. ../README.md 的 Skill 清單
2. /CLAUDE.md 路由表
-->

# 剪口播 v3

> Google Cloud STT 原生繁體轉錄 + AI 口誤/語意重複識別 + 網頁審核

## 快速使用

```
用戶: 幫我剪這個口播影片
用戶: 處理一下這個影片
```

## 輸出目錄結構

```
output/
└── YYYY-MM-DD_影片名/
    ├── 剪口播/
    │   ├── 1_轉錄/
    │   │   ├── audio.mp3
    │   │   ├── google_result.json      ← Google STT 原生繁體
    │   │   └── subtitles_words.json    ← 字級字幕（含 isGap）
    │   ├── 2_分析/
    │   │   ├── readable.txt
    │   │   ├── sentences.txt
    │   │   ├── auto_selected.json      ← 刪除索引列表
    │   │   ├── diff_report.json        ← 使用者修正差異（審核後產出）
    │   │   └── 口誤分析.md
    │   └── 3_審核/
    │       ├── review.html
    │       ├── video.mp4 → 源影片(符號鏈接)
    │       ├── 影片名_cut.mp4          ← 最終輸出
    │       └── 影片名_cut.srt          ← 剪輯後字幕（自動產出）
    └── 字幕/
        └── ...
```

**規則**：已有資料夾則複用，否則新建。

## 流程

```
1. 建立輸出目錄
   ↓
2. 提取音頻 + Google Cloud STT 轉錄（zh-TW）
   ↓
3. 生成字級字幕 (subtitles_words.json)
   ↓
4. AI 分析（靜音標記 + 口誤偵測 + 語意重複偵測）← 讀取 training_config.json
   ↓ 產出 auto_selected.json（規則層）
4.5 [可選] AI 第二遍敘事級剪輯（layered 模式）
   ↓ 產出 auto_selected_layered.json（規則 + AI 敘事級重複）
5. 驗證 auto_selected*.json
   ↓
6. 生成審核網頁 + 啟動服務器
   ↓
【等待使用者確認】→ 網頁點擊「執行剪輯」
   ↓
7. 輸出 _cut.mp4 + _cut.srt
   ↓
8. 自動學習 → apply_feedback.js → 更新 training_config.json
   ↓
下一支影片自動使用更新後的規則
```

### 三種剪輯模式（如何選）

| 模式 | 來源檔 | 適用 | F1 (3 支樣本) |
|------|--------|------|---------------|
| **rules**（預設） | `auto_selected.json` | 一般 fine-cut，cosmetic 級清理 | 96.93% |
| **layered**（推薦遇到敘事級重複） | `auto_selected_layered.json` | rules + AI 第二遍敘事級重複偵測 | **97.35%**（+0.42 點） |
| **full_edit**（壓縮版） | `auto_selected_full.json` | 製作精華版/短片，激進刪減 | 4.86%（不對齊使用者剪輯哲學） |

> 預設用 rules。若特定影片發現「同觀點講兩遍」「同例子舉兩遍」rules 抓不到，切到 layered。
> full_edit 不適合替代日常剪輯，當壓縮工具用即可。

### 自動學習迴路

```
┌─→ 規則標記(讀 training_config.json) → 審核 → 使用者修正 → 剪輯
│                                                              ↓
│   apply_feedback.js ← diff_report.json ←────────────────────┘
│         ↓
└── 更新 training_config.json ──→ 下一支影片
```

**training_config.json** 集中存放所有可調參數（靜音閾值、重複句前綴長度、語氣詞列表等）。
每次剪輯後自動微調（保守策略：單支影片只調靜音閾值 ±0.1s）。
批量訓練可一次分析 N 支影片，高信心建議自動套用。

## 執行步驟

### 步驟 1: 建立輸出目錄

```bash
# 變數設置（根據實際影片調整）
VIDEO_PATH="/path/to/影片.mp4"
VIDEO_NAME=$(basename "$VIDEO_PATH" | sed 's/\.[^.]*$//')
DATE=$(date +%Y-%m-%d)
BASE_DIR="output/${DATE}_${VIDEO_NAME}/剪口播"

# 建立子目錄
mkdir -p "$BASE_DIR/1_轉錄" "$BASE_DIR/2_分析" "$BASE_DIR/3_審核"
cd "$BASE_DIR"
```

### 步驟 2: 轉錄

```bash
cd 1_轉錄
SKILL_DIR="$HOME/.claude/skills/videocut-skills/剪口播"

# 提取音訊（檔名有冒號需加 file: 前綴）
ffmpeg -i "file:$VIDEO_PATH" -vn -acodec libmp3lame -y audio.mp3

# Google Cloud STT 轉錄（繁體中文 zh-TW，原生，含字級時間戳）
PYTHONIOENCODING=utf-8 python "$SKILL_DIR/scripts/google_transcribe.py" audio.mp3 google_result.json
# 輸出: google_result.json

# （備用：若 Google STT 不可用，改用 Whisper + OpenCC）
# "$SKILL_DIR/scripts/whisper_transcribe.sh" audio.mp3
```

### 步驟 3: 生成字幕

```bash
node "$SKILL_DIR/scripts/generate_subtitles.js"
# 自動偵測：優先用 google_result.json，其次 whisper_result.json
# 輸出: subtitles_words.json

cd ..
```

### 步驟 4: 分析（腳本 + AI）

#### 4.1 生成易讀格式

```bash
cd 2_分析

node -e "
const data = require('../1_轉錄/subtitles_words.json');
let output = [];
data.forEach((w, i) => {
  if (w.isGap) {
    const dur = (w.end - w.start).toFixed(2);
    if (dur >= 0.2) output.push(i + '|[靜' + dur + 's]|' + w.start.toFixed(2) + '-' + w.end.toFixed(2));
  } else {
    output.push(i + '|' + w.text + '|' + w.start.toFixed(2) + '-' + w.end.toFixed(2));
  }
});
require('fs').writeFileSync('readable.txt', output.join('\\n'));
"
```

#### 4.2 讀取使用者習慣

先讀 `用户习惯/` 目錄下所有規則檔案。

#### 4.3 生成句子列表（關鍵步驟）

**必須先分句，再分析**。按靜音切分成句子列表：

```bash
node -e "
const data = require('../1_轉錄/subtitles_words.json');
let sentences = [];
let curr = { text: '', startIdx: -1, endIdx: -1 };

data.forEach((w, i) => {
  const isLongGap = w.isGap && (w.end - w.start) >= 0.5;
  if (isLongGap) {
    if (curr.text.length > 0) sentences.push({...curr});
    curr = { text: '', startIdx: -1, endIdx: -1 };
  } else if (!w.isGap) {
    if (curr.startIdx === -1) curr.startIdx = i;
    curr.text += w.text;
    curr.endIdx = i;
  }
});
if (curr.text.length > 0) sentences.push(curr);

sentences.forEach((s, i) => {
  console.log(i + '|' + s.startIdx + '-' + s.endIdx + '|' + s.text);
});
" > sentences.txt
```

#### 4.4 腳本自動標記靜音（必須先執行）

```bash
node -e "
const words = require('../1_轉錄/subtitles_words.json');
const selected = [];
words.forEach((w, i) => {
  if (w.isGap && (w.end - w.start) >= 1.0) selected.push(i);
});
require('fs').writeFileSync('auto_selected.json', JSON.stringify(selected, null, 2));
console.log('≥1.0s 靜音數量:', selected.length);
"
```

→ 輸出 `auto_selected.json`（只含 ≥1s 靜音 idx）

#### 4.5 AI 分析口誤（追加到 auto_selected.json）

**偵測規則（按優先級）**：

| # | 類型 | 判斷方法 | 刪除範圍 |
|---|------|----------|----------|
| 1 | 重複句 | 相鄰句子開頭≥5字相同 | 較短的**整句** |
| 2 | 隔一句重複 | 中間是殘句時，比對前後句 | 前句+殘句 |
| 3 | 殘句 | 話說一半+靜音 | **整個殘句** |
| 4 | 句內重複 | A+中間+A 模式 | 前面部分 |
| 5 | 卡頓詞 | 那個那個、就是就是 | 前面部分 |
| 6 | 重說糾正 | 部分重複/否定糾正 | 前面部分 |
| 7 | 語氣詞 | 嗯、啊、那個 | 標記但不自動刪 |

🚨 **不要刪連接詞**（但是、就是說、事實上等），見 `用户习惯/10-保留連接詞.md`

**核心原則**：
- **先分句，再比對**：用 sentences.txt 比對相鄰句子
- **整句刪除**：殘句、重複句都要刪整句，不只是刪異常的幾個字
- **範圍整段刪除**：標記口誤時，從 startIdx 到 endIdx 之間的**所有元素**（含中間的 gap）全部加入 auto_selected

**分段分析（循環執行）**：

```
1. Read readable.txt offset=N limit=300
2. 結合 sentences.txt 分析這 300 行
3. 追加口誤 idx 到 auto_selected.json
4. 記錄到 口誤分析.md
5. N += 300，回到步驟 1
```

🚨 **關鍵警告：行號 ≠ idx**

```
readable.txt 格式: idx|內容|時間
                   ↑ 用這個值

行號1500 → "1568|[靜1.02s]|..."  ← idx 是 1568，不是 1500！
```

**口誤分析.md 格式：**

```markdown
## 第N段 (行號範圍)

| idx | 時間 | 類型 | 內容 | 處理 |
|-----|------|------|------|------|
| 65-75 | 15.80-17.66 | 重複句 | "這是我剪出來的一個案例" | 刪 |
```

#### 4.6 語意重複偵測（全文 AI 分析）

**目標**：找出說話者把同一個觀點/例子完整說了兩遍的段落，刪除冗餘版本。

> 規則細節見 `用户习惯/11-語意重複偵測.md`

**執行方式**（嵌入向量篩選候選 + AI 確認）：

```bash
# 1. 用嵌入向量找出候選重複組（相似度 ≥0.85，相距 5-30 句）
PYTHONIOENCODING=utf-8 python "$SKILL_DIR/scripts/detect_redundancy.py" sentences.txt > redundancy_candidates.json

# 2. AI 讀取候選組（通常 10-20 組），逐組確認：
#    - 是否真的語意重複（排除結構相似但內容不同的）
#    - 保留哪個版本（更完整/更後出現的）
# 3. 將確認的刪除 startIdx-endIdx 全範圍（含 gap）追加到 auto_selected.json
# 4. 記錄到 口誤分析.md（標注類型為「語意重複」）
```

> 若 `sentence-transformers` 未安裝，腳本自動 fallback 為字元 3-gram 重疊率（閾值 0.6）。
> 安裝：`pip install sentence-transformers`

### 步驟 4.7: [可選] AI 第二遍敘事級剪輯（layered 模式）

**何時用**：當 rules 跑完後，發現使用者常需要手動補刪「同觀點講兩遍」「同例子舉兩遍」這類**跨段落重複觀點**時，啟用此步驟。

```bash
# 前置：先跑過步驟 4（產出 auto_selected.json）+ ai_polish 產出 polished.json
node "$SKILL_DIR/scripts/ai_polish.js" \
  ../1_轉錄/subtitles_words.json polished.json

# 跑 layered（rules → 過濾殘餘 → Claude 敘事級剪輯 → 合併）
node "$SKILL_DIR/scripts/ai_narrative_pass.js" \
  polished.json ../1_轉錄/subtitles_words.json auto_selected.json
# 輸出: auto_selected_layered.json
```

**內部流程**：
1. 讀 `auto_selected.json`（規則層刪除清單）
2. 過濾掉 `polished.json` 中已被規則層刪掉的 word，得到「殘餘文稿」
3. Claude 對殘餘文稿做敘事級剪輯（鐵律：只刪不寫；目標保留率 ≥85%）
4. 對齊 Claude 輸出回原始 word index
5. 合併：最終刪除 = 規則層 ∪ AI 敘事層
6. 輸出 `auto_selected_layered.json`（含 `mode: "layered"` 與分層統計）

**驗證**：
- AI 第二遍刪除率 > 20% 會警告（可能過度介入）
- 對齊警告 > 0 表示 Claude 違反「只刪不寫」，輸出不可用

**測量品質**：
```bash
node "$SKILL_DIR/scripts/compare_layered_f1.js" <影片名>
# 輸出三方 F1 對比：rules / full_edit / layered
```

### 步驟 5: 驗證

```bash
node "$SKILL_DIR/scripts/validate_selection.js" \
  ../1_轉錄/subtitles_words.json \
  auto_selected.json
```

驗證內容：idx 範圍有效、不含被保護的連接詞、刪除區間完整（不漏 gap）。

### 步驟 6: 審核

```bash
cd ../3_審核

# 生成審核網頁（傳入影片檔案，自動建立符號鏈接）
node "$SKILL_DIR/scripts/generate_review.js" ../1_轉錄/subtitles_words.json ../2_分析/auto_selected.json "$VIDEO_PATH"
# 輸出: review.html, video.mp4(符號鏈接)

# 啟動審核服務器
node "$SKILL_DIR/scripts/review_server.js" 4000 "$VIDEO_PATH"
# 開啟 http://localhost:4000
```

> ⚠️ **必須用 review_server.js**，不能用 `python3 -m http.server` 替代。
> 原因：影片播放依賴 HTTP Range 請求（206），python 簡易服務器不支援。
> 啟動時不要在命令末尾加 `&`（shell 後台），用 `run_in_background` 參數即可。

使用者在網頁中：
- 播放影片畫面確認
- 拖曳選取批量標記刪除
- 點擊「執行剪輯」

### 步驟 7: 生成文稿（剪輯完成後）

剪輯完成後，用保留的逐字稿生成結構化文稿：

```bash
cd ../2_分析

# 從 subtitles_words.json 提取保留文字（排除 auto_selected 的 idx）
node -e "
const words = require('../1_轉錄/subtitles_words.json');
const raw = require('./auto_selected.json');
const deleted = new Set(Array.isArray(raw) ? raw : (raw.indices || []));
const kept = words.filter((w, i) => !deleted.has(i) && !w.isGap).map(w => w.text).join('');
require('fs').writeFileSync('kept_text.txt', kept);
console.log('保留文字:', kept.length, '字');
"
```

AI 讀取 `kept_text.txt`，產出兩個版本：

1. **忠實版**（`文稿_忠實.md`）：保留口語風格，只修語病和標點
2. **精煉版**（`文稿_精煉.md`）：書面語重整，加標題分段，適合部落格

---

## 數據格式

### subtitles_words.json

```json
[
  {"text": "大", "start": 0.12, "end": 0.2, "isGap": false},
  {"text": "", "start": 6.78, "end": 7.48, "isGap": true}
]
```

### auto_selected.json

支援兩種格式（向下兼容）：

**簡單格式**（腳本靜音標記）：
```json
[72, 85, 120]
```

**帶理由格式**（AI 口誤分析追加時使用）：
```json
{
  "indices": [72, 85, 120, 200, 201, 202, 203],
  "reasons": {
    "72": "靜音 ≥1s",
    "200-203": "殘句：話說一半停頓"
  }
}
```

`reasons` 的 key 可以是單一 idx 或 `startIdx-endIdx` 範圍。review.html 會在 hover 時顯示理由。

> 讀取時自動偵測：如果是陣列就是簡單格式，如果是物件就讀 `indices` 和 `reasons`。

### auto_selected_layered.json（layered 模式輸出）

```json
{
  "indices": [...],
  "reasons": { "12": "[規則] 重複句", "188": "[AI 敘事] 跨段落重複觀點" },
  "mode": "layered",
  "layers": {
    "rules":     { "count": 154 },
    "narrative": { "count": 56, "deletion_runs": [...] }
  },
  "stats": {
    "original_words": 700, "after_rules_words": 546, "after_ai_words": 490,
    "rules_deleted": 154, "narrative_deleted": 56, "total_deleted": 210,
    "ai_cut_rate": 0.1026
  },
  "alignment_warnings": []
}
```

`reasons` 的 prefix 標明來源（`[規則]` / `[AI 敘事]`），方便審核時追蹤。

### auto_selected_full.json（full_edit 模式輸出，激進壓縮用）

格式與上類似但 `mode: "full_edit"`，AI 直接看整篇文稿做敘事級裁剪，不接 rules 層。日常剪輯**不建議用**，留給壓縮版需求。

---

## 剪輯編碼（硬性規則）

⚠️ **匹配原片參數重編碼，幀級精確切割。**

`cut_video.sh` 的工作方式：
1. 自動偵測原片編碼參數（codec/profile/pix_fmt/bitrate）
2. 並行分段提取 + concat demuxer 無損拼接
3. 以相同參數重編碼：`-profile:v high -b:v {原片碼率} -pix_fmt yuv420p`
4. 優先使用 NVENC 硬體編碼（若有 NVIDIA 顯卡）

---

## 批量訓練（學習使用者剪輯風格）

用多支影片 + 使用者已剪好的 SRT 自動對照，統計各規則的準確率並產出優化建議。

### 使用方式

```bash
# 1. 準備 manifest 檔案
cat > training_manifest.json << 'EOF'
{
  "videos": [
    { "video": "E:/影片/Obsidian技巧.mp4", "srt": "E:/影片/Obsidian技巧.srt" },
    { "video": "E:/影片/PKM入門.mp4", "srt": "E:/影片/PKM入門.srt" }
  ],
  "options": {
    "transcriber": "google"
  }
}
EOF

# 2. 執行批量訓練
node "$SKILL_DIR/scripts/batch_train.js" training_manifest.json
```

### 流程

```
每支影片：轉錄 → 規則自動標記 → 對照 SRT → diff_report.json
         ↓
全部完成後：匯總分析 → training_report.md + rule_updates.json
```

### 輸出

- `training_output/training_report.md` — 各規則精確率/召回率、靜音閾值建議、數據覆蓋率
- `training_output/rule_updates.json` — 機器可讀的規則調整建議

### 建議訓練量

- **5 支**：校準高頻規則（靜音、重複句、殘句）→ ~80% 準確率
- **8-10 支**：補齊低頻規則（句內重複、語意重複）→ 完整收斂

### 省錢技巧

- `existing_output` 欄位指向已跑過管道的目錄 → 複用轉錄結果，不花 STT 費用
- `"transcriber": "whisper"` → 用本地 Whisper 免費轉錄（品質略差但不影響規則訓練）

### 涉及腳本

| 腳本 | 功能 |
|------|------|
| `batch_train.js` | 協調器：讀 manifest → 逐支處理 → 匯總 |
| `auto_select_rules.js` | 純規則自動標記（不需 AI） |
| `compare_with_srt.js` | SRT 對照：貪心前向匹配計算差異 |
| `aggregate_training.js` | 匯總 N 份 diff → 統計報告 + 規則建議 |

---

## 配置

### Google Cloud STT

```bash
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/fc-project-key.json"
export GCS_BUCKET="stt-temp-fc-project-178615"
```

### 備用：Whisper 本地轉錄

若 Google Cloud 不可用，改用 Whisper + OpenCC：
```bash
"$SKILL_DIR/scripts/whisper_transcribe.sh" audio.mp3
```
