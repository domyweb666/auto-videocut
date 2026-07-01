#!/bin/bash
#
# 根据删除列表剪辑视频（匹配码率重编码，帧级精确）
#
# 原理：每个保留片段用 -ss/-to 独立提取（避免 trim filter 灰帧问题）
# 分批并行处理，最后 concat demuxer 无损拼接
#
# 用法: ./cut_video.sh <input.mp4> <delete_segments.json> [output.mp4]
#

INPUT="$1"
DELETE_JSON="$2"
OUTPUT="${3:-output_cut.mp4}"
PARALLEL=4  # 同时编码的段数

if [ -z "$INPUT" ] || [ -z "$DELETE_JSON" ]; then
  echo "❌ 用法: ./cut_video.sh <input.mp4> <delete_segments.json> [output.mp4]"
  exit 1
fi

if [ ! -f "$INPUT" ]; then
  echo "❌ 找不到输入文件: $INPUT"
  exit 1
fi

if [ ! -f "$DELETE_JSON" ]; then
  echo "❌ 找不到删除列表: $DELETE_JSON"
  exit 1
fi

# ── MERGE_GAP 合併：單一事實來源 merge_delete_segments.js ──
# 落地「合併後的最終刪除清單」，本腳本與 SRT/TXT/verify 全部以這份為準，
# 不再各自複製合併規則（否則字幕會因被吞的短保留區而時間漂移）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FINAL_JSON="${DELETE_JSON%.json}.final.json"
if ! node "$SCRIPT_DIR/merge_delete_segments.js" "$DELETE_JSON" "$FINAL_JSON" || [ ! -f "$FINAL_JSON" ]; then
  echo "❌ 產生最終刪除清單失敗: $FINAL_JSON"
  exit 1
fi

# 获取视频信息
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "file:$INPUT")
BITRATE=$(ffprobe -v error -show_entries stream=bit_rate -select_streams v:0 -of csv=p=0 "file:$INPUT")
PROFILE=$(ffprobe -v error -show_entries stream=profile -select_streams v:0 -of csv=p=0 "file:$INPUT")
PIX_FMT=$(ffprobe -v error -show_entries stream=pix_fmt -select_streams v:0 -of csv=p=0 "file:$INPUT")
# 偵測原片 fps（解決剪接點定格：所有片段強制成同一 CFR）
INPUT_FPS_RAW=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "file:$INPUT")
# 把 "30000/1001" 之類分數算成小數
INPUT_FPS=$(node -e "
  const r='$INPUT_FPS_RAW';
  if(!r||r==='N/A'){console.log('30');process.exit()}
  if(r.includes('/')){const [a,b]=r.split('/').map(Number);console.log((a/b).toFixed(3))}
  else console.log(r);
" 2>/dev/null || echo "30")

# mkv/mov 等格式 stream bitrate 可能為 N/A，改用 container bitrate
if [ -z "$BITRATE" ] || [ "$BITRATE" = "N/A" ]; then
  BITRATE=$(ffprobe -v error -show_entries format=bit_rate -of csv=p=0 "file:$INPUT")
fi
# 若仍為空，預設 5000kbps
if [ -z "$BITRATE" ] || [ "$BITRATE" = "N/A" ]; then
  BITRATE=5000000
fi

BITRATE_K=$((BITRATE/1000))

# 碼率模式（recommended=原片 / high=×1.5 / low=×0.6）
case "${CUT_BITRATE_MODE:-recommended}" in
  high) BITRATE_K=$((BITRATE_K * 15 / 10)); echo "📊 碼率: 更高（原片 ×1.5）";;
  low)  BITRATE_K=$((BITRATE_K * 6 / 10));  echo "📊 碼率: 更低（原片 ×0.6，省空間）";;
  *) ;;
esac

MAXRATE_K=$((BITRATE_K * 13 / 10))
BUFSIZE_K=$((BITRATE_K * 2))

echo "📹 视频时长: ${DURATION}s"
echo "📊 原片参数: ${BITRATE_K}kbps, profile=${PROFILE}, pix_fmt=${PIX_FMT}"
echo "⚙️ 匹配码率重编码（-ss/-to 逐段提取，无 trim filter）"

# 创建临时目录（Windows 相容：放在輸出檔案同層，避免 mktemp 路徑問題）
OUTPUT_DIR=$(dirname "$OUTPUT")
TMP_DIR="$OUTPUT_DIR/_tmp_cut_$$"
mkdir -p "$TMP_DIR"
trap "rm -rf '$TMP_DIR'" EXIT

# 映射 profile
PROFILE_LC=$(echo "$PROFILE" | tr '[:upper:]' '[:lower:]')
case "$PROFILE_LC" in
  "high") X264_PROFILE="high" ;;
  "main") X264_PROFILE="main" ;;
  "baseline") X264_PROFILE="baseline" ;;
  *) X264_PROFILE="high" ;;
esac

# 偵測硬體編碼器（優先 NVENC > QSV > AMF > 軟編碼）
detect_encoder() {
  local os_type
  os_type=$(uname -s 2>/dev/null || echo "Windows")

  case "$os_type" in
    Darwin*)
      if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
        ENCODER="h264_videotoolbox"
        ENCODER_ARGS="-q:v 60"
        ENCODER_LABEL="VideoToolbox (macOS)"
        return
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows*)
      if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc; then
        ENCODER="h264_nvenc"
        ENCODER_ARGS="-preset p4 -cq 20 -profile:v $X264_PROFILE"
        ENCODER_LABEL="NVENC (NVIDIA)"
        return
      fi
      if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_qsv; then
        ENCODER="h264_qsv"
        ENCODER_ARGS="-global_quality 20 -profile:v $X264_PROFILE"
        ENCODER_LABEL="QSV (Intel)"
        return
      fi
      if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_amf; then
        ENCODER="h264_amf"
        ENCODER_ARGS="-quality balanced -profile:v $X264_PROFILE"
        ENCODER_LABEL="AMF (AMD)"
        return
      fi
      ;;
    Linux*)
      if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc; then
        ENCODER="h264_nvenc"
        ENCODER_ARGS="-preset p4 -cq 20 -profile:v $X264_PROFILE"
        ENCODER_LABEL="NVENC (NVIDIA)"
        return
      fi
      if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_vaapi; then
        ENCODER="h264_vaapi"
        ENCODER_ARGS="-qp 20"
        ENCODER_LABEL="VAAPI (Linux)"
        return
      fi
      ;;
  esac

  # 軟編碼兜底
  ENCODER="libx264"
  ENCODER_ARGS="-profile:v $X264_PROFILE"
  ENCODER_LABEL="x264 (軟編碼)"
}

detect_encoder

# ── 匯出選項（環境變數）──
# CUT_LOSSLESS: 1 (無損模式：音訊 copy、影片 libx264 CRF 17，忽略解析度/fps/codec)
# CUT_RESOLUTION: 1080 / 720 / 480 / (空=原始)
# CUT_CODEC: h265 / av1 / (空=h264)
# CUT_FPS: 30 / 60 / (空=原始)
# CUT_CONTAINER: mp4(預設) / mkv / mov（由呼叫端透過 OUTPUT 檔名決定副檔名，此變數僅參考）
# CUT_BITRATE_MODE: recommended(預設) / high / low（於上方已處理）
# CUT_AUDIO_ONLY: 1 = 輸出 mp3（剪輯完成後抽音訊，刪除視訊）
# CUT_EXPORT_GIF: 1 = 在剪輯完成後額外產生 240P 15fps GIF

SCALE_FILTER=""
FPS_ARGS=""
# 注意：A/V 漂移修正（原 -async 1）改由每段 -af 內的 aresample=async=1 處理，
# 因為 -async 與 -af 不能同時使用，故把同步折進 filter chain。
AUDIO_ARGS="-c:a aac -b:a 128k"

# 切點淡入淡出秒數（借鑑 video-use：每段頭尾各加微淡入/淡出，消除 concat 接點爆音）
# 可用 CUT_FADE_DUR 覆寫；設 0 關閉。無損模式音訊 copy 無法套 filter，自動略過。
FADE_DUR="${CUT_FADE_DUR:-0.03}"

if [ "$CUT_LOSSLESS" = "1" ]; then
  echo "💎 無損模式：音訊 stream copy、影片 libx264 CRF 17（忽略解析度/codec）"
  ENCODER="libx264"
  ENCODER_ARGS="-crf 17 -preset slow -profile:v $X264_PROFILE"
  ENCODER_LABEL="libx264 CRF 17 (近無損)"
  # lossless 也要 CFR，否則剪接點仍會定格
  FPS_ARGS="-r $INPUT_FPS -fps_mode cfr"
  AUDIO_ARGS="-c:a copy"
  FADE_DUR=""  # copy 串流無法套 afade
else
  if [ "$CUT_RESOLUTION" = "4320" ]; then
    SCALE_FILTER="-vf scale=7680:4320:force_original_aspect_ratio=decrease,pad=7680:4320:-1:-1:color=black"
    echo "📐 解析度: 8K (7680×4320)"
  elif [ "$CUT_RESOLUTION" = "2160" ]; then
    SCALE_FILTER="-vf scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:-1:-1:color=black"
    echo "📐 解析度: 4K (3840×2160)"
  elif [ "$CUT_RESOLUTION" = "1440" ]; then
    SCALE_FILTER="-vf scale=2560:1440:force_original_aspect_ratio=decrease,pad=2560:1440:-1:-1:color=black"
    echo "📐 解析度: 2K (2560×1440)"
  elif [ "$CUT_RESOLUTION" = "1080" ]; then
    SCALE_FILTER="-vf scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1:color=black"
    echo "📐 解析度: 1080P"
  elif [ "$CUT_RESOLUTION" = "720" ]; then
    SCALE_FILTER="-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1:color=black"
    echo "📐 解析度: 720P"
  elif [ "$CUT_RESOLUTION" = "480" ]; then
    SCALE_FILTER="-vf scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:-1:-1:color=black"
    echo "📐 解析度: 480P"
  fi

  if [ "$CUT_CODEC" = "h265" ]; then
    echo "🔄 切換到 H.265/HEVC 編碼器..."
    if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_nvenc; then
      ENCODER="hevc_nvenc"; ENCODER_ARGS="-preset p4 -cq 22"; ENCODER_LABEL="HEVC NVENC (GPU)"
    elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_qsv; then
      ENCODER="hevc_qsv"; ENCODER_ARGS="-global_quality 22"; ENCODER_LABEL="HEVC QSV (Intel)"
    elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_amf; then
      ENCODER="hevc_amf"; ENCODER_ARGS="-quality quality"; ENCODER_LABEL="HEVC AMF (AMD)"
    else
      ENCODER="libx265"; ENCODER_ARGS="-crf 22 -preset medium"; ENCODER_LABEL="libx265 (軟編碼)"
    fi
  elif [ "$CUT_CODEC" = "av1" ]; then
    echo "🔄 切換到 AV1 編碼器..."
    if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q av1_nvenc; then
      ENCODER="av1_nvenc"; ENCODER_ARGS="-preset p4 -cq 30"; ENCODER_LABEL="AV1 NVENC (RTX 40+)"
    elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q av1_qsv; then
      ENCODER="av1_qsv"; ENCODER_ARGS="-global_quality 30"; ENCODER_LABEL="AV1 QSV (Intel Arc / 13th+)"
    elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q av1_amf; then
      ENCODER="av1_amf"; ENCODER_ARGS="-quality quality"; ENCODER_LABEL="AV1 AMF (RX 7000+)"
    elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libsvtav1; then
      ENCODER="libsvtav1"; ENCODER_ARGS="-crf 30 -preset 6"; ENCODER_LABEL="SVT-AV1 (軟編碼)"
    elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libaom-av1; then
      ENCODER="libaom-av1"; ENCODER_ARGS="-crf 30 -b:v 0 -cpu-used 4"; ENCODER_LABEL="libaom-av1 (軟編碼, 慢)"
    else
      echo "⚠️ 此系統無可用 AV1 編碼器，fallback 到 H.265"
      if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_nvenc; then
        ENCODER="hevc_nvenc"; ENCODER_ARGS="-preset p4 -cq 22"; ENCODER_LABEL="HEVC NVENC (AV1 fallback)"
      else
        ENCODER="libx265"; ENCODER_ARGS="-crf 22 -preset medium"; ENCODER_LABEL="libx265 (AV1 fallback)"
      fi
    fi
  fi

  if [ -n "$CUT_FPS" ]; then
    FPS_ARGS="-r $CUT_FPS -fps_mode cfr"
    echo "🎬 幀率: ${CUT_FPS}fps (CFR 強制)"
  else
    # 沒指定 → 套原片 fps，但**強制 CFR**避免剪接點定格
    FPS_ARGS="-r $INPUT_FPS -fps_mode cfr"
    echo "🎬 幀率: ${INPUT_FPS}fps (跟隨原片，CFR 強制以避免剪接點定格)"
  fi
fi

echo "🎯 編碼器: $ENCODER_LABEL"
if [ -n "$FADE_DUR" ] && [ "$FADE_DUR" != "0" ]; then
  echo "🔊 切點淡入淡出: ${FADE_DUR}s（消除接點爆音）"
fi

# 用 node 计算保留片段，生成提取脚本和 concat 列表
# 注意：讀的是 FINAL_JSON（merge_delete_segments.js 已排序＋合併），此處不再自己合併
TOTAL_SEGS=$(node -e "
const fs = require('fs');
const mergedSegs = JSON.parse(fs.readFileSync('$FINAL_JSON', 'utf8'));
const duration = $DURATION;

const keepSegs = [];
let cursor = 0;
for (const del of mergedSegs) {
  if (del.start > cursor) keepSegs.push({ start: cursor, end: del.start });
  cursor = del.end;
}
if (cursor < duration) keepSegs.push({ start: cursor, end: duration });

let deletedTime = 0;
for (const seg of mergedSegs) deletedTime += seg.end - seg.start;

console.error('保留片段数:', keepSegs.length);
console.error('删除片段数:', mergedSegs.length);
console.error('删除总时长:', deletedTime.toFixed(2) + 's');
console.error('预计输出时长:', (duration - deletedTime).toFixed(2) + 's');

// 生成 concat 列表和片段信息
const concatLines = [];
const segInfos = [];
keepSegs.forEach((seg, i) => {
  const padded = String(i).padStart(5, '0');
  const outFile = '$TMP_DIR/seg_' + padded + '.mp4';
  // concat.txt 與 seg 檔同在 TMP_DIR：concat demuxer 會把 file 路徑當成相對於 concat.txt 所在資料夾，
  // 故此處只寫檔名（不加 TMP_DIR 前綴），否則 OUTPUT 為相對路徑時會疊成 TMP_DIR/TMP_DIR/seg 而找不到
  concatLines.push(\"file 'seg_\" + padded + \".mp4'\");
  segInfos.push({ i, start: seg.start, end: seg.end, out: outFile });
});

fs.writeFileSync('$TMP_DIR/concat.txt', concatLines.join('\n'));
fs.writeFileSync('$TMP_DIR/segments.json', JSON.stringify(segInfos));
console.log(keepSegs.length);
")

if [ -z "$TOTAL_SEGS" ] || [ "$TOTAL_SEGS" -eq 0 ]; then
  echo "❌ 计算保留片段失败"
  exit 1
fi

# ── 單趟濾鏡 vs 多段提取＋concat 的選擇 ──
# 多段 concat 會在每個 AAC 接點累積 encoder priming 靜音，段數一多（停頓壓平會產生數十段）
# 整段音訊破裂（實測 63 段 → 77s 靜音）。段數超過門檻改用 select/aselect 單趟重編碼（無 concat）。
# 可用 CUT_SINGLE_PASS=1 強制開、=0 強制關。
SINGLE_PASS_THRESHOLD="${CUT_SINGLE_PASS_THRESHOLD:-12}"
USE_SINGLE_PASS=0
if [ "$CUT_LOSSLESS" != "1" ] && [ "$TOTAL_SEGS" -gt "$SINGLE_PASS_THRESHOLD" ]; then USE_SINGLE_PASS=1; fi
[ "$CUT_SINGLE_PASS" = "1" ] && USE_SINGLE_PASS=1
[ "$CUT_SINGLE_PASS" = "0" ] && USE_SINGLE_PASS=0

# faststart flags（兩條路徑共用）
OUT_EXT_LC=$(echo "${OUTPUT##*.}" | tr '[:upper:]' '[:lower:]')
MOVFLAGS_ARGS=""
if [ "$OUT_EXT_LC" = "mp4" ] || [ "$OUT_EXT_LC" = "mov" ] || [ "$OUT_EXT_LC" = "m4v" ]; then
  MOVFLAGS_ARGS="-movflags +faststart"
fi

if [ "$USE_SINGLE_PASS" = "1" ]; then
  echo "🎛️ 單趟濾鏡切割（${TOTAL_SEGS} 段，trim/atrim+concat 一次重編碼，避免多段 concat 音訊破裂）"
  # 由 segments.json（保留片段）生成 filter_complex 腳本。
  # 用 trim/atrim+concat（每個 clause 簡單），不用 select 的巨型 between() 表達式——
  # 後者段數一多會撐爆 ffmpeg 運算式解析器（Cannot allocate memory）。
  node -e "
const fs=require('fs');
const segs=JSON.parse(fs.readFileSync('$TMP_DIR/segments.json','utf8'));
let scale=(process.argv[1]||'').replace(/^-vf[ ]+/,'');
const parts=[]; const labels=[];
segs.forEach((s,i)=>{
  parts.push('[0:v]trim='+s.start.toFixed(3)+':'+s.end.toFixed(3)+',setpts=PTS-STARTPTS[v'+i+']');
  parts.push('[0:a]atrim='+s.start.toFixed(3)+':'+s.end.toFixed(3)+',asetpts=PTS-STARTPTS[a'+i+']');
  labels.push('[v'+i+'][a'+i+']');
});
parts.push(labels.join('')+'concat=n='+segs.length+':v=1:a=1[vc][a]');
parts.push('[vc]'+(scale?scale:'null')+'[v]');
fs.writeFileSync('$TMP_DIR/filt.txt', parts.join(';'));
" "$SCALE_FILTER"
  if [ "$CUT_LOSSLESS" = "1" ]; then
    ffmpeg -y -v error -stats -i "file:$INPUT" -filter_complex_script "$TMP_DIR/filt.txt" \
      -map "[v]" -map "[a]" -c:v $ENCODER $ENCODER_ARGS -pix_fmt $PIX_FMT $FPS_ARGS $AUDIO_ARGS $MOVFLAGS_ARGS "file:$OUTPUT"
  else
    ffmpeg -y -v error -stats -i "file:$INPUT" -filter_complex_script "$TMP_DIR/filt.txt" \
      -map "[v]" -map "[a]" -c:v $ENCODER $ENCODER_ARGS -b:v ${BITRATE_K}k -maxrate ${MAXRATE_K}k -bufsize ${BUFSIZE_K}k \
      -pix_fmt $PIX_FMT $FPS_ARGS $AUDIO_ARGS $MOVFLAGS_ARGS "file:$OUTPUT"
  fi
  if [ $? -ne 0 ]; then echo "❌ 單趟切割失敗"; exit 1; fi
  echo ""
  echo "✅ 已保存: $OUTPUT"
  NEW_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "file:$OUTPUT")
  echo "📹 新时长: ${NEW_DURATION}s"
else

echo "✂️ 提取 $TOTAL_SEGS 个片段（并行度 $PARALLEL）..."
if [ "$CUT_LOSSLESS" = "1" ]; then
  echo "   编码: $ENCODER $ENCODER_ARGS -pix_fmt $PIX_FMT (CRF-based, audio=copy)"
else
  echo "   编码: $ENCODER $ENCODER_ARGS -b:v ${BITRATE_K}k -pix_fmt $PIX_FMT"
fi

# node 生成每段独立的 shell 脚本
# argv: [input, encoder, bitrate_k, maxrate_k, bufsize_k, pix_fmt, encoder_args, scale_filter, fps_args, audio_args, lossless]
node -e "
const fs = require('fs');
const segs = JSON.parse(fs.readFileSync('$TMP_DIR/segments.json', 'utf8'));
const isLossless = process.argv[11] === '1';
const fadeDur = parseFloat(process.argv[12] || '0') || 0;
segs.forEach((s, i) => {
  // 切點淡入淡出 + A/V 同步：折進同一條 -af（無損 copy 模式略過）
  let afArg = '';
  if (!isLossless) {
    const segDur = s.end - s.start;
    const fd = Math.min(fadeDur, segDur / 2);
    // 注意：混合跳轉用 -accurate_seek，每段影音已幀準對齊，不需 aresample=async=1
    // （它原是補償 input-seek 的 A/V 漂移；精準 seek 下反而會塞 padding 造成累積漂移/殘音）
    const chain = [];
    if (fd > 0.001) {
      chain.push('afade=t=in:st=0:d=' + fd.toFixed(3));
      chain.push('afade=t=out:st=' + Math.max(0, segDur - fd).toFixed(3) + ':d=' + fd.toFixed(3));
    }
    if (chain.length) afArg = ' -af \"' + chain.join(',') + '\"';
  }
  // 混合跳轉：先 input seek 快速到 START 前 PAD 秒（落在前一個 keyframe），
  // 再用 output seek（-ss 在 -i 之後）精準微調到 START，-t 取精確長度。
  // 純 input seek + CFR 會讓每段影/音各自多出不一致的零頭 → 拼接後嘴型漂移；
  // output seek 則幀準且影音對齊。input seek 保留 → 末段也不必從頭解碼，維持速度。
  const PAD = 1.0;
  const seekPre = Math.max(0, s.start - PAD);
  const fineOff = s.start - seekPre;
  const segLen2 = s.end - s.start;
  let cmd = '#!/bin/bash\nffmpeg -y -v error' +
    ' -ss ' + seekPre.toFixed(3) + ' -accurate_seek' +
    ' -i \"file:' + process.argv[1] + '\"' +
    ' -ss ' + fineOff.toFixed(3) + ' -t ' + segLen2.toFixed(3) +
    ' -c:v ' + process.argv[2] + ' ' + process.argv[7];
  if (!isLossless) {
    cmd += ' -b:v ' + process.argv[3] + 'k -maxrate ' + process.argv[4] + 'k -bufsize ' + process.argv[5] + 'k';
  }
  cmd += ' -pix_fmt ' + process.argv[6] +
    (process.argv[8] ? ' ' + process.argv[8] : '') +
    (process.argv[9] ? ' ' + process.argv[9] : '') +
    ' ' + process.argv[10] + afArg +
    ' -avoid_negative_ts make_zero' +
    ' \"file:' + s.out + '\"\n';
  const padded = String(i).padStart(5, '0');
  fs.writeFileSync('$TMP_DIR/cmd_' + padded + '.sh', cmd);
});
" "$INPUT" "$ENCODER" "$BITRATE_K" "$MAXRATE_K" "$BUFSIZE_K" "$PIX_FMT" "$ENCODER_ARGS" "$SCALE_FILTER" "$FPS_ARGS" "$AUDIO_ARGS" "${CUT_LOSSLESS:-0}" "$FADE_DUR"

# 逐段提取（控制并行度）
RUNNING=0
DONE=0

for CMD_FILE in "$TMP_DIR"/cmd_*.sh; do
  (
    bash "$CMD_FILE" || touch "$TMP_DIR/failed"
  ) &

  RUNNING=$((RUNNING + 1))
  if [ "$RUNNING" -ge "$PARALLEL" ]; then
    # wait -n 需要 bash 4.3+，Git Bash 可能不支援，fallback 到 wait
    if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) )); then
      wait -n 2>/dev/null || wait
    else
      wait
    fi
    RUNNING=$((RUNNING - 1))
    DONE=$((DONE + 1))
    printf "\r   进度: %d/%d" "$DONE" "$TOTAL_SEGS"
    # 機器可解析的進度行（給 training_server.js 解析用）
    echo "PROGRESS=${DONE}/${TOTAL_SEGS}"
  fi
done

# 等待剩余任务
wait
# 最後一批可能有未計入的片段，補一行 100% 進度
echo "PROGRESS=${TOTAL_SEGS}/${TOTAL_SEGS}"
echo ""

if [ -f "$TMP_DIR/failed" ]; then
  echo "❌ 部分片段编码失败"
  exit 1
fi

echo "   ✅ 全部 $TOTAL_SEGS 个片段提取完成"

# 拼接
echo "🔗 拼接..."
OUT_EXT_LC=$(echo "${OUTPUT##*.}" | tr '[:upper:]' '[:lower:]')
MOVFLAGS_ARGS=""
# faststart 僅對 mp4/mov 家族有效（放 moov atom 到檔頭，串流更快）
if [ "$OUT_EXT_LC" = "mp4" ] || [ "$OUT_EXT_LC" = "mov" ] || [ "$OUT_EXT_LC" = "m4v" ]; then
  MOVFLAGS_ARGS="-movflags +faststart"
fi
ffmpeg -y -v error -stats \
  -f concat -safe 0 -i "$TMP_DIR/concat.txt" \
  -c copy \
  $MOVFLAGS_ARGS \
  "file:$OUTPUT"

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ 已保存: $OUTPUT"
  NEW_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "file:$OUTPUT")
  NEW_BR=$(ffprobe -v error -show_entries stream=bit_rate -select_streams v:0 -of csv=p=0 "file:$OUTPUT")
  if [ -z "$NEW_BR" ] || [ "$NEW_BR" = "N/A" ]; then
    NEW_BR=$(ffprobe -v error -show_entries format=bit_rate -of csv=p=0 "file:$OUTPUT")
  fi
  if [ -n "$NEW_BR" ] && [ "$NEW_BR" != "N/A" ]; then
    NEW_BR_K=$((NEW_BR/1000))
  else
    NEW_BR_K="?"
  fi
  echo "📹 新时长: ${NEW_DURATION}s"
  echo "📊 原始码率: ${BITRATE_K}kbps → 输出码率: ${NEW_BR_K}kbps"
else
  echo "❌ 拼接失败"
  exit 1
fi

fi  # ── end: 單趟濾鏡 / 多段 concat 二擇一 ──

# ── GIF 匯出（240P, 15fps）──
if [ "$CUT_EXPORT_GIF" = "1" ]; then
  GIF_OUT="${OUTPUT%.*}.gif"
  echo "🎞️ 產生 GIF: $GIF_OUT"
  # 兩步法：先產調色板，再依調色板產 GIF，畫質更好
  PALETTE="$TMP_DIR/palette.png"
  ffmpeg -y -v error -i "file:$OUTPUT" \
    -vf "fps=15,scale=240:-1:flags=lanczos,palettegen" "$PALETTE" \
  && ffmpeg -y -v error -i "file:$OUTPUT" -i "$PALETTE" \
       -lavfi "fps=15,scale=240:-1:flags=lanczos [v]; [v][1:v] paletteuse" \
       -loop 0 "file:$GIF_OUT"
  if [ $? -eq 0 ]; then
    echo "✅ GIF: $GIF_OUT"
  else
    echo "⚠️ GIF 生成失敗"
  fi
fi

# ── 音訊匯出（MP3）──
# 執行於最後：若勾選，從最終視訊抽取音訊，並刪除原視訊檔案
if [ "$CUT_AUDIO_ONLY" = "1" ]; then
  MP3_OUT="${OUTPUT%.*}.mp3"
  echo "🎵 抽取音訊為 MP3: $MP3_OUT"
  ffmpeg -y -v error -i "file:$OUTPUT" -vn -acodec libmp3lame -q:a 2 "file:$MP3_OUT"
  if [ $? -eq 0 ]; then
    rm -f "$OUTPUT"
    echo "✅ 音訊檔: $MP3_OUT（已刪除中繼視訊）"
  else
    echo "⚠️ MP3 轉換失敗，保留原視訊 $OUTPUT"
  fi
fi
