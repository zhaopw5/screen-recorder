// Electron 桌面壳：内置本地服务 + 自动选择整个屏幕（含系统声音，WASAPI loopback）。
// 用户点「开始录制」后不会再弹系统分享框，也不用手动勾「分享系统音频」。
const { app, BrowserWindow, session, desktopCapturer, screen, shell, dialog, Menu, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

app.setName('录屏助手');
app.setAppUserModelId('com.dsh.screenrecorder');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let info = null;
  let serverApi = null;

  process.env.RECORDINGS_DIR = process.env.RECORDINGS_DIR
    || (app.isPackaged ? path.join(app.getPath('videos'), '录屏助手') : path.join(ROOT, 'recordings'));
  process.env.NO_OPEN = '1';

  async function createWindow() {
    win = new BrowserWindow({
      width: 1320,
      height: 880,
      minWidth: 1000,
      minHeight: 680,
      title: '录屏助手',
      backgroundColor: '#0a0e13',
      icon: path.join(ROOT, 'assets', 'icon.ico'),
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { win = null; });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    await win.loadURL(`http://127.0.0.1:${info.port}/`);
  }

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    ipcMain.handle('pick-folder', async () => {
      const options = { title: '选择录屏保存位置', properties: ['openDirectory', 'createDirectory'] };
      const result = win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0];
    });

    serverApi = await import(pathToFileURL(path.join(ROOT, 'server.mjs')).href);

    // 关键：完全跳过系统分享选择框，直接给「鼠标所在的屏幕」+ 系统声音
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (!sources.length) return callback({});
        // 录「录屏助手窗口所在的那块屏幕」；用户把窗口拖到副屏就能录副屏
        let display = null;
        try {
          if (win && !win.isDestroyed()) display = screen.getDisplayMatching(win.getBounds());
        } catch { }
        if (!display) display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
        callback({ video: source, audio: 'loopback' });
      } catch (err) {
        console.error('[display-media]', err);
        callback({});
      }
    }, { useSystemPicker: false });

    info = await serverApi.startServer({ port: 8787, open: false });
    await createWindow();
  }).catch((err) => {
    dialog.showErrorBox('录屏助手启动失败', String((err && err.message) || err));
    app.quit();
  });

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('before-quit', () => {
    try { serverApi && serverApi.stopAllAsr(); } catch { }
    try { info && info.close(); } catch { }
  });

  app.on('window-all-closed', () => app.quit());
}
