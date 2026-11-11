// ASR 子进程：加载模型，接收 PCM，按静音切句后回传文字。
import { createEngine, defaultModelPaths } from './asr-core.mjs';

let engine = null;

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  try {
    if (msg.type === 'init') {
      const t0 = Date.now();
      engine = createEngine({
        paths: defaultModelPaths(),
        maxSpeechSeconds: msg.maxSpeechSeconds || 15,
        onSegment: (s) => process.send({ type: 'segment', start: s.start, end: s.end, text: s.text }),
      });
      process.send({ type: 'ready', loadMs: Date.now() - t0 });
    } else if (msg.type === 'pcm') {
      if (!engine) return;
      engine.acceptInt16(Buffer.from(msg.data));
    } else if (msg.type === 'flush') {
      if (engine) engine.flush();
      process.send({ type: 'flushed' });
    } else if (msg.type === 'close') {
      process.exit(0);
    }
  } catch (err) {
    process.send({ type: 'error', message: String(err && err.message || err) });
  }
});

process.on('uncaughtException', (err) => {
  try { process.send({ type: 'error', message: 'uncaught: ' + String(err && err.stack || err) }); } catch { }
  process.exit(1);
});
