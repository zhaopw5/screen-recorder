// 离线中文语音识别核心：SenseVoiceSmall(ONNX) + Silero VAD，全部在本机 CPU 上跑。
// 模型复用 DeepSeek Harness 已经下载好的缓存（~/.dsh/speech-to-text/sensevoice/models），
// 不需要联网、不需要 Python、不需要编译器。
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// 先在 node_modules 里找；找不到就用自带的 vendor 副本（避免 npm install 把本地原生包清掉）
function loadSherpa() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = ['sherpa-onnx-node', path.join(here, '..', 'vendor', 'sherpa-onnx-node')];
  let lastErr;
  for (const c of candidates) {
    try { return require(c); } catch (err) { lastErr = err; }
  }
  throw new Error(`找不到 sherpa-onnx-node（node_modules 和 vendor 都没有）：${lastErr?.message || ''}`);
}

const sherpa = loadSherpa();

export const SAMPLE_RATE = 16000;

export function defaultModelPaths() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, '..', 'models'); // 软件自带，和 DSH 无关
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  const dsh = path.join(home, '.dsh', 'speech-to-text', 'sensevoice', 'models'); // 兼容旧位置
  const file = process.env.SENSEVOICE_MODEL_FILE || 'model.int8.onnx';

  const roots = [];
  if (process.env.SENSEVOICE_MODEL_DIR) roots.push(process.env.SENSEVOICE_MODEL_DIR);
  roots.push(bundled, dsh);
  const root = roots.find((r) => existsSync(path.join(r, 'sensevoice-onnx', file))) || dsh;

  return {
    model: path.join(root, 'sensevoice-onnx', file),
    tokens: path.join(root, 'sensevoice-onnx', 'tokens.txt'),
    vad: path.join(root, 'silero', 'silero_vad.onnx'),
  };
}

/** SenseVoice 有时会输出 <|zh|><|NEUTRAL|> 这类控制标签，删掉它们。 */
export function cleanText(raw) {
  if (!raw) return '';
  let t = String(raw);
  t = t.replace(/<\|[^|>]*\|>/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (/^(<\|nospeech\|>|nospeech|sil|blank)$/i.test(t)) return '';
  return t;
}

/**
 * 创建一个流式喂 PCM、自动按静音切句的识别引擎。
 * 只能在单个进程里同步使用（底层是同步 native 调用）。
 */
export function createEngine(options = {}) {
  const paths = options.paths || defaultModelPaths();
  const onSegment = options.onSegment || (() => {});
  const threads = options.threads || Math.max(1, Math.min(4, (require('node:os').availableParallelism?.() || 4) - 1));
  const maxSpeechSeconds = options.maxSpeechSeconds || 15;

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: paths.model,
        language: options.language || 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: paths.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  });

  const vad = new sherpa.Vad({
    sileroVad: {
      model: paths.vad,
      threshold: options.vadThreshold ?? 0.45,
      minSilenceDuration: options.minSilenceSeconds ?? 0.35,
      minSpeechDuration: options.minSpeechSeconds ?? 0.2,
      maxSpeechDuration: maxSpeechSeconds,
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, maxSpeechSeconds + 6);

  let fedSamples = 0;      // 已经喂进去的总样本数（时间轴基准）
  let pending = new Float32Array(0); // 不足 512 的尾巴
  const segments = [];

  function decode(samples) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    recognizer.decode(stream);
    return cleanText(recognizer.getResult(stream).text);
  }

  function drain() {
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      const samples = seg.samples;
      vad.pop();
      if (!samples || samples.length < SAMPLE_RATE * 0.35) continue;
      const start = seg.start / SAMPLE_RATE;
      const end = (seg.start + samples.length) / SAMPLE_RATE;
      const text = decode(samples);
      if (!text) continue;
      const item = { start: Math.max(0, start), end, text };
      segments.push(item);
      onSegment(item);
    }
  }

  function acceptFloat32(samples) {
    if (!samples || samples.length === 0) return;
    let buf;
    if (pending.length) {
      buf = new Float32Array(pending.length + samples.length);
      buf.set(pending, 0);
      buf.set(samples, pending.length);
    } else {
      buf = samples;
    }
    let off = 0;
    for (; off + 512 <= buf.length; off += 512) {
      vad.acceptWaveform(buf.subarray(off, off + 512));
      fedSamples += 512;
      drain();
    }
    pending = buf.slice(off);
  }

  function acceptInt16(buffer) {
    const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const n = Math.floor(view.byteLength / 2);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = view.readInt16LE(i * 2) / 32768;
    acceptFloat32(f);
  }

  /** 结束时把 VAD 里还没吐出来的最后一句挤出来 */
  function flush() {
    if (pending.length) {
      const tail = new Float32Array(512);
      tail.set(pending, 0);
      vad.acceptWaveform(tail);
      fedSamples += 512;
      pending = new Float32Array(0);
    }
    vad.flush();
    drain();
  }

  return {
    acceptFloat32,
    acceptInt16,
    flush,
    segments,
    stats: () => ({ fedSeconds: fedSamples / SAMPLE_RATE, segments: segments.length }),
    close: () => { try { vad.clear(); } catch {} },
  };
}
