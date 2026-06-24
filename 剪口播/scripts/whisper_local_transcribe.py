#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本機 faster-whisper 轉錄（large-v3）— 免雲端、免金鑰，每字帶 STT 把握度。

為什麼要這支：Google / OpenAI 雲端轉錄要憑證或 API key，而且多半拿不到
「每個字的 confidence」。唸糊偵測（P1 選 take / P2 唸糊）需要這個把握度——
講糊的字 STT 自己就沒把握。faster-whisper 的 word_timestamps 直接給 word.probability，
本機 GPU 跑、零外部相依、零費用。

輸出與 google_transcribe.py 相容的 google_result.json 格式，額外每字帶 confidence：
  { source:'google_stt', words:[{word,start,end,confidence}], _actual_source:'faster_whisper', ... }
下游 generate_subtitles.js 負責簡轉繁與 isGap，confidence 會一路帶到 subtitles_words.json。

用法: python whisper_local_transcribe.py <audio> [output=google_result.json] [--model large-v3] [--cpu]
"""

import os
import sys
import json

# Windows 主控台預設 cp950 無法輸出 emoji，強制 stdout/stderr 走 UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 對抗式 prompt：餵中性的繁中 PKM 語境，壓制中國頻道訓練資料的結尾語幻覺
# （與 openai_transcribe.py 同一招，Whisper 把 initial_prompt 當前文上下文延續）
ANTI_HALLUCINATION_PROMPT = (
    "這是一段繁體中文的個人知識管理講解影片，講者用台灣口語介紹"
    "卡片筆記、知識體系、Heptabase 等工具，內容專注於方法論本身，"
    "不會出現頻道訂閱結尾語。"
)


def transcribe(audio_path, output_path, model_size="large-v3", device="cuda"):
    from faster_whisper import WhisperModel

    if not os.path.exists(audio_path):
        print(f"❌ 找不到音訊檔案: {audio_path}")
        sys.exit(1)

    compute_type = "float16" if device == "cuda" else "int8"
    print(f"📁 音訊: {audio_path}")
    print(f"🧠 載入 faster-whisper {model_size}（{device}/{compute_type}）… 首次會下載模型（~3GB）")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    print("🎙️  轉錄中（word_timestamps，每字把握度）…")
    segments, info = model.transcribe(
        audio_path,
        language="zh",
        word_timestamps=True,
        initial_prompt=ANTI_HALLUCINATION_PROMPT,
        temperature=0,
        vad_filter=True,          # 內建 VAD 過濾長靜音，降低幻覺
        vad_parameters={"min_silence_duration_ms": 500},
    )

    all_words = []
    for seg in segments:
        if not seg.words:
            continue
        for w in seg.words:
            text = (w.word or "").strip()
            if not text:
                continue
            # w.probability ∈ [0,1] 是這個字的 STT 把握度（= 我們要的 confidence）
            conf = float(w.probability) if w.probability is not None else None
            word_obj = {
                "word": text,
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
            }
            if conf is not None:
                word_obj["confidence"] = round(conf, 4)
            all_words.append(word_obj)

    if not all_words:
        print("⚠️  未轉出任何字，請確認音訊與模型")
        sys.exit(1)

    duration = all_words[-1]["end"]
    n_conf = sum(1 for w in all_words if "confidence" in w)
    result = {
        "source": "google_stt",                 # 讓 generate_subtitles.js 走相容分支
        "words": all_words,
        "_actual_source": "faster_whisper",      # 觸發下游簡轉繁
        "_model": model_size,
        "_duration": round(duration, 1),
        "_word_count": len(all_words),
        "_detected_language": info.language,
        "_language_probability": round(float(info.language_probability), 4),
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    confs = [w["confidence"] for w in all_words if "confidence" in w]
    avg_conf = sum(confs) / len(confs) if confs else 0
    print(f"✅ 已儲存 {output_path}")
    print(f"📊 {len(all_words)} 字，時長 {duration:.1f}s，{n_conf} 字有 confidence（平均 {avg_conf:.3f}）")
    print(f"🌐 偵測語言 {info.language}（{info.language_probability:.2f}）")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    if not args:
        print("用法: python whisper_local_transcribe.py <audio> [output] [--model large-v3] [--cpu]")
        sys.exit(1)
    audio = args[0]
    out = args[1] if len(args) > 1 else "google_result.json"
    model_size = "large-v3"
    for fl in flags:
        if fl.startswith("--model"):
            model_size = fl.split("=", 1)[1] if "=" in fl else "large-v3"
    device = "cpu" if "--cpu" in flags else "cuda"
    transcribe(audio, out, model_size=model_size, device=device)
