#!/usr/bin/env node
/**
 * AI 剪輯判斷（Phase 2：只判斷哪些段落該刪除）
 *
 * 接收 ai_polish.js 的輸出（已加標點的短語陣列），
 * 用 Claude 判斷哪些段落該刪除（重錄/填充詞/停頓等）。
 * 不做任何標點修改，保留 polished.json 的 displayText 原樣。
 *
 * 用法: node ai_cut.js [--model <model>] [--skills-file <path>] <polished.json> [output_ai_sentences.json]
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmExec } = require('./llm_call');

// ── 解析參數 ──
let CUT_MODEL   = '';
let SKILLS_FILE = '';
const _positionalArgs = [];
for (let _i = 2; _i < process.argv.length; _i++) {
  const a = process.argv[_i];
  if (a === '--model' && process.argv[_i + 1]) {
    CUT_MODEL = process.argv[++_i];
  } else if (a === '--skills-file' && process.argv[_i + 1]) {
    SKILLS_FILE = process.argv[++_i];
  } else {
    _positionalArgs.push(a);
  }
}

const polishedFile = _positionalArgs[0];
const outputFile   = _positionalArgs[1]
  || (_positionalArgs[0] && path.join(path.dirname(_positionalArgs[0]), 'ai_sentences.json'));

if (!polishedFile) {
  console.error('用法: node ai_cut.js [--model <model>] [--skills-file <path>] <polished.json> [output_ai_sentences.json]');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// ── 載入 prompt 模板 ──
const PROMPT_TEMPLATE_PATH = path.join(__dirname, '..', 'prompts', 'ai_cut_prompt.md');
let PROMPT_TEMPLATE_RAW = '';
try {
  PROMPT_TEMPLATE_RAW = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim();
} catch (e) {
  console.error(`❌ 無法讀取 prompt 模板: ${PROMPT_TEMPLATE_PATH}`);
  process.exit(1);
}

// ── 回傳格式（寫死在程式）──
const RETURN_FORMAT_BLOCK = `## 回傳格式
JSON 物件，只含 deletions：

{
  "deletions": [
    {"delete": [3, 4], "reason": "重錄：XXX，保留[5]", "category": "repeat"},
    {"trimGaps": [10, 15], "reason": "過長停頓 >2s", "category": "pause"},
    {"delete": [20], "reason": "純填充詞 Hmm", "category": "filler"}
  ]
}

- deletions 中 delete 為段落編號陣列，trimGaps 為停頓編號陣列
- 沒有要刪的就給 "deletions": []
- 只回傳 JSON，不要其他文字`;

/**
 * 從模板生成最終 prompt（帶 AUTORESEARCH_END 分隔）。
 */
function buildPrompt(notesSection, inputLines) {
  const SPLIT_MARKER = '<!-- AUTORESEARCH_END -->';
  let editable, tail;
  if (PROMPT_TEMPLATE_RAW.includes(SPLIT_MARKER)) {
    [editable, tail] = PROMPT_TEMPLATE_RAW.split(SPLIT_MARKER);
  } else {
    editable = PROMPT_TEMPLATE_RAW;
    tail = '\n## 段落：\n{{INPUT_LINES}}';
  }
  const editableFilled = editable.replace('{{NOTES_SECTION}}', notesSection);
  const tailFilled     = tail.replace('{{INPUT_LINES}}', inputLines);
  return `${editableFilled.trimEnd()}\n\n${RETURN_FORMAT_BLOCK}\n${tailFilled.trimStart()}`;
}

// ── 讀取剪輯 Skills ──
let editingSkills = '';
try {
  const skillsPath = SKILLS_FILE
    ? path.resolve(SKILLS_FILE)
    : path.join(__dirname, '..', 'editing_skills.md');
  if (fs.existsSync(skillsPath)) {
    editingSkills = fs.readFileSync(skillsPath, 'utf8')
      .replace(/^<!--[\s\S]*?-->\s*/gm, '')
      .trim();
    console.log('📚 已載入剪輯 Skills');
  }
} catch (e) {}

// ── 讀取習慣文件（若無 editing_skills.md 時備用）──
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

// ── 讀取訓練設定 ──
let notes = {};
try {
  const configPath = path.join(__dirname, '..', 'training_config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    notes = config.notes || {};
  }
} catch (e) {}

// ── 讀取 polished.json ──
const phrases = JSON.parse(fs.readFileSync(polishedFile, 'utf8'));
console.log(`📝 共 ${phrases.length} 個短語段落（已潤飾）`);

// ── 分批 ──
// 120：攤薄 editing_skills.md 的固定開銷；cut 回應含 reason 文字，比 polish 大，故比 polish 的 150 略保守
const BATCH_SIZE = 120;
const batches = [];
for (let i = 0; i < phrases.length; i += BATCH_SIZE) {
  batches.push({ startIdx: i, items: phrases.slice(i, i + BATCH_SIZE) });
}

// ── 組 NOTES_SECTION ──
let notesSection = '';
if (editingSkills) {
  notesSection += `\n## 個人剪輯風格說明書（請嚴格遵循）\n${editingSkills}\n`;
} else if (habitsContent) {
  notesSection += `\n## 剪輯偏好標準\n${habitsContent}\n`;
}
if (notes.proper_nouns && notes.proper_nouns.length > 0) {
  notesSection += `\n## 專有名詞參考\n${notes.proper_nouns.join('、')}\n`;
}
if (notes.guidelines) {
  notesSection += `\n## 注意事項\n${notes.guidelines}\n`;
}

let successBatches = 0;

for (let bi = 0; bi < batches.length; bi++) {
  const batch        = batches[bi];
  const batchPhrases = batch.items;
  const offset       = batch.startIdx;

  console.log(`\n🤖 剪輯批次 ${bi + 1}/${batches.length}（${batchPhrases.length} 段，編號 ${offset}–${offset + batchPhrases.length - 1}）[模型: ${CUT_MODEL || 'default'}]`);

  // 使用 displayText（已加標點）作為 INPUT_LINES，讓語意重複更清晰
  const inputLines = batchPhrases.map((p, idx) => {
    const gap = p.gapAfter ? ` [停${p.gapAfter.toFixed(1)}s]` : '';
    const text = p.displayText || p.text;
    return `[${offset + idx}] ${text}${gap}`;
  }).join('\n');

  const prompt = buildPrompt(notesSection, inputLines);

  try {
    const modelFlag = CUT_MODEL ? ` --model ${CUT_MODEL}` : '';
    const result = llmExec(modelFlag, {
      input:     prompt,
      encoding:  'utf8',
      timeout:   600000,
      maxBuffer: 10 * 1024 * 1024,
      stdio:     ['pipe', 'pipe', 'pipe'],
      shell:     true
    });

    // ── 解析 JSON ──
    let parsed;
    try {
      parsed = JSON.parse(result.trim());
    } catch {
      const objMatch = result.match(/\{[\s\S]*\}(?=\s*$)/);
      if (objMatch) {
        parsed = JSON.parse(objMatch[0]);
      } else {
        const anyObj = result.match(/\{[\s\S]*\}/);
        parsed = anyObj ? JSON.parse(anyObj[0]) : { deletions: [] };
      }
    }

    // 相容舊格式（直接回傳陣列）
    const deletions = Array.isArray(parsed) ? parsed : (parsed.deletions || []);

    // ── 套用刪除標記 ──
    let deleteCount = 0;
    let gapCount    = 0;
    for (const group of deletions) {
      const cat = group.category || 'repeat';

      if (group.delete && Array.isArray(group.delete)) {
        for (const delIdx of group.delete) {
          if (typeof delIdx === 'number' && delIdx >= 0 && delIdx < phrases.length) {
            phrases[delIdx].aiDelete        = true;
            phrases[delIdx].deleteReason    = group.reason || '建議刪除';
            phrases[delIdx].deleteCategory  = cat;
            deleteCount++;
          }
        }
      }

      if (group.trimGaps && Array.isArray(group.trimGaps)) {
        for (const gapIdx of group.trimGaps) {
          if (typeof gapIdx === 'number' && gapIdx >= 0 && gapIdx < phrases.length) {
            if (phrases[gapIdx].gapAfterIdx !== undefined) {
              phrases[gapIdx].gapDelete         = true;
              phrases[gapIdx].gapDeleteReason   = group.reason || '過長停頓';
              phrases[gapIdx].gapDeleteCategory = cat;
              gapCount++;
            }
          }
        }
      }
    }
    console.log(`   ✅ 標記 ${deleteCount} 段刪除, ${gapCount} 個停頓刪除`);
    successBatches++;

    // 摘要輸出
    for (const group of deletions) {
      const items = [...(group.delete || []), ...(group.trimGaps || []).map(i => `gap:${i}`)];
      if (items.length > 0) {
        const preview = items.slice(0, 3).map(i => {
          if (typeof i === 'string') return i;
          const ph = phrases[i];
          if (ph) return `[${i}] ${(ph.displayText || ph.text).substring(0, 12)}...`;
          return `[${i}]`;
        }).join(', ');
        const more = items.length > 3 ? ` (+${items.length - 3})` : '';
        console.log(`   🗑️ [${group.category}] ${group.reason}: ${preview}${more}`);
      }
    }

  } catch (err) {
    const errMsg = ((err.stdout && err.stdout.toString()) || '')
                 + ((err.stderr && err.stderr.toString()) || '')
                 + (err.message || '');
    console.error(`   ⚠️ 剪輯批次 ${bi + 1} 失敗: ${err.message}`);
    if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
      console.error('   ❌ 找不到 claude CLI，請確認已安裝 Claude Code');
    }
  }
}

// ── 確認成功率 ──
if (successBatches === 0) {
  console.error(`\n❌ 所有 ${batches.length} 批剪輯判斷均失敗，請確認 claude CLI 可用`);
  console.error('   嘗試執行: claude --version');
  process.exit(1);
}

// ── 輸出（包含 polished 欄位 + aiDelete 欄位）──
fs.writeFileSync(outputFile, JSON.stringify(phrases, null, 2));

const totalDelete    = phrases.filter(p => p.aiDelete).length;
const totalGapDelete = phrases.filter(p => p.gapDelete).length;
const totalKeep      = phrases.length - totalDelete;
console.log(`\n✅ 剪輯判斷完成:`);
console.log(`   📊 共 ${phrases.length} 段，保留 ${totalKeep} 段，建議刪除 ${totalDelete} 段，停頓刪除 ${totalGapDelete} 個`);
console.log(`   📄 輸出: ${outputFile}`);
