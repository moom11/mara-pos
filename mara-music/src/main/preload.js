'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * جسر آمن بين نافذة المشغّل والعملية الرئيسية.
 * الأوامر تنزل من العملية الرئيسية، والأحداث تصعد من محرّك الصوت.
 */
contextBridge.exposeInMainWorld('mara', {
  onCommand(handler) {
    ipcRenderer.on('player-command', (_event, command) => handler(command));
  },
  emit(event) {
    ipcRenderer.send('player-event', event);
  },
  ready() {
    ipcRenderer.send('player-ready');
  },
  onScreen(handler) {
    ipcRenderer.on('screen-update', (_event, data) => handler(data));
  },
  requestScreen() {
    ipcRenderer.send('screen-request');
  },
  staffAction(action) {
    ipcRenderer.send('staff-action', action);
  }
});
