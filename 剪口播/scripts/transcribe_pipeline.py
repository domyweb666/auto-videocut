#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
轉錄一條龍：gpt-4o 底稿 → (可選)文檔校正 → 本地 Whisper 時間戳對齊 → subtitles_words.json

這是「轉錄天花板」流程的一鍵封裝，給 8900/cut 的 startCutProcess 呼叫：
  1. gpt-4o-transcribe：最準中文底稿（自然標點），但無字級時間戳
  2. 若提供參考文檔：gpt-4o-chat 保守校正（只改辨識錯字，不改寫語句）
  3. faster-whisper：本地出字級時間戳（含口誤）
  4. align_corrected.js：NW 字級對齊，把校正稿貼回 Whisper 時間戳

用法:
  python transcribe_pipeline.py <audio.mp3> <out_subtitles.json> [reference_doc.txt]
環境變數: OPENAI_API_KEY（從 scripts/.env 載入）
"""
import os
import sys
import json
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env():
    envf = os.path.join(HERE, ".env")
    if os.path.exists(envf):
        for line in open(envf, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def gpt4o_transcribe(client, audio_path):
    with open(audio_path, "rb") as f:
        r = client.audio.transcriptions.create(
            model="gpt-4o-transcribe", file=f, response_format="text", language="zh"
        )
    return r if isinstance(r, str) else r.text


def gpt4o_correct(client, asr_text, doc_text):
    """用參考文檔保守校正辨識稿——只改辨識錯字，不改寫。"""
    prompt = (
        "你是中文逐字稿校正員。下面有一份語音辨識稿（ASR），和一份參考文檔"
        "（內容相近但非逐字稿，講者沒有照唸）。\n"
        "請『只』修正辨識稿裡明顯的辨識錯誤：同音錯字、聽糊的詞、專有名詞，"
        "用參考文檔裡的正確寫法替換。\n"
        "嚴禁：改寫語句、刪減或新增內容、調整語序、修飾語氣。逐字輸出修正後的全文，"
        "不要任何說明或標記。\n\n"
        f"=== 參考文檔 ===\n{doc_text}\n\n=== 辨識稿 ===\n{asr_text}"
    )
    r = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
    )
    return r.choices[0].message.content.strip()


def main():
    if len(sys.argv) < 3:
        print("用法: python transcribe_pipeline.py <audio> <out_subtitles.json> [reference_doc.txt]")
        sys.exit(1)
    audio_path = sys.argv[1]
    out_subs = sys.argv[2]
    doc_path = sys.argv[3] if len(sys.argv) > 3 else None

    load_env()
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    work = os.path.dirname(os.path.abspath(out_subs))

    # 1. gpt-4o 底稿
    print("①  gpt-4o-transcribe 底稿…", flush=True)
    text = gpt4o_transcribe(client, audio_path)
    corrected_txt = os.path.join(work, "corrected_text.txt")

    # 2. 可選文檔校正
    if doc_path and os.path.exists(doc_path):
        print("②  gpt-4o 文檔校正…", flush=True)
        doc = open(doc_path, encoding="utf-8").read()
        text = gpt4o_correct(client, text, doc)
    else:
        print("②  無參考文檔，跳過校正", flush=True)
    open(corrected_txt, "w", encoding="utf-8").write(text)

    # 3. faster-whisper 字級時間戳
    print("③  faster-whisper 時間戳…", flush=True)
    whisper_json = os.path.join(work, "whisper_result.json")
    subprocess.run(
        [sys.executable, os.path.join(HERE, "faster_whisper_transcribe.py"),
         audio_path, whisper_json, "large-v3", "cuda"],
        check=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    whisper_words = os.path.join(work, "whisper_words.json")
    # generate_subtitles 寫在 cwd → 在 work 下跑，輸出 subtitles_words.json，改名
    subprocess.run(
        ["node", os.path.join(HERE, "generate_subtitles.js"), whisper_json],
        check=True, cwd=work, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    os.replace(os.path.join(work, "subtitles_words.json"), whisper_words)

    # 4. 對齊
    print("④  字級對齊（gpt-4o 文字 + Whisper 時間戳）…", flush=True)
    subprocess.run(
        ["node", os.path.join(HERE, "align_corrected.js"), corrected_txt, whisper_words, out_subs],
        check=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    print(f"✅ 完成 → {out_subs}", flush=True)


if __name__ == "__main__":
    main()
