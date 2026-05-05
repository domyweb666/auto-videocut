#!/bin/bash
#
# Whisper 本地語音辨識（繁體中文）+ VAD 前置靜音偵測
#
# VAD 邏輯：先用 ffmpeg silencedetect 找出 ≥3s 的靜音區段
# 若存在，把音訊拆成「說話片段」分批送 Whisper，避免幻覺
# 最後合併時間戳，還原成完整 whisper_result.json
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

if ! command -v whisper &> /dev/null; then
  echo "❌ 找不到 whisper 指令，請先安裝："
  echo "   pip install openai-whisper"
  exit 1
fi

AUDIO_BASENAME=$(basename "$AUDIO_FILE" | sed 's/\.[^.]*$//')
OUTPUT_DIR=$(dirname "$AUDIO_FILE")
RESULT_FILE="$OUTPUT_DIR/whisper_result.json"

echo "🎤 開始 Whisper 本地轉錄..."
echo "音訊檔案: $AUDIO_FILE"
echo "模型: large-v3 | 語言: 繁體中文"

# ── VAD 前置偵測 ──
# 用 ffmpeg silencedetect 找出 ≥ 3s 的靜音，避免長靜音觸發幻覺
VAD_SILENCE_DUR=3.0    # 靜音門檻（秒），超過才分段
VAD_NOISE_DB="-40dB"  # 靜音音量門檻
CONTEXT_PAD=0.3        # 每段前後保留的重疊秒數（避免截字）

echo "🔍 VAD：偵測靜音區段（≥${VAD_SILENCE_DUR}s @ ${VAD_NOISE_DB}）..."
SILENCE_RAW=$(ffmpeg -i "$AUDIO_FILE" \
  -af "silencedetect=noise=${VAD_NOISE_DB}:duration=${VAD_SILENCE_DUR}" \
  -f null - 2>&1 | grep -E "silence_(start|end)")

# 用 Python 決定是否需要 VAD 分段，並產生 segments.json
SEGMENTS_JSON="$OUTPUT_DIR/_vad_segments.json"
python3 - "$AUDIO_FILE" "$SILENCE_RAW" "$SEGMENTS_JSON" "$VAD_SILENCE_DUR" "$CONTEXT_PAD" << 'PYEOF'
import sys, json, re

audio_file   = sys.argv[1]
silence_raw  = sys.argv[2]
out_json     = sys.argv[3]
min_sil      = float(sys.argv[4])
pad          = float(sys.argv[5])

import subprocess
result = subprocess.run(
    ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
     '-of', 'csv=p=0', audio_file],
    capture_output=True, text=True
)
total_dur = float(result.stdout.strip() or '0')

# 解析 silencedetect 輸出
starts, ends = [], []
for line in silence_raw.split('\n'):
    m = re.search(r'silence_start:\s*([\d.]+)', line)
    if m: starts.append(float(m.group(1)))
    m = re.search(r'silence_end:\s*([\d.]+)', line)
    if m: ends.append(float(m.group(1)))

# 配對靜音區間
silences = []
for i in range(min(len(starts), len(ends))):
    if ends[i] - starts[i] >= min_sil:
        silences.append((starts[i], ends[i]))
# 尾部未閉合的靜音（影片結尾靜音）
if len(starts) > len(ends):
    if total_dur - starts[-1] >= min_sil:
        silences.append((starts[-1], total_dur))

if not silences:
    # 無長靜音 → 直接跑全檔，不需分段
    json.dump([{"start": 0, "end": total_dur, "offset": 0}], open(out_json, 'w'))
    print(f"VAD: 無長靜音，直接全檔轉錄（{total_dur:.1f}s）", flush=True)
    sys.exit(0)

total_silence = sum(e - s for s, e in silences)
print(f"VAD: 發現 {len(silences)} 段長靜音，共 {total_silence:.1f}s / {total_dur:.1f}s", flush=True)

# 計算說話區段（靜音補集）
speech = []
cursor = 0.0
for s, e in sorted(silences):
    if s > cursor + 0.1:
        seg_start = max(0, cursor - pad)
        seg_end   = min(total_dur, s + pad)
        speech.append({"start": seg_start, "end": seg_end, "offset": cursor - pad if cursor > 0 else 0})
    cursor = e
if cursor < total_dur - 0.1:
    seg_start = max(0, cursor - pad)
    speech.append({"start": seg_start, "end": total_dur, "offset": cursor - pad if cursor > 0 else 0})

json.dump(speech, open(out_json, 'w'))
print(f"VAD: {len(speech)} 個說話區段", flush=True)
PYEOF

if [ $? -ne 0 ] || [ ! -f "$SEGMENTS_JSON" ]; then
  echo "⚠️ VAD 偵測失敗，回退到全檔轉錄"
  SEGMENTS_JSON=""
fi

# ── 決定轉錄方式 ──
SEG_COUNT=$(python3 -c "import json; d=json.load(open('$SEGMENTS_JSON')); print(len(d))" 2>/dev/null || echo "1")

if [ "$SEG_COUNT" -le 1 ] || [ -z "$SEGMENTS_JSON" ]; then
  # ── 標準全檔轉錄 ──
  echo "📝 全檔轉錄..."
  whisper "$AUDIO_FILE" \
    --model large-v3 \
    --language zh \
    --initial_prompt "以下是繁體中文口語內容：" \
    --word_timestamps True \
    --output_format json \
    --output_dir "$OUTPUT_DIR"

  WHISPER_OUTPUT="$OUTPUT_DIR/${AUDIO_BASENAME}.json"
  if [ ! -f "$WHISPER_OUTPUT" ]; then
    echo "❌ 轉錄失敗，找不到輸出檔案: $WHISPER_OUTPUT"
    exit 1
  fi
  mv "$WHISPER_OUTPUT" "$RESULT_FILE"
else
  # ── VAD 分段轉錄 ──
  echo "🔀 VAD 分段轉錄（${SEG_COUNT} 段）..."
  TMP_DIR="$OUTPUT_DIR/_vad_tmp"
  mkdir -p "$TMP_DIR"

  # 提取每段音訊並轉錄
  python3 - "$SEGMENTS_JSON" "$AUDIO_FILE" "$TMP_DIR" << 'PYEOF2'
import sys, json, subprocess, os

segs_file  = sys.argv[1]
audio_file = sys.argv[2]
tmp_dir    = sys.argv[3]
segs = json.load(open(segs_file))

for i, seg in enumerate(segs):
    clip = os.path.join(tmp_dir, f'clip_{i:04d}.wav')
    subprocess.run([
        'ffmpeg', '-y', '-v', 'error',
        '-ss', str(seg['start']), '-to', str(seg['end']),
        '-i', audio_file,
        '-ar', '16000', '-ac', '1', clip
    ], check=True)
    print(f"  抽取片段 {i+1}/{len(segs)}: {seg['start']:.1f}s-{seg['end']:.1f}s → {os.path.basename(clip)}", flush=True)
PYEOF2

  # 各段分別跑 Whisper
  for CLIP in "$TMP_DIR"/clip_*.wav; do
    IDX=$(basename "$CLIP" | grep -o '[0-9]*')
    CLIP_BASENAME=$(basename "$CLIP" .wav)
    echo "  🎙️ Whisper 片段 $(echo $IDX | sed 's/^0*//')/${SEG_COUNT}..."
    whisper "$CLIP" \
      --model large-v3 \
      --language zh \
      --initial_prompt "以下是繁體中文口語內容：" \
      --word_timestamps True \
      --output_format json \
      --output_dir "$TMP_DIR" 2>/dev/null
  done

  # 合併所有片段結果，套用時間偏移
  python3 - "$SEGMENTS_JSON" "$TMP_DIR" "$RESULT_FILE" << 'PYEOF3'
import sys, json, os, re

segs_file   = sys.argv[1]
tmp_dir     = sys.argv[2]
result_file = sys.argv[3]

segs = json.load(open(segs_file))
merged_segments = []

for i, seg in enumerate(segs):
    clip_name = f'clip_{i:04d}'
    clip_json = os.path.join(tmp_dir, clip_name + '.json')
    if not os.path.exists(clip_json):
        print(f"  ⚠️ 找不到片段結果: {clip_json}", flush=True)
        continue
    data = json.load(open(clip_json))
    # 時間偏移 = 片段在原始音訊的起始秒
    offset = seg['start']
    for s in (data.get('segments') or []):
        new_words = []
        for w in (s.get('words') or []):
            text = (w.get('word') or '').strip()
            if not text:
                continue
            new_words.append({
                'word': text,
                'start': round(w['start'] + offset, 3),
                'end':   round(w['end']   + offset, 3),
            })
        if new_words:
            merged_segments.append({
                'start': new_words[0]['start'],
                'end':   new_words[-1]['end'],
                'text':  s.get('text', '').strip(),
                'words': new_words,
            })

result = {'segments': merged_segments}
json.dump(result, open(result_file, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
total_words = sum(len(s['words']) for s in merged_segments)
print(f"✅ 合併完成：{len(merged_segments)} 段 / {total_words} 字", flush=True)
PYEOF3

  # 清理暫存
  rm -rf "$TMP_DIR" "$SEGMENTS_JSON"
fi

if [ ! -f "$RESULT_FILE" ]; then
  echo "❌ 轉錄失敗，找不到輸出檔案"
  exit 1
fi

echo "✅ 轉錄完成，已儲存 whisper_result.json"

WORD_COUNT=$(python3 -c "
import json
data = json.load(open('$RESULT_FILE'))
count = sum(len(s.get('words', [])) for s in data.get('segments', []))
print(count)
" 2>/dev/null || echo "?")
echo "📝 識別到 $WORD_COUNT 個字"
