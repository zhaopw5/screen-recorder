/* 录屏助手前端：屏幕 + 系统声音采集，本地转写，AI 纪要 */
import { t, setLocale, getLocale, applyStatic, detectLocale } from './i18n.js';

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
  segCount: 0,
  lastLevelAt: 0,
  ending: false,
  cancelling: false,
  resultShown: false,
  statusKey: 'idle',
  locale: 'zh-CN',
};

// ------------------------------------------------------------------ 初始化

init();

async function init() {
  bindUI();
  restoreOptions();
  window.__rec = state; // 方便调试/自动化

  let saved = null;
  try { saved = localStorage.getItem('rec.locale'); } catch { }
  setLocale(saved || detectLocale());
  state.locale = getLocale();
  if (IS_DESKTOP) applyDesktopCopy();

  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    if (!saved && cfg.locale) setLocale(cfg.locale);
    state.locale = getLocale();
    applyLlmBadge(cfg.llm);
    state.recordingsDir = cfg.recordings;
    refreshTexts();
  } catch {
    $('#llmBadge').textContent = t('badge.disconnected');
    $('#llmBadge').className = 'badge badge-bad';
  }
}

function applyLlmBadge(llm) {
  const badge = $('#llmBadge');
  badge.style.cursor = 'pointer';
  if (!llm) {
    badge.textContent = t('badge.disconnected');
    badge.className = 'badge badge-bad';
    return;
  }
  if (llm.ready) {
    const src = llm.source && llm.source !== 'none' ? ' · ' + t('settings.source.' + llm.source) : '';
    badge.textContent = t('badge.ready', { model: llm.model, src });
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = t('badge.noKey');
    badge.className = 'badge badge-bad';
  }
}

function setStatus(key) {
  state.statusKey = key;
  $('#statusText').textContent = t('status.' + key);
}

function refreshTexts() {
  applyStatic();
  document.title = t('app.docTitle');

  if (state.recording) $('#hint').textContent = t('hint.recording');
  else if (state.ending) $('#hint').textContent = t('hint.stopping');
  else if (state.resultShown) $('#hint').textContent = t('hint.done');
  else $('#hint').textContent = IS_DESKTOP ? t('hint.desktop') : t('hint.idle');

  setStatus(state.statusKey || 'idle');
  $('#segCount').textContent = t('seg.count', { n: state.segCount });
  $('#btnPause').textContent = state.paused ? t('btn.resume') : t('btn.pause');
  if (!$('#screenFlags').hidden) {
    $('#flagMic').textContent = state.micStream ? t('flag.mic') : t('flag.sysOnly');
  }
  if (IS_DESKTOP) applyDesktopCopy();
  if (state.statusKey === 'idle' && !state.recording && !state.resultShown) {
    $('#meterTip').textContent = '';
  }
}

function bindUI() {
  $('#btnStart').addEventListener('click', startRecording);
  $('#btnPause').addEventListener('click', togglePause);
  $('#btnStop').addEventListener('click', () => stopRecording('toast.stoppedByUser'));
  $('#btnCancel').addEventListener('click', showCancelDialog);
  $('#btnHistory').addEventListener('click', showHistory);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#llmBadge').addEventListener('click', openSettings);
  $('#optQuality').addEventListener('change', saveOptions);
  $('#optMic').addEventListener('change', saveOptions);

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

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
    btn.textContent = t('history.generating');
    try {
      const r = await fetch(`/api/session/${btn.dataset.regen}/summary`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      btn.textContent = t('history.generated');
      toast(t('history.genToast'), 'ok');
      setTimeout(() => showHistory(), 500);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t('history.generate');
      toast(t('history.genFailed') + (err.message || err), 'err');
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
    toast(t('toast.screenDenied') + (err.message || err), 'err');
    return;
  }

  const sysTracks = display.getAudioTracks();
  if (!sysTracks.length) {
    display.getTracks().forEach((tr) => tr.stop());
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
      toast(t('toast.noMic'), 'err');
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
    toast(t('toast.sessionFailed') + (err.message || err), 'err');
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
  rec.onerror = (e) => toast(t('toast.recorderError') + (e.error?.message || e), 'err');

  display.getVideoTracks()[0].addEventListener('ended', () => {
    if (state.recording) stopRecording('toast.stoppedByShare');
  });

  state.recorder = rec;
  rec.start(4000);

  state.recording = true;
  state.paused = false;
  state.ending = false;
  state.cancelling = false;
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
  $('#flagSys').textContent = t('flag.system');
  $('#flagMic').className = 'flag ' + (state.micStream ? 'on' : 'off');
  $('#flagMic').textContent = state.micStream ? t('flag.mic') : t('flag.sysOnly');
  $('#btnStart').disabled = true;
  $('#btnPause').disabled = false;
  $('#btnStop').disabled = false;
  $('#btnCancel').disabled = false;
  $('#optQuality').disabled = true;
  $('#optMic').disabled = true;
  $('#hint').textContent = t('hint.recording');
  setStatus('recording');
  startTimer();
  watchSilence();
  toast(t('toast.started'), 'ok');
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
    $('#btnPause').textContent = t('btn.resume');
    $('#pauseVeil').hidden = false;
    setStatus('paused');
  } else {
    try { rec.resume(); } catch { }
    state.pausedTotal += Date.now() - state.pausedAt;
    state.paused = false;
    $('#btnPause').textContent = t('btn.pause');
    $('#pauseVeil').hidden = true;
    setStatus('recording');
  }
}

async function stopRecording(reasonKey, opts = {}) {
  if (!state.recording || state.ending) return;
  state.ending = true;
  state.recording = false;
  clearInterval(state.timerId);
  $('#btnStop').disabled = true;
  $('#btnPause').disabled = true;
  $('#btnCancel').disabled = true;
  setStatus('saving');
  if (reasonKey) toast(t(reasonKey), 'ok');

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
      body: JSON.stringify({ durationSec, reason: reasonKey, skipSummary: Boolean(opts.skipSummary) }),
    });
  } catch (err) {
    toast(t('toast.saveFailed') + (err.message || err), 'err');
  }

  showProcessing(opts.skipSummary ? 'processing.saveDesc' : '');
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
  $('#hint').textContent = t('hint.stopping');
}

function showCancelDialog() {
  if (!state.recording) return;
  const card = $('#modalCard');
  card.innerHTML = `
    <h2>${t('cancel.title')}</h2>
    <div class="modal-sub">${t('cancel.desc', { dur: fmt(activeSeconds()) })}</div>
    <div class="modal-actions">
      <button id="btnKeepRecording" class="ghost">${t('cancel.keep')}</button>
      <button id="btnSaveOnly" class="ghost">${t('cancel.saveOnly')}</button>
      <button id="btnDiscard" class="danger">${t('cancel.discard')}</button>
    </div>`;
  openModal();
  $('#btnKeepRecording').addEventListener('click', closeModal);
  $('#btnSaveOnly').addEventListener('click', () => {
    closeModal();
    stopRecording('toast.stoppedByUser', { skipSummary: true });
  });
  $('#btnDiscard').addEventListener('click', () => {
    closeModal();
    cancelRecording();
  });
}

/** 直接丢弃这次录制：停止采集、删掉服务端会话目录、不生成任何文件。 */
async function cancelRecording() {
  if (!state.recording && !state.ending) return;
  state.cancelling = true;
  state.ending = true;
  state.recording = false;
  clearInterval(state.timerId);
  $('#btnStart').disabled = true;
  $('#btnPause').disabled = true;
  $('#btnStop').disabled = true;
  $('#btnCancel').disabled = true;
  setStatus('saving');

  try { state.recorder?.stop(); } catch { }
  await sleep(200);
  cleanupMedia();
  state.chunkQueue.length = 0;
  state.audioQueue.length = 0;

  try { await fetch(`/api/session/${state.sessionId}/abort`, { method: 'POST' }); } catch { }
  try { state.sse?.close(); } catch { }
  state.sse = null;

  state.sessionId = null;
  state.ending = false;
  state.cancelling = false;
  state.resultShown = false;
  state.segCount = 0;
  state.statusKey = 'idle';

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
  $('#btnCancel').disabled = true;
  $('#optQuality').disabled = false;
  $('#optMic').disabled = false;
  $('#hint').textContent = IS_DESKTOP ? t('hint.desktop') : t('hint.idle');
  $('#segCount').textContent = t('seg.count', { n: 0 });
  clearTranscript();
  $('#transcript').innerHTML = `<div class="empty">${t('empty.transcript')}</div>`;
  setStatus('idle');
  toast(t('toast.cancelled'), 'ok');
}

function cleanupMedia() {
  try { state.displayStream?.getTracks().forEach((tr) => tr.stop()); } catch { }
  try { state.micStream?.getTracks().forEach((tr) => tr.stop()); } catch { }
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
  if (state.cancelling) return;
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
  if (state.uploading || state.chunkQueue.length) toast(t('toast.uploadIncomplete'), 'err');
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
  const timer = setInterval(() => {
    if (!state.recording) { clearInterval(timer); return; }
    if (state.paused) return;
    if (Date.now() - state.lastLevelAt > 9000) {
      $('#meterTip').textContent = IS_DESKTOP ? t('meter.silenceDesktop') : t('meter.silence');
      if (Date.now() - state.lastLevelAt > 15000) state.lastLevelAt = Date.now();
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
    if (state.recording) setStatus('reconnecting');
  };
}

function handleEvent(d) {
  if (d.type === 'snapshot') {
    if (d.segments?.length) {
      clearTranscript();
      d.segments.forEach((s) => appendSegment(s, false));
      state.segCount = d.segments.length;
      $('#segCount').textContent = t('seg.count', { n: state.segCount });
    }
    if (d.summary) renderSummary(d.summary);
    if (d.status === 'done' && d.result) showResult(d.result, d.summary);
    return;
  }
  if (d.type === 'segment') {
    appendSegment(d, true);
    state.segCount++;
    $('#segCount').textContent = t('seg.count', { n: state.segCount });
    setStatus(state.paused ? 'paused' : 'recording');
    return;
  }
  if (d.type === 'summary') {
    renderSummary(d.summary);
    if (d.partial) setStatus('updated');
    return;
  }
  if (d.type === 'status') {
    if (d.status === 'processing') {
      setStatus('processing');
      showProcessing();
    }
    if (d.status === 'error') setStatus('error');
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
  ts.title = t('seg.seekTitle');
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
    toast(t('ask.noSession'), 'err');
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
      body: JSON.stringify({ question, locale: getLocale() }),
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
    bot.textContent = t('ask.failed') + (err.message || err);
  } finally {
    bot.classList.remove('streaming');
    $('#btnAsk').disabled = false;
    chat.scrollTop = chat.scrollHeight;
  }
}

// ------------------------------------------------------------------ 面板/弹窗

function switchTab(name) {
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  ['transcript', 'summary', 'ask'].forEach((n) => {
    $(`#tab-${n}`).hidden = n !== name;
  });
  if (name === 'ask') $('#askInput').focus();
}

function resetPanels() {
  clearTranscript();
  $('#transcript').innerHTML = `<div class="empty">${t('empty.transcriptLoading')}</div>`;
  $('#summary').innerHTML = `<div class="empty">${t('empty.summary')}</div>`;
  $('#chat').innerHTML = `<div class="empty">${t('empty.ask')}</div>`;
  state.segCount = 0;
  $('#segCount').textContent = t('seg.count', { n: 0 });
  switchTab('transcript');
}

function showProcessing(descKey) {
  const card = $('#modalCard');
  card.innerHTML = `<h2>${t('processing.title')}</h2><div class="modal-sub">${t(descKey || 'processing.desc')}</div>
    <div class="processing"><div class="spinner"></div><span id="procMsg">${t('status.processing')}</span></div>
    <p class="hint">${t('processing.hint')}</p>`;
  openModal();
}

function showResult(result, summary) {
  if (state.resultShown) return;
  state.resultShown = true;
  closeModal();
  const card = $('#modalCard');
  const sub = t('result.sub', {
    dur: fmt(result.durationSec),
    n: result.segments,
    dir: result.folder || '',
  });
  card.innerHTML = `
    <h2>${esc(result.title || t('result.done'))}</h2>
    <div class="modal-sub">${esc(sub)}</div>
    ${result.summaryError ? `<div class="warn-box">${t('result.warn', { err: esc(result.summaryError) })}</div>` : ''}
    ${result.video ? `<video controls src="${result.video}"${result.poster ? ` poster="${result.poster}"` : ''}></video>` : `<p class="hint">${t('result.noVideo')}</p>`}
    <div class="modal-actions">
      ${result.video ? `<a href="${result.video}" download>${t('result.download')}</a>` : ''}
      <a href="${result.transcript}" target="_blank">${t('result.transcript')}</a>
      ${result.summary ? `<a href="${result.summary}" target="_blank">${t('result.summary')}</a>` : ''}
      <button id="btnRegen" class="ghost">${t('result.regen')}</button>
      <button id="btnOpenFolder" class="ghost">${t('result.openFolder')}</button>
      <button id="btnCloseModal" class="ghost">${t('result.close')}</button>
    </div>
    <div class="markdown" id="resultSummary">${summary ? renderMarkdown(summary) : `<p class="hint">${t('result.noSummary')}</p>`}</div>`;
  openModal();
  $('#btnCloseModal')?.addEventListener('click', closeModal);
  $('#btnOpenFolder')?.addEventListener('click', async () => {
    try { await fetch(`/api/session/${result.id}/open`, { method: 'POST' }); } catch { }
  });
  $('#btnRegen')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t('result.regening');
    try {
      const r = await fetch(`/api/session/${result.id}/summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: getLocale() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      $('#resultSummary').innerHTML = renderMarkdown(j.summary);
      if (j.title) card.querySelector('h2').textContent = j.title;
      card.querySelector('.warn-box')?.remove();
      btn.textContent = t('result.regenDone');
      toast(t('result.regenToast'), 'ok');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t('result.regen');
      toast(t('result.regenFailed') + (err.message || err), 'err');
    }
  });
  setStatus('done');
  $('#hint').textContent = t('hint.done');
}

function applyDesktopCopy() {
  document.body.classList.add('desktop');
  const ph = document.querySelector('.placeholder');
  if (ph) {
    const h = ph.querySelector('h2');
    const p = ph.querySelector('p');
    if (h) h.textContent = t('placeholder.titleDesktop');
    if (p) p.innerHTML = t('placeholder.descDesktop');
    ph.querySelector('.ph-steps')?.remove();
  }
  $('#hint').textContent = t('hint.desktop');
}

function showNoAudioHelp() {
  const card = $('#modalCard');
  if (IS_DESKTOP) {
    card.innerHTML = `
      <h2>${t('noaudio.title')}</h2>
      <div class="modal-sub">${t('noaudio.descDesktop')}</div>
      <div class="markdown">
        <p>${t('noaudio.descTitle')}</p>
        <ul>
          <li>${t('noaudio.dstep1')}</li>
          <li>${t('noaudio.dstep2')}</li>
          <li>${t('noaudio.dstep3')}</li>
        </ul>
      </div>
      <div class="modal-actions"><button id="btnRetryShare" class="primary">${t('noaudio.retryDesktop')}</button><button id="btnCancelShare" class="ghost">${t('noaudio.cancel')}</button></div>`;
    openModal();
    $('#btnRetryShare').addEventListener('click', () => { closeModal(); startRecording(); });
    $('#btnCancelShare').addEventListener('click', closeModal);
    return;
  }
  card.innerHTML = `
    <h2>${t('noaudio.title')}</h2>
    <div class="modal-sub">${t('noaudio.descBrowser')}</div>
    <div class="markdown">
      <p>${t('noaudio.howTitle')}</p>
      <ul>
        <li>${t('noaudio.step1')}</li>
        <li>${t('noaudio.step2')}</li>
        <li>${t('noaudio.step3')}</li>
      </ul>
      <p>${t('noaudio.tip')}</p>
    </div>
    <div class="modal-actions"><button id="btnRetryShare" class="primary">${t('noaudio.retry')}</button><button id="btnCancelShare" class="ghost">${t('noaudio.cancel')}</button></div>`;
  openModal();
  $('#btnRetryShare').addEventListener('click', () => { closeModal(); startRecording(); });
  $('#btnCancelShare').addEventListener('click', closeModal);
}

async function showHistory() {
  const card = $('#modalCard');
  card.innerHTML = `<h2>${t('history.title')}</h2><div class="modal-sub">${t('history.subtitleAll')}</div><div class="processing"><div class="spinner"></div><span>${t('history.loading')}</span></div>`;
  openModal();
  try {
    const r = await fetch('/api/sessions');
    const { sessions } = await r.json();
    if (!sessions.length) {
      card.innerHTML = `<h2>${t('history.title')}</h2><div class="modal-sub">${t('history.empty')}</div><div class="modal-actions"><button class="ghost" id="btnCloseModal">${t('history.close')}</button></div>`;
      $('#btnCloseModal').addEventListener('click', closeModal);
      return;
    }
    const rows = sessions.map((s) => `
      <div class="session-item">
        <div class="meta"><b>${esc(s.title || s.id)}</b><span>${s.createdAt ? new Date(s.createdAt).toLocaleString(getLocale()) : ''} ${s.durationSec ? '· ' + fmt(s.durationSec) : ''} ${s.segments ? '· ' + t('seg.count', { n: s.segments }) : ''}</span></div>
        ${s.video ? `<a href="${s.video}" target="_blank">${t('history.play')}</a>` : ''}
        ${s.summary ? `<a href="${s.summary}" target="_blank">${t('history.summary')}</a>` : `<button data-regen="${s.id}">${t('history.generate')}</button>`}
        ${s.transcript ? `<a href="${s.transcript}" target="_blank">${t('history.transcript')}</a>` : ''}
        ${s.unfinished ? `<span class="badge badge-bad">${t('history.unfinished')}</span>` : ''}
      </div>`).join('');
    card.innerHTML = `<h2>${t('history.title')}</h2><div class="modal-sub">${t('history.subtitleCount', { n: sessions.length })}</div>
      <div class="session-list">${rows}</div>
      <div class="modal-actions"><button class="ghost" id="btnCloseModal">${t('history.close')}</button></div>`;
    $('#btnCloseModal').addEventListener('click', closeModal);
  } catch (err) {
    card.innerHTML = `<h2>${t('history.title')}</h2><div class="modal-sub">${t('history.readFailed')}${esc(err.message || String(err))}</div>`;
  }
}

async function openSettings() {
  let cfg = {};
  try { cfg = await (await fetch('/api/config')).json(); } catch { }
  const llm = cfg.llm || {};
  const locale = getLocale();
  const sourceText = t('settings.source.' + (llm.source || 'none'));
  const card = $('#modalCard');
  card.innerHTML = `
    <h2>${t('settings.title')}</h2>
    <div class="modal-sub">${t('settings.subtitle')}</div>
    <div class="form">
      <label>${t('settings.language')}</label>
      <select id="setLocale">
        <option value="zh-CN"${locale === 'zh-CN' ? ' selected' : ''}>简体中文</option>
        <option value="en"${locale === 'en' ? ' selected' : ''}>English</option>
      </select>
    </div>
    <hr class="sep" />
    <div class="form">
      <label>${t('settings.dirLabel')} <span class="dim">${t('settings.dirNote')}</span></label>
      <div class="dir-row">
        <input id="setDir" value="${esc(cfg.recordings || '')}" spellcheck="false" />
        ${window.desktop && window.desktop.pickFolder ? `<button type="button" id="btnPickDir" class="ghost">${t('settings.choose')}</button>` : ''}
      </div>
      <p class="hint">${t('settings.dirDefault', { path: esc(cfg.recordingsDefault || '') })}<br />${t('settings.dirHint')}</p>
    </div>
    <hr class="sep" />
    <div class="form">
      <label>${t('settings.apiKey')} <span class="dim">${t('settings.keySource', { src: esc(sourceText), hint: llm.keyHint ? ' · ' + esc(llm.keyHint) : '' })}</span></label>
      <input id="setKey" type="password" autocomplete="off" placeholder="${esc(t('settings.keyPlaceholder'))}" />
      <label>${t('settings.baseUrl')} <span class="dim">${t('settings.baseUrlHint')}</span></label>
      <input id="setBase" value="${esc(llm.baseUrl || 'https://api.deepseek.com')}" />
      <label>${t('settings.model')}</label>
      <input id="setModel" value="${esc(llm.model || 'deepseek-chat')}" />
    </div>
    <p class="hint">${t('settings.configPath', { path: esc(llm.configFile || '') })}</p>
    <div id="testResult" class="test-result"></div>
    <div class="modal-actions">
      <button id="btnTestLlm" class="ghost">${t('settings.test')}</button>
      <button id="btnSaveSettings" class="primary">${t('settings.save')}</button>
      ${llm.source === 'dsh' ? `<button id="btnImportDsh" class="ghost">${t('settings.importDsh')}</button>` : ''}
      <button id="btnCloseModal" class="ghost">${t('settings.close')}</button>
    </div>`;
  openModal();

  $('#btnCloseModal').addEventListener('click', closeModal);

  $('#setLocale').addEventListener('change', async (e) => {
    const next = e.currentTarget.value;
    setLocale(next);
    state.locale = next;
    refreshTexts();
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
    } catch { }
    openSettings();
  });

  $('#btnPickDir')?.addEventListener('click', async () => {
    try {
      const dir = await window.desktop.pickFolder();
      if (dir) $('#setDir').value = dir;
    } catch (err) {
      toast(t('toast.pickFailed') + (err.message || err), 'err');
    }
  });

  $('#btnTestLlm')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = $('#testResult');
    btn.disabled = true;
    btn.textContent = t('settings.testing');
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
      out.textContent = t('settings.testOk', { model: j.model });
      out.className = 'test-result ok';
    } catch (err) {
      out.textContent = t('settings.testFail') + (err.message || err);
      out.className = 'test-result err';
    } finally {
      btn.disabled = false;
      btn.textContent = t('settings.test');
    }
  });

  $('#btnImportDsh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t('settings.importing');
    try {
      const r = await fetch('/api/config/import-dsh', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      applyLlmBadge(j.llm);
      toast(t('toast.importOk'), 'ok');
      closeModal();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t('settings.importDsh');
      toast(t('toast.importFailed') + (err.message || err), 'err');
    }
  });

  $('#btnSaveSettings').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t('settings.saving');
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: $('#setKey').value,
          baseUrl: $('#setBase').value,
          model: $('#setModel').value,
          recordingsDir: $('#setDir') ? $('#setDir').value : undefined,
          locale: getLocale(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      applyLlmBadge(j.llm);
      if (j.recordings) state.recordingsDir = j.recordings;
      toast(j.llm.ready ? t('toast.settingsSaved') : t('toast.settingsSavedNoKey'), j.llm.ready ? 'ok' : 'err');
      closeModal();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t('settings.save');
      toast(t('settings.saveFail') + (err.message || err), 'err');
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
