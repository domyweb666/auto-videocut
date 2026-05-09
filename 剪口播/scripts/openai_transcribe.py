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

def split_audio(audio_path, max_size_mb=8, overlap_sec=1):
    """
    將大音訊檔切割成片段。預設 max_size_mb=8（OpenAI 上限 25 MB）— 保守切小，
    避免長 POST 在不穩網路被中介設備切斷（RemoteProtocolError）。
    每段之間有 overlap_sec 秒重疊，避免切斷字詞。
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
    max_chunks = int(duration / chunk_duration) + 2  # 防禦性上限

    while offset < duration and idx < max_chunks:
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
        # 最後一段不需要 overlap，直接結束
        if end >= duration:
            break
        offset = end - overlap_sec
        idx += 1

    print(f"📦 音訊切成 {len(chunks)} 段（每段 ~{chunk_duration:.0f}s）")
    return chunks

# 對抗式 prompt：餵 Whisper 一段個人知識管理／PKM 風格的中性 context，
# 抑制中國頻道訓練資料污染（「請不吝點讚、訂閱、轉發、明鏡」這類幻覺）。
# Whisper 會把 prompt 視為前文上下文，傾向延續這個用詞風格。
ANTI_HALLUCINATION_PROMPT = (
    "這是一段繁體中文的個人知識管理講解影片，講者用台灣口語介紹"
    "卡片筆記、知識體系、Heptabase 等工具，內容專注於方法論本身，"
    "不會出現頻道訂閱結尾語。"
)

def transcribe_chunk(client, audio_path, language="zh", max_retries=5):
    """轉錄單個音訊片段，回傳 word-level 結果。
    網路/API 失敗時最多重試 5 次（指數退避，10s → 20s → 40s → 80s → 160s）。
    對 RemoteProtocolError 特別寬容——這通常是大檔上傳被中介設備切斷。"""
    import time
    last_err = None
    for attempt in range(max_retries):
        try:
            with open(audio_path, 'rb') as f:
                response = client.audio.transcriptions.create(
                    model="whisper-1",
                    file=f,
                    language=language,
                    response_format="verbose_json",
                    timestamp_granularities=["word"],
                    temperature=0,
                    prompt=ANTI_HALLUCINATION_PROMPT
                )
            return response
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                wait = (2 ** attempt) * 10  # 10s → 20s → 40s → 80s → 160s
                print(f"   ⚠️ Whisper API 失敗（{type(e).__name__}: {str(e)[:120]}），{wait}s 後重試 ({attempt+2}/{max_retries})", flush=True)
                time.sleep(wait)
            else:
                raise last_err

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

    # 優先讀 scripts/.env（專案級設定 > 系統環境變數，避免使用者忘記同步更新環境變數時抓到舊 key）
    api_key = None
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('OPENAI_API_KEY='):
                    api_key = line.split('=', 1)[1].strip()
                    break
    # .env 沒設才退回系統環境變數
    if not api_key:
        api_key = os.environ.get('OPENAI_API_KEY')
    if not api_key:
        print("❌ 未設定 OPENAI_API_KEY（請填入 scripts/.env 或設定環境變數）")
        sys.exit(1)
    print(f"🔑 key 來源：{'.env' if os.path.exists(env_path) and api_key else '系統環境變數'}（前綴 {api_key[:14]}…{api_key[-6:]}）")

    client = OpenAI(api_key=api_key)

    print(f"📁 音訊檔案: {audio_path}")
    duration = get_audio_duration(audio_path)
    size_mb = get_file_size_mb(audio_path)
    print(f"📊 檔案大小: {size_mb:.1f}MB, 時長: {duration:.1f}s ({duration/60:.1f}分鐘)")
    print(f"💰 預估費用: ${duration/60 * 0.006:.3f} USD")

    # 切割大檔案
    chunks = split_audio(audio_path)

    # 設置 chunk 快取：成功的塊寫到 <audio_dir>/whisper_cache/chunk_NNNN.json
    # 下次跑時只重做缺漏的塊，避免每次重斷重傳
    audio_dir = os.path.dirname(os.path.abspath(audio_path))
    cache_dir = os.path.join(audio_dir, 'whisper_cache')
    os.makedirs(cache_dir, exist_ok=True)
    audio_mtime = os.path.getmtime(audio_path)
    audio_size = os.path.getsize(audio_path)
    manifest_path = os.path.join(cache_dir, 'manifest.json')
    # 比對 manifest，若 audio 變動則整個快取失效
    cache_valid = False
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                m = json.load(f)
            if m.get('mtime') == audio_mtime and m.get('size') == audio_size and m.get('total_chunks') == len(chunks):
                cache_valid = True
        except Exception:
            pass
    if not cache_valid:
        # 清掉舊快取
        for fn in os.listdir(cache_dir):
            if fn.startswith('chunk_') and fn.endswith('.json'):
                try: os.remove(os.path.join(cache_dir, fn))
                except: pass
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump({'mtime': audio_mtime, 'size': audio_size, 'total_chunks': len(chunks)}, f)

    # 轉錄每個片段（有快取就跳過）
    chunk_results = []
    cached_count = 0
    for i, (chunk_path, offset) in enumerate(chunks):
        cache_file = os.path.join(cache_dir, f'chunk_{i:04d}.json')
        label = f"[{i+1}/{len(chunks)}] " if len(chunks) > 1 else ""

        # 命中快取 → 直接讀
        if os.path.exists(cache_file):
            try:
                with open(cache_file, 'r', encoding='utf-8') as f:
                    cached = json.load(f)
                chunk_results.append((cached['words'], cached['offset']))
                cached_count += 1
                print(f"♻️  {label}快取命中（{len(cached['words'])} 個詞，跳過 Whisper）")
                continue
            except Exception as e:
                print(f"⚠️  {label}快取讀取失敗（{e}），重新轉錄")

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

        # 立刻寫快取（成功一塊就 persist 一塊，下次斷掉可從這裡接）
        try:
            with open(cache_file, 'w', encoding='utf-8') as f:
                json.dump({'words': words, 'offset': offset, 'index': i}, f, ensure_ascii=False)
        except Exception as e:
            print(f"⚠️  {label}快取寫入失敗（{e}），但繼續執行")

        chunk_results.append((words, offset))
        print(f"   ✅ {len(words)} 個詞（已存快取）")

    if cached_count > 0:
        print(f"📊 共 {cached_count}/{len(chunks)} 塊命中快取，省下重複上傳")

    # 合併結果
    all_words = merge_results(chunk_results) if len(chunks) > 1 else chunk_results[0][0]

    # 清理暫存檔（chunks 拆出來的 mp3 暫存）
    if len(chunks) > 1:
        import shutil
        tmpdir = os.path.dirname(chunks[0][0])
        shutil.rmtree(tmpdir, ignore_errors=True)
        print("🗑️  已清理暫存檔")

    # 全部成功 → 清掉 chunk 快取（下次不會留到讓 audio 改了還用舊快取）
    try:
        import shutil
        shutil.rmtree(cache_dir, ignore_errors=True)
        print("🗑️  已清理 whisper_cache/")
    except Exception:
        pass

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
