#!/usr/bin/env node
/**
 * 批量訓練協調器
 *
 * 讀取 manifest → 逐支影片處理 → 匯總分析 → 產出報告
 *
 * 用法: node batch_train.js <training_manifest.json>
 *
 * manifest 格式:
 * {
 *   "videos": [
 *     { "video": "path/to/video.mp4", "srt": "path/to/video.srt" },
 *     { "video": "path/to/video2.mp4", "srt": "path/to/video2.srt", "existing_output": "path/to/output/剪口播" }
 *   ],
 *   "options": {
 *     "transcriber": "google" | "whisper",  // 預設 google
 *     "parallel": 2                          // 同時處理數（預設 1）
 *   }
 * }
 *
 * 輸出目錄: training_output/ (在 manifest 同層)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const manifestFile = process.argv[2];
if (!manifestFile || !fs.existsSync(manifestFile)) {
  console.error('用法: node batch_train.js <training_manifest.json>');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const videos = manifest.videos || [];
const options = manifest.options || {};
const transcriber = options.transcriber || 'google';

if (videos.length === 0) {
  console.error('❌ manifest 中沒有影片');
  process.exit(1);
}

const SCRIPT_DIR = __dirname;
const OUTPUT_DIR = path.resolve(path.dirname(manifestFile), 'training_output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`🎯 批量訓練: ${videos.length} 支影片`);
console.log(`📂 輸出目錄: ${OUTPUT_DIR}`);
console.log(`🎙️ 轉錄引擎: ${transcriber}`);
console.log('---');

const reportFiles = [];
let successCount = 0;
let failCount = 0;

// 偵測比對模式：有 edited 欄位用音檔比對，有 srt 欄位用 SRT 比對
const isAudioMode = videos.length > 0 && videos[0].edited;
console.log(`📋 比對模式: ${isAudioMode ? '音檔比對（原始 vs 剪後）' : 'SRT 比對'}`);

for (let vi = 0; vi < videos.length; vi++) {
  const entry = videos[vi];
  const videoName = entry.name || path.basename(entry.original || entry.video || '').replace(/\.[^/.]+$/, '');

  // 路徑解析：如果已經是絕對路徑就直接用，否則相對於 manifest 目錄
  const manifestDir = path.dirname(manifestFile);
  function resolvePath(p) {
    if (!p) return null;
    return path.isAbsolute(p) ? p : path.resolve(manifestDir, p);
  }
  const originalPath = resolvePath(entry.original || entry.video);
  const editedPath = resolvePath(entry.edited);
  const srtPath = resolvePath(entry.srt);

  console.log(`\n═══ [${vi + 1}/${videos.length}] ${videoName} ═══`);

  if (isAudioMode && (!editedPath || !fs.existsSync(editedPath))) {
    console.error(`❌ 找不到剪後影片: ${editedPath}`);
    failCount++;
    continue;
  }
  if (!isAudioMode && (!srtPath || !fs.existsSync(srtPath))) {
    console.error(`❌ 找不到 SRT: ${srtPath}`);
    failCount++;
    continue;
  }

  const workDir = path.join(OUTPUT_DIR, videoName);
  const transcribeDir = path.join(workDir, '1_轉錄');
  const analysisDir = path.join(workDir, '2_分析');
  fs.mkdirSync(transcribeDir, { recursive: true });
  fs.mkdirSync(analysisDir, { recursive: true });

  try {
    // ── Step 1: 轉錄原始影片 → subtitles_words.json ──
    let subtitlesPath = path.join(transcribeDir, 'subtitles_words.json');

    // 檢查是否有現成的
    if (entry.existing_output) {
      const existingPath = path.resolve(path.dirname(manifestFile), entry.existing_output, '1_轉錄', 'subtitles_words.json');
      if (fs.existsSync(existingPath)) {
        console.log(`♻️ 複用現有原始轉錄: ${existingPath}`);
        fs.copyFileSync(existingPath, subtitlesPath);
      }
    }

    if (!fs.existsSync(subtitlesPath)) {
      if (!fs.existsSync(originalPath)) {
        console.error(`❌ 找不到原始影片: ${originalPath}`);
        failCount++;
        continue;
      }

      // 提取原始音頻
      const audioOrigName = isAudioMode ? 'audio_original.mp3' : 'audio.mp3';
      const audioPath = path.join(transcribeDir, audioOrigName);
      console.log('🎵 提取原始音頻...');
      execSync(`ffmpeg -y -i "${originalPath.replace(/\\/g, '/')}" -vn -acodec libmp3lame "${audioPath.replace(/\\/g, '/')}"`, {
        stdio: 'pipe',
        cwd: transcribeDir
      });

      // 轉錄原始
      if (transcriber === 'openai') {
        console.log('🎙️ OpenAI Whisper API 轉錄原始...');
        execSync(`python "${path.join(SCRIPT_DIR, 'openai_transcribe.py')}" "${audioOrigName}" google_result.json`, {
          stdio: 'inherit',
          cwd: transcribeDir,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
      } else if (transcriber === 'google') {
        console.log('🎙️ Google STT 轉錄...');
        execSync(`python "${path.join(SCRIPT_DIR, 'google_transcribe.py')}" "${audioOrigName}" google_result.json`, {
          stdio: 'inherit',
          cwd: transcribeDir,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
      } else {
        console.log('🎙️ Whisper (本機) 轉錄...');
        execSync(`bash "${path.join(SCRIPT_DIR, 'whisper_transcribe.sh')}" "${audioOrigName}"`, {
          stdio: 'inherit',
          cwd: transcribeDir
        });
      }

      // 生成原始字幕
      console.log('📝 生成原始字幕...');
      execSync(`node "${path.join(SCRIPT_DIR, 'generate_subtitles.js')}"`, {
        stdio: 'inherit',
        cwd: transcribeDir
      });
    }

    if (!fs.existsSync(subtitlesPath)) {
      console.error(`❌ 未能生成 subtitles_words.json`);
      failCount++;
      continue;
    }

    // ── Step 1.5（音檔模式）: 轉錄剪後影片 → edited_words.json ──
    let editedWordsPath = null;
    if (isAudioMode) {
      editedWordsPath = path.join(analysisDir, 'edited_words.json');

      // 檢查是否有現成的
      if (entry.existing_output) {
        const existingEdited = path.resolve(path.dirname(manifestFile), entry.existing_output, '2_分析', 'edited_words.json');
        if (fs.existsSync(existingEdited)) {
          console.log(`♻️ 複用現有剪後轉錄: ${existingEdited}`);
          fs.copyFileSync(existingEdited, editedWordsPath);
        }
      }

      if (!fs.existsSync(editedWordsPath)) {
        // 提取剪後音頻
        const audioEditedPath = path.join(transcribeDir, 'audio_edited.mp3');
        console.log('🎵 提取剪後音頻...');
        execSync(`ffmpeg -y -i "${editedPath.replace(/\\/g, '/')}" -vn -acodec libmp3lame "${audioEditedPath.replace(/\\/g, '/')}"`, {
          stdio: 'pipe',
          cwd: transcribeDir
        });

        // 轉錄剪後
        const editedResultPath = path.join(transcribeDir, 'edited_result.json');
        if (transcriber === 'openai') {
          console.log('🎙️ OpenAI Whisper API 轉錄剪後...');
          execSync(`python "${path.join(SCRIPT_DIR, 'openai_transcribe.py')}" audio_edited.mp3 edited_result.json`, {
            stdio: 'inherit',
            cwd: transcribeDir,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
          });
        } else if (transcriber === 'google') {
          execSync(`python "${path.join(SCRIPT_DIR, 'google_transcribe.py')}" audio_edited.mp3 edited_result.json`, {
            stdio: 'inherit',
            cwd: transcribeDir,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
          });
        } else {
          // 本機 Whisper 需要特殊處理輸出檔名
          execSync(`bash "${path.join(SCRIPT_DIR, 'whisper_transcribe.sh')}" audio_edited.mp3`, {
            stdio: 'inherit',
            cwd: transcribeDir
          });
          // whisper 輸出為 whisper_result.json，重新命名
          const whisperOut = path.join(transcribeDir, 'whisper_result.json');
          if (fs.existsSync(whisperOut)) {
            fs.renameSync(whisperOut, editedResultPath);
          }
        }

        // 生成剪後字幕（在暫存目錄操作，避免覆蓋原始字幕）
        console.log('📝 生成剪後字幕...');
        const tmpDir = path.join(transcribeDir, '_edited_tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        // 複製轉錄結果到暫存目錄
        const editedSrc = fs.existsSync(editedResultPath) ? editedResultPath : path.join(transcribeDir, 'edited_result.json');
        fs.copyFileSync(editedSrc, path.join(tmpDir, 'google_result.json'));
        execSync(`node "${path.join(SCRIPT_DIR, 'generate_subtitles.js')}"`, {
          stdio: 'inherit',
          cwd: tmpDir
        });
        // 搬到目標位置
        const tmpSubtitles = path.join(tmpDir, 'subtitles_words.json');
        if (fs.existsSync(tmpSubtitles)) {
          fs.copyFileSync(tmpSubtitles, editedWordsPath);
        }
        // 清理暫存
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      if (!fs.existsSync(editedWordsPath)) {
        console.error(`❌ 未能生成 edited_words.json`);
        failCount++;
        continue;
      }
    }

    // ── Step 2: 生成 sentences.txt ──
    console.log('📋 生成句子列表...');
    const subtitlesData = JSON.parse(fs.readFileSync(subtitlesPath, 'utf8'));
    const sentences = [];
    let curr = { text: '', startIdx: -1, endIdx: -1 };
    subtitlesData.forEach((w, i) => {
      const isLongGap = w.isGap && (w.end - w.start) >= 0.5;
      if (isLongGap) {
        if (curr.text.length > 0) sentences.push({...curr});
        curr = { text: '', startIdx: -1, endIdx: -1 };
      } else if (!w.isGap) {
        if (curr.startIdx === -1) curr.startIdx = i;
        curr.text += w.text;
        curr.endIdx = i;
      }
    });
    if (curr.text.length > 0) sentences.push(curr);
    const sentLines = sentences.map((s, i) => i + '|' + s.startIdx + '-' + s.endIdx + '|' + s.text);
    fs.writeFileSync(path.join(analysisDir, 'sentences.txt'), sentLines.join('\n'));

    // ── Step 3: 規則自動標記 ──
    console.log('🤖 規則自動標記...');
    const autoSelectedPath = path.join(analysisDir, 'auto_selected.json');
    execSync(`node "${path.join(SCRIPT_DIR, 'auto_select_rules.js')}" "${subtitlesPath}" "${autoSelectedPath}"`, {
      stdio: 'inherit'
    });

    // ── Step 4: 比對 ──
    const diffReportPath = path.join(analysisDir, 'diff_report.json');
    let diffOutput;

    if (isAudioMode) {
      console.log('📊 音檔比對（原始 vs 剪後轉錄）...');
      diffOutput = execSync(
        `node "${path.join(SCRIPT_DIR, 'compare_transcriptions.js')}" "${subtitlesPath}" "${editedWordsPath}" "${autoSelectedPath}"`,
        { encoding: 'utf8' }
      );
    } else {
      console.log('📊 對照 SRT...');
      diffOutput = execSync(
        `node "${path.join(SCRIPT_DIR, 'compare_with_srt.js')}" "${subtitlesPath}" "${autoSelectedPath}" "${srtPath}"`,
        { encoding: 'utf8' }
      );
    }
    fs.writeFileSync(diffReportPath, diffOutput);
    reportFiles.push(diffReportPath);

    console.log(`✅ ${videoName} 完成`);
    successCount++;

  } catch (err) {
    console.error(`❌ ${videoName} 失敗: ${err.message}`);
    failCount++;
  }
}

// ── Step 5: 匯總分析 ──
console.log('\n═══ 匯總分析 ═══');

if (reportFiles.length === 0) {
  console.error('❌ 沒有成功的報告，無法匯總');
  process.exit(1);
}

try {
  const args = reportFiles.map(f => `"${f}"`).join(' ');
  execSync(`node "${path.join(SCRIPT_DIR, 'aggregate_training.js')}" ${args}`, {
    stdio: 'inherit',
    cwd: OUTPUT_DIR
  });
} catch (err) {
  console.error('❌ 匯總失敗:', err.message);
}

// ── Step 6: 自動套用高信心建議到 training_config.json ──
const CONFIG_PATH = path.join(SCRIPT_DIR, '..', 'training_config.json');
const updatesPath = path.join(OUTPUT_DIR, 'rule_updates.json');

if (fs.existsSync(updatesPath)) {
  try {
    const updates = JSON.parse(fs.readFileSync(updatesPath, 'utf8'));
    const config = fs.existsSync(CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      : {};

    let appliedCount = 0;
    const applied = [];
    const suggested = [];

    for (const [rule, update] of Object.entries(updates)) {
      if (update.confidence === 'high') {
        // 自動套用
        if (update.recommended && update.field === 'threshold' && rule.includes('静音')) {
          const match = update.recommended.match(/([\d.]+)s/);
          if (match) {
            const newVal = parseFloat(match[1]);
            const oldVal = config.silence?.threshold ?? 1.0;
            if (!config.silence) config.silence = {};
            config.silence.threshold = newVal;
            applied.push(`silence.threshold: ${oldVal} → ${newVal}`);
            appliedCount++;
          }
        }
        // 可擴展其他規則的自動套用...
      } else {
        suggested.push(`[${update.confidence}] ${rule}: ${update.evidence || update.current_precision || ''}`);
      }
    }

    if (appliedCount > 0) {
      config._updated = new Date().toISOString();
      config._source = 'batch_training';
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`\n🧠 自動套用 ${appliedCount} 項高信心建議:`);
      applied.forEach(a => console.log(`   ✅ ${a}`));
    }

    if (suggested.length > 0) {
      console.log(`\n📋 ${suggested.length} 項建議（需手動確認）:`);
      suggested.forEach(s => console.log(`   💡 ${s}`));
    }
  } catch (err) {
    console.error('⚠️ 自動套用失敗:', err.message);
  }
}

console.log(`\n═══ 完成 ═══`);
console.log(`✅ 成功: ${successCount} 支`);
if (failCount > 0) console.log(`❌ 失敗: ${failCount} 支`);
console.log(`📄 報告: ${path.join(OUTPUT_DIR, 'training_report.md')}`);
console.log(`📋 建議: ${path.join(OUTPUT_DIR, 'rule_updates.json')}`);
