#!/bin/bash
# Google Cloud STT 轉錄包裝腳本
# 用法: ./google_transcribe.sh <audio.mp3>
# 輸出: google_result.json

set -e

AUDIO_FILE="$1"
if [ -z "$AUDIO_FILE" ]; then
  echo "用法: $0 <audio.mp3>"
  exit 1
fi

if [ ! -f "$AUDIO_FILE" ]; then
  echo "❌ 找不到音訊檔案: $AUDIO_FILE"
  exit 1
fi

# 確認 GOOGLE_APPLICATION_CREDENTIALS 已設定
if [ -z "$GOOGLE_APPLICATION_CREDENTIALS" ] && ! gcloud auth application-default print-access-token &>/dev/null; then
  echo "❌ 未設定 Google Cloud 認證"
  echo "請執行：export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json"
  echo "或：gcloud auth application-default login"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PYTHONIOENCODING=utf-8 python "$SCRIPT_DIR/google_transcribe.py" "$AUDIO_FILE" google_result.json
