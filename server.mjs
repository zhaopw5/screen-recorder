// DeepSeek 录屏助手 —— 本地服务
// 只监听 127.0.0.1，所有录制文件写在本机；只有"AI 总结 / 提问"会把文字发给你配置的大模型。
import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat, appendFile, rm, rename } from 'node:fs/promises';
import { createWriteStream, createReadStream, existsSync } from 'node:fs';
import { join, extname, dirname, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { llmConfig, chat, chatStream, saveConfig, publicLlmStatus, importKeyFromDsh, testLlm, readConfigFile, writeConfigFile } from './lib/llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const DEFAULT_RECORDINGS = process.env.RECORDINGS_DIR || join(__dirname, 'recordings');
const PORT = Number(process.env.PORT || 8787);

/** 当前设置里的保存位置：config.json 的 recordingsDir，没有就用默认目录。 */
function recordingsRoot() {
  const d = String(readConfigFile().recordingsDir || '').trim();
  return d || DEFAULT_RECORDINGS;
}

/** 当前目录 + 以前用过的目录：改过保存位置后，历史记录仍然能看到旧文件。 */
function knownRecordingRoots() {
  const cfg = readConfigFile();
  const list = [recordingsRoot(), ...(Array.isArray(cfg.recordingsDirs) ? cfg.recordingsDirs : [])];
  const seen = new Set();
  const out = [];
  for (const d of list) {
    if (!d) continue;
    const key = String(d).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(d)) out.push(d);
  }
  if (!out.length) out.push(DEFAULT_RECORDINGS);
  return out;
}

/** 按会话 id 找它所在的目录（兼容切换过保存位置的情况）。 */
function findSessionDir(id) {
  for (const root of knownRecordingRoots()) {
    const p = join(root, id);
    if (existsSync(p)) return p;
  }
  return join(recordingsRoot(), id);
}

await mkdir(DEFAULT_RECORDINGS, { recursive: true });

const sessions = new Map();

// ---------------------------------------------------------------- 工具函数

function nowId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return sessions.has(base) ? `${base}-${String(sessions.size + 1).padStart(2, '0')}` : base;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h > 0 ? `${String(h).padStart(2, '0')}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sseSend(session, obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of session.clients) {
    try { res.write(data); } catch { }
  }
}

// ---------------------------------------------------------------- 会话

function createSession() {
  const id = nowId();
  const dir = join(recordingsRoot(), id);
  const s = {
    id,
    dir,
    createdAt: new Date().toISOString(),
    startedAt: Date.now(),
    status: 'recording',
    chunks: 0,
    segments: [],
    summary: '',
    title: '',
    qa: [],
    clients: new Set(),
    asr: null,
    asrReady: false,
    audioBytes: 0,
    summarizing: false,
    summarizedUpto: 0,
    lastSummaryAt: 0,
    finalizing: false,
    lastActivity: Date.now(),
  };
  sessions.set(id, s);
  return s;
}

function broadcastSegments(session, items) {
  for (const item of items) {
    sseSend(session, { type: 'segment', ...item });
  }
}

function spawnAsr(session) {
  const child = fork(join(__dirname, 'lib', 'asr-worker.mjs'), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env },
  });
  session.asr = child;
  child.stdout.on('data', (d) => process.stdout.write(`[asr ${session.id}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[asr ${session.id}] ${d}`));
  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      session.asrReady = true;
      sseSend(session, { type: 'asr', status: 'ready' });
    } else if (msg.type === 'segment') {
      const item = { start: msg.start, end: msg.end, text: msg.text, at: fmtTime(msg.start) };
      session.segments.push(item);
      sseSend(session, { type: 'segment', ...item });
      maybeSummarize(session);
    } else if (msg.type === 'flushed') {
      session.asrFlushed = true;
    } else if (msg.type === 'error') {
      sseSend(session, { type: 'error', message: `语音识别出错：${msg.message}` });
    }
  });
  child.on('exit', (code) => {
    session.asrReady = false;
    session.asr = null;
    if (!session.finalizing && session.status === 'recording') {
      sseSend(session, { type: 'error', message: `语音识别进程已退出（code ${code}）` });
    }
  });
  child.send({ type: 'init', paths: {}, maxSpeechSeconds: 15 });
  return child;
}

function segmentsText(session, from = 0) {
  return session.segments.slice(from).map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
}

function fullTranscript(session) {
  return session.segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
}

// ---------------------------------------------------------------- AI 总结

/** 界面语言（存在配置里），决定纪要/逐字稿用中文还是英文。 */
function uiLocale() {
  return readConfigFile().locale === 'en' ? 'en' : 'zh-CN';
}
const L = (zh, en, locale) => ((locale || uiLocale()) === 'en' ? en : zh);

function summarySystem(locale) {
  if (locale === 'en') {
    return `You are a professional meeting note-taker. You receive live transcript chunks from a recorded online meeting.
Produce rolling meeting notes in English, in Markdown, strictly following this structure, keeping every section short:

## One-line summary
(max 60 words)

## Key points
- 3–8 short bullets grouped by topic; do not repeat the transcript sentence by sentence

## Decisions
- If none, write "None yet"

## Action items
- Format: task — owner (or "TBD") — due date (or "Not set")

## Open questions
- If none, write "None yet"

Output only the notes: no preamble, no pleasantries. Merge duplicates and keep concrete numbers, dates, names and product names.`;
  }
  return `你是一名专业的中文会议速记员。你会收到一场线上会议（录屏）的实时转写片段。
请输出"滚动更新"的会议纪要，使用简体中文，Markdown 格式，严格按以下结构，每节都很短：

## 一句话概要
（不超过 60 字）

## 讨论要点
- 用 3~8 条短句，按主题聚合，不要逐句复述

## 已达成的结论 / 决议
- 没有就写"暂无"

## 待办与负责人
- 格式：事项 —— 负责人（没有就写"待定"）—— 时间（没有就写"未定"）

## 待确认的问题
- 没有就写"暂无"

只输出纪要本身，不要解释，不要客套。合并重复内容，保留具体数字、日期、人名、产品名。`;
}

async function maybeSummarize(session) {
  if (session.summarizing || session.status !== 'recording') return;
  if (session.segments.length - session.summarizedUpto < 3) return;
  if (Date.now() - session.lastSummaryAt < 30000) return;

  const fresh = session.segments.slice(session.summarizedUpto);
  const freshChars = fresh.reduce((n, s) => n + s.text.length, 0);
  if (freshChars < 80) return;

  const locale = uiLocale();
  session.summarizing = true;
  session.lastSummaryAt = Date.now();
  const prev = session.summary;
  try {
    const user = [
      prev ? L(`【已有的会议纪要】\n${prev}\n`, `Existing notes\n${prev}\n`, locale) : '',
      L('【新增的转写内容】', 'New transcript', locale) + `\n${fresh.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n')}`,
      L('请基于已有纪要 + 新增内容，输出更新后的完整会议纪要。', 'Update the notes using the existing notes plus the new transcript. Output the complete updated notes.', locale),
    ].filter(Boolean).join('\n');

    const out = await chat([
      { role: 'system', content: summarySystem(locale) },
      { role: 'user', content: user },
    ], { maxTokens: 900, temperature: 0.2 });

    session.summary = out.trim();
    session.summarizedUpto = session.segments.length;
    sseSend(session, { type: 'summary', summary: session.summary, partial: true });
  } catch (err) {
    sseSend(session, { type: 'error', message: L(`AI 总结失败：${err.message}`, `AI notes failed: ${err.message}`, locale) });
  } finally {
    session.summarizing = false;
  }
}

function finalSystem(locale) {
  if (locale === 'en') {
    return `You are a senior meeting-notes editor. Based on the full transcript of a recorded online meeting, produce notes that can be sent to colleagues directly.
Requirements: English, Markdown; the first line must be "# <a title of at most 12 words>"; dense with information, keeping names, numbers, dates, product names and conclusions;
do not invent content that is not in the transcript; if a section has no information, write "Not mentioned". Structure:

# Title
> Recorded: {time} · Duration: {duration} · Source: screen recording

## Overview
3–5 sentences on what the meeting was, what was discussed and the outcome.

## Key conclusions
- 3–6 of the most important conclusions

## Walkthrough (with timestamps)
Group into 3–6 topic sections, each with a start–end timestamp, followed by 1–3 sentences.

## Action items
| Item | Owner | Due |
|---|---|---|
(if none, write a single row "Not mentioned")

## Risks / open questions
- If none, write "None"

Note: do not repeat the transcript paragraph by paragraph and do not paste the raw transcript into the notes.`;
  }
  return `你是一名资深的中文会议纪要专家。请根据一场线上会议（录屏）的完整转写，输出一份可以直接发给同事的会议纪要。
要求：简体中文，Markdown；第一行必须是 "# 一句不超过 20 字的会议标题"；信息密度高，保留所有人名、数字、日期、产品名、结论；
不要编造转写里没有的内容；如果某部分没有信息就写"未提及"。结构如下：

# 标题
> 录制时间：{时间} · 时长：{时长} · 来源：屏幕录制

## 会议概览
3~5 句话说明这是什么会、讨论了什么、结果如何。

## 关键结论
- 3~6 条最重要的结论

## 内容脉络（带时间戳）
按主题分 3~6 个小节，每个小节标题后给出起止时间戳，再用 1~3 句话概括。

## 待办事项
| 事项 | 负责人 | 截止时间 |
|---|---|---|
（没有就写一行"未提及"）

## 风险与待确认
- 没有就写"暂无"

注意：不要逐段复述转写，也不要把逐字稿原文附在纪要里。`;
}

async function finalSummary(session, locale = uiLocale()) {
  const transcript = fullTranscript(session);
  const duration = session.durationSec || 0;
  const when = new Date(session.createdAt).toLocaleString(locale);
  const head = L(
    `录制时间：${when}\n时长：${fmtTime(duration)}\n\n【完整转写】\n`,
    `Recorded: ${when}\nDuration: ${fmtTime(duration)}\n\nFull transcript:\n`,
    locale,
  );

  // 太长的会议先分段压缩，避免超出上下文
  if (transcript.length > 60000) {
    const parts = [];
    const lines = transcript.split('\n');
    let buf = [];
    let len = 0;
    for (const line of lines) {
      buf.push(line);
      len += line.length;
      if (len > 20000) { parts.push(buf.join('\n')); buf = []; len = 0; }
    }
    if (buf.length) parts.push(buf.join('\n'));
    const briefs = [];
    for (let i = 0; i < parts.length; i++) {
      const b = await chat([
        {
          role: 'system',
          content: L(
            '你是会议速记员。把下面这段转写压缩成 400 字以内的要点，保留数字、人名、结论、待办。只输出要点。',
            'You are a meeting note-taker. Compress the transcript below into bullet points under 400 words, keeping numbers, names, conclusions and action items. Output only the bullets.',
            locale,
          ),
        },
        { role: 'user', content: parts[i] },
      ], { maxTokens: 800, temperature: 0.2 });
      briefs.push(L(`【第 ${i + 1} 段要点】\n${b.trim()}`, `Section ${i + 1} summary\n${b.trim()}`, locale));
    }
    return (await chat([
      { role: 'system', content: finalSystem(locale) },
      {
        role: 'user',
        content: head + L('（转写过长，以下为分段要点）', '(Transcript too long; section summaries below)', locale) + `\n\n${briefs.join('\n\n')}`,
      },
    ], { maxTokens: 2500, temperature: 0.25, timeoutMs: 180000 })).trim();
  }

  return (await chat([
    {
      role: 'system',
      content: finalSystem(locale)
        .replace('{time}', when)
        .replace('{duration}', fmtTime(duration)),
    },
    { role: 'user', content: head + transcript },
  ], { maxTokens: 2500, temperature: 0.25, timeoutMs: 180000 })).trim();
}

/** 大模型不可用时的兜底纪要：保证 summary.md 一定存在，链接不会 404。 */
function fallbackSummary(session, reason, locale = uiLocale()) {
  const untitled = L('未命名录制', 'Untitled recording', locale);
  const first = session.segments[0]?.text || untitled;
  const title = first.replace(/[，。！？、,.!?\s]+/g, ' ').trim().slice(0, 20) || untitled;
  const when = new Date(session.createdAt).toLocaleString(locale);
  const lines = [
    `# ${title}`,
    '',
    L(
      `> 录制时间：${when} · 时长：${fmtTime(session.durationSec)} · 来源：屏幕录制`,
      `> Recorded: ${when} · Duration: ${fmtTime(session.durationSec)} · Source: screen recording`,
      locale,
    ),
    '',
  ];
  if (reason) {
    lines.push(L(`> ⚠️ AI 纪要生成失败：${reason}`, `> ⚠️ AI notes failed: ${reason}`, locale));
    lines.push(L(
      '> 下面是本地自动整理的要点。网络恢复后，可在结果页点「重新生成纪要」。',
      '> The local extract below is a fallback. Click "Regenerate notes" once the network is back.',
      locale,
    ));
    lines.push('');
  }
  lines.push(L('## 关键内容（自动摘录）', '## Key content (auto extract)', locale));
  for (const s of session.segments) lines.push(`- **[${fmtTime(s.start)}]** ${s.text}`);
  lines.push('');
  lines.push(L('## 说明', '## Notes', locale));
  lines.push(L(
    `- 共识别 ${session.segments.length} 句、${session.segments.reduce((n, x) => n + x.text.length, 0)} 字。`,
    `- ${session.segments.length} segments, ${session.segments.reduce((n, x) => n + x.text.length, 0)} characters.`,
    locale,
  ));
  lines.push(L('- 完整逐字稿见同目录的 transcript.md。', '- Full transcript: transcript.md in the same folder.', locale));
  return lines.join('\n');
}

async function logError(message) {
  try {
    await mkdir(join(__dirname, 'logs'), { recursive: true });
    await appendFile(join(__dirname, 'logs', 'server.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch { }
}

// ---------------------------------------------------------------- 收尾

async function concatChunks(session) {
  const chunkDir = join(session.dir, 'chunks');
  if (!existsSync(chunkDir)) return null;
  const files = (await readdir(chunkDir)).filter((f) => /\.(webm|mp4)$/i.test(f)).sort();
  if (!files.length) return null;
  const ext = files[0].toLowerCase().endsWith('.mp4') ? '.mp4' : '.webm';
  const raw = join(session.dir, `recording.raw${ext}`);
  const out = createWriteStream(raw);
  for (const f of files) {
    const buf = await readFile(join(chunkDir, f));
    if (!out.write(buf)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  return raw;
}

function ffmpegExe() {
  const local = join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return existsSync(local) ? local : 'ffmpeg';
}

function runProcess(exe, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let done = false;
    const p = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { if (!done) { try { p.kill(); } catch { } } }, timeoutMs);
    p.on('error', () => { done = true; clearTimeout(timer); resolve(false); });
    p.on('exit', (code) => {
      if (done) return;
      done = true; clearTimeout(timer); resolve(code === 0);
    });
  });
}

/** 网页录出来的 webm 往往没写时长，ffmpeg 无损重封装一次就能正常拖动进度条；mp4 也顺手整理。 */
async function remuxForPlayback(rawPath) {
  const ext = extname(rawPath).toLowerCase();
  const out = join(dirname(rawPath), `recording${ext}`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', rawPath, '-c', 'copy'];
  if (ext === '.mp4') args.push('-movflags', '+faststart');
  args.push(out);
  const ok = await runProcess(ffmpegExe(), args, 180000);
  if (ok && existsSync(out)) {
    try { await rm(rawPath); } catch { }
    return out;
  }
  // ffmpeg 不可用：直接把原始文件当成成品
  const fallback = join(dirname(rawPath), `recording${ext}`);
  try { await rm(fallback, { force: true }); await rename(rawPath, fallback); return fallback; } catch { return rawPath; }
}

async function makePoster(videoPath) {
  const out = join(dirname(videoPath), 'poster.jpg');
  for (const ss of ['1', '0']) {
    const ok = await runProcess(ffmpegExe(), ['-y', '-hide_banner', '-loglevel', 'error', '-ss', ss, '-i', videoPath, '-frames:v', '1', '-q:v', '4', out], 60000);
    if (ok && existsSync(out)) return out;
  }
  return null;
}

async function finalize(session, { skipSummary = false } = {}) {
  if (session.finalizing) return;
  session.finalizing = true;
  session.status = 'processing';
  sseSend(session, { type: 'status', status: 'processing', message: '正在合并录像并生成会议纪要…' });

  try {
    // 1) 让识别进程把最后一句吐出来
    if (session.asr) {
      session.asrFlushed = false;
      try { session.asr.send({ type: 'flush' }); } catch { }
      const deadline = Date.now() + 45000;
      while (!session.asrFlushed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
      try { session.asr.send({ type: 'close' }); } catch { }
      setTimeout(() => { try { session.asr?.kill(); } catch { } }, 3000);
    }

    // 2) 合并分片，并用 ffmpeg 重封装（修正网页录像缺少时长、无法拖动的问题）
    const raw = await concatChunks(session);
    let video = null;
    let poster = null;
    if (raw) {
      video = await remuxForPlayback(raw);
      poster = await makePoster(video);
    }

    // 3) 逐字稿
    const locale = uiLocale();
    const transcriptMd = buildTranscriptMd(session, locale);
    await writeFile(join(session.dir, 'transcript.md'), transcriptMd, 'utf8');

    // 4) 最终纪要（skipSummary：只保存录像+逐字稿，不调用 AI）
    let summary = session.summary;
    let summaryError = '';
    if (!skipSummary && session.segments.length >= 1) {
      sseSend(session, { type: 'status', status: 'processing', message: L('正在生成完整会议纪要…', 'Writing the final notes…', locale) });
      try {
        summary = await finalSummary(session, locale);
      } catch (err) {
        summaryError = String(err && err.message || err);
        console.error('[summary]', session.id, summaryError);
        await logError(`summary ${session.id}: ${summaryError}`);
        sseSend(session, {
          type: 'error',
          message: L(
            `完整纪要生成失败：${summaryError}${summary ? '（已保留实时纪要）' : '（已生成基础纪要，可稍后重新生成）'}`,
            `Final notes failed: ${summaryError}${summary ? ' (live notes kept)' : ' (a local fallback was written; you can retry later)'}`,
            locale,
          ),
        });
      }
    }
    if (!skipSummary && !summary) summary = fallbackSummary(session, summaryError, locale);
    if (summary) await writeFile(join(session.dir, 'summary.md'), summary + '\n', 'utf8');

    const titleMatch = summary.match(/^#\s+(.+)$/m);
    if (titleMatch) session.title = titleMatch[1].trim();

    const meta = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      durationSec: session.durationSec,
      segments: session.segments.length,
      chars: session.segments.reduce((n, s) => n + s.text.length, 0),
      video: video ? video.split(/[\\/]/).pop() : null,
      poster: poster ? poster.split(/[\\/]/).pop() : null,
      summary: summary || '',
      summaryError,
      skippedSummary: Boolean(skipSummary),
      transcript: transcriptMd,
    };
    await writeFile(join(session.dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    session.status = 'done';
    session.result = {
      id: session.id,
      title: session.title,
      durationSec: session.durationSec,
      video: video ? `/api/session/${session.id}/file/${encodeURIComponent(video.split(/[\\/]/).pop())}` : null,
      poster: poster ? `/api/session/${session.id}/file/${encodeURIComponent(poster.split(/[\\/]/).pop())}` : null,
      transcript: `/api/session/${session.id}/file/transcript.md`,
      summary: summary ? `/api/session/${session.id}/file/summary.md` : null,
      folder: session.dir,
      segments: session.segments.length,
      summaryAi: !skipSummary && !summaryError,
      summaryError,
      skippedSummary: Boolean(skipSummary),
    };
    sseSend(session, { type: 'done', result: session.result, summary });
    console.log(`[done] ${session.id} ${session.title || ''} (${fmtTime(session.durationSec)})`);
  } catch (err) {
    console.error('[finalize]', err);
    session.status = 'error';
    sseSend(session, { type: 'error', message: `收尾失败：${err.message}` });
    sseSend(session, { type: 'status', status: 'error', message: err.message });
  } finally {
    session.finalizing = false;
  }
}

function buildTranscriptMd(session, locale = uiLocale()) {
  const en = locale === 'en';
  const lines = [];
  lines.push(en ? `# Transcript · ${session.id}` : `# 逐字稿 · ${session.id}`);
  lines.push('');
  lines.push((en ? '- Recorded: ' : '- 录制时间：') + new Date(session.createdAt).toLocaleString(locale));
  lines.push((en ? '- Duration: ' : '- 时长：') + fmtTime(session.durationSec));
  lines.push(en ? '- Engine: SenseVoiceSmall (local, offline)' : '- 识别引擎：SenseVoiceSmall（本地离线）');
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const s of session.segments) {
    lines.push(`**${fmtTime(s.start)}**  ${s.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

function parseTimecode(t) {
  const p = String(t).split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

/** 服务器重启后，从磁盘上的 transcript.md 还原一份会话，用来重新生成纪要。 */
async function loadSessionFromDisk(id) {
  const dir = findSessionDir(id);
  if (!existsSync(dir)) return null;
  const tp = join(dir, 'transcript.md');
  if (!existsSync(tp)) return null;
  const md = await readFile(tp, 'utf8');
  const segments = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\*\*([\d:]+)\*\*\s+(.+)$/);
    if (m) segments.push({ start: parseTimecode(m[1]), end: 0, text: m[2].trim() });
  }
  let meta = {};
  try { meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')); } catch { }
  return {
    id,
    dir,
    createdAt: meta.createdAt || new Date().toISOString(),
    durationSec: meta.durationSec || (segments.length ? segments[segments.length - 1].start : 0),
    segments,
    summary: meta.summary || '',
    title: meta.title || '',
    status: 'done',
  };
}

async function regenerateSummary(id, locale = uiLocale()) {
  const session = sessions.get(id) || (await loadSessionFromDisk(id));
  if (!session || !session.segments.length) return null;
  const summary = await finalSummary(session, locale);
  await writeFile(join(session.dir, 'summary.md'), summary + '\n', 'utf8');
  const title = (summary.match(/^#\s+(.+)$/m) || [])[1]?.trim() || session.title || '';
  session.summary = summary;
  session.title = title;
  try {
    const metaPath = join(session.dir, 'meta.json');
    if (existsSync(metaPath)) {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      meta.summary = summary;
      meta.title = title;
      meta.summaryError = '';
      await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
  } catch { }
  return { summary, title };
}

// ---------------------------------------------------------------- 路由

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveStatic(res, filePath) {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': st.size,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, ...
  const method = req.method;

  if (parts[1] === 'config' && method === 'GET') {
    return json(res, 200, {
      version: '1.6.0',
      llm: publicLlmStatus(),
      recordings: recordingsRoot(),
      recordingsDefault: DEFAULT_RECORDINGS,
      locale: readConfigFile().locale || '',
    });
  }

  if (parts[1] === 'config' && parts[2] === 'import-dsh' && method === 'POST') {
    try {
      importKeyFromDsh();
      return json(res, 200, { ok: true, llm: publicLlmStatus() });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) });
    }
  }

  if (parts[1] === 'config' && parts[2] === 'test' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const out = await testLlm(body);
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) });
    }
  }

  if (parts[1] === 'config' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');

      // 界面语言：中文 / 英文，同时决定纪要语言
      if (body.locale === 'en' || body.locale === 'zh-CN') {
        writeConfigFile({ ...readConfigFile(), locale: body.locale });
      }

      // 保存位置：验证/创建目录，并把旧目录记下来，保证历史列表不丢
      if (typeof body.recordingsDir === 'string' && body.recordingsDir.trim()) {
        const target = resolve(body.recordingsDir.trim());
        try {
          await mkdir(target, { recursive: true });
          await stat(target);
        } catch (err) {
          return json(res, 400, { error: `无法使用这个目录（${target}）：${err.message}` });
        }
        const cur = readConfigFile();
        const previous = recordingsRoot();
        const list = [...(Array.isArray(cur.recordingsDirs) ? cur.recordingsDirs : []), previous];
        const dedup = [];
        const seen = new Set();
        for (const d of list) {
          if (!d) continue;
          const key = String(d).toLowerCase();
          if (key === target.toLowerCase() || seen.has(key)) continue;
          seen.add(key);
          dedup.push(d);
        }
        writeConfigFile({ ...cur, recordingsDir: target, recordingsDirs: dedup });
      }

      saveConfig(body);
      return json(res, 200, {
        ok: true,
        llm: publicLlmStatus(),
        recordings: recordingsRoot(),
      });
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    }
  }

  if (parts[1] === 'sessions' && method === 'GET') {
    const roots = knownRecordingRoots();
    const entries = [];
    for (const root of roots) {
      let names = [];
      try {
        names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch { }
      for (const name of names) entries.push({ id: name, root });
    }
    const seen = new Set();
    const list = [];
    for (const { id, root } of entries) {
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const meta = JSON.parse(await readFile(join(root, id, 'meta.json'), 'utf8'));
        const hasSummary = existsSync(join(root, id, 'summary.md'));
        list.push({
          id, title: meta.title || id, createdAt: meta.createdAt, durationSec: meta.durationSec,
          hasVideo: Boolean(meta.video), segments: meta.segments, hasSummary, folder: join(root, id),
          video: meta.video ? `/api/session/${id}/file/${encodeURIComponent(meta.video)}` : null,
          summary: hasSummary ? `/api/session/${id}/file/summary.md` : null,
          transcript: `/api/session/${id}/file/transcript.md`,
        });
      } catch {
        // 没有 meta.json 说明没正常收尾，看看有没有分片
        const chunks = join(root, id, 'chunks');
        let has = false;
        try { has = existsSync(chunks) && (await readdir(chunks)).length > 0; } catch { }
        if (has) list.push({ id, title: `${id}（未正常结束）`, unfinished: true, createdAt: null, durationSec: 0, segments: 0, folder: join(root, id) });
      }
    }
    list.sort((a, b) => String(b.id).localeCompare(String(a.id)));
    return json(res, 200, { sessions: list.slice(0, 100), dirs: roots });
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'start' && method === 'POST') {
    const session = createSession();
    await mkdir(join(session.dir, 'chunks'), { recursive: true });
    spawnAsr(session);
    return json(res, 200, { id: session.id, dir: session.dir });
  }

  const session = parts[1] === 'session' && parts[2] ? sessions.get(parts[2]) : null;

  if (parts[1] === 'session' && parts[2] && parts[3] === 'chunk' && method === 'POST') {
    if (!session) return json(res, 404, { error: '会话不存在' });
    const seq = Number(url.searchParams.get('seq') || 0);
    const ext = url.searchParams.get('ext') === 'mp4' ? 'mp4' : 'webm';
    const body = await readBody(req);
    if (!body.length) return json(res, 200, { ok: true, seq });
    const name = String(seq).padStart(6, '0') + '.' + ext;
    await writeFile(join(session.dir, 'chunks', name), body);
    session.chunks = Math.max(session.chunks, seq);
    session.lastActivity = Date.now();
    return json(res, 200, { ok: true, seq, bytes: body.length });
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'audio' && method === 'POST') {
    if (!session) return json(res, 404, { error: '会话不存在' });
    const body = await readBody(req);
    if (session.asr && body.length >= 2) {
      session.audioBytes += body.length;
      if (process.env.SAVE_AUDIO === '1') {
        await appendFile(join(session.dir, 'audio.pcm'), body).catch(() => { });
      }
      try { session.asr.send({ type: 'pcm', data: body }); } catch { }
    }
    return json(res, 200, { ok: true, bytes: body.length });
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'tick' && method === 'POST') {
    if (!session) return json(res, 404, { error: '会话不存在' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (typeof body.durationSec === 'number') session.durationSec = body.durationSec;
    session.lastActivity = Date.now();
    return json(res, 200, { ok: true });
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'finish' && method === 'POST') {
    if (!session) return json(res, 404, { error: '会话不存在' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (typeof body.durationSec === 'number') session.durationSec = body.durationSec;
    finalize(session, { skipSummary: Boolean(body.skipSummary) });
    return json(res, 202, { ok: true });
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'abort' && method === 'POST') {
    if (!session) return json(res, 200, { ok: true });
    session.aborted = true;
    try { session.asr?.kill(); } catch { }
    for (const client of session.clients) { try { client.end(); } catch { } }
    session.clients.clear();
    sessions.delete(session.id);
    try { await rm(session.dir, { recursive: true, force: true }); } catch { }
    console.log(`[abort] ${session.id} 已丢弃`);
    return json(res, 200, { ok: true });
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'events' && method === 'GET') {
    if (!session) return json(res, 404, { error: '会话不存在' });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({
      type: 'snapshot',
      status: session.status,
      segments: session.segments,
      summary: session.summary,
      result: session.result || null,
      durationSec: session.durationSec,
    })}\n\n`);
    session.clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
    req.on('close', () => { clearInterval(ping); session.clients.delete(res); });
    return;
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'ask' && method === 'POST') {
    if (!session) return json(res, 404, { error: '会话不存在' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const question = String(body.question || '').trim().slice(0, 2000);
    if (!question) return json(res, 400, { error: '问题为空' });
    const locale = body.locale === 'en' ? 'en' : 'zh-CN';

    const recent = session.segments.slice(-80).map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
    const sys = locale === 'en'
      ? `You are the AI assistant for this recorded meeting. You get the notes so far and the recent transcript. Answer in English.
Rules:
- Ground your answer in the notes and transcript, and cite timestamps like "around 12:30".
- If the transcript does not cover it, say "The recording so far does not mention that", then you may add a guess marked "(guess)".
- Be concise; prefer bullets; do not restate the question.`
      : `你是这场线上会议的 AI 助手。下面是会议到目前为止的纪要和转写。请用简体中文回答用户的问题。
规则：
- 优先依据纪要和转写回答；引用内容时带上时间戳，例如"在 12:30 左右"。
- 如果转写里没有相关信息，直接说"目前录到的内容里没有提到"，可以再给出你的推测，但要标注"（推测）"。
- 回答简洁，能用要点就用要点，不要重复问题。`;
    const user = locale === 'en'
      ? `Meeting notes\n${session.summary || '(not generated yet; answer from the transcript)'}\n\nRecent transcript\n${recent || '(no speech recognized yet)'}\n\nQuestion: ${question}`
      : `【会议纪要】\n${session.summary || '（还没有生成，请依据转写回答）'}\n\n【最近转写】\n${recent || '（还没有识别到语音）'}\n\n【问题】${question}`;

    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    try {
      const answer = await chatStream([
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], (delta) => { res.write(delta); }, { maxTokens: 1200, temperature: 0.3 });
      session.qa.push({ q: question, a: answer, at: new Date().toISOString() });
      res.end();
    } catch (err) {
      res.write(locale === 'en' ? `\n[Answer failed] ${err.message}` : `\n[回答失败] ${err.message}`);
      res.end();
    }
    return;
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'summary' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const locale = body.locale === 'en' ? 'en' : body.locale === 'zh-CN' ? 'zh-CN' : undefined;
      const out = await regenerateSummary(parts[2], locale);
      if (!out) return json(res, 400, { error: '这条录制没有逐字稿，无法生成纪要' });
      if (session) sseSend(session, { type: 'summary', summary: out.summary });
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      await logError(`regenerate ${parts[2]}: ${err.message}`);
      return json(res, 500, { error: String(err.message || err) });
    }
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'state' && method === 'GET') {
    if (!session) return json(res, 404, { error: '会话不存在' });
    return json(res, 200, {
      id: session.id,
      status: session.status,
      durationSec: session.durationSec,
      segments: session.segments,
      summary: session.summary,
      result: session.result || null,
      audioBytes: session.audioBytes,
      asrReady: session.asrReady,
    });
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'open' && method === 'POST') {
    const dir = session ? session.dir : findSessionDir(parts[2]);
    try {
      spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true, dir });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (parts[1] === 'open-recordings' && method === 'POST') {
    spawn('explorer', [recordingsRoot()], { detached: true, stdio: 'ignore' }).unref();
    return json(res, 200, { ok: true });
  }

  if (parts[1] === 'session' && parts[2] && parts[3] === 'file' && method === 'GET') {
    const name = decodeURIComponent(parts[4] || '');
    if (!/^[\w.\-\u4e00-\u9fa5]+$/.test(name)) return json(res, 400, { error: 'bad name' });
    return serveStatic(res, join(findSessionDir(parts[2]), name));
  }

  return json(res, 404, { error: '未知接口' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = normalize(p).replace(/^(\.\.[/\\])+/, '');
    return await serveStatic(res, join(PUBLIC, p));
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

/**
 * 启动本地服务。浏览器模式直接调用；Electron 桌面版也复用它（in-process）。
 * 端口被占用时自动 +1，最多试 10 个。
 */
export function startServer({ port = PORT, open = process.env.NO_OPEN !== '1' } = {}) {
  return new Promise((resolve, reject) => {
    let activePort = port;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      console.error('启动失败：', err.message);
      reject(err);
    };

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && activePort - port < 10) {
        activePort += 1;
        setTimeout(() => server.listen(activePort, '127.0.0.1'), 120);
        return;
      }
      fail(err);
    });

    server.listen(port, '127.0.0.1', () => {
      const cfg = llmConfig();
      console.log('');
      console.log('  ----------------------------------------------');
      console.log('   录屏助手 已启动');
      console.log('  ----------------------------------------------');
      console.log(`   地址： http://127.0.0.1:${activePort}`);
      console.log(`   录像： ${recordingsRoot()}`);
      console.log(`   模型： ${cfg.model} @ ${cfg.baseUrl}  ${cfg.apiKey ? '（已读取到密钥）' : '（未找到密钥！）'}`);
      console.log('');
      if (open) {
        try {
          spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${activePort}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } catch { }
      }
      if (!settled) {
        settled = true;
        resolve({
          port: activePort,
          recordings: recordingsRoot(),
          server,
          close: () => new Promise((r) => server.close(r)),
        });
      }
    });
  });
}

/** 停掉所有语音识别子进程（Electron 退出时用）。 */
export function stopAllAsr() {
  for (const s of sessions.values()) {
    try { s.asr?.kill(); } catch { }
  }
}

// 直接 `node server.mjs` 运行时才自动启动；被 Electron import 时由主进程控制
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch(() => process.exit(1));
  process.on('SIGINT', () => { stopAllAsr(); process.exit(0); });
}
