import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8810;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeApp = mkdtempSync(join(tmpdir(), 'i18napp-'));

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, APPDATA: fakeApp, PORT: String(PORT), NO_OPEN: '1' },
  stdio: 'ignore',
});
await sleep(2500);

const profile = mkdtempSync(join(tmpdir(), 'i18nchrome-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--remote-debugging-port=9250', `--user-data-dir=${profile}`, '--window-size=1440,900',
  `${BASE}/`,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 50; i++) {
  await sleep(400);
  try {
    const list = await (await fetch('http://127.0.0.1:9250/json/list')).json();
    target = list.find((t) => t.type === 'page' && t.url.includes(String(PORT)));
    if (target) break;
  } catch { }
}
if (!target) { console.log('NO TARGET'); server.kill(); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; p.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) { writeFileSync(join('docs', name), Buffer.from(s.result.data, 'base64')); console.log('saved docs/' + name); }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 40; i++) { if (await ev('document.readyState==="complete" && !!window.__rec')) break; await sleep(300); }
await sleep(900);

console.log('zh title:', await ev('document.title'));
console.log('zh start:', await ev("document.querySelector('#btnStart').textContent"));
console.log('zh hint:', await ev("document.querySelector('#hint').textContent"));
await shot('home-zh.png');

// 打开设置切到英文
await ev("document.querySelector('#btnSettings').click(); 1");
await sleep(600);
console.log('locale select:', await ev("document.querySelector('#setLocale').value"));
await ev("(() => { const s = document.querySelector('#setLocale'); s.value='en'; s.dispatchEvent(new Event('change')); return 1; })()");
await sleep(1200);
console.log('after switch, settings title:', await ev("document.querySelector('#modalCard h2').textContent"));
console.log('dir label:', await ev("document.querySelector('#modalCard label').textContent"));
console.log('server locale:', (await (await fetch(`${BASE}/api/config`)).json()).locale);
await shot('settings-en.png');

// 关闭弹窗，看主界面
await ev("document.querySelector('#btnCloseModal').click(); 1");
await sleep(400);
console.log('en title:', await ev('document.title'));
console.log('en start:', await ev("document.querySelector('#btnStart').textContent"));
console.log('en hint:', await ev("document.querySelector('#hint').textContent"));
console.log('en tabs:', await ev("[...document.querySelectorAll('.tab')].map(t=>t.textContent).join(' | ')"));
console.log('en placeholder:', await ev("document.querySelector('.placeholder h2').textContent"));
console.log('en empty:', await ev("document.querySelector('#transcript .empty')?.textContent"));
await shot('home-en.png');

// 页面里是否还有中文（排除语言下拉里的“简体中文”）
console.log('cjk leftovers:', await ev(`(() => {
  const bad = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (el.children.length) return;
    const txt = (el.textContent || '').trim();
    if (!txt || !/[\\u4e00-\\u9fff]/.test(txt)) return;
    if (el.closest('#setLocale')) return;
    bad.push(txt.slice(0, 40));
  });
  return [...new Set(bad)].slice(0, 10);
})()`));

// 刷新后是否仍为英文
await send('Page.reload');
await sleep(2500);
for (let i = 0; i < 30; i++) { if (await ev('document.readyState==="complete" && !!window.__rec')) break; await sleep(300); }
console.log('after reload title:', await ev('document.title'));
console.log('after reload start:', await ev("document.querySelector('#btnStart').textContent"));
console.log('after reload config locale:', (await (await fetch(`${BASE}/api/config`)).json()).locale);

ws.close(); chrome.kill(); server.kill();
