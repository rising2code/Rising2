const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('api', {
  openFolder: call('dialog:openFolder'),
  openFile: call('dialog:openFile'),
  saveFile: call('dialog:saveFile'),
  confirm: call('dialog:confirm'),
  exists: call('fs:exists'),
  readText: call('fs:readText'),
  readBinary: call('fs:readBinary'),
  writeFile: call('fs:writeFile'),
  list: call('fs:list'),
  listRecursive: call('fs:listRecursive'),
  copyDir: call('fs:copyDir'),
  remove: call('fs:remove'),
  appDir: call('path:appDir'),
  args: call('app:args'),
  clipboardRead: call('clipboard:read'),
  clipboardWrite: call('clipboard:write'),
  openPath: call('shell:open'),
  loadSettings: call('settings:load'),
  saveSettings: call('settings:save'),
});
