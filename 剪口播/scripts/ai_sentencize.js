#!/usr/bin/env node
// @deprecated — 已被兩階段管線取代（ai_polish.js + ai_cut.js）
// 此檔保留供緊急 fallback，正式流程請勿使用
/**
 * AI 智慧剪輯分析（全權 AI 判斷 + 標點符號）
 *
 * 使用 Claude Code CLI 分析口播逐字稿：
 * 1. 智慧判斷哪些段落該刪除（重錄/填充詞/口吃/停頓/重複）
 * 2. 為每個段落加上中文標點符號
 *
 * 每個刪除標記帶 category: "pause" | "filler" | "repeat"
 *
 * 用法: node ai_sentencize.js <subtitles_words.json> [output_sentences.json]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

// 解析 --model 旗標（可在任何位置），其餘按位置讀取
let SENTENCIZE_MODEL = '';
const _positionalArgs = [];
for (let _i = 2; _i < process.argv.length; _i++) {
  if (process.argv[_i] === '--model' && process.argv[_i + 1]) {
    SENTENCIZE_MODEL = process.argv[++_i];
  } else {
    _positionalArgs.push(process.argv[_i]);
  }
}

const wordsFile = _positionalArgs[0];
const outputFile = _positionalArgs[1] || (_positionalArgs[0] && path.join(path.dirname(_positionalArgs[0]), 'sentences.json'));

if (!wordsFile) {
  console.error('用法: node ai_sentencize.js [--model <model>] <subtitles_words.json> [output.json]');
  process.exit(1);
}

// ── 載入可編輯 prompt 模板（autoresearch 可能會改寫此檔）──
const PROMPT_TEMPLATE_PATH = path.join(__dirname, '..', 'prompts', 'ai_sentencize_prompt.md');
let PROMPT_TEMPLATE_RAW = '';
try {
  PROMPT_TEMPLATE_RAW = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8')
    // 去除 HTML 注釋頭部說明
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim();
} catch (e) {
  console.error(`❌ 無法讀取 prompt 模板: ${PROMPT_TEMPLATE_PATH}`);
  console.error('   ' + e.message);
  process.exit(1);
}

// ── 回傳格式區塊（寫死在程式中，autoresearch 不可動）──
const RETURN_FORMAT_BLOCK = `## 回傳格式
JSON 物件，包含 deletions 和 texts：

{
  "deletions": [
    {"delete": [3, 4], "reason": "重錄：XXX，保留[5]", "category": "repeat"},
    {"trimGaps": [10, 15], "reason": "過長停頓 >2s", "category": "pause"},
    {"delete": [20], "reason": "純填充詞 Hmm", "category": "filler"}
  ],
  "texts": {
    "0": "嗨，大家好，",
    "1": "第一步是列出預算，",
    "2": "那第二步它是代表，"
  }
}

- deletions 中 delete 為段落編號陣列，trimGaps 為停頓編號陣列
- texts 中 key 為段落編號（字串），value 為加上標點的文字
- 所有段落都要有 texts 條目
- 沒有要刪的 deletions 就給空陣列 []
- 只回傳 JSON，不要其他文字`;

/**
 * 從模板生成最終 prompt：
 *   editable 區段 + RETURN_FORMAT_BLOCK + 段落區段
 * 模板以 <!-- AUTORESEARCH_END --> 為分隔，前段 autoresearch 可改、後段固定。
 */
function buildPrompt(notesSection, inputLines) {
  const SPLIT_MARKER = '<!-- AUTORESEARCH_END -->';
  let editable, tail;
  if (PROMPT_TEMPLATE_RAW.includes(SPLIT_MARKER)) {
    [editable, tail] = PROMPT_TEMPLATE_RAW.split(SPLIT_MARKER);
  } else {
    // 容錯：若模板被誤改，整個視為 editable，並補一個預設 tail
    editable = PROMPT_TEMPLATE_RAW;
    tail = '\n## 段落：\n{{INPUT_LINES}}';
  }
  const editableFilled = editable.replace('{{NOTES_SECTION}}', notesSection);
  const tailFilled = tail.replace('{{INPUT_LINES}}', inputLines);
  return `${editableFilled.trimEnd()}\n\n${RETURN_FORMAT_BLOCK}\n${tailFilled.trimStart()}`;
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));

// 讀取參考資訊
let notes = {};
try {
  const configPath = path.join(__dirname, '..', 'training_config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    notes = config.notes || {};
  }
} catch (e) {}

// 讀取個人化剪輯 Skills 文檔（由 generate_editing_skills.js 生成）
let editingSkills = '';
try {
  const skillsPath = path.join(__dirname, '..', 'editing_skills.md');
  if (fs.existsSync(skillsPath)) {
    const raw = fs.readFileSync(skillsPath, 'utf8');
    // 去除自動生成的 HTML 注釋頭部
    editingSkills = raw.replace(/^<!--[\s\S]*?-->\s*/gm, '').trim();
    console.log('📚 已載入個人化剪輯 Skills');
  }
} catch (e) {}

// 讀取核心習慣文件（一般原則補充）
let habitsContent = '';
try {
  const INCLUDE_HABITS = ['20-剪輯偏好標準.md'];
  const habitsDir = path.join(__dirname, '..', '用戶習慣');
  for (const file of INCLUDE_HABITS) {
    const p = path.join(habitsDir, file);
    if (fs.existsSync(p)) {
      habitsContent += fs.readFileSync(p, 'utf8') + '\n\n';
    }
  }
} catch (e) {}

// ── 第一步：用 gap 分割成短語 ──
const PHRASE_GAP = 0.3;
const phrases = [];
let curr = { text: '', wordIndices: [], gapIndices: [], startTime: 0, endTime: 0 };

words.forEach((w, i) => {
  if (w.isGap) {
    const dur = w.end - w.start;
    if (dur >= PHRASE_GAP && curr.text.length > 0) {
      curr.gapAfter = dur;
      curr.gapAfterIdx = i;
      phrases.push({ ...curr });
      curr = { text: '', wordIndices: [], gapIndices: [], startTime: 0, endTime: 0 };
    } else if (dur < PHRASE_GAP) {
      curr.gapIndices.push(i);
    }
  } else {
    if (curr.wordIndices.length === 0) curr.startTime = w.start;
    curr.text += w.text;
    curr.endTime = w.end;
    curr.wordIndices.push(i);
  }
});
if (curr.text.length > 0) phrases.push(curr);

console.log(`📝 共 ${phrases.length} 個短語段落`);

// ── 第二步：送 AI 分析 + 加標點 ──
const BATCH_SIZE = 80; // 每批 80 個（因為要回傳標點版本，回應較大）
const batches = [];
for (let i = 0; i < phrases.length; i += BATCH_SIZE) {
  batches.push({ startIdx: i, items: phrases.slice(i, i + BATCH_SIZE) });
}

let notesSection = '';
// 個人化剪輯 Skills（優先）
if (editingSkills) {
  notesSection += `\n## 個人剪輯風格說明書（請嚴格遵循）\n${editingSkills}\n`;
} else if (habitsContent) {
  // 若無 editing_skills.md，退回到習慣文件
  notesSection += `\n## 剪輯偏好標準\n${habitsContent}\n`;
}
// 專有名詞
if (notes.proper_nouns && notes.proper_nouns.length > 0) {
  notesSection += `\n## 專有名詞參考\n${notes.proper_nouns.join('、')}\n`;
}
// 自訂注意事項
if (notes.guidelines) {
  notesSection += `\n## 注意事項\n${notes.guidelines}\n`;
}

let successBatches = 0;

for (let bi = 0; bi < batches.length; bi++) {
  const batch = batches[bi];
  const batchPhrases = batch.items;
  const offset = batch.startIdx;

  console.log(`\n🤖 AI 分析第 ${bi + 1}/${batches.length} 批 (${batchPhrases.length} 段, 編號 ${offset}-${offset + batchPhrases.length - 1})...`);

  const inputLines = batchPhrases.map((p, idx) => {
    const gap = p.gapAfter ? ` [停${p.gapAfter.toFixed(1)}s]` : '';
    return `[${offset + idx}] ${p.text}${gap}`;
  }).join('\n');

  const prompt = buildPrompt(notesSection, inputLines);

  try {
    // Windows 需要用 claude.cmd，Unix 用 claude
    const isWindows = process.platform === 'win32';
    const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

    const modelFlag = SENTENCIZE_MODEL ? ` --model ${SENTENCIZE_MODEL}` : '';
    const result = llmExec(modelFlag, {
      input: prompt,
      encoding: 'utf8',
      timeout: 600000, // 10 分鐘
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });

    let parsed;
    try {
      parsed = JSON.parse(result.trim());
    } catch {
      // 嘗試提取 JSON 物件
      const objMatch = result.match(/\{[\s\S]*\}(?=\s*$)/);
      if (objMatch) {
        parsed = JSON.parse(objMatch[0]);
      } else {
        // 最後嘗試
        const anyObj = result.match(/\{[\s\S]*\}/);
        if (anyObj) parsed = JSON.parse(anyObj[0]);
        else parsed = { deletions: [], texts: {} };
      }
    }

    // 相容舊格式（如果回傳是陣列，當作 deletions）
    let deletions, texts;
    if (Array.isArray(parsed)) {
      deletions = parsed;
      texts = {};
    } else {
      deletions = parsed.deletions || [];
      texts = parsed.texts || {};
    }

    // 套用標點符號
    let punctCount = 0;
    for (const [idxStr, pText] of Object.entries(texts)) {
      const idx = parseInt(idxStr);
      const actualIdx = idx; // 已經是全域編號
      if (actualIdx >= 0 && actualIdx < phrases.length && pText) {
        phrases[actualIdx].displayText = pText;
        punctCount++;
      }
    }
    console.log(`   📝 ${punctCount} 段已加標點`);

    // 套用刪除標記
    let deleteCount = 0;
    let gapCount = 0;
    for (const group of deletions) {
      const cat = group.category || 'repeat';

      if (group.delete && Array.isArray(group.delete)) {
        for (const delIdx of group.delete) {
          if (typeof delIdx === 'number' && delIdx >= 0 && delIdx < phrases.length) {
            phrases[delIdx].aiDelete = true;
            phrases[delIdx].deleteReason = group.reason || '建議刪除';
            phrases[delIdx].deleteCategory = cat;
            deleteCount++;
          }
        }
      }

      if (group.trimGaps && Array.isArray(group.trimGaps)) {
        for (const gapIdx of group.trimGaps) {
          if (typeof gapIdx === 'number' && gapIdx >= 0 && gapIdx < phrases.length) {
            if (phrases[gapIdx].gapAfterIdx !== undefined) {
              phrases[gapIdx].gapDelete = true;
              phrases[gapIdx].gapDeleteReason = group.reason || '過長停頓';
              phrases[gapIdx].gapDeleteCategory = cat;
              gapCount++;
            }
          }
        }
      }
    }
    console.log(`   ✅ 標記 ${deleteCount} 段刪除, ${gapCount} 個停頓刪除`);
    successBatches++;

    // 摘要
    for (const group of deletions) {
      const items = [...(group.delete || []), ...(group.trimGaps || []).map(i => `gap:${i}`)];
      if (items.length > 0) {
        const preview = items.slice(0, 3).map(i => {
          if (typeof i === 'string') return i;
          if (i >= 0 && i < phrases.length) return `[${i}] ${phrases[i].text.substring(0, 12)}...`;
          return `[${i}]`;
        }).join(', ');
        const more = items.length > 3 ? ` (+${items.length - 3})` : '';
        console.log(`   🗑️ [${group.category}] ${group.reason}: ${preview}${more}`);
      }
    }
  } catch (err) {
    console.error(`   ⚠️ AI 分析批次 ${bi + 1} 失敗: ${err.message}`);
    if (err.code === 'ENOENT' || (err.message && err.message.includes('ENOENT'))) {
      console.error('   ❌ 找不到 claude CLI，請確認已安裝 Claude Code');
    }
  }
}

// 檢查 AI 分析成功率
if (successBatches === 0) {
  console.error(`\n❌ 所有 ${batches.length} 個 AI 分析批次都失敗，請檢查 claude CLI 是否可用`);
  console.error('   嘗試執行: claude --version');
  process.exit(1);
}

// ── 輸出結果 ──
fs.writeFileSync(outputFile, JSON.stringify(phrases, null, 2));

const totalDelete = phrases.filter(p => p.aiDelete).length;
const totalGapDelete = phrases.filter(p => p.gapDelete).length;
const totalPunct = phrases.filter(p => p.displayText).length;
const totalKeep = phrases.length - totalDelete;
console.log(`\n✅ 分析完成:`);
console.log(`   📊 共 ${phrases.length} 段, 保留 ${totalKeep} 段, 建議刪除 ${totalDelete} 段, 停頓刪除 ${totalGapDelete} 個`);
console.log(`   📝 ${totalPunct} 段已加標點符號`);
console.log(`   📄 輸出: ${outputFile}`);
