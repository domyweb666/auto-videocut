#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vad_guard.py — 反幻覺守門第一層：Silero VAD 語音活動偵測（音訊層真相）

為什麼：STT（BytePlus/Whisper 系）在長靜音、氣音、環境噪音裡會幻覺出字（訓練資料污染的
「請不吝點讚」類，或把呼吸聲聽成語氣詞）。文字層黑名單只能抓已知片語；VAD 直接回答
「這段時間到底有沒有人在說話」，跟轉錄字時間戳交叉比對就能抓到未知幻覺。
借鑑 arkiv 專案的四層反幻覺架構（VAD → 無語音閾值 → 空白/重複過濾 → 修正）。

模型：silero-vad（pip install silero-vad），走 onnxruntime 後端＝不佔 GPU、免下載
（模型隨套件內建）。輸入先用 ffmpeg 轉 16k 單聲道 wav（torchaudio 在 Windows 解 mp3 不可靠）。

用法:
  python vad_guard.py <audio> <out.json> [--threshold 0.5] [--min-speech-ms 100]
                      [--min-silence-ms 150] [--pad-ms 60]

輸出 JSON:
  {"version": 1, "source": "silero-vad", "durationSec": X,
   "params": {...}, "speech": [{"start": 秒, "end": 秒}, ...]}
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave


def decode_to_wav16k(src: str, dst: str):
    """ffmpeg 解碼成 16k 單聲道 wav（與轉錄前處理同規格）。"""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000",
         "-f", "wav", dst],
        capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg 解碼失敗: {r.stderr.strip()[:300]}")


def read_wav(path: str):
    import numpy as np
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    audio = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    return audio, sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--min-speech-ms", type=int, default=100)
    ap.add_argument("--min-silence-ms", type=int, default=150)
    ap.add_argument("--pad-ms", type=int, default=60)
    args = ap.parse_args()

    if not os.path.exists(args.audio):
        raise SystemExit(f"找不到音訊檔: {args.audio}")

    import torch
    from silero_vad import load_silero_vad, get_speech_timestamps

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        decode_to_wav16k(args.audio, tmp.name)
        audio, sr = read_wav(tmp.name)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    duration = len(audio) / sr
    model = load_silero_vad(onnx=True)  # onnxruntime 後端：CPU 快且不跟 GPU 任務打架
    ts = get_speech_timestamps(
        torch.from_numpy(audio), model,
        threshold=args.threshold,
        sampling_rate=sr,
        min_speech_duration_ms=args.min_speech_ms,
        min_silence_duration_ms=args.min_silence_ms,
        speech_pad_ms=args.pad_ms,
    )
    # 自己除以 sr（不用 return_seconds，各版本小數精度行為不一）
    speech = [{"start": round(t["start"] / sr, 3), "end": round(t["end"] / sr, 3)} for t in ts]

    covered = sum(s["end"] - s["start"] for s in speech)
    result = {
        "version": 1,
        "source": "silero-vad",
        "durationSec": round(duration, 3),
        "params": {
            "threshold": args.threshold,
            "min_speech_ms": args.min_speech_ms,
            "min_silence_ms": args.min_silence_ms,
            "pad_ms": args.pad_ms,
        },
        "speech": speech,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    sys.stderr.write(
        f"[vad_guard] {os.path.basename(args.audio)}: 全長 {duration:.1f}s、"
        f"語音 {covered:.1f}s（{covered / max(duration, 0.001) * 100:.0f}%）、"
        f"{len(speech)} 段 → {args.out}\n")


if __name__ == "__main__":
    main()
