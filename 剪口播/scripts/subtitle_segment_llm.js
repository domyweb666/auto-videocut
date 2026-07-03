#!/usr/bin/env node
/**
 * subtitle_segment_llm.js — 讓 Claude 依意群斷字幕行（機械斷句抓不到的語意邊界）
 *
 * 機械斷句只能斷在標點＋避開虛詞，抓不到「感受到｜自己」這種語意意群邊界。這支把「已定稿、
 * 一個字都不會變的保留稿」丟給 Claude，只讓它決定在哪裡換行。
 *
 * 安全鐵律（跟所有 domi skill 的「只斷行不改字」同一條紅線）：
 *   Claude 回來後，把它的斷行結果去掉換行、逐字比對原逐字稿——**一個字不符就整個作廢、退回機械
 *   斷句**。絕不讓 AI 動到字幕文字（那會跟影片/index 選集對不上）。時間戳用逐字元內插，斷點落在
 *   哪都對得回去。
 *
 * 純函式（建 prompt / 驗證 / 對時間）可單元測試；呼叫 Claude 抽成可注入的 callClaude。
 */
const { execSync } = require('child_process');

const PROMPT_TEMPLATE = `你是字幕斷行工。下面是一段口播的逐字稿——這些字已經定稿，一個字都不會變。
你的工作只有一個：決定在哪裡換行，把它斷成一行一行的螢幕字幕。

鐵則（違反任一條就是失敗）：
1. 只能斷行。一個字都不准改、不准加、不准刪、不准調順序、不准改任何標點。輸出的每個字元都照原樣，只是多了換行。
2. 橫式長片字幕，每行約 8–16 字，寧短勿長；寧可斷得乾淨，也不要硬塞滿。
3. 斷在意群邊界：一口氣講完、語意完整的一小段就是一行。有標點優先斷在標點（逗號、句號）。
4. 不要把一個詞或語意單位切成兩半（「機器學習」不可拆成「機器學」＋「習」）。
5. 行末不要掛在虛詞上（的、了、而、就、把、被、和、但、也、還、就是…這些字結尾幾乎都是斷錯）。
6. 頓號「、」串起來的清單（甲、乙、丙）盡量留在同一行，不要從中間拆。
7. 標點全部照留（行末標點我會自己處理），你只管換行。

輸出格式：只輸出斷好行的文字，一行一個字幕，用換行分隔。不要編號、不要引號、不要任何說明、不要 markdown 圍欄。

逐字稿：
---
{{TEXT}}`;

function buildSegmentPrompt(keptText) {
  return PROMPT_TEMPLATE.replace('{{TEXT}}', keptText);
}

// 把保留字攤成「逐字元＋時間」（多字元元素如「策。」用內插），回傳 { chars, keptText }
function charsFromWords(keptWords) {
  const chars = [];
  for (const w of keptWords) {
    const t = w.text || '';
    const dur = (w.end - w.start) || 0;
    for (let k = 0; k < t.length; k++) {
      chars.push({ ch: t[k], start: w.start + dur * (k / t.length), end: w.start + dur * ((k + 1) / t.length) });
    }
  }
  return { chars, keptText: chars.map(c => c.ch).join('') };
}

const normalize = s => String(s == null ? '' : s).replace(/\s/g, '');

// 解析 Claude 回傳成「行陣列」，並逐字驗證＝原逐字稿；不符回 null（呼叫端退回機械斷句）
function parseSegmentResponse(raw, keptText) {
  let s = String(raw || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/,'').replace(/\s*```$/,'').trim(); // 去 markdown 圍欄
  const lines = s.split(/\r?\n/).map(x => x.replace(/\s/g, '')).filter(Boolean);
  if (!lines.length) return null;
  if (lines.join('') !== normalize(keptText)) return null; // 字元不符 → 作廢
  return lines;
}

// 呼叫 Claude（沿用 ai_cut_pairs.js / seam_coldread.js 的 CLI 慣例）
function callClaudeCLI(prompt, model) {
  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const modelFlag = model ? ` --model ${model}` : '';
  return execSync(claudeCmd + ' -p -' + modelFlag, {
    input: prompt, encoding: 'utf8', timeout: 300000,
    maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], shell: true,
  }).trim();
}

/**
 * 主流程：keptWords → LLM 斷行 cues（{text,start,end}）。任何一關不過回 null（退回機械斷句）。
 * opts: { callClaude, model, maxChars, maxLine }
 */
function segmentByLLM(keptWords, opts = {}) {
  const { chars, keptText } = charsFromWords(keptWords || []);
  if (!keptText) return null;
  const maxChars = opts.maxChars || 8000;
  if (keptText.length > maxChars) return null;      // 太長不冒險（一次 call 越長越容易漂字）
  const callClaude = opts.callClaude || callClaudeCLI;
  let raw;
  try { raw = callClaude(buildSegmentPrompt(keptText), opts.model || 'sonnet'); }
  catch (_) { return null; }
  const lines = parseSegmentResponse(raw, keptText);
  if (!lines) return null;
  const maxLine = opts.maxLine || 28;
  if (lines.some(l => l.length > maxLine)) return null; // 有超長行＝品質不佳，退回

  const cues = [];
  let p = 0;
  for (const line of lines) {
    const n = line.length;
    if (p + n > chars.length) return null;           // 對不齊
    cues.push({ text: line, start: chars[p].start, end: chars[p + n - 1].end });
    p += n;
  }
  if (p !== chars.length) return null;               // 沒用完＝對不齊
  return cues;
}

module.exports = { buildSegmentPrompt, parseSegmentResponse, charsFromWords, segmentByLLM, PROMPT_TEMPLATE };
