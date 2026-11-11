// 大模型调用。密钥来源优先级：
//   1) 环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY
//   2) 软件自己的配置文件 %APPDATA%\录屏助手\config.json
//   3) DeepSeek Harness 的凭据 ~/.dsh/.credentials.yaml（只是图省事复用一次，不依赖 DSH 运行）
// 地址/模型同样支持环境变量和配置文件，可以指向任意 OpenAI 兼容服务（含本地 Ollama）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let cached = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function configFile() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, '录屏助手', 'config.json');
}

function readConfigFile() {
  try { return JSON.parse(readFileSync(configFile(), 'utf8')) || {}; } catch { return {}; }
}

function readDshKey() {
  const p = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', '.credentials.yaml');
  // DSH 偶尔会重写这个文件：读不到就多试两次
  for (let i = 0; i < 3; i++) {
    try {
      const m = readFileSync(p, 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*["']?([A-Za-z0-9_\-]{16,})/);
      if (m) return m[1];
    } catch { }
  }
  return '';
}

export function llmConfig() {
  if (cached) return cached;
  const file = readConfigFile();
  const recKey = process.env.REC_API_KEY || '';
  const deepseekKey = process.env.DEEPSEEK_API_KEY || '';
  const dshKey = readDshKey();

  let apiKey = '';
  let source = 'none';
  if (recKey) { apiKey = recKey; source = 'env'; }
  else if (file.apiKey) { apiKey = file.apiKey; source = 'config'; }
  else if (deepseekKey) { apiKey = deepseekKey; source = 'env'; }
  else if (dshKey) { apiKey = dshKey; source = 'dsh'; }

  // 只有显式配置了地址/模型才覆盖；否则用配置文件的，再不行用 DeepSeek 默认值。
  // 注意：不碰 OPENAI_API_KEY / OPENAI_BASE_URL —— 那是别的软件（如 sub2api 代理）的配置，
  // 拿来配 DeepSeek 地址会 401。要接别的服务，请在「设置」里填，或用 REC_* 变量。
  const explicitBase = process.env.REC_BASE_URL || process.env.DEEPSEEK_BASE_URL || '';
  const baseUrl = (explicitBase || (source === 'dsh' ? '' : file.baseUrl) || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.REC_MODEL || process.env.DEEPSEEK_MODEL || file.model || 'deepseek-chat';

  const cfg = { apiKey, baseUrl, model, source };
  if (apiKey) cached = cfg;
  return cfg;
}

/** 保存到软件自己的配置文件（不动 DSH 的凭据）。空字符串表示保留原值。 */
export function saveConfig(patch = {}) {
  const cur = readConfigFile();
  const pick = (v, old) => (typeof v === 'string' && v.trim() ? v.trim() : old);
  const next = {
    apiKey: pick(patch.apiKey, cur.apiKey),
    baseUrl: pick(patch.baseUrl, cur.baseUrl),
    model: pick(patch.model, cur.model),
  };
  mkdirSync(path.dirname(configFile()), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf8');
  cached = null;
  return llmConfig();
}

/** 把 DSH 凭据里的 Key 复制到软件自己的配置里，之后就不再依赖 DSH。 */
export function importKeyFromDsh() {
  const key = readDshKey();
  if (!key) throw new Error('没有在 ~/.dsh/.credentials.yaml 里找到 DEEPSEEK_API_KEY');
  return saveConfig({ apiKey: key });
}

/** 给前端看的脱敏状态（绝不返回完整密钥）。 */
export function publicLlmStatus() {
  const cfg = llmConfig();
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    ready: Boolean(cfg.apiKey),
    source: cfg.source,
    keyHint: cfg.apiKey ? cfg.apiKey.slice(0, 5) + '…' + cfg.apiKey.slice(-4) : '',
    configFile: configFile(),
  };
}

function endpoint() {
  const { baseUrl } = llmConfig();
  return baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
}

/** 用「设置」里当前填的（可能还没保存的）参数试一次请求，方便立刻发现 Key/地址不匹配。 */
export async function testLlm({ apiKey, baseUrl, model } = {}) {
  const cur = llmConfig();
  const key = (apiKey && apiKey.trim()) || cur.apiKey;
  const base = ((baseUrl && baseUrl.trim()) || cur.baseUrl).replace(/\/+$/, '');
  const m = (model && model.trim()) || cur.model;
  if (!key) throw new Error('还没有填 API Key');
  const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`接口 ${r.status}：${t.slice(0, 240)}`);
  }
  const data = await r.json().catch(() => null);
  return { model: data?.model || m, reply: data?.choices?.[0]?.message?.content || '' };
}

function isRetryable(err) {
  const m = String(err && err.message || err);
  if (/接口 (400|401|403|404|422)/.test(m)) return false;
  return /接口 (429|500|502|503|504)|abort|timeout|fetch failed|ECONNRESET|ETIMEDOUT|socket|network/i.test(m);
}

async function requestChat(messages, { maxTokens, temperature, stream, onDelta, timeoutMs }) {
  const cfg = llmConfig();
  if (!cfg.apiKey) throw new Error('还没有配置大模型密钥：点右上角「设置」填一个，或设置环境变量 DEEPSEEK_API_KEY');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
  let full = '';
  try {
    const r = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: Boolean(stream),
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const hint = (r.status === 401 || r.status === 403)
        ? `（Key 无效，或与接口地址 ${cfg.baseUrl} / 模型 ${cfg.model} 不匹配，请到右上角「设置」里检查）`
        : '';
      throw new Error(`大模型接口 ${r.status}${hint}：${t.slice(0, 240)}`);
    }
    if (!stream) {
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('大模型返回为空');
      return text;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta?.content || '';
          if (delta) { full += delta; onDelta(delta); }
        } catch { }
      }
    }
    return full;
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(messages, { maxTokens = 1200, temperature = 0.3, timeoutMs = 90000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await requestChat(messages, { maxTokens, temperature, stream: false, timeoutMs });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === 2) break;
      console.warn(`[llm] 第 ${attempt + 1} 次失败，重试：${err.message}`);
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function chatStream(messages, onDelta, { maxTokens = 1200, temperature = 0.3, timeoutMs = 120000 } = {}) {
  return requestChat(messages, { maxTokens, temperature, stream: true, onDelta, timeoutMs });
}
