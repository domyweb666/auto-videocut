#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
BytePlus Seed Speech ASR（Audio File 2.0 / bigmodel）轉錄一條龍
取代舊的 transcribe_pipeline.py（gpt-4o + 本地 whisper）。

一次拿到「文字 + 字級時間碼」，不需 OpenAI、不需 GPU。

流程：
  1. 本機音檔 base64 → submit → query 輪詢拿結果
  2. 存 volcengine_result.json（把回應的 .result 拆到頂層，utterances 在頂層）
  3. 呼叫 generate_subtitles.js → subtitles_words.json（含 isGap、簡→繁）

用法:
  python byteplus_transcribe.py <audio.mp3> <out_subtitles.json>
環境變數（scripts/.env）: BYTEPLUS_API_KEY（或 VOLCENGINE_API_KEY / BP_ACCESS_KEY）
"""
import os
import sys
import json
import time
import uuid
import base64
import subprocess
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://voice.ap-southeast-1.bytepluses.com/api/v3/auc/bigmodel"
SUBMIT_URL = f"{BASE}/submit"
QUERY_URL = f"{BASE}/query"
RESOURCE_ID = "volc.seedasr.auc"


def load_env():
    envf = os.path.join(HERE, ".env")
    if os.path.exists(envf):
        for line in open(envf, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def get_key():
    for name in ("BYTEPLUS_API_KEY", "VOLCENGINE_API_KEY", "BP_ACCESS_KEY"):
        if os.environ.get(name):
            return os.environ[name]
    sys.exit("❌ scripts/.env 缺 BYTEPLUS_API_KEY")


def headers(key, request_id, with_seq):
    h = {
        "Content-Type": "application/json",
        "x-api-key": key,
        "X-Api-Resource-Id": RESOURCE_ID,
        "X-Api-Request-Id": request_id,
    }
    if with_seq:
        h["X-Api-Sequence"] = "-1"
    return h


def transcribe(audio_path, request_id, key, lang="zh-CN", ddc=True):
    # enable_ddc（語義順滑）：True=BytePlus 自動刪口水/重複字（文字乾淨，但字級時間碼一起消失）；
    # False=逐字原稿（含贅字+時間碼，給剪輯層按時間碼下刀用）。雙轉模式靠這個開關拿「原稿 vs 順滑版」。
    fmt = os.path.splitext(audio_path)[1].lstrip(".").lower() or "mp3"
    with open(audio_path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    body = {
        "user": {"uid": "domi-cut"},
        "audio": {"data": data, "format": fmt, "language": lang},
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "enable_ddc": bool(ddc),
            "show_utterances": True,
            "vad_segment": True,
        },
    }
    print("①  BytePlus submit…", flush=True)
    r = requests.post(SUBMIT_URL, headers=headers(key, request_id, True),
                      data=json.dumps(body), timeout=120)
    sc = r.headers.get("X-Api-Status-Code")
    if sc != "20000000":
        sys.exit(f"❌ submit 失敗 X-Api-Status-Code={sc} | {r.headers.get('X-Api-Message')} | {r.text[:300]}")

    print("②  query 輪詢…", flush=True)
    waited = 0
    while waited < 900:
        r = requests.post(QUERY_URL, headers=headers(key, request_id, False),
                          data=json.dumps({}), timeout=120)
        sc = r.headers.get("X-Api-Status-Code")
        if sc == "20000000":
            return r.json()
        if sc in ("20000001", "20000002"):
            time.sleep(3)
            waited += 3
            continue
        sys.exit(f"❌ query 失敗 X-Api-Status-Code={sc} | {r.text[:300]}")
    sys.exit("❌ query 超時")


def main():
    # 解析 --ddc on|off（預設 off：主流程要逐字原稿給剪輯層；雙轉的順滑版才用 --ddc on）
    argv = [a for a in sys.argv[1:]]
    ddc = False
    out = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--ddc":
            ddc = (i + 1 < len(argv) and argv[i + 1].lower() in ("on", "true", "1"))
            i += 2; continue
        if a.startswith("--ddc="):
            ddc = a.split("=", 1)[1].lower() in ("on", "true", "1")
            i += 1; continue
        out.append(a); i += 1
    if len(out) < 2:
        print("用法: python byteplus_transcribe.py <audio.mp3> <out_subtitles.json> [--ddc on|off]")
        sys.exit(1)
    audio_path = out[0]
    out_subs = out[1]
    work = os.path.dirname(os.path.abspath(out_subs))

    load_env()
    key = get_key()
    rid = str(uuid.uuid4())

    print(f"（enable_ddc={ddc}）", flush=True)
    resp = transcribe(audio_path, rid, key, ddc=ddc)
    result = resp.get("result", {})
    if not result.get("utterances"):
        sys.exit("❌ 回應沒有 utterances，無法產生字級字幕")

    # 拆到頂層：generate_subtitles.js 的火山分支讀頂層 .utterances
    volc_path = os.path.join(work, "volcengine_result.json")
    with open(volc_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"③  已存 {volc_path}（{len(result['utterances'])} 段）", flush=True)

    # 沿用現成轉換器（含 isGap 拆分、OpenCC 簡→繁、幻覺詞標記）
    print("④  generate_subtitles.js → subtitles_words.json…", flush=True)
    subprocess.run(
        ["node", os.path.join(HERE, "generate_subtitles.js"), "volcengine_result.json"],
        check=True, cwd=work, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    gen = os.path.join(work, "subtitles_words.json")
    if os.path.abspath(gen) != os.path.abspath(out_subs):
        os.replace(gen, out_subs)
    print(f"✅ 完成 → {out_subs}", flush=True)


if __name__ == "__main__":
    main()
