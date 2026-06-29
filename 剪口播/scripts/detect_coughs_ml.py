#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ML 音訊事件偵測：咳嗽 / 清喉 / 噴嚏（AudioSet 預訓練模型，非啟發式）。

為什麼用 ML：咳嗽聲學上太像語音，ffmpeg 的 flatness/RMS 啟發式分不開，硬調門檻會
誤砍講話聲。改用 AudioSet 訓練好的 Audio Spectrogram Transformer，它有原生的
Cough / Throat clearing / Sneeze 類別，能在「聽起來像不像咳嗽」這個層次判斷。

輸出是「建議」清單（時間段 + 標籤 + 信心），預設不直接刪——非語音刪除誤砍風險高，
交人確認（符合「AI 提案、人決定」）。

用法:
  python detect_coughs_ml.py <audio> [out=cough_segments.json] [--thr 0.3] [--win 1.5] [--hop 0.5]

依賴: torch, transformers, librosa（皆已安裝）。首次執行會下載模型 (~350MB)。
"""

import sys
import json
import numpy as np

MODEL = "MIT/ast-finetuned-audioset-10-10-0.4593"
# AudioSet 類別名（小寫比對）→ 視為「該剪掉的非語音雜音」
TARGET_KEYWORDS = ["cough", "throat clearing", "sneeze", "snort", "sniff", "gasp"]


def parse_args():
    a = {"audio": None, "out": "cough_segments.json", "thr": 0.3, "win": 1.5, "hop": 0.5}
    pos = []
    i = 1
    while i < len(sys.argv):
        t = sys.argv[i]
        if t == "--thr": a["thr"] = float(sys.argv[i + 1]); i += 2
        elif t == "--win": a["win"] = float(sys.argv[i + 1]); i += 2
        elif t == "--hop": a["hop"] = float(sys.argv[i + 1]); i += 2
        else: pos.append(t); i += 1
    if pos: a["audio"] = pos[0]
    if len(pos) > 1: a["out"] = pos[1]
    return a


def main():
    a = parse_args()
    if not a["audio"]:
        print("用法: python detect_coughs_ml.py <audio> [out] [--thr 0.3] [--win 1.5] [--hop 0.5]")
        sys.exit(1)

    import torch
    import librosa
    from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

    SR = 16000
    print("載入模型: " + MODEL)
    fe = AutoFeatureExtractor.from_pretrained(MODEL)
    model = AutoModelForAudioClassification.from_pretrained(MODEL)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device).eval()
    print("device: " + device)

    id2label = model.config.id2label
    target_ids = [int(i) for i, l in id2label.items()
                  if any(k in l.lower() for k in TARGET_KEYWORDS)]
    print("目標類別: " + ", ".join(id2label[i] for i in target_ids))

    print("載入音訊: " + a["audio"])
    y, _ = librosa.load(a["audio"], sr=SR, mono=True)
    dur = len(y) / SR
    win_n = int(a["win"] * SR)

    starts = np.arange(0.0, max(0.0, dur - 0.2), a["hop"])
    frames = []  # (start, score, label)
    BATCH = 24
    buf, meta = [], []

    def flush():
        if not buf:
            return
        inputs = fe([b for b in buf], sampling_rate=SR, return_tensors="pt")
        with torch.no_grad():
            logits = model(**{k: v.to(device) for k, v in inputs.items()}).logits
            probs = torch.sigmoid(logits)  # AudioSet 多標籤 → 每類獨立機率
        for row, st in zip(probs, meta):
            tscores = [(float(row[i]), id2label[i]) for i in target_ids]
            tscores.sort(reverse=True)
            frames.append((st, tscores[0][0], tscores[0][1]))
        buf.clear()
        meta.clear()

    for st in starts:
        seg = y[int(st * SR): int(st * SR) + win_n]
        if len(seg) < int(0.2 * SR):
            continue
        buf.append(seg)
        meta.append(float(st))
        if len(buf) >= BATCH:
            flush()
    flush()

    # 門檻 + 合併相鄰高分窗 → 事件段
    thr = a["thr"]
    hop = a["hop"]
    segs = []
    cur = None
    for (st, score, label) in frames:
        if score >= thr:
            if cur is None:
                cur = {"start": st, "end": st + a["win"], "score": score, "label": label}
            else:
                cur["end"] = st + a["win"]
                if score > cur["score"]:
                    cur["score"] = score
                    cur["label"] = label
        else:
            if cur is not None:
                segs.append(cur)
                cur = None
    if cur is not None:
        segs.append(cur)

    # 收斂事件邊界：用窗中心估計，事件中心 ± 0.4s（咳嗽很短，避免把整個 win 都刪）
    out = []
    for s in segs:
        center = (s["start"] + s["end"]) / 2.0
        out.append({
            "start": round(max(0.0, center - 0.4), 3),
            "end": round(min(dur, center + 0.4), 3),
            "label": s["label"],
            "confidence": round(s["score"], 3),
            "win_start": round(s["start"], 3),
            "win_end": round(s["end"], 3),
        })

    with open(a["out"], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print("偵測到 %d 段（thr=%.2f, win=%.1fs, hop=%.1fs）→ %s" % (len(out), thr, a["win"], a["hop"], a["out"]))
    for o in out:
        print("  %.1f-%.1fs  %s  conf=%.2f" % (o["start"], o["end"], o["label"], o["confidence"]))


if __name__ == "__main__":
    main()
