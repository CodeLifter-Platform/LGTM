const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lgtm', {
  // PAT
  validatePat: (pat, orgUrl) => ipcRenderer.invoke('validate-pat', { pat, orgUrl }),
  clearPat: () => ipcRenderer.invoke('clear-pat'),

  // PRs
  refreshPrs: () => ipcRenderer.invoke('refresh-prs'),
  reviewPr: (pr) => ipcRenderer.invoke('review-pr', pr),
  getReviews: () => ipcRenderer.invoke('get-reviews'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // Events from main → renderer
  onPrList: (cb) => ipcRenderer.on('pr-list', (_e, prs) => cb(prs)),
  onPrError: (cb) => ipcRenderer.on('pr-error', (_e, msg) => cb(msg)),
  onPatStatus: (cb) => ipcRenderer.on('pat-status', (_e, status) => cb(status)),
  onReviewUpdate: (cb) => ipcRenderer.on('review-update', (_e, data) => cb(data)),
  onShowSettings: (cb) => ipcRenderer.on('show-settings', () => cb()),
});
