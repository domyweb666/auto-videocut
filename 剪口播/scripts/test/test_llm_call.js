// llm_call.js 純函式單元測試（不碰網路、不碰 CLI）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseEnvText, mergeEnvText, parseCodexJsonl, extractApiText, buildApiRequest,
} = require('../llm_call');

test('parseEnvText：基本鍵值與註解', () => {
  const env = parseEnvText('# 註解\nA=1\nB = hello world \n\nC=x=y\n不是鍵值');
  assert.deepStrictEqual(env, { A: '1', B: 'hello world', C: 'x=y' });
});

test('mergeEnvText：原地替換保留註解，新鍵附加檔尾', () => {
  const src = '# BytePlus 金鑰\nBYTEPLUS_API_KEY=old\nOPENAI_API_KEY=keep\n';
  const out = mergeEnvText(src, { BYTEPLUS_API_KEY: 'new', LLM_MODE: 'api' });
  assert.ok(out.includes('# BytePlus 金鑰'));
  assert.ok(out.includes('BYTEPLUS_API_KEY=new'));
  assert.ok(out.includes('OPENAI_API_KEY=keep'));
  assert.ok(out.trimEnd().endsWith('LLM_MODE=api'));
  assert.ok(!out.includes('old'));
});

test('mergeEnvText：空檔案直接生成', () => {
  const out = mergeEnvText('', { LLM_MODE: 'claude_code' });
  assert.strictEqual(out, 'LLM_MODE=claude_code\n');
});

test('parseCodexJsonl：抽 agent_message、忽略其他事件與非 JSON 行', () => {
  const raw = [
    'garbage not json',
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '第一段' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '忽略我' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '第二段' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n');
  assert.strictEqual(parseCodexJsonl(raw), '第一段\n\n第二段');
});

test('parseCodexJsonl：只有錯誤事件時拋錯，額度錯誤有提示', () => {
  const raw = JSON.stringify({ type: 'error', error: { message: 'usage limit reached' } });
  assert.throws(() => parseCodexJsonl(raw), /額度用盡/);
});

test('extractApiText：anthropic 串接 text 片段', () => {
  const resp = { content: [{ type: 'text', text: '你' }, { type: 'tool_use' }, { type: 'text', text: '好' }] };
  assert.strictEqual(extractApiText('anthropic', resp), '你好');
});

test('extractApiText：openai 取 choices[0].message.content，缺欄位拋錯', () => {
  assert.strictEqual(extractApiText('openai', { choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.throws(() => extractApiText('openai', { choices: [] }), /choices/);
});

test('buildApiRequest：anthropic 預設官方端點、key 進 header 不進 URL', () => {
  const r = buildApiRequest('測試', { apiProtocol: 'anthropic', apiBaseUrl: '', apiKey: 'sk-test', apiModel: 'claude-sonnet-5' });
  assert.strictEqual(r.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(r.headers['x-api-key'], 'sk-test');
  assert.ok(!r.url.includes('sk-test'));
  assert.strictEqual(r.body.messages[0].content, '測試');
});

test('buildApiRequest：openai 沒填 base url 要拋錯，有填就去尾斜線', () => {
  assert.throws(() => buildApiRequest('x', { apiProtocol: 'openai', apiBaseUrl: '', apiKey: 'k', apiModel: 'm' }), /BASE_URL/);
  const r = buildApiRequest('x', { apiProtocol: 'openai', apiBaseUrl: 'https://api.deepseek.com/v1/', apiKey: 'k', apiModel: 'deepseek-chat' });
  assert.strictEqual(r.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(r.headers.authorization, 'Bearer k');
});
