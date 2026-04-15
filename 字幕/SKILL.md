---
name: videocut:字幕
description: 字幕生成与烧录。火山引擎转录→词典纠错→审核→烧录。触发词：加字幕、生成字幕、字幕
---

<!--
input: 视频文件（可选，不传则自动查找）
output: 带字幕视频
pos: 后置 skill，剪辑完成后调用
-->

# 字幕

> 转录 → Agent校对 → 人工审核 → 烧录

## 核心流程（总计约 8-15 分钟，含人工审核）

```
0. 自动查找视频              ⏱ 即时
    ↓
1. 提取音频 + 上传          ⏱ ~1min
    ↓
2. 火山引擎转录（带热词）    ⏱ ~2min
    ↓
3. Agent 自动校对            ⏱ ~3-5min
    ↓
4. 人工审核确认              ⏱ 取决于用户
    ↓
5. 烧录字幕                  ⏱ ~1-2min
```

---

## Step 0: 自动查找视频

**优先级规则**（从高到低）：

1. **用户传入的视频路径**（如有 ARGUMENTS）
2. **剪口播产出的 `_cut.mp4`**：在当前 output 目录下查找 `剪口播/3_审核/*_cut.mp4`
3. **原始视频**：用户最初传入剪口播的原始视频

```bash
# 查找逻辑
OUTPUT_DIR="output/YYYY-MM-DD_视频名"

# 优先找剪辑后视频
CUT_VIDEO=$(find "$OUTPUT_DIR/剪口播/3_审核" -name "*_cut.mp4" -type f 2>/dev/null | head -1)

if [ -n "$CUT_VIDEO" ]; then
  VIDEO_PATH="$CUT_VIDEO"
  echo "✅ 找到剪辑后视频: $VIDEO_PATH"
else
  # 使用用户传入的原始视频
  VIDEO_PATH="$ARGUMENTS"
  echo "⚠️ 未找到剪辑后视频，使用原始视频: $VIDEO_PATH"
fi
```

**关键**：字幕应该基于**剪辑后的视频**生成，而不是原始视频。因为剪口播会删除口误和静音段，原始视频的时间戳与剪辑后不匹配。

---

## Step 1: 提取音频并上传

### 1.1 檢查是否可複用剪口播轉錄

如果視頻來自剪口播的 `_cut.mp4`，可直接複用轉錄結果，**跳過 Step 1-2**：

```bash
TRANSCRIBE_DIR="$OUTPUT_DIR/剪口播/1_轉錄"
ANALYSIS_DIR="$OUTPUT_DIR/剪口播/2_分析"
SKILL_DIR="$HOME/.claude/skills/videocut-skills/剪口播"

if [ -f "$TRANSCRIBE_DIR/subtitles_words.json" ] && [ -f "$ANALYSIS_DIR/auto_selected.json" ]; then
  echo "✅ 複用剪口播轉錄結果（跳過重新轉錄）"

  # 用 generate_subtitles.js 的時間映射，產出剪輯後的字幕
  cd "$OUTPUT_DIR/字幕/1_转录"
  # 將 delete_segments.json 從 auto_selected 轉換（idx → 時間範圍）
  node -e "
  const words = require('$TRANSCRIBE_DIR/subtitles_words.json');
  const selected = new Set(require('$ANALYSIS_DIR/auto_selected.json'));
  const segments = [];
  let seg = null;
  words.forEach((w, i) => {
    if (selected.has(i)) {
      if (!seg) seg = { start: w.start, end: w.end };
      else seg.end = w.end;
    } else if (seg) {
      segments.push(seg);
      seg = null;
    }
  });
  if (seg) segments.push(seg);
  require('fs').writeFileSync('delete_segments.json', JSON.stringify(segments, null, 2));
  "

  # 用原始轉錄 + 刪除片段 → 映射後的 subtitles_words.json
  node "$SKILL_DIR/scripts/generate_subtitles.js" "$TRANSCRIBE_DIR/google_result.json" delete_segments.json
  # → 輸出 subtitles_words.json（時間已對齊 _cut.mp4）

  # 跳到 Step 3
fi
```

### 1.2 正常提取（無法複用時）

```bash
# 提取音频（使用 Step 0 确定的 VIDEO_PATH）
ffmpeg -i "$VIDEO_PATH" -vn -acodec libmp3lame -y audio.mp3

# 上传到 uguu.se（临时文件托管）
curl -s -F "files[]=@audio.mp3" https://uguu.se/upload
# 返回 URL 如: https://o.uguu.se/xxxxx.mp3
```

---

## Step 2: 火山引擎转录（带热词）

转录脚本会**自动读取词典**作为热词，提高识别准确率：

```bash
# 词典位置: ~/.claude/skills/videocut-skills/字幕/词典.txt
# 脚本会自动加载

bash ../剪口播/scripts/volcengine_transcribe.sh "https://o.uguu.se/xxxxx.mp3"
```

**词典格式**（每行一个词）：
```
skills
Claude
Agent
成峰
剪辑skills
claude code
```

---

## Step 3: Agent 自动校对

### 3.1 生成带时间戳的字幕

```javascript
const result = JSON.parse(fs.readFileSync('volcengine_result.json'));
const subtitles = result.utterances.map((u, i) => ({
  id: i + 1,
  text: u.text,
  start: u.start_time / 1000,
  end: u.end_time / 1000
}));
fs.writeFileSync('subtitles_with_time.json', JSON.stringify(subtitles, null, 2));
```

### 3.2 Agent 手动校对（不用脚本）

**转录后，Agent 必须逐条阅读全部字幕，手动校对以下问题：**

#### ⚠️ 校对核心原则

1. **只改不加**：校对只能修正识别错误，绝不能往字幕里添加视频中没说的话
2. **人名必查**：词典里的人名（如"成峰"）即使加了热词，火山引擎仍可能识别错（如"乘风"、"成风"），必须逐条检查
3. **碎片合并**：像"音画" + "同步"这样被拆成两条的，必须合并成一条
4. **不要自作主张**：发现可疑内容时标记留给人工审核，不要自己决定保留或删除

#### 常见误识别规则表

| 误识别 | 正确 | 类型 |
|--------|------|------|
| 成风 | 成峰 | 同音字 |
| 正特/整特 | Agent | 误识别 |
| IT就 | Agent就 | 发音相似 |
| edge的叉100 | Agentx100 | 误识别 |
| cloud code | Claude Code | 发音相似 |
| Schill/skill | skills | 发音相似 |
| 剪口拨/剪口波 | 剪口播 | 同音字 |
| 自净化/资金化 | 自进化 | 同音字 |
| 减口播 | 剪口播 | 同音字 |
| 录剪 | 漏剪 | 同音字 |
| 作为这个 | 做这个 | 同音字 |
| 斜杠V1/斜杠v | /v | 口语描述 |
| 斜杠v点口拨 | /v.口播 | 口语+同音 |
| a p i t/APIK | API Key | 误识别 |
| excuse | skills | 误识别 |
| 移完了 | 剪完了 | 同音字 |

#### 常见漏字问题

| 原文 | 修正 | 说明 |
|------|------|------|
| 步呢是配置 | 第二步呢是配置 | 漏"第二" |
| 4步就是 | 第4步就是 | 漏"第" |
| 别省时间 | 特别省时间 | 漏"特" |
| 这个我们的 | 这个是我们的 | 漏"是" |
| 在里面看到 | 可以在里面看到 | 漏"可以" |
| 跟大家处理完 | 跟大家讲完 | 用词不当 |
| 剪辑了逻辑 | 剪辑的逻辑 | 语法错误 |

### 3.3 对照原稿校对（如有原稿）

如果有原稿/脚本，可以辅助校对，但**不要用脚本自动匹配**（文字差异会导致时间戳累积错误）。

Agent 应：
1. 读取原稿作为参考
2. 手动逐条对比，发现差异时修正
3. 不确定的地方标记，留给人工审核

#### ⚠️ 原稿校对的关键规则

- **原稿没有 = 必须删除**：字幕基于 _cut.mp4（剪辑后视频），原稿里没有的内容说明在剪口播阶段已经被剪掉了，转录出现是火山引擎的幻觉或错误识别，必须删除
- **绝不能从原稿往字幕里"补"内容**：原稿里有但转录没有的话，说明视频里确实没说，不能硬加进去
- **校对方向是单向的**：只能用原稿来验证转录是否正确，不能用原稿来"补充"转录
- **产品名以原稿为准**：如原稿要求用英文名（如 Kling 而非可灵），所有字幕统一替换

---

## Step 4: 启动审核服务器

```bash
cd 字幕目录/
node /path/to/skills/字幕/scripts/subtitle_server.js 8898 "video.mp4"
```

访问 http://localhost:8898

**功能：**
- 左侧视频播放，右侧字幕列表
- 播放时自动高亮当前字幕
- 双击字幕文字编辑（时间戳不变）
- 倍速播放（1x/1.5x/2x/3x）
- 保存字幕 / 导出 SRT / 烧录字幕
- 底部显示词典快捷插入

---

## Step 5: 烧录字幕

**默认样式：22号金黄粗体、黑色描边2px、底部居中**

```bash
ffmpeg -i "video.mp4" \
  -vf "subtitles='video.srt':force_style='FontSize=22,FontName=PingFang SC,Bold=1,PrimaryColour=&H0000deff,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=30'" \
  -c:a copy \
  -y "video_字幕.mp4"
```

| 参数 | 值 | 说明 |
|------|------|------|
| FontSize | 22 | 字体大小 |
| FontName | PingFang SC | 苹方字体 |
| Bold | 1 | 粗体 |
| PrimaryColour | &H0000deff | 金黄色 #ffde00 |
| OutlineColour | &H00000000 | 黑色描边 |
| Outline | 2 | 描边宽度 |
| Alignment | 2 | 底部居中 |
| MarginV | 30 | 底部边距 |

---

## 目录结构

```
output/YYYY-MM-DD_视频名/字幕/
├── 1_转录/
│   ├── audio.mp3
│   └── volcengine_result.json
├── subtitles_with_time.json    # 核心文件
└── 3_输出/
    ├── video.srt
    └── video_字幕.mp4
```

---

## 字幕规范

| 规则 | 说明 |
|------|------|
| 一屏一行 | 不换行，不堆叠 |
| 句尾无标点 | `你好` 不是 `你好。` |
| 句中保留标点 | `先点这里，再点那里` |

---

## 反馈记录

### 2026-02-10
- **重要**：字幕必须基于剪辑后的视频（`*_cut.mp4`），不能用原始视频
- 新增 Step 0 自动查找视频逻辑：优先找 `剪口播/3_审核/*_cut.mp4`
- 查找顺序：用户指定 > 剪辑后视频 > 原始视频
- **严重教训：校对只改不加**：火山引擎转录没有的内容，绝不能从原稿里"补"进字幕。案例：转录是"已经算领先了"，Agent 错误地从原稿补了一条"已经遥遥领先"，实际上视频已经剪掉了这段
- **严重教训：原稿没有 = 删除**：原稿里没有的内容，说明剪口播阶段已经剪掉，必须删除。不能因为"口播有说"就自作主张保留
- **人名必查**：词典热词不保证 100% 识别。案例："成峰"在词典里，火山引擎仍识别成"乘风"，Agent 校对时漏掉了
- 新增词典词条：Kling、DeepSeek、分镜、音画同步、音画同出、首帧

### 2026-01-31
- 火山引擎支持热词，已集成到转录脚本
- Agent 转录后需要自动校对，不能直接交给用户
- 字幕样式：金黄粗体 #ffde00，描边 2px
- IT 常被误识别为 Agent，需加入纠错规则
- **重要**：Agent 校对必须手动逐条阅读，不能用脚本自动匹配
- 新增 17 条常见误识别规则（详见 3.2 节）
- 漏字问题比误识别更难发现，需要特别注意
