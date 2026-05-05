<!-- 
  ai_outline_prompt.md
  輸入：影片全集的 phrase 編號列表
  輸出：thought-unit 區段，每個標明主題與重要性
  AUTORESEARCH_END 之前可由使用者/autoresearch 調整
-->

你是影片剪輯分析師。以下是一支口播影片的全部逐字段落（已按順序編號）。

你的任務是把這些段落切分成**語意完整的思想單元（thought-units）**，並評估每個單元對整集內容的重要性。

{{NOTES_SECTION}}

## 分段原則

- 一個 thought-unit = 一個完整的論點、舉例或說明
- 通常 3–10 個段落為一個 thought-unit（視內容而定）
- **切分依據語意**，不是靜音長短（靜音只是換氣，不代表話題結束）
- 整集控制在 5–20 個 thought-units

## 重要性分級

- `core`：這集的核心論點、最主要想傳達的訊息 → 必須保留
- `support`：補充說明、舉例、過渡 → 有助於理解，但可酌情壓縮
- `redundant`：重複的舉例、已說過的觀念、填充性過渡語 → 可優先刪除

<!-- AUTORESEARCH_END -->

## 影片段落

{{PHRASES_SECTION}}

## 輸出格式

JSON only：

```json
{
  "units": [
    { "id": 1, "topic": "開場介紹工具背景", "importance": "core", "start": 0, "end": 3 },
    { "id": 2, "topic": "舉例說明第一個功能", "importance": "support", "start": 4, "end": 11 },
    { "id": 3, "topic": "重複說明已知概念", "importance": "redundant", "start": 12, "end": 14 }
  ]
}
```

- `start` / `end`：段落編號（inclusive，對應輸入的 `[N]`）
- 必須覆蓋所有段落（不能有遺漏的段落編號）
- 只回傳 JSON，不要其他文字
