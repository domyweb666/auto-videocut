#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Google Cloud STT 轉錄腳本（繁體中文 zh-TW）

用法: python google_transcribe.py <audio.mp3> [output.json]

環境需求:
  GOOGLE_APPLICATION_CREDENTIALS=<service-account.json 路徑>
  GCS_BUCKET=<GCS bucket 名稱>   （若未設定，自動以 project_id 建立）

安裝:
  pip install google-cloud-speech google-cloud-storage
"""

import os
import sys
import json
import time

def transcribe(audio_path, output_path='google_result.json'):
    from google.cloud import speech, storage

    if not os.path.exists(audio_path):
        print(f"❌ 找不到音訊檔案: {audio_path}")
        sys.exit(1)

    print(f"📁 音訊檔案: {audio_path}")

    # --- 初始化 clients ---
    speech_client = speech.SpeechClient()
    storage_client = storage.Client()
    project_id = storage_client.project
    print(f"☁️  Google Cloud 專案: {project_id}")

    # --- GCS Bucket ---
    bucket_name = os.environ.get('GCS_BUCKET', f"stt-temp-{project_id}")
    try:
        bucket = storage_client.get_bucket(bucket_name)
        print(f"✅ 使用 GCS Bucket: {bucket_name}")
    except Exception:
        print(f"🪣 建立 GCS Bucket: {bucket_name}...")
        bucket = storage_client.create_bucket(bucket_name, location="asia-east1")
        print(f"✅ Bucket 建立完成")

    # --- 上傳音訊 ---
    blob_name = f"stt_audio_{int(time.time())}.mp3"
    blob = bucket.blob(blob_name)
    print(f"⬆️  上傳音訊中...")
    blob.upload_from_filename(audio_path)
    gcs_uri = f"gs://{bucket_name}/{blob_name}"
    print(f"✅ 上傳完成: {gcs_uri}")

    # --- 設定識別參數 ---
    audio = speech.RecognitionAudio(uri=gcs_uri)
    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.MP3,
        language_code="zh-TW",                # 繁體中文
        enable_word_time_offsets=True,        # 字級時間戳
        enable_automatic_punctuation=True,    # 自動標點
        model="default",                      # V1 僅 default 支援 cmn-Hant-TW
        audio_channel_count=1,
    )

    # --- 非同步識別（長音訊必須） ---
    print("🎙️  開始 Google STT 識別（繁體中文 zh-TW）...")
    operation = speech_client.long_running_recognize(config=config, audio=audio)

    start_time = time.time()
    while not operation.done():
        elapsed = int(time.time() - start_time)
        print(f"\r⏳ 已等待 {elapsed}s...", end='', flush=True)
        time.sleep(3)

    elapsed_total = int(time.time() - start_time)
    print(f"\n✅ 識別完成！共 {elapsed_total}s")

    # --- 清理 GCS 暫存 ---
    blob.delete()
    print("🗑️  已清理 GCS 暫存檔案")

    # --- 解析結果 ---
    response = operation.result()
    all_words = []
    full_transcript = []

    for result in response.results:
        if not result.alternatives:
            continue
        alt = result.alternatives[0]
        full_transcript.append(alt.transcript)
        for w in alt.words:
            start_s = w.start_time.total_seconds()
            end_s = w.end_time.total_seconds()
            all_words.append({
                "word": w.word,
                "start": round(start_s, 3),
                "end": round(end_s, 3)
            })

    if not all_words:
        print("⚠️  未識別到任何詞，請確認音訊檔案和語言設定")
        sys.exit(1)

    # --- 存成與 Whisper 相容的格式 ---
    output = {
        "source": "google_stt",
        "language": "zh-TW",
        "text": "".join(full_transcript),
        "words": all_words
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    duration = all_words[-1]['end'] if all_words else 0
    print(f"✅ 已儲存 {output_path}")
    print(f"📊 共 {len(all_words)} 個詞，音訊時長 {duration:.1f}s")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python google_transcribe.py <audio.mp3> [output.json]")
        print("環境變數: GOOGLE_APPLICATION_CREDENTIALS=<key.json>")
        print("         GCS_BUCKET=<bucket名稱>（可選）")
        sys.exit(1)

    audio_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else 'google_result.json'
    transcribe(audio_path, output_path)
