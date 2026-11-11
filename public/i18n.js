// 界面文案：zh-CN / en。key 用点号分组，{name} 是占位符。
export const LOCALES = ['zh-CN', 'en'];

const zh = {
  'app.title': '录屏助手',
  'app.subtitle': '屏幕 + 系统声音 · 本地转写 · AI 边录边记',
  'app.docTitle': '录屏助手',

  'nav.settings': '设置',
  'nav.history': '历史录制',

  'badge.checking': '检测中…',
  'badge.disconnected': '服务未连接',
  'badge.noKey': 'AI 未配置密钥 · 点此设置',
  'badge.ready': 'AI 就绪 · {model}{src}',

  'placeholder.title': '把线上会议的画面和声音一起录下来',
  'placeholder.desc': '点「开始录制」后，选择 <b>整个屏幕</b>，并勾选 <b>同时分享系统音频</b>。<br />这样电脑里播放的声音（会议、视频、直播）才会被录进去。',
  'placeholder.step1': '1 选整个屏幕',
  'placeholder.step2': '2 勾选系统音频',
  'placeholder.step3': '3 点分享',
  'placeholder.titleDesktop': '一键录制屏幕和电脑里的声音',
  'placeholder.descDesktop': '桌面版会自动录制<b>整个屏幕</b>和<b>系统声音</b>：不用选窗口，也不用勾选音频。<br />点下面的「开始录制」就可以了。',

  'hint.idle': '提示：录制时请保持本页面打开；会议软件里的声音不要静音。戴耳机可以避免"对方的回声被麦克风二次录入"。',
  'hint.desktop': '桌面版：点开始就直接录，保持这个窗口打开即可。戴耳机可以避免回声。',
  'hint.recording': '正在录制：本页面请保持打开。可以在右侧「提问」里随时问 AI。',
  'hint.stopping': '已停止录制，正在合并录像并生成最终纪要，请稍候…',
  'hint.done': '录制完成。录像、逐字稿、会议纪要都在上面的文件夹里。',

  'btn.start': '开始录制',
  'btn.pause': '暂停',
  'btn.resume': '继续',
  'btn.stop': '结束并生成纪要',
  'opt.mic': '麦克风',
  'quality.high': '高清 1080p·30fps',
  'quality.std': '标准 1080p·15fps',
  'quality.lite': '轻量 720p·15fps',

  'flag.system': '系统声音',
  'flag.mic': '麦克风',
  'flag.sysOnly': '仅系统声音',
  'rec.paused': '已暂停',
  'meter.silence': '没检测到声音：确认勾选了「系统音频」，并检查会议软件是否静音',
  'meter.silenceDesktop': '没检测到声音：确认会议/视频正在出声，且输出设备正确',

  'status.idle': '待机',
  'status.recording': '正在录制',
  'status.paused': '已暂停',
  'status.saving': '正在保存…',
  'status.processing': '正在生成纪要…',
  'status.updated': '纪要已更新',
  'status.done': '已完成',
  'status.error': '收尾出错',
  'status.reconnecting': '连接中断，正在重连…',

  'tab.transcript': '实时字幕',
  'tab.summary': 'AI 纪要',
  'tab.ask': '提问',
  'empty.transcript': '开始录制后，这里会实时出现文字，按说话停顿自动断句。',
  'empty.transcriptLoading': '正在启动本地语音识别…第一句话识别出来后就会出现在这里。',
  'empty.summary': 'AI 会边录边整理纪要，大约每 30 秒刷新一次。',
  'empty.ask': '录屏过程中可以随时提问，例如「刚才说的预算是多少？」「总结一下前十分钟」。',
  'seg.count': '{n} 句',
  'seg.seekTitle': '点击定位到视频这个时间点',
  'ask.placeholder': '问点什么…（Enter 发送，Shift+Enter 换行）',
  'ask.send': '发送',
  'ask.noSession': '先开始录制，AI 才有内容可回答',
  'ask.failed': '回答失败：',

  'toast.screenDenied': '没有拿到屏幕共享：',
  'toast.noMic': '没有拿到麦克风权限，这次只录系统声音',
  'toast.sessionFailed': '无法创建录制会话：',
  'toast.started': '开始录制，正在加载本地语音识别模型…',
  'toast.stoppedByUser': '手动结束',
  'toast.stoppedByShare': '屏幕共享已停止',
  'toast.saveFailed': '提交收尾失败：',
  'toast.uploadIncomplete': '还有分片没传完，文件可能不完整',
  'toast.recorderError': '录制器出错：',
  'toast.reconnected': '连接已恢复',
  'toast.settingsSaved': '已保存：新录制会存到上面的位置',
  'toast.settingsSavedNoKey': '已保存，但还没有 AI 密钥',
  'toast.pickFailed': '选择文件夹失败：',
  'toast.importOk': '已复制到本机配置，卸载 DSH 也不影响 AI 了',
  'toast.importFailed': '导入失败：',

  'processing.title': '正在收尾',
  'processing.desc': '录像分片已经保存在本机，正在合并并让 AI 写最终纪要。',
  'processing.hint': '首次生成长纪要通常需要 20~60 秒，请不要关闭本页面。',

  'result.done': '录制完成',
  'result.sub': '时长 {dur} · 识别 {n} 句 · 文件在 {dir}',
  'result.noVideo': '没有拿到视频数据（可能录制时间太短）。',
  'result.download': '下载录像',
  'result.transcript': '逐字稿 .md',
  'result.summary': '会议纪要 .md',
  'result.regen': '重新生成纪要',
  'result.regening': '生成中…',
  'result.regenDone': '已重新生成',
  'result.regenToast': '纪要已重新生成',
  'result.regenFailed': '重新生成失败：',
  'result.openFolder': '打开文件夹',
  'result.close': '关闭',
  'result.warn': '⚠️ 这次 AI 纪要没生成成功：{err}<br />下面先用本地自动摘录顶上，可以点「重新生成纪要」再试一次。',

  'history.title': '历史录制',
  'history.subtitleAll': '全部保存在本机。',
  'history.subtitleCount': '共 {n} 条，全部保存在本机。',
  'history.empty': '还没有录制过。',
  'history.loading': '读取中…',
  'history.play': '播放',
  'history.summary': '纪要',
  'history.transcript': '逐字稿',
  'history.generate': '生成纪要',
  'history.generating': '生成中…',
  'history.generated': '已生成',
  'history.genToast': '纪要已生成',
  'history.genFailed': '生成失败：',
  'history.readFailed': '读取失败：',
  'history.unfinished': '未正常结束',
  'history.close': '关闭',

  'noaudio.title': '这次没有抓到「系统声音」',
  'noaudio.descBrowser': '你刚才选择的分享方式里不含音频，录出来会没有声音。',
  'noaudio.howTitle': '请按下面步骤重来一次：',
  'noaudio.step1': '点「重新选择」后，在弹窗顶部选择 <b>整个屏幕</b>（不要选「窗口」或「标签页」）。',
  'noaudio.step2': '在弹窗左下角，把 <b>「同时分享系统音频」</b> 勾上（Chrome/Edge 里叫「分享系统音频」）。',
  'noaudio.step3': '再点「分享」。',
  'noaudio.tip': '如果根本看不到这个勾选项：说明你选的是单个窗口或标签页，换成「整个屏幕」就会出现。',
  'noaudio.retry': '重新选择',
  'noaudio.cancel': '取消',
  'noaudio.descDesktop': '桌面版会请求系统环回音频（WASAPI loopback），但这次返回的是空音轨。',
  'noaudio.descTitle': '可以这样排查：',
  'noaudio.dstep1': '确认电脑正在出声（会议/视频没有静音，音量不为 0）。',
  'noaudio.dstep2': '确认默认输出设备是现在在用的扬声器或耳机，蓝牙耳机没连上时容易出问题。',
  'noaudio.dstep3': '点「重新录制」再试一次；还不行就关掉软件重开。',
  'noaudio.retryDesktop': '重新录制',

  'settings.title': '设置',
  'settings.subtitle': '保存位置只影响之后的新录制；AI 设置只影响「AI 纪要 / 提问」，录屏和本地转写不需要密钥。',
  'settings.language': '语言',
  'settings.dirLabel': '录屏保存位置',
  'settings.dirNote': '只影响之后的新录制',
  'settings.choose': '选择…',
  'settings.dirDefault': '默认：{path}',
  'settings.dirHint': '改位置不会移动已有录像，历史列表仍然能看到它们。',
  'settings.apiKey': 'API Key',
  'settings.keySource': '当前来源：{src}{hint}',
  'settings.keyPlaceholder': '留空表示不修改；填 sk-... 会保存到本机',
  'settings.baseUrl': '接口地址',
  'settings.baseUrlHint': '兼容 OpenAI 协议即可，也可以填本地 Ollama，例如 http://127.0.0.1:11434/v1',
  'settings.model': '模型名',
  'settings.configPath': '保存位置：{path}',
  'settings.test': '测试连接',
  'settings.testing': '测试中…',
  'settings.testOk': '连接成功 · 模型 {model}',
  'settings.testFail': '连接失败：',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.saveFail': '保存失败：',
  'settings.importDsh': '从 DSH 导入密钥',
  'settings.importing': '导入中…',
  'settings.close': '关闭',
  'settings.source.dsh': 'DSH 凭据',
  'settings.source.config': '本机配置文件',
  'settings.source.env': '环境变量',
  'settings.source.none': '还没配置',
};

const en = {
  'app.title': 'Screen Recorder',
  'app.subtitle': 'Screen + system audio · local transcription · AI notes',
  'app.docTitle': 'Screen Recorder',

  'nav.settings': 'Settings',
  'nav.history': 'History',

  'badge.checking': 'Checking…',
  'badge.disconnected': 'Service unavailable',
  'badge.noKey': 'No AI key · click to configure',
  'badge.ready': 'AI ready · {model}{src}',

  'placeholder.title': 'Record your screen and the sound of your meetings',
  'placeholder.desc': 'Click Start, choose <b>Entire screen</b>, and tick <b>Share system audio</b>.<br />That is how audio played on this PC (meetings, videos, streams) gets recorded.',
  'placeholder.step1': '1 Entire screen',
  'placeholder.step2': '2 Share audio',
  'placeholder.step3': '3 Share',
  'placeholder.titleDesktop': 'One click: screen and system sound',
  'placeholder.descDesktop': 'The desktop app records <b>the entire screen</b> and <b>system audio</b> automatically — no picker, no checkbox.<br />Just click Start.',
  'placeholder.titleDesktopAlt': 'One click: screen and system sound',
  'placeholder.descDesktopAlt': 'The desktop app records the entire screen and system audio automatically. Just click Start.',

  'hint.idle': 'Keep this page open while recording, and make sure the meeting app is not muted. Headphones avoid the mic picking the speakers up again.',
  'hint.desktop': 'Desktop mode records right away — just keep this window open. Headphones avoid echo.',
  'hint.recording': 'Recording: keep this window open. Ask the AI anytime on the right.',
  'hint.stopping': 'Stopped — merging the video and writing the final notes…',
  'hint.done': 'Done. Video, transcript and notes are in the folder above.',

  'btn.start': 'Start recording',
  'btn.pause': 'Pause',
  'btn.resume': 'Resume',
  'btn.stop': 'Stop & generate notes',
  'opt.mic': 'Microphone',
  'quality.high': 'High 1080p·30fps',
  'quality.std': 'Standard 1080p·15fps',
  'quality.lite': 'Light 720p·15fps',

  'flag.system': 'System audio',
  'flag.mic': 'Microphone',
  'flag.sysOnly': 'System audio only',
  'rec.paused': 'Paused',
  'meter.silence': 'No audio detected: make sure system audio is shared and the meeting app is not muted',
  'meter.silenceDesktop': 'No audio detected: make sure the meeting/video is playing and the output device is right',

  'status.idle': 'Idle',
  'status.recording': 'Recording',
  'status.paused': 'Paused',
  'status.saving': 'Saving…',
  'status.processing': 'Writing notes…',
  'status.updated': 'Notes updated',
  'status.done': 'Done',
  'status.error': 'Finalize failed',
  'status.reconnecting': 'Connection lost — reconnecting…',

  'tab.transcript': 'Transcript',
  'tab.summary': 'AI notes',
  'tab.ask': 'Ask',
  'empty.transcript': 'Text appears here as you record, split at natural pauses.',
  'empty.transcriptLoading': 'Starting local speech recognition… the first sentence will appear here.',
  'empty.summary': 'AI notes update about every 30 seconds while recording.',
  'empty.ask': 'Ask anything while recording, e.g. “What was the budget?” or “Summarize the last ten minutes”.',
  'seg.count': '{n} segments',
  'seg.seekTitle': 'Click to seek to this point',
  'ask.placeholder': 'Ask something… (Enter to send, Shift+Enter for a new line)',
  'ask.send': 'Send',
  'ask.noSession': 'Start recording first — there is nothing to answer yet',
  'ask.failed': 'Failed to answer: ',

  'toast.screenDenied': 'Screen sharing failed: ',
  'toast.noMic': 'No microphone permission — recording system audio only',
  'toast.sessionFailed': 'Could not create a recording session: ',
  'toast.started': 'Recording started — loading the local speech model…',
  'toast.stoppedByUser': 'Stopped',
  'toast.stoppedByShare': 'Screen sharing stopped',
  'toast.saveFailed': 'Failed to finalize: ',
  'toast.uploadIncomplete': 'Some chunks failed to upload; the file may be incomplete',
  'toast.recorderError': 'Recorder error: ',
  'toast.reconnected': 'Connection restored',
  'toast.settingsSaved': 'Saved — new recordings go to the folder above',
  'toast.settingsSavedNoKey': 'Saved, but there is no AI key yet',
  'toast.pickFailed': 'Folder picker failed: ',
  'toast.importOk': 'Copied to the local config — AI keeps working after DSH is removed',
  'toast.importFailed': 'Import failed: ',

  'processing.title': 'Finishing up',
  'processing.desc': 'Chunks are safe on disk. Merging the video and writing the final notes.',
  'processing.hint': 'The first long summary usually takes 20–60 s. Please keep this page open.',

  'result.done': 'Recording complete',
  'result.sub': 'Duration {dur} · {n} segments · Saved in {dir}',
  'result.noVideo': 'No video data (the recording may have been too short).',
  'result.download': 'Download video',
  'result.transcript': 'Transcript .md',
  'result.summary': 'Notes .md',
  'result.regen': 'Regenerate notes',
  'result.regening': 'Generating…',
  'result.regenDone': 'Regenerated',
  'result.regenToast': 'Notes regenerated',
  'result.regenFailed': 'Regenerate failed: ',
  'result.openFolder': 'Open folder',
  'result.close': 'Close',
  'result.warn': '⚠️ AI notes failed: {err}<br />A local extract is shown below — click “Regenerate notes” to retry.',

  'history.title': 'History',
  'history.subtitleAll': 'Everything is stored locally.',
  'history.subtitleCount': '{n} recordings, all stored locally.',
  'history.empty': 'No recordings yet.',
  'history.loading': 'Loading…',
  'history.play': 'Play',
  'history.summary': 'Notes',
  'history.transcript': 'Transcript',
  'history.generate': 'Generate notes',
  'history.generating': 'Generating…',
  'history.generated': 'Done',
  'history.genToast': 'Notes generated',
  'history.genFailed': 'Failed: ',
  'history.readFailed': 'Failed to load: ',
  'history.unfinished': 'Not finished',
  'history.close': 'Close',

  'noaudio.title': 'No system audio this time',
  'noaudio.descBrowser': 'The sharing option you picked included no audio, so the recording would be silent.',
  'noaudio.howTitle': 'Try again:',
  'noaudio.step1': 'Click “Choose again”, pick <b>Entire screen</b> at the top (not a window or tab).',
  'noaudio.step2': 'Tick <b>Share system audio</b> at the bottom left.',
  'noaudio.step3': 'Click “Share”.',
  'noaudio.tip': 'If the checkbox is missing, you picked a window or tab — choose “Entire screen” instead.',
  'noaudio.retry': 'Choose again',
  'noaudio.cancel': 'Cancel',
  'noaudio.descDesktop': 'The desktop app asked for loopback audio, but the system returned an empty track.',
  'noaudio.descTitle': 'Things to check:',
  'noaudio.dstep1': 'Make sure the PC is actually playing sound (not muted, volume above zero).',
  'noaudio.dstep2': 'Make sure the default output device is the speaker/headset you are using; Bluetooth headsets that are not connected cause this.',
  'noaudio.dstep3': 'Click “Record again”; if it still fails, restart the app.',
  'noaudio.retryDesktop': 'Record again',

  'settings.title': 'Settings',
  'settings.subtitle': 'The folder only affects new recordings. AI settings only affect notes and Q&A — recording and transcription work offline.',
  'settings.language': 'Language',
  'settings.dirLabel': 'Recording location',
  'settings.dirNote': 'affects new recordings only',
  'settings.choose': 'Choose…',
  'settings.dirDefault': 'Default: {path}',
  'settings.dirHint': 'Existing files are not moved; the history list still scans old folders.',
  'settings.apiKey': 'API Key',
  'settings.keySource': 'Current source: {src}{hint}',
  'settings.keyPlaceholder': 'Leave blank to keep the current key; paste sk-... to save it locally',
  'settings.baseUrl': 'Base URL',
  'settings.baseUrlHint': 'Any OpenAI-compatible endpoint, e.g. local Ollama at http://127.0.0.1:11434/v1',
  'settings.model': 'Model',
  'settings.configPath': 'Config file: {path}',
  'settings.test': 'Test connection',
  'settings.testing': 'Testing…',
  'settings.testOk': 'Connected · model {model}',
  'settings.testFail': 'Connection failed: ',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.saveFail': 'Save failed: ',
  'settings.importDsh': 'Import key from DSH',
  'settings.importing': 'Importing…',
  'settings.close': 'Close',
  'settings.source.dsh': 'DSH credentials',
  'settings.source.config': 'local config file',
  'settings.source.env': 'environment variable',
  'settings.source.none': 'not configured',
};

const dicts = { 'zh-CN': zh, en };

let current = 'zh-CN';

export function getLocale() { return current; }

export function t(key, vars) {
  const table = dicts[current] || zh;
  let s = table[key];
  if (s === undefined) s = zh[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? '' : String(vars[name])));
}

const STATIC_ATTRS = [
  ['data-i18n', 'textContent'],
  ['data-i18n-html', 'innerHTML'],
  ['data-i18n-ph', 'placeholder'],
  ['data-i18n-title', 'title'],
];

export function applyStatic(root = document) {
  for (const [attr, prop] of STATIC_ATTRS) {
    root.querySelectorAll(`[${attr}]`).forEach((el) => {
      el[prop] = t(el.getAttribute(attr));
    });
  }
}

export function setLocale(locale, { translate = true } = {}) {
  current = dicts[locale] ? locale : 'zh-CN';
  document.documentElement.lang = current;
  try { localStorage.setItem('rec.locale', current); } catch { }
  if (translate) applyStatic();
  document.title = t('app.docTitle');
  return current;
}

export function detectLocale() {
  try {
    const saved = localStorage.getItem('rec.locale');
    if (saved && dicts[saved]) return saved;
  } catch { }
  const nav = (navigator.language || '').toLowerCase();
  return nav.startsWith('zh') ? 'zh-CN' : 'en';
}
