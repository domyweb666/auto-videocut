#!/bin/bash
#
# Whisper 本地語音辨識（繁體中文）
#
# 用法: ./whisper_transcribe.sh <audio_file>
# 輸出: whisper_result.json
#

AUDIO_FILE="$1"

if [ -z "$AUDIO_FILE" ]; then
  echo "❌ 用法: ./whisper_transcribe.sh <audio_file>"
  exit 1
fi

if [ ! -f "$AUDIO_FILE" ]; then
  echo "❌ 找不到音訊檔案: $AUDIO_FILE"
  exit 1
fi

# 確認 whisper 已安裝
if ! command -v whisper &> /dev/null; then
  echo "❌ 找不到 whisper 指令，請先安裝："
  echo "   pip install openai-whisper"
  exit 1
fi

AUDIO_BASENAME=$(basename "$AUDIO_FILE" | sed 's/\.[^.]*$//')
OUTPUT_DIR=$(dirname "$AUDIO_FILE")

echo "🎤 開始 Whisper 本地轉錄..."
echo "音訊檔案: $AUDIO_FILE"
echo "模型: large-v3 | 語言: 繁體中文"

whisper "$AUDIO_FILE" \
  --model large-v3 \
  --language zh \
  --initial_prompt "以下是繁體中文口語內容：" \
  --word_timestamps True \
  --output_format json \
  --output_dir "$OUTPUT_DIR"

# Whisper 輸出檔名為 <音訊名>.json，統一改名為 whisper_result.json
WHISPER_OUTPUT="$OUTPUT_DIR/${AUDIO_BASENAME}.json"

if [ ! -f "$WHISPER_OUTPUT" ]; then
  echo "❌ 轉錄失敗，找不到輸出檔案: $WHISPER_OUTPUT"
  exit 1
fi

mv "$WHISPER_OUTPUT" "$OUTPUT_DIR/whisper_result.json"

echo "✅ 轉錄完成，已儲存 whisper_result.json"

# 顯示統計
WORD_COUNT=$(python3 -c "
import json, sys
data = json.load(open('$OUTPUT_DIR/whisper_result.json'))
count = sum(len(s.get('words', [])) for s in data.get('segments', []))
print(count)
" 2>/dev/null || echo "?")
echo "📝 識別到 $WORD_COUNT 個字"
