#!/usr/bin/env python3
"""
OpenAI Whisper API 語音轉錄（繁體中文）

功能：
  - 使用 OpenAI Whisper API 轉錄音訊
  - 支援字級時間戳（word-level timestamps）
  - 自動切割大檔案（>25MB 限制）
  - 輸出格式與 google_transcribe.py 相容（google_result.json 格式）

用法: python openai_transcribe.py <audio_file> <output_json>
環境變數: OPENAI_API_KEY

費用: $0.006/分鐘（約 NT$0.2/分鐘）
"""

import os
import sys
import json
import math
import subprocess
import tempfile

def get_audio_duration(audio_path):
    """用 ffprobe 取得音訊時長"""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', f'file:{audio_path}'],
            capture_output=True, text=True
        )
        return float(result.stdout.strip())
    except:
        return 0

def get_file_size_mb(path):
    return os.path.getsize(path) / (1024 * 1024)

def split_audio(audio_path, max_size_mb=24, overlap_sec=1):
    """
    將大音訊檔切割成 <25MB 的片段
    每段之間有 overlap_sec 秒重疊，避免切斷字詞
    """
    size_mb = get_file_size_mb(audio_path)
    if size_mb <= max_size_mb:
        return [(audio_path, 0)]  # (path, offset_seconds)

    duration = get_audio_duration(audio_path)
    if duration <= 0:
        return [(audio_path, 0)]

    # 估算每秒多少 MB
    mb_per_sec = size_mb / duration
    chunk_duration = max_size_mb / mb_per_sec * 0.9  # 留 10% 餘量

    chunks = []
    tmpdir = tempfile.mkdtemp(prefix='whisper_chunks_')
    offset = 0
    idx = 0

    while offset < duration:
        chunk_path = os.path.join(tmpdir, f'chunk_{idx:04d}.mp3')
        end = min(offset + chunk_duration, duration)

        subprocess.run([
            'ffmpeg', '-y', '-ss', str(offset),
            '-i', f'file:{audio_path}',
            '-t', str(end - offset),
            '-acodec', 'libmp3lame', '-q:a', '4',
            chunk_path
        ], capture_output=True)

        chunks.append((chunk_path, offset))
        offset = end - overlap_sec  # 重疊避免切斷
        idx += 1

    print(f"📦 音訊切成 {len(chunks)} 段（每段 ~{chunk_duration:.0f}s）")
    return chunks

def transcribe_chunk(client, audio_path, language="zh"):
    """轉錄單個音訊片段，回傳 word-level 結果"""
    with open(audio_path, 'rb') as f:
        response = client.audio.transcriptions.create(
            model="whisper-1",
            file=f,
            language=language,
            response_format="verbose_json",
            timestamp_granularities=["word"]
        )
    return response

def merge_results(chunk_results):
    """合併多個片段的結果，去除重疊區域的重複字詞"""
    all_words = []

    for words, offset in chunk_results:
        for w in words:
            adjusted_start = w['start'] + offset
            adjusted_end = w['end'] + offset

            # 去重：如果新字的開始時間 < 上一個字的結束時間，跳過
            if all_words and adjusted_start < all_words[-1]['end'] - 0.05:
                continue

            all_words.append({
                'word': w['word'].strip(),
                'start': round(adjusted_start, 3),
                'end': round(adjusted_end, 3)
            })

    return all_words

def convert_to_google_format(words, duration):
    """
    將 OpenAI Whisper 結果轉換為 generate_subtitles.js 期待的扁平格式
    格式: { source: 'google_stt', words: [{word, start, end}, ...] }
    """
    flat_words = []
    for w in words:
        flat_words.append({
            'word': w['word'],
            'start': w['start'],
            'end': w['end']
        })

    return {
        'source': 'google_stt',  # 讓 generate_subtitles.js 認得
        'words': flat_words,
        '_actual_source': 'openai_whisper',
        '_model': 'whisper-1',
        '_duration': duration,
        '_word_count': len(words)
    }

def transcribe(audio_path, output_path):
    from openai import OpenAI

    api_key = os.environ.get('OPENAI_API_KEY')
    if not api_key:
        print("❌ 未設定 OPENAI_API_KEY 環境變數")
        sys.exit(1)

    client = OpenAI(api_key=api_key)

    print(f"📁 音訊檔案: {audio_path}")
    duration = get_audio_duration(audio_path)
    size_mb = get_file_size_mb(audio_path)
    print(f"📊 檔案大小: {size_mb:.1f}MB, 時長: {duration:.1f}s ({duration/60:.1f}分鐘)")
    print(f"💰 預估費用: ${duration/60 * 0.006:.3f} USD")

    # 切割大檔案
    chunks = split_audio(audio_path)

    # 轉錄每個片段
    chunk_results = []
    for i, (chunk_path, offset) in enumerate(chunks):
        label = f"[{i+1}/{len(chunks)}] " if len(chunks) > 1 else ""
        print(f"🎙️  {label}Whisper API 轉錄中...")

        response = transcribe_chunk(client, chunk_path)

        words = []
        if hasattr(response, 'words') and response.words:
            for w in response.words:
                words.append({
                    'word': w.word.strip() if hasattr(w, 'word') else str(w.get('word', '')).strip(),
                    'start': float(w.start if hasattr(w, 'start') else w.get('start', 0)),
                    'end': float(w.end if hasattr(w, 'end') else w.get('end', 0))
                })

        chunk_results.append((words, offset))
        print(f"   ✅ {len(words)} 個詞")

    # 合併結果
    all_words = merge_results(chunk_results) if len(chunks) > 1 else chunk_results[0][0]

    # 清理暫存檔
    if len(chunks) > 1:
        import shutil
        tmpdir = os.path.dirname(chunks[0][0])
        shutil.rmtree(tmpdir, ignore_errors=True)
        print("🗑️  已清理暫存檔")

    # 轉成 google_result.json 格式
    result = convert_to_google_format(all_words, duration)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"✅ 已儲存 {output_path}")
    print(f"📊 共 {len(all_words)} 個詞，音訊時長 {duration:.1f}s")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("用法: python openai_transcribe.py <audio_file> <output_json>")
        sys.exit(1)

    audio_path = sys.argv[1]
    output_path = sys.argv[2]

    if not os.path.exists(audio_path):
        print(f"❌ 找不到音訊檔案: {audio_path}")
        sys.exit(1)

    transcribe(audio_path, output_path)
