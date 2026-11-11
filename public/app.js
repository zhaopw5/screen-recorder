/* 录屏助手前端：屏幕 + 系统声音采集，本地转写，AI 纪要 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const IS_DESKTOP = /Electron/i.test(navigator.userAgent);

const QUALITY = {
  high: { w: 1920, h: 1080, fps: 30, bps: 5_000_000 },
  std: { w: 1920, h: 1080, fps: 15, bps: 3_000_000 },
  lite: { w: 1280, h: 720, fps: 15, bps: 1_600_000 },
};

const state = {
  sessionId: null,
  recording: false,
  paused: false,
  displayStream: null,
  micStream: null,
  ctx: null,
  tap: null,
  recorder: null,
  ext: 'webm',
  mime: '',
  startedAt: 0,
  pausedTotal: 0,
  pausedAt: 0,
  timerId: null,
  sse: null,
  chunkSeq: 0,
  chunkQueue: [],
  uploading: false,
  audioQueue: [],
  audioBusy: false,
  audioChain: Promise.resolve(),
  audioInflight: 0,
  segCount: 0,
  lastLevelAt: 0,
  ending: false,
  resultShown: false,
};

// ------------------------------------------------------------------ 初始化

init();

async function init() {
  bindUI();
  restoreOptions();
  window.__rec = state; // 方便调试/自动化
  if (IS_DESKTOP) applyDesktopCopy();

  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    applyLlmBadge(cfg.llm);
    state.recordingsDir = cfg.recordings;
  } catch {
    $('#llmBadge').textContent = '服务未连接';
    $('#llmBadge').className = 'badge badge-bad';
  }
}

function applyLlmBadge(llm) {
  const badge = $('#llmBadge');
  badge.style.cursor = 'pointer';
  if (!llm) {
    badge.textContent = '服务未连接';
    badge.className = 'badge badge-bad';
    return;
  }
  if (llm.ready) {
    const src = llm.source === 'dsh' ? 'DSH 密钥' : llm.source === 'config' ? '本机配置' : llm.source === 'env' ? '环境变量' : '';
    badge.textContent = `AI 就绪 · ${llm.model}${src ? ' · ' + src : ''}`;
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = 'AI 未配置密钥 · 点此设置';
    badge.className = 'badge badge-bad';
  }
}

function bindUI() {
  $('#btnStart').addEventListener('click', startRecording);
  $('#btnPause').addEventListener('click', togglePause);
  $('#btnStop').addEventListener('click', () => stopRecording('手动结束'));
  $('#btnHistory').addEventListener('click', showHistory);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#llmBadge').addEventListener('click', openSettings);
  $('#optQuality').addEventListener('change', saveOptions);
  $('#optMic').addEventListener('change', saveOptions);

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#askInput').value.trim();
    if (q) { $('#askInput').value = ''; ask(q); }
  });
  $('#askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#askForm').requestSubmit();
    }
  });

  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  $('#modalCard').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-regen]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const r = await fetch(`/api/session/${btn.dataset.regen}/summary`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      btn.textContent = '已生成';
      toast('纪要已生成', 'ok');
      setTimeout(() => showHistory(), 500);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '生成纪要';
      toast('生成失败：' + (err.message || err), 'err');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.recording) { e.preventDefault(); e.returnValue = ''; }
  });
}

function restoreOptions() {
  try {
    const q = localStorage.getItem('rec.quality');
    if (q && QUALITY[q]) $('#optQuality').value = q;
    const mic = localStorage.getItem('rec.mic');
    if (mic !== null) $('#optMic').checked = mic === '1';
  } catch { }
}
function saveOptions() {
  try {
    localStorage.setItem('rec.quality', $('#optQuality').value);
    localStorage.setItem('rec.mic', $('#optMic').checked ? '1' : '0');
  } catch { }
}

// ------------------------------------------------------------------ 录制

async function startRecording() {
  if (state.recording || state.ending) return;
  const q = QUALITY[$('#optQuality').value] || QUALITY.std;
  const wantMic = $('#optMic').checked;
  state.resultShown = false;
  closeModal();

  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: q.fps, max: q.fps },
        width: { ideal: q.w },
        height: { ideal: q.h },
        displaySurface: 'monitor',
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
      },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
      preferCurrentTab: false,
    });
  } catch (err) {
    toast('没有拿到屏幕共享：' + (err.message || err), 'err');
    return;
  }

  const sysTracks = display.getAudioTracks();
  if (!sysTracks.length) {
    display.getTracks().forEach((t) => t.stop());
    showNoAudioHelp();
    return;
  }

  state.displayStream = display;

  // 麦克风（可选）
  if (wantMic) {
    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      state.micStream = null;
      toast('没有拿到麦克风权限，这次只录系统声音', 'err');
    }
  } else {
    state.micStream = null;
  }

  // 服务端会话
  try {
    const r = await fetch('/api/session/new/start', { method: 'POST' });
    const j = await r.json();
    state.sessionId = j.id;
  } catch (err) {
    cleanupMedia();
    toast('无法创建录制会话：' + (err.message || err), 'err');
    return;
  }

  resetPanels();
  openEvents();

  // 音频图：系统声音 + 麦克风 → 录制音轨 / 16k PCM
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  const sysGain = ctx.createGain();
  sysGain.gain.value = 1;
  ctx.createMediaStreamSource(display).connect(sysGain);
  sysGain.connect(dest);

  let micGain = null;
  if (state.micStream) {
    micGain = ctx.createGain();
    micGain.gain.value = 1;
    ctx.createMediaStreamSource(state.micStream).connect(micGain);
    micGain.connect(dest);
  }

  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const tap = new AudioWorkletNode(ctx, 'pcm-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetRate: 16000 },
  });
  sysGain.connect(tap);
  if (micGain) micGain.connect(tap);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  tap.connect(sink).connect(ctx.destination);
  tap.port.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'pcm') sendPcm(d.pcm);
    else if (d.type === 'level') updateLevel(d.rms);
    else if (d.type === 'info') state.workletInfo = d;
  };
  state.ctx = ctx;
  state.tap = tap;

  // 录制：优先 MP4（H.264 硬编码 + 时长/进度条正常），不支持再退回 WebM
  const pick = pickMime();
  const mixed = new MediaStream([display.getVideoTracks()[0], dest.stream.getAudioTracks()[0]]);
  let rec;
  try {
    rec = new MediaRecorder(mixed, {
      mimeType: pick.mime || undefined,
      videoBitsPerSecond: q.bps,
      audioBitsPerSecond: 128000,
    });
    state.ext = pick.ext;
  } catch {
    rec = new MediaRecorder(mixed, { videoBitsPerSecond: q.bps });
    state.ext = 'webm';
  }
  state.mime = pick.mime;
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) enqueueChunk(e.data);
  };
  rec.onerror = (e) => toast('录制器出错：' + (e.error?.message || e), 'err');

  display.getVideoTracks()[0].addEventListener('ended', () => {
    if (state.recording) stopRecording('屏幕共享已停止');
  });

  state.recorder = rec;
  rec.start(4000);

  state.recording = true;
  state.paused = false;
  state.ending = false;
  state.startedAt = Date.now();
  state.pausedTotal = 0;
  state.segCount = 0;
  state.lastLevelAt = Date.now();

  $('#preview').srcObject = display;
  $('#preview').classList.add('on');
  $('#preview').play().catch(() => { });
  $('#placeholder').classList.add('hide');
  $('#recBadge').hidden = false;
  $('#screenFlags').hidden = false;
  $('#flagSys').className = 'flag on';
  $('#flagMic').className = 'flag ' + (state.micStream ? 'on' : 'off');
  $('#flagMic').textContent = state.micStream ? '麦克风' : '仅系统声音';
  $('#btnStart').disabled = true;
  $('#btnPause').disabled = false;
  $('#btnStop').disabled = false;
  $('#optQuality').disabled = true;
  $('#optMic').disabled = true;
  $('#hint').textContent = '正在录制：本页面请保持打开。可以在右侧「提问」里随时问 AI。';
  $('#statusText').textContent = '正在录制';
  startTimer();
  watchSilence();
  toast('开始录制，正在加载本地语音识别模型…', 'ok');
}

function pickMime() {
  const list = [
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=h264,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  for (const c of list) {
    try { if (MediaRecorder.isTypeSupported(c.mime)) return c; } catch { }
  }
  return { mime: '', ext: 'webm' };
}

function startTimer() {
  clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    $('#timer').textContent = fmt(activeSeconds());
  }, 500);
}

function activeSeconds() {
  if (!state.startedAt) return 0;
  const now = state.paused ? state.pausedAt : Date.now();
  return Math.max(0, (now - state.startedAt - state.pausedTotal) / 1000);
}

function togglePause() {
  if (!state.recording) return;
  const rec = state.recorder;
  if (!state.paused) {
    try { rec.pause(); } catch { }
    state.paused = true;
    state.pausedAt = Date.now();
    $('#btnPause').textContent = '继续';
    $('#pauseVeil').hidden = false;
    $('#statusText').textContent = '已暂停';
  } else {
    try { rec.resume(); } catch { }
    state.pausedTotal += Date.now() - state.pausedAt;
    state.paused = false;
    $('#btnPause').textContent = '暂停';
    $('#pauseVeil').hidden = true;
    $('#statusText').textContent = '正在录制';
  }
}

async function stopRecording(reason) {
  if (!state.recording || state.ending) return;
  state.ending = true;
  state.recording = false;
  clearInterval(state.timerId);
  $('#btnStop').disabled = true;
  $('#btnPause').disabled = true;
  $('#statusText').textContent = '正在保存…';
  if (reason) toast(reason, 'ok');

  const durationSec = activeSeconds();

  try {
    const rec = state.recorder;
    const stopped = new Promise((resolve) => {
      const done = () => resolve();
      rec.addEventListener('stop', done, { once: true });
      setTimeout(done, 6000);
    });
    try { rec.stop(); } catch { }
    await stopped;
  } catch { }

  try { state.tap?.port.postMessage('flush'); } catch { }
  await sleep(250);
  await drainAudio();

  cleanupMedia();

  await flushUploads();

  try {
    await fetch(`/api/session/${state.sessionId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ durationSec, reason }),
    });
  } catch (err) {
    toast('提交收尾失败：' + (err.message || err), 'err');
  }

  showProcessing();
  $('#recBadge').hidden = true;
  $('#pauseVeil').hidden = true;
  $('#screenFlags').hidden = true;
  $('#placeholder').classList.remove('hide');
  $('#meterFill').style.width = '0%';
  $('#meterPeak').style.left = '0%';
  $('#meterLabel').textContent = '-∞ dB';
  $('#btnStart').disabled = false;
  $('#btnPause').disabled = true;
  $('#btnStop').disabled = true;
  $('#optQuality').disabled = false;
  $('#optMic').disabled = false;
  $('#hint').textContent = '已停止录制，正在合并录像并生成最终纪要，请稍候…';
}

function cleanupMedia() {
  try { state.displayStream?.getTracks().forEach((t) => t.stop()); } catch { }
  try { state.micStream?.getTracks().forEach((t) => t.stop()); } catch { }
  try { state.ctx?.close(); } catch { }
  state.ctx = null;
  state.tap = null;
  state.recorder = null;
  state.displayStream = null;
  state.micStream = null;
  $('#preview').srcObject = null;
  $('#preview').classList.remove('on');
}

// ------------------------------------------------------------------ 上传

function enqueueChunk(blob) {
  state.chunkQueue.push(blob);
  drainChunks();
}

async function drainChunks() {
  if (state.uploading) return;
  state.uploading = true;
  while (state.chunkQueue.length) {
    const blob = state.chunkQueue[0];
    const seq = state.chunkSeq + 1;
    try {
      const r = await fetch(`/api/session/${state.sessionId}/chunk?seq=${seq}&ext=${state.ext || 'webm'}`, {
        method: 'POST',
        body: blob,
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (!r.ok) throw new Error(await r.text());
      state.chunkSeq = seq;
      state.chunkQueue.shift();
    } catch (err) {
      console.warn('chunk upload failed', err);
      await sleep(1500);
    }
  }
  state.uploading = false;
}

async function flushUploads() {
  const deadline = Date.now() + 60000;
  while ((state.chunkQueue.length || state.uploading) && Date.now() < deadline) {
    await sleep(200);
  }
  if (state.uploading || state.chunkQueue.length) toast('还有分片没传完，文件可能不完整', 'err');
}

function sendPcm(pcm) {
  if (!state.sessionId || !state.recording || state.paused) return;
  // 必须严格按顺序上传，否则 16k PCM 会被打乱，识别结果会变成乱码
  if (state.audioQueue.length > 10) state.audioQueue.shift();
  state.audioQueue.push(pcm);
  pumpAudio();
}

async function pumpAudio() {
  if (state.audioBusy) return;
  state.audioBusy = true;
  while (state.audioQueue.length) {
    const pcm = state.audioQueue.shift();
    try {
      await fetch(`/api/session/${state.sessionId}/audio`, {
        method: 'POST',
        body: pcm,
        headers: { 'content-type': 'application/octet-stream' },
      });
    } catch { }
  }
  state.audioBusy = false;
}

async function drainAudio() {
  const deadline = Date.now() + 8000;
  while ((state.audioQueue.length || state.audioBusy) && Date.now() < deadline) await sleep(100);
}

function updateLevel(rms) {
  const db = rms > 0 ? 20 * Math.log10(rms) : -100;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('#meterFill').style.width = pct + '%';
  if (pct > 1) $('#meterPeak').style.left = pct + '%';
  $('#meterLabel').textContent = db <= -60 ? '-∞ dB' : db.toFixed(0) + ' dB';
  if (db > -45) {
    state.lastLevelAt = Date.now();
    $('#meterTip').textContent = '';
  }
}

function watchSilence() {
  const t = setInterval(() => {
    if (!state.recording) { clearInterval(t); return; }
    if (state.paused) return;
    if (Date.now() - state.lastLevelAt > 9000) {
      $('#meterTip').textContent = '没检测到声音：确认勾选了「系统音频」，并检查会议软件是否静音';
      if (Date.now() - state.lastLevelAt > 15000) state.lastLevelAt = Date.now(); // 别一直刷
    }
  }, 2000);
}

// ------------------------------------------------------------------ SSE

function openEvents() {
  try { state.sse?.close(); } catch { }
  const es = new EventSource(`/api/session/${state.sessionId}/events`);
  state.sse = es;
  es.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    handleEvent(d);
  };
  es.onerror = () => {
    if (state.recording) $('#statusText').textContent = '连接中断，正在重连…';
  };
}

function handleEvent(d) {
  if (d.type === 'snapshot') {
    if (d.segments?.length) {
      clearTranscript();
      d.segments.forEach((s) => appendSegment(s, false));
      state.segCount = d.segments.length;
      $('#segCount').textContent = `${state.segCount} 句`;
    }
    if (d.summary) renderSummary(d.summary);
    if (d.status === 'done' && d.result) showResult(d.result, d.summary);
    return;
  }
  if (d.type === 'segment') {
    appendSegment(d, true);
    state.segCount++;
    $('#segCount').textContent = `${state.segCount} 句`;
    $('#statusText').textContent = state.paused ? '已暂停' : '正在录制';
    return;
  }
  if (d.type === 'summary') {
    renderSummary(d.summary);
    if (d.partial) $('#statusText').textContent = '纪要已更新';
    return;
  }
  if (d.type === 'status') {
    if (d.status === 'processing') {
      $('#statusText').textContent = d.message || '正在生成纪要…';
      showProcessing(d.message);
    }
    if (d.status === 'error') $('#statusText').textContent = '收尾出错';
    return;
  }
  if (d.type === 'done') {
    showResult(d.result, d.summary);
    return;
  }
  if (d.type === 'error') {
    toast(d.message, 'err');
    return;
  }
}

function appendSegment(s, isNew) {
  const wrap = $('#transcript');
  const empty = wrap.querySelector('.empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'seg' + (isNew ? ' new' : '');
  const ts = document.createElement('button');
  ts.className = 'ts';
  ts.textContent = fmt(s.start);
  ts.title = '点击定位到视频这个时间点';
  ts.addEventListener('click', () => seekVideo(s.start));
  const p = document.createElement('p');
  p.textContent = s.text;
  el.append(ts, p);
  wrap.appendChild(el);
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120;
  if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
}

function clearTranscript() {
  $('#transcript').innerHTML = '';
}

function renderSummary(md) {
  $('#summary').innerHTML = renderMarkdown(md);
  const el = $('#summary');
  el.scrollTop = 0;
}

function seekVideo(sec) {
  const v = document.querySelector('#modal video');
  if (v) { v.currentTime = Math.max(0, sec); v.play?.(); }
}

// ------------------------------------------------------------------ 提问

async function ask(question) {
  if (!state.sessionId) {
    toast('先开始录制，AI 才有内容可回答', 'err');
    return;
  }
  const chat = $('#chat');
  chat.querySelector('.empty')?.remove();
  const u = document.createElement('div');
  u.className = 'msg user';
  u.textContent = question;
  chat.appendChild(u);
  chat.scrollTop = chat.scrollHeight;

  const bot = document.createElement('div');
  bot.className = 'msg bot streaming';
  bot.textContent = '';
  chat.appendChild(bot);
  chat.scrollTop = chat.scrollHeight;
  $('#btnAsk').disabled = true;

  try {
    const res = await fetch(`/api/session/${state.sessionId}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bot.textContent += dec.decode(value, { stream: true });
      chat.scrollTop = chat.scrollHeight;
    }
  } catch (err) {
    bot.classList.add('err');
    bot.textContent = '回答失败：' + (err.message || err);
  } finally {
    bot.classList.remove('streaming');
    $('#btnAsk').disabled = false;
    chat.scrollTop = chat.scrollHeight;
  }
}

// ------------------------------------------------------------------ 面板/弹窗

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['transcript', 'summary', 'ask'].forEach((n) => {
    $(`#tab-${n}`).hidden = n !== name;
  });
  if (name === 'ask') $('#askInput').focus();
}

function resetPanels() {
  clearTranscript();
  $('#transcript').innerHTML = '<div class="empty">正在启动本地语音识别…第一句话识别出来后就会出现在这里。</div>';
  $('#summary').innerHTML = '<div class="empty">AI 会边录边整理纪要，大约每 30 秒刷新一次。</div>';
  $('#chat').innerHTML = '<div class="empty">录屏过程中可以随时提问，例如「刚才说的预算是多少？」「总结一下前十分钟」。</div>';
  $('#segCount').textContent = '0 句';
  state.segCount = 0;
  switchTab('transcript');
}

function showProcessing(message = '正在合并录像并生成会议纪要…') {
  const card = $('#modalCard');
  card.innerHTML = `<h2>正在收尾</h2><div class="modal-sub">录像分片已经保存在本机，正在合并并让 AI 写最终纪要。</div>
    <div class="processing"><div class="spinner"></div><span id="procMsg">${esc(message)}</span></div>
    <p class="hint">首次生成长纪要通常需要 20~60 秒，请不要关闭本页面。</p>`;
  openModal();
}

function showResult(result, summary) {
  if (state.resultShown) return;
  state.resultShown = true;
  closeModal();
  const card = $('#modalCard');
  card.innerHTML = `
    <h2>${esc(result.title || '录制完成')}</h2>
    <div class="modal-sub">时长 ${fmt(result.durationSec)} · 识别 ${result.segments} 句 · 文件在 ${esc(result.folder || '')}</div>
    ${result.summaryAi === false ? `<div class="warn-box">⚠️ 这次 AI 纪要没生成成功：${esc(result.summaryError || '未知原因')}<br />下面先用本地自动摘录顶上，可以点「重新生成纪要」再试一次。</div>` : ''}
    ${result.video ? `<video controls src="${result.video}"${result.poster ? ` poster="${result.poster}"` : ''}></video>` : '<p class="hint">没有拿到视频数据（可能录制时间太短）。</p>'}
    <div class="modal-actions">
      ${result.video ? `<a href="${result.video}" download>下载录像</a>` : ''}
      <a href="${result.transcript}" target="_blank">逐字稿 .md</a>
      <a href="${result.summary}" target="_blank">会议纪要 .md</a>
      <button id="btnRegen" class="ghost">重新生成纪要</button>
      <button id="btnOpenFolder" class="ghost">打开文件夹</button>
      <button id="btnCloseModal" class="ghost">关闭</button>
    </div>
    <div class="markdown" id="resultSummary">${renderMarkdown(summary || '')}</div>`;
  openModal();
  $('#btnCloseModal')?.addEventListener('click', closeModal);
  $('#btnOpenFolder')?.addEventListener('click', async () => {
    try { await fetch(`/api/session/${result.id}/open`, { method: 'POST' }); } catch { }
  });
  $('#btnRegen')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const r = await fetch(`/api/session/${result.id}/summary`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      $('#resultSummary').innerHTML = renderMarkdown(j.summary);
      if (j.title) card.querySelector('h2').textContent = j.title;
      card.querySelector('.warn-box')?.remove();
      btn.textContent = '已重新生成';
      toast('纪要已重新生成', 'ok');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '重新生成纪要';
      toast('重新生成失败：' + (err.message || err), 'err');
    }
  });
  $('#statusText').textContent = '已完成';
  $('#hint').textContent = '录制完成。录像、逐字稿、会议纪要都在上面的文件夹里。';
}

function applyDesktopCopy() {
  document.body.classList.add('desktop');
  const ph = document.querySelector('.placeholder');
  if (ph) {
    const h = ph.querySelector('h2');
    const p = ph.querySelector('p');
    if (h) h.textContent = '一键录制屏幕和电脑里的声音';
    if (p) p.innerHTML = '桌面版会自动录制<b>整个屏幕</b>和<b>系统声音</b>：不用选窗口，也不用勾选音频。<br />点下面的「开始录制」就可以了。';
    ph.querySelector('.ph-steps')?.remove();
  }
  $('#hint').textContent = '桌面版：点开始就直接录，保持这个窗口打开即可。戴耳机可以避免回声。';
}

function showNoAudioHelp() {
  const card = $('#modalCard');
  if (IS_DESKTOP) {
    card.innerHTML = `
      <h2>这次没有拿到「系统声音」</h2>
      <div class="modal-sub">桌面版会请求系统环回音频（WASAPI loopback），但这次返回的是空音轨。</div>
      <div class="markdown">
        <p>可以这样排查：</p>
        <ul>
          <li>确认电脑正在出声（会议/视频没有静音，音量不为 0）。</li>
          <li>确认默认输出设备是现在在用的扬声器或耳机，蓝牙耳机没连上时容易出问题。</li>
          <li>点「重新录制」再试一次；还不行就关掉软件重开。</li>
        </ul>
      </div>
      <div class="modal-actions"><button id="btnRetryShare" class="primary">重新录制</button><button id="btnCancelShare" class="ghost">取消</button></div>`;
    openModal();
    $('#btnRetryShare').addEventListener('click', () => { closeModal(); startRecording(); });
    $('#btnCancelShare').addEventListener('click', closeModal);
    return;
  }
  card.innerHTML = `
    <h2>这次没有抓到「系统声音」</h2>
    <div class="modal-sub">你刚才选择的分享方式里不含音频，录出来会没有声音。</div>
    <div class="markdown">
      <p>请按下面步骤重来一次：</p>
      <ul>
        <li>点「重新选择」后，在弹窗顶部选择 <b>整个屏幕</b>（不要选「窗口」或「标签页」）。</li>
        <li>在弹窗左下角，把 <b>「同时分享系统音频」</b> 勾上（Chrome/Edge 里叫「分享系统音频」）。</li>
        <li>再点「分享」。</li>
      </ul>
      <p>如果根本看不到这个勾选项：说明你选的是单个窗口或标签页，换成「整个屏幕」就会出现。</p>
    </div>
    <div class="modal-actions"><button id="btnRetryShare" class="primary">重新选择</button><button id="btnCancelShare" class="ghost">取消</button></div>`;
  openModal();
  $('#btnRetryShare').addEventListener('click', () => { closeModal(); startRecording(); });
  $('#btnCancelShare').addEventListener('click', closeModal);
}

async function showHistory() {
  const card = $('#modalCard');
  card.innerHTML = '<h2>历史录制</h2><div class="modal-sub">全部保存在本机 recordings 目录。</div><div class="processing"><div class="spinner"></div><span>读取中…</span></div>';
  openModal();
  try {
    const r = await fetch('/api/sessions');
    const { sessions } = await r.json();
    if (!sessions.length) {
      card.innerHTML = '<h2>历史录制</h2><div class="modal-sub">还没有录制过。</div><div class="modal-actions"><button class="ghost" id="btnCloseModal">关闭</button></div>';
      $('#btnCloseModal').addEventListener('click', closeModal);
      return;
    }
    const rows = sessions.map((s) => `
      <div class="session-item">
        <div class="meta"><b>${esc(s.title || s.id)}</b><span>${s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN') : ''} ${s.durationSec ? '· ' + fmt(s.durationSec) : ''} ${s.segments ? '· ' + s.segments + ' 句' : ''}</span></div>
        ${s.video ? `<a href="${s.video}" target="_blank">播放</a>` : ''}
        ${s.summary ? `<a href="${s.summary}" target="_blank">纪要</a>` : `<button data-regen="${s.id}">生成纪要</button>`}
        ${s.transcript ? `<a href="${s.transcript}" target="_blank">逐字稿</a>` : ''}
        ${s.unfinished ? '<span class="badge badge-bad">未正常结束</span>' : ''}
      </div>`).join('');
    card.innerHTML = `<h2>历史录制</h2><div class="modal-sub">共 ${sessions.length} 条，全部保存在本机。</div>
      <div class="session-list">${rows}</div>
      <div class="modal-actions"><button class="ghost" id="btnCloseModal">关闭</button></div>`;
    $('#btnCloseModal').addEventListener('click', closeModal);
  } catch (err) {
    card.innerHTML = `<h2>历史录制</h2><div class="modal-sub">读取失败：${esc(err.message || String(err))}</div>`;
  }
}

async function openSettings() {
  let llm = {};
  try { llm = (await (await fetch('/api/config')).json()).llm || {}; } catch { }
  const sourceText = { dsh: 'DeepSeek Harness 凭据', config: '本机配置文件', env: '环境变量', none: '还没配置' }[llm.source] || '未知';
  const card = $('#modalCard');
  card.innerHTML = `
    <h2>AI 设置</h2>
    <div class="modal-sub">只影响「AI 纪要 / 提问」。录屏和本地转写是离线的，不需要任何密钥。</div>
    ${llm.source === 'dsh' ? `<div class="warn-box" style="color:#9fd0ff;background:rgba(76,141,255,.08);border-color:rgba(76,141,255,.35)">当前用的是 DeepSeek Harness 的密钥。以后如果要卸载 DSH，点下面「从 DSH 导入密钥」把它复制到本机配置，卸载后 AI 仍然可用。</div>` : ''}
    <div class="form">
      <label>API Key <span class="dim">当前来源：${esc(sourceText)}${llm.keyHint ? ' · ' + esc(llm.keyHint) : ''}</span></label>
      <input id="setKey" type="password" autocomplete="off" placeholder="留空表示不修改；填 sk-... 会保存到本机" />
      <label>接口地址 <span class="dim">兼容 OpenAI 协议即可，也可以填本地 Ollama，例如 http://127.0.0.1:11434/v1</span></label>
      <input id="setBase" value="${esc(llm.baseUrl || 'https://api.deepseek.com')}" />
      <label>模型名</label>
      <input id="setModel" value="${esc(llm.model || 'deepseek-chat')}" />
    </div>
    <p class="hint">保存位置：${esc(llm.configFile || '')}</p>
    <div id="testResult" class="test-result"></div>
    <div class="modal-actions">
      <button id="btnTestLlm" class="ghost">测试连接</button>
      <button id="btnSaveSettings" class="primary">保存</button>
      ${llm.source === 'dsh' ? '<button id="btnImportDsh" class="ghost">从 DSH 导入密钥</button>' : ''}
      <button id="btnCloseModal" class="ghost">关闭</button>
    </div>`;
  openModal();
  $('#btnCloseModal').addEventListener('click', closeModal);
  $('#btnTestLlm')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = $('#testResult');
    btn.disabled = true;
    btn.textContent = '测试中…';
    out.textContent = '';
    out.className = 'test-result';
    try {
      const r = await fetch('/api/config/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: $('#setKey').value,
          baseUrl: $('#setBase').value,
          model: $('#setModel').value,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      out.textContent = `连接成功 · 模型 ${j.model}`;
      out.className = 'test-result ok';
    } catch (err) {
      out.textContent = '连接失败：' + (err.message || err);
      out.className = 'test-result err';
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  });
  $('#btnImportDsh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const r = await fetch('/api/config/import-dsh', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      applyLlmBadge(j.llm);
      toast('已复制到本机配置，卸载 DSH 也不影响 AI 了', 'ok');
      closeModal();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '从 DSH 导入密钥';
      toast('导入失败：' + (err.message || err), 'err');
    }
  });
  $('#btnSaveSettings').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: $('#setKey').value,
          baseUrl: $('#setBase').value,
          model: $('#setModel').value,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      applyLlmBadge(j.llm);
      toast(j.llm.ready ? '已保存，AI 可以用了' : '已保存，但还没有密钥', j.llm.ready ? 'ok' : 'err');
      closeModal();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '保存';
      toast('保存失败：' + (err.message || err), 'err');
    }
  });
}

function openModal() { $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }

// ------------------------------------------------------------------ 小工具

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? `${String(h).padStart(2, '0')}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return s;
}

function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let inTable = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (let raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); closeTable(); continue; }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (/^[\s:|-]+$/.test(cells.join(''))) continue;
      if (!inTable) {
        closeList();
        out.push(`<table><thead><tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`);
        inTable = true;
      } else {
        out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      continue;
    }
    closeTable();

    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lv = Math.min(4, m[1].length);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line) || /^---+$/.test(line)) {
      closeList(); out.push('<hr />'); continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTable();
  return out.join('\n');
}
