// 把混音后的 48k 音频降采样成 16k 单声道 PCM，按 1 秒一包发给主线程；
// 同时每 50ms 汇报一次音量，用来驱动界面上的电平表。
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.target = opts.targetRate || 16000;
    this.ratio = sampleRate / this.target;
    this.phase = 0;
    this.acc = 0;
    this.accN = 0;
    this.buf = new Int16Array(this.target); // 1 秒
    this.n = 0;
    this.levelAcc = 0;
    this.levelN = 0;
    this.levelBlocks = Math.max(1, Math.round(sampleRate * 0.05));
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.flush();
    };
    this.port.postMessage({ type: 'info', sampleRate, ratio: this.ratio, target: this.target });
  }

  flush() {
    if (this.n > 0) {
      const out = this.buf.slice(0, this.n);
      this.n = 0;
      this.buf = new Int16Array(this.target);
      this.port.postMessage({ type: 'pcm', pcm: out }, [out.buffer]);
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const L = input[0];
      const R = input.length > 1 ? input[1] : null;
      for (let i = 0; i < L.length; i++) {
        let x = R ? (L[i] + R[i]) * 0.5 : L[i];
        this.levelAcc += x * x;
        this.levelN++;
        this.acc += x;
        this.accN++;
        this.phase += 1;
        if (this.phase >= this.ratio) {
          this.phase -= this.ratio;
          let v = this.acc / Math.max(1, this.accN);
          v = v < -1 ? -1 : v > 1 ? 1 : v;
          this.buf[this.n++] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
          this.acc = 0;
          this.accN = 0;
          if (this.n >= this.buf.length) {
            const out = this.buf;
            this.buf = new Int16Array(this.target);
            this.n = 0;
            this.port.postMessage({ type: 'pcm', pcm: out }, [out.buffer]);
          }
        }
      }
      if (this.levelN >= this.levelBlocks) {
        this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelAcc / this.levelN) });
        this.levelAcc = 0;
        this.levelN = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
