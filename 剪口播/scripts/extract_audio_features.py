#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音頻特徵抽取（P0 地基）— take 打分 / 唸糊偵測 / 停頓分級 / 呼吸切點的共同輸入。

文字稿是平的，聲音不是。同一句話講三次，文字一模一樣，但「講得最篤定」那次
音量飽、語速穩、STT confidence 高。這個腳本把每個字的聲學特徵抽出來，讓後續
階段能用「聽起來對不對」而不只是「文字重不重複」做判斷。

用法:
  python extract_audio_features.py <audio> <subtitles_words.json> [out=audio_features.json]

輸出 audio_features.json（以 word idx 對齊，不修改 subtitles_words.json）。
設計取捨：純 ffmpeg + 標準庫，零新依賴。pitch 需要 librosa，列為之後的可選增強。
"""

import json
import subprocess
import sys

FRAME_SEC = 0.05
SAMPLE_RATE = 8000
LOCAL_WINDOW = 6
RMS_FLOOR_DB = -60.0


def extract_rms_series(audio_path):
    """用 ffmpeg astats 一次抽全程 RMS 時間序列，回傳 [(t, db), ...]。"""
    af = (
        "aresample={sr},"
        "asetnsamples={n}:p=0,"
        "astats=metadata=1:reset=1,"
        "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"
    ).format(sr=SAMPLE_RATE, n=int(SAMPLE_RATE * FRAME_SEC))
    cmd = ["ffmpeg", "-hide_banner", "-i", "file:" + audio_path,
           "-af", af, "-f", "null", "-"]
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    series = []
    cur_t = None
    for line in (proc.stdout + "\n" + proc.stderr).splitlines():
        line = line.strip()
        if line.startswith("pts_time:"):
            try:
                cur_t = float(line.split("pts_time:")[1].split()[0])
            except (ValueError, IndexError):
                cur_t = None
        elif "RMS_level=" in line:
            raw = line.split("RMS_level=")[1].strip()
            db = RMS_FLOOR_DB if raw in ("-inf", "inf", "nan") else float(raw)
            db = max(RMS_FLOOR_DB, db)
            t = cur_t if cur_t is not None else len(series) * FRAME_SEC
            series.append((t, db))
            cur_t = None
    return series


def db_to_norm(db):
    return max(0.0, min(1.0, (db - RMS_FLOOR_DB) / (0.0 - RMS_FLOOR_DB)))


def region_stats(series, start, end):
    vals = [db for (t, db) in series if start <= t < end]
    if not vals:
        nearest = min(series, key=lambda x: abs(x[0] - start), default=None)
        vals = [nearest[1]] if nearest else [RMS_FLOOR_DB]
    mean_db = sum(vals) / len(vals)
    voiced = sum(1 for v in vals if v > RMS_FLOOR_DB + 8) / len(vals)
    return mean_db, voiced


def main():
    if len(sys.argv) < 3:
        print("用法: python extract_audio_features.py <audio> <subtitles_words.json> [out]")
        sys.exit(1)

    audio_path = sys.argv[1]
    words_path = sys.argv[2]
    # out_path = 第 3 個「非 flag」參數（避免把 --dump-series 當成輸出路徑）
    positional = [a for a in sys.argv[3:] if not a.startswith("--")]
    # 排除緊跟在 --dump-series 後面的值
    if "--dump-series" in sys.argv:
        ds_val = sys.argv[sys.argv.index("--dump-series") + 1] if sys.argv.index("--dump-series") + 1 < len(sys.argv) else None
        positional = [a for a in positional if a != ds_val]
    out_path = positional[0] if positional else "audio_features.json"

    with open(words_path, "r", encoding="utf-8") as f:
        words = json.load(f)

    print("抽取 RMS 時間序列: " + audio_path)
    series = extract_rms_series(audio_path)
    if not series:
        print("ERROR: ffmpeg 沒有輸出 RMS 資料")
        sys.exit(1)
    print("  {0} 格 x {1}s = {2:.1f}s".format(len(series), FRAME_SEC, series[-1][0]))

    # ── 落檔原始 RMS 序列（給 refine_segments.js 做切點吸附用）──
    # 抽取邏輯只此一處，避免 JS 端複製出第二套標準。零新依賴。
    if "--dump-series" in sys.argv:
        series_path = sys.argv[sys.argv.index("--dump-series") + 1]
        with open(series_path, "w", encoding="utf-8") as f:
            json.dump({
                "frame_sec": FRAME_SEC,
                "rms_floor_db": RMS_FLOOR_DB,
                "series": [[round(t, 3), round(db, 2)] for (t, db) in series],
            }, f, ensure_ascii=False)
        print("OK 已落檔 RMS 序列: " + series_path)

    voiced_dbs = [db for (_, db) in series if db > RMS_FLOOR_DB + 8]
    g_mean = sum(voiced_dbs) / len(voiced_dbs) if voiced_dbs else RMS_FLOOR_DB
    g_std = (sum((d - g_mean) ** 2 for d in voiced_dbs) / len(voiced_dbs)) ** 0.5 if voiced_dbs else 1.0

    real_idx = [i for i, w in enumerate(words) if not w.get("isGap")]

    feats = {}
    for pos, i in enumerate(real_idx):
        w = words[i]
        start, end = w["start"], w["end"]
        dur = max(1e-3, end - start)
        n_char = max(1, len(w.get("text", "")))
        mean_db, voiced = region_stats(series, start, end)

        lo = max(0, pos - LOCAL_WINDOW)
        hi = min(len(real_idx), pos + LOCAL_WINDOW + 1)
        win = [words[real_idx[k]] for k in range(lo, hi)]
        win_chars = sum(len(x.get("text", "")) for x in win)
        win_span = max(1e-3, win[-1]["end"] - win[0]["start"])
        local_cps = win_chars / win_span

        conf = w.get("confidence")
        vol_score = db_to_norm(mean_db)
        speed_score = max(0.0, min(1.0, local_cps / 6.0))
        conf_score = conf if isinstance(conf, (int, float)) else 0.7
        assertiveness = round(
            0.35 * vol_score + 0.20 * speed_score + 0.20 * voiced + 0.25 * conf_score, 4
        )

        feats[str(i)] = {
            "rms_db": round(mean_db, 2),
            "rms_norm": round(db_to_norm(mean_db), 4),
            "dur": round(dur, 3),
            "cps": round(n_char / dur, 2),
            "local_cps": round(local_cps, 2),
            "voiced_ratio": round(voiced, 3),
            "confidence": conf,
            "assertiveness": assertiveness,
        }

    out = {
        "meta": {
            "audio": audio_path,
            "words_source": words_path,
            "frame_sec": FRAME_SEC,
            "n_words": len(feats),
            "global_rms_db_mean": round(g_mean, 2),
            "global_rms_db_std": round(g_std, 2),
            "has_confidence": any(w.get("confidence") is not None for w in words),
        },
        "words": feats,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("OK 已儲存 {0} ({1} 字特徵)".format(out_path, len(feats)))
    print("全片有聲音量 {0:.1f}+-{1:.1f} dB".format(g_mean, g_std))


if __name__ == "__main__":
    main()
