#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export_jianying_draft.py — 把剪輯結果輸出成「剪映草稿」（真無損路徑）

為什麼：單檔 mp4 匯出一定要重編碼（字級剪點不在關鍵幀上）；使用者成品本來就要
進剪映做後製，直接生成剪映草稿＝草稿引用原始檔＋剪點，零重編碼、秒級完成、
剪點在剪映裡還能微調。SRT 一併掛上字幕軌。

依賴：pip install pyJianYingDraft（草稿生成支援剪映 5+；6+ 的加密只影響「讀舊模板」，
本script只生成新草稿不受影響）

用法：
  python export_jianying_draft.py --video <原片> --keeps <keeps.json> --name <草稿名>
         [--srt <字幕.srt>] [--draft-folder <剪映草稿資料夾>] [--width 1920 --height 1080 --fps 30]

keeps.json 格式：[{"start": 秒, "end": 秒}, ...]（原片時間軸上要保留的段，按序拼接）
輸出（stdout 最後一行）：JSON {"ok": true, "draftPath": "...", "segments": N, "durationSec": X}
"""
import argparse
import json
import os
import sys


def find_draft_folder(explicit: str) -> str:
    """草稿資料夾：明確指定 → 直接用；否則掃剪映專業版的預設安裝位置。"""
    if explicit:
        if os.path.isdir(explicit):
            return explicit
        raise SystemExit(json.dumps({"ok": False, "error": f"指定的草稿資料夾不存在：{explicit}"}, ensure_ascii=False))
    candidates = []
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        candidates.append(os.path.join(local, "JianyingPro", "User Data", "Projects", "com.lveditor.draft"))
        candidates.append(os.path.join(local, "CapCut", "User Data", "Projects", "com.lveditor.draft"))
    for c in candidates:
        if os.path.isdir(c):
            return c
    raise SystemExit(json.dumps({
        "ok": False,
        "error": "找不到剪映草稿資料夾。請在 training_config.json 的 jianying.draft_folder 填入路徑"
                 "（剪映 → 全域設定 → 草稿位置，通常類似 "
                 "C:\\Users\\<你>\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft）",
    }, ensure_ascii=False))


def _srt_ts(s: str) -> float:
    h, m, rest = s.strip().split(":")
    sec, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000.0


def _fmt_ts(t: float) -> str:
    if t < 0:
        t = 0.0
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def sanitize_srt(srt_path: str) -> str:
    """排序＋消除條目重疊（end 夾到下一條 start − 1ms），寫成 <原檔>.clean.srt 回傳路徑。"""
    with open(srt_path, "r", encoding="utf-8-sig") as f:
        raw = f.read()
    entries = []
    for block in raw.replace("\r\n", "\n").split("\n\n"):
        lines = [l for l in block.split("\n") if l.strip()]
        if len(lines) < 2:
            continue
        ts_line = lines[1] if "-->" in lines[1] else (lines[0] if "-->" in lines[0] else None)
        if not ts_line:
            continue
        text_start = lines.index(ts_line) + 1
        try:
            a, b = [p.strip() for p in ts_line.split("-->")]
            start, end = _srt_ts(a), _srt_ts(b)
        except (ValueError, IndexError):
            continue
        text = "\n".join(lines[text_start:]).strip()
        if text and end > start:
            entries.append([start, end, text])
    entries.sort(key=lambda e: e[0])
    for i in range(len(entries) - 1):
        if entries[i][1] > entries[i + 1][0] - 0.001:
            entries[i][1] = max(entries[i][0] + 0.05, entries[i + 1][0] - 0.001)
    out = srt_path + ".clean.srt"
    with open(out, "w", encoding="utf-8") as f:
        for n, (s, e, t) in enumerate(entries, 1):
            f.write(f"{n}\n{_fmt_ts(s)} --> {_fmt_ts(e)}\n{t}\n\n")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--keeps", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--srt", default="")
    ap.add_argument("--draft-folder", default="")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--fps", type=int, default=30)
    args = ap.parse_args()

    try:
        import pyJianYingDraft as draft
        from pyJianYingDraft import trange
    except ImportError:
        raise SystemExit(json.dumps({"ok": False, "error": "缺 pyJianYingDraft：pip install pyJianYingDraft"}, ensure_ascii=False))

    if not os.path.isfile(args.video):
        raise SystemExit(json.dumps({"ok": False, "error": f"找不到原片：{args.video}"}, ensure_ascii=False))
    with open(args.keeps, "r", encoding="utf-8") as f:
        keeps = json.load(f)
    keeps = [k for k in keeps if isinstance(k, dict) and k.get("end", 0) - k.get("start", 0) > 0.01]
    if not keeps:
        raise SystemExit(json.dumps({"ok": False, "error": "keeps 為空，沒有可保留的片段"}, ensure_ascii=False))
    # 防呆：夾在素材實際時長內（超界段 pyJianYingDraft 會直接 raise）。
    # 若大量段被丟棄＝很可能拿錯影片檔（例如給了已剪的成品而非原片）→ 出聲警告，不靜默截斷。
    try:
        from pyJianYingDraft import VideoMaterial
        mat_dur = VideoMaterial(args.video).duration / 1e6  # 微秒 → 秒
        before = len(keeps)
        want_end = max(k["end"] for k in keeps)
        keeps = [{"start": k["start"], "end": min(k["end"], mat_dur)} for k in keeps
                 if k["start"] < mat_dur - 0.01]
        keeps = [k for k in keeps if k["end"] - k["start"] > 0.01]
        dropped = before - len(keeps)
        if dropped > 0 or want_end > mat_dur + 1.0:
            sys.stderr.write(
                f"⚠ 剪點時間軸（到 {want_end:.1f}s）超出影片素材時長（{mat_dur:.1f}s）："
                f"丟棄 {dropped} 段。若非刻意，請確認 --video 指向的是「原始影片」而非已剪成品。\n")
    except SystemExit:
        raise
    except Exception:
        pass  # 素材探測失敗就交給後面 VideoSegment 自己報錯

    folder = find_draft_folder(args.draft_folder)
    df = draft.DraftFolder(folder)
    script = df.create_draft(args.name, args.width, args.height, fps=args.fps, allow_replace=True)

    script.add_track(draft.TrackType.video, "主軌")
    cursor = 0.0  # 成品時間軸游標（秒）
    for k in keeps:
        dur = k["end"] - k["start"]
        seg = draft.VideoSegment(
            args.video,
            trange(f"{cursor:.6f}s", f"{dur:.6f}s"),
            source_timerange=trange(f"{k['start']:.6f}s", f"{dur:.6f}s"),
        )
        script.add_segment(seg, "主軌")
        cursor += dur

    if args.srt and os.path.isfile(args.srt):
        # SRT 用理想時間軸生成（generate_cut_srt 不帶 timeline_map），與草稿逐段拼接的時間軸完全一致。
        # pyJianYingDraft 不容忍條目時間重疊（SegmentOverlap）→ 先淨化：排序＋把 end 夾到下一條 start 前
        cleaned = sanitize_srt(args.srt)
        script.import_srt(cleaned, track_name="字幕")

    script.save()
    draft_path = os.path.join(folder, args.name)
    print(json.dumps({"ok": True, "draftPath": draft_path, "segments": len(keeps),
                      "durationSec": round(cursor, 3)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
