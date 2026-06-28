#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
faster-whisper 本地轉錄（GPU）— 取代 Google STT V1，準度與標點大幅提升。

輸出 schema 與 google_transcribe.py 相容（generate_subtitles.js 直接吃）：
  {
    "source": "google_stt",          # 走 generate_subtitles 的 Google 分支（有 confidence 處理）
    "_actual_source": "faster_whisper",  # 觸發 OpenCC 簡→繁
    "language": "zh",
    "text": "...",                    # 含標點全文
    "words": [{"word": "危險，", "start": 1.23, "end": 1.55, "confidence": 0.98}, ...]
  }

用法:
  python faster_whisper_transcribe.py <audio.(mp3|wav)> <out.json> [model] [device]
  model 預設 large-v3；device 預設 cuda（無 GPU 自動退 cpu/int8）

注意: 標點由 Whisper 自動產生，附在 word token 上，整條 pipeline 以 word 為元素帶著走。
"""
import sys
import json


def main():
    if len(sys.argv) < 3:
        print("用法: python faster_whisper_transcribe.py <audio> <out.json> [model] [device]")
        sys.exit(1)

    audio_path = sys.argv[1]
    out_path = sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) > 3 else "large-v3"
    device = sys.argv[4] if len(sys.argv) > 4 else "cuda"

    from faster_whisper import WhisperModel

    compute_type = "float16" if device == "cuda" else "int8"
    print(f"🎙️  載入模型 {model_name}（{device} / {compute_type}）…", flush=True)
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as e:
        print(f"⚠️ {device} 載入失敗（{e}），改用 cpu/int8", flush=True)
        device, compute_type = "cpu", "int8"
        model = WhisperModel(model_name, device=device, compute_type=compute_type)

    print("⏳ 轉錄中（word_timestamps + 標點）…", flush=True)
    segments, info = model.transcribe(
        audio_path,
        language="zh",
        word_timestamps=True,
        vad_filter=True,                       # 用 VAD 過濾長靜音，減少幻覺
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    words = []
    full_text_parts = []
    seg_count = 0
    for seg in segments:
        seg_count += 1
        full_text_parts.append(seg.text)
        if seg.words:
            for w in seg.words:
                t = (w.word or "").strip()
                if not t:
                    continue
                words.append({
                    "word": t,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "confidence": round(w.probability, 4),
                })
        if seg_count % 20 == 0:
            print(f"  …已處理 {seg_count} 段 / {len(words)} 詞", flush=True)

    # ── 停頓式標點：Whisper 對中文常不給標點，改用字間停頓補。 ──
    # 大停頓→。 中停頓→，（附在停頓前的字上）。對齊自然語氣、無 initial_prompt 幻覺風險。
    import re as _re
    _PUNC_END = _re.compile(r"[，。！？、,.!?]$")
    for i, wd in enumerate(words):
        if _PUNC_END.search(wd["word"]):
            continue
        gap_after = (words[i + 1]["start"] - wd["end"]) if i < len(words) - 1 else 99
        if gap_after >= 0.5:
            wd["word"] += "。"
        elif gap_after >= 0.22:
            wd["word"] += "，"

    result = {
        "source": "google_stt",
        "_actual_source": "faster_whisper",
        "language": info.language,
        "model": model_name,
        "text": "".join(w["word"] for w in words).strip(),
        "words": words,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    dur = words[-1]["end"] if words else 0
    print(f"✅ 完成：{len(words)} 詞，末詞 {dur}s，偵測語言 {info.language}（機率 {info.language_probability:.2f}）", flush=True)
    print(f"✅ 已儲存 {out_path}", flush=True)


if __name__ == "__main__":
    main()
