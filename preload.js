const { contextBridge, ipcRenderer, webFrame } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, p) => cb(p));

contextBridge.exposeInMainWorld('api', {
  authStatus: call('auth:status'), authCreate: call('auth:create'), authLogin: call('auth:login'),
  authLogout: call('auth:logout'), addUser: call('auth:adduser'), passwd: call('auth:passwd'),
  getSettings: call('settings:get'), setSettings: call('settings:set'),
  listModels: call('models:list'), pullModel: call('models:pull'), pullCancel: call('models:pullCancel'),
  setupStatus: call('setup:status'), setupRun: call('setup:run'), setupCancel: call('setup:cancel'),
  send: call('chat:send'), stop: call('chat:stop'), clear: call('chat:clear'),
  compact: call('chat:compact'), transcript: call('chat:transcript'), respond: call('approval:respond'),
  pickFolder: call('folder:pick'), openFolder: call('folder:open'), closeFolder: call('folder:close'),
  listDir: call('ws:list'), searchFiles: call('ws:search'), readFile: call('file:read'), writeFile: call('file:write'), exportText: call('ws:export'), quit: call('app:quit'),
  termOpen: call('term:open'), termInput: call('term:input'), termResize: call('term:resize'), termClose: call('term:close'),
  // generic bridge for features: only "feat:" channels
  setZoom: (f) => webFrame.setZoomFactor(f),
  call: (ch, ...a) => (String(ch).startsWith('feat:') ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('Blocked channel'))),
  on: (ch, cb) => { if (String(ch).startsWith('feat:')) ipcRenderer.on(ch, (_e, p) => cb(p)); },
  onChat: on('chat:event'), onPull: on('pull:progress'), onSetup: on('setup:progress'),
  onTermData: on('term:data'), onTermExit: on('term:exit'), onFsChanged: on('fs:changed'), onReloadKey: on('app:reload'),
});
