#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
FunASR Paraformer 本地轉錄（中文專用 ASR，對標剪映的火山引擎）。

相較 Whisper large-v3（多語通用），Paraformer-zh 是中文專用模型，
同音字辨識與口語/快語速的聲學穩定度通常更接近剪映。

輸出 schema 與 faster_whisper_transcribe.py 相容（generate_subtitles.js 直接吃）：
  { "source":"google_stt", "_actual_source":"funasr", "language":"zh",
    "text":"...", "words":[{"word":"字","start":1.23,"end":1.55,"confidence":1.0}, ...] }

字級時間戳來自 Paraformer 的 timestamp 輸出；標點用「停頓式」補（與 Whisper 路徑一致）。

用法:
  python funasr_transcribe.py <audio.(mp3|wav)> <out.json>
"""
import sys
import json
import re


def main():
    if len(sys.argv) < 3:
        print("用法: python funasr_transcribe.py <audio> <out.json>")
        sys.exit(1)
    audio_path = sys.argv[1]
    out_path = sys.argv[2]

    from funasr import AutoModel

    print("🎙️  載入 Paraformer-zh（+VAD，首次會下載模型）…", flush=True)
    model = AutoModel(
        model="paraformer-zh",
        vad_model="fsmn-vad",
        vad_kwargs={"max_single_segment_time": 30000},
        disable_update=True,
    )

    print("⏳ 轉錄中…", flush=True)
    res = model.generate(input=audio_path, batch_size_s=300, use_itn=True)
    r0 = res[0]
    text = r0.get("text", "")
    ts = r0.get("timestamp", [])  # [[start_ms, end_ms], ...] 每字一組

    # text 可能是空白分隔的字；取出非空白字元，與 timestamp 對齊
    chars = [c for c in text if not c.isspace()]
    words = []
    n = min(len(chars), len(ts))
    if len(chars) != len(ts):
        print(f"⚠️ 字數({len(chars)}) 與時間戳數({len(ts)}) 不一致，取較小值 {n}", flush=True)
    for i in range(n):
        s_ms, e_ms = ts[i][0], ts[i][1]
        words.append({
            "word": chars[i],
            "start": round(s_ms / 1000.0, 3),
            "end": round(e_ms / 1000.0, 3),
            "confidence": 1.0,
        })

    # 停頓式標點（與 faster_whisper_transcribe 一致）：大停頓→。中停頓→，
    _PUNC_END = re.compile(r"[，。！？、,.!?]$")
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
        "_actual_source": "funasr",
        "language": "zh",
        "model": "paraformer-zh",
        "text": "".join(w["word"] for w in words).strip(),
        "words": words,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    dur = words[-1]["end"] if words else 0
    print(f"✅ 完成：{len(words)} 字，末字 {dur}s", flush=True)
    print(f"✅ 已儲存 {out_path}", flush=True)


if __name__ == "__main__":
    main()
