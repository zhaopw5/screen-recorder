// 只暴露一个「选择文件夹」能力给页面，其余 Node 能力一律不开放。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
