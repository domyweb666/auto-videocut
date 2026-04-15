#!/usr/bin/env python3
"""
語意重複偵測（嵌入向量輔助）

用法: python detect_redundancy.py <sentences.txt> [threshold] [min_gap] [max_gap]

預設: threshold=0.85, min_gap=5, max_gap=30

輸出到 stdout: JSON 格式的候選重複組
[
  {
    "sent_a": { "idx": 3, "startIdx": 45, "endIdx": 62, "text": "..." },
    "sent_b": { "idx": 18, "startIdx": 320, "endIdx": 345, "text": "..." },
    "similarity": 0.92
  }
]

需要安裝: pip install sentence-transformers
"""

import sys
import json
import re

def parse_sentences(filepath):
    """解析 sentences.txt 格式: idx|startIdx-endIdx|text"""
    sentences = []
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split('|', 2)
            if len(parts) < 3:
                continue
            sent_idx = int(parts[0])
            range_part = parts[1]
            text = parts[2]
            start_idx, end_idx = range_part.split('-')
            sentences.append({
                'idx': sent_idx,
                'startIdx': int(start_idx),
                'endIdx': int(end_idx),
                'text': text
            })
    return sentences


def detect_with_embeddings(sentences, threshold=0.85, min_gap=5, max_gap=30):
    """使用 sentence-transformers 計算句對相似度"""
    try:
        from sentence_transformers import SentenceTransformer
        import numpy as np
    except ImportError:
        print("需要安裝 sentence-transformers: pip install sentence-transformers", file=sys.stderr)
        print("改用 fallback（字元重疊率）...", file=sys.stderr)
        return detect_with_overlap(sentences, threshold=0.6, min_gap=min_gap, max_gap=max_gap)

    print(f"載入模型...", file=sys.stderr)
    # 使用多語言模型（支援中文）
    model = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')

    texts = [s['text'] for s in sentences]
    print(f"編碼 {len(texts)} 個句子...", file=sys.stderr)
    embeddings = model.encode(texts, show_progress_bar=False, normalize_embeddings=True)

    # 計算候選句對
    candidates = []
    for i in range(len(sentences)):
        for j in range(i + min_gap, min(i + max_gap + 1, len(sentences))):
            # 餘弦相似度（已正規化，點積即可）
            sim = float(np.dot(embeddings[i], embeddings[j]))
            if sim >= threshold:
                # 過濾太短的句子（<10字容易誤判）
                if len(sentences[i]['text']) < 10 or len(sentences[j]['text']) < 10:
                    continue
                candidates.append({
                    'sent_a': sentences[i],
                    'sent_b': sentences[j],
                    'similarity': round(sim, 4)
                })

    # 按相似度降序排列
    candidates.sort(key=lambda x: x['similarity'], reverse=True)
    return candidates


def detect_with_overlap(sentences, threshold=0.6, min_gap=5, max_gap=30):
    """Fallback: 用字元 3-gram 重疊率偵測"""
    def ngrams(text, n=3):
        return set(text[i:i+n] for i in range(len(text) - n + 1))

    candidates = []
    for i in range(len(sentences)):
        if len(sentences[i]['text']) < 10:
            continue
        grams_i = ngrams(sentences[i]['text'])
        if not grams_i:
            continue

        for j in range(i + min_gap, min(i + max_gap + 1, len(sentences))):
            if len(sentences[j]['text']) < 10:
                continue
            grams_j = ngrams(sentences[j]['text'])
            if not grams_j:
                continue

            overlap = len(grams_i & grams_j)
            union = len(grams_i | grams_j)
            sim = overlap / union if union > 0 else 0

            if sim >= threshold:
                candidates.append({
                    'sent_a': sentences[i],
                    'sent_b': sentences[j],
                    'similarity': round(sim, 4)
                })

    candidates.sort(key=lambda x: x['similarity'], reverse=True)
    return candidates


def main():
    if len(sys.argv) < 2:
        print("用法: python detect_redundancy.py <sentences.txt> [threshold] [min_gap] [max_gap]", file=sys.stderr)
        sys.exit(1)

    sentences_file = sys.argv[1]
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0.85
    min_gap = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    max_gap = int(sys.argv[4]) if len(sys.argv) > 4 else 30

    sentences = parse_sentences(sentences_file)
    print(f"讀取 {len(sentences)} 個句子", file=sys.stderr)
    print(f"參數: threshold={threshold}, gap={min_gap}-{max_gap}", file=sys.stderr)

    candidates = detect_with_embeddings(sentences, threshold, min_gap, max_gap)
    print(f"找到 {len(candidates)} 組候選重複", file=sys.stderr)

    # 輸出 JSON 到 stdout
    print(json.dumps(candidates, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
