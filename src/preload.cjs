const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['logcat:lines', 'logcat:exit', 'screen:frame', 'screen:exit', 'view:devMode']);

contextBridge.exposeInMainWorld('explorer', {
  async call(name, ...args) {
    const result = await ipcRenderer.invoke('call', name, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  on(channel, listener) {
    if (!EVENTS.has(channel)) throw new Error(`알 수 없는 이벤트: ${channel}`);
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  // Dropped files carry no path in the sandboxed renderer; Electron resolves it here.
  pathForFile: file => webUtils.getPathForFile(file),
});
