const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, ...a) => cb(...a);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    export: () => ipcRenderer.invoke('settings:export'),
    import: () => ipcRenderer.invoke('settings:import')
  },
  profiles: {
    save: (profile) => ipcRenderer.invoke('profile:save', profile),
    create: (name, starter) => ipcRenderer.invoke('profile:create', name, starter),
    remove: (id) => ipcRenderer.invoke('profile:delete', id),
    reorder: (ids) => ipcRenderer.invoke('profile:reorder', ids),
    runNow: (id) => ipcRenderer.invoke('profile:run', id),
    openOutput: (id) => ipcRenderer.invoke('profile:open-output', id)
  },
  feed: { test: (feed, profileId, raw) => ipcRenderer.invoke('feed:test', feed, profileId, raw) },
  digest: { send: () => ipcRenderer.invoke('digest:send') },
  cliInfo: () => ipcRenderer.invoke('cli:info'),
  placeholderPreview: (file) => ipcRenderer.invoke('placeholder:preview', file),
  scheduler: {
    status: () => ipcRenderer.invoke('scheduler:status'),
    setPaused: (paused) => ipcRenderer.invoke('scheduler:set-paused', paused)
  },
  pick: { folder: () => ipcRenderer.invoke('pick:folder'), image: () => ipcRenderer.invoke('pick:image') },
  logs: { get: () => ipcRenderer.invoke('logs:get'), openFolder: () => ipcRenderer.invoke('logs:open-folder') },
  telegram: { test: (cfg) => ipcRenderer.invoke('telegram:test', cfg) },
  email: { test: (cfg) => ipcRenderer.invoke('email:test', cfg) },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    reveal: (file) => ipcRenderer.invoke('update:reveal', file),
    onProgress: on('update:progress')
  },
  onStatus: on('status:update'),
  onLog: on('log:entry'),
  onSettings: on('settings:changed'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
