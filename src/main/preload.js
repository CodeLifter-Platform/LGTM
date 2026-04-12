const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lgtm', {
  // PAT
  validatePat: (pat, orgUrl) => ipcRenderer.invoke('validate-pat', { pat, orgUrl }),
  clearPat: () => ipcRenderer.invoke('clear-pat'),

  // PRs
  refreshPrs: () => ipcRenderer.invoke('refresh-prs'),
  reviewPr: ({ pr, agentId, model }) => ipcRenderer.invoke('review-pr', { pr, agentId, model }),
  getReviews: () => ipcRenderer.invoke('get-reviews'),
  getReviewOutput: (key) => ipcRenderer.invoke('get-review-output', key),

  // Agents
  getAgents: () => ipcRenderer.invoke('get-agents'),
  refreshAgents: () => ipcRenderer.invoke('refresh-agents'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  getPromptConventions: () => ipcRenderer.invoke('get-prompt-conventions'),
  getRepoFileTree: (project, repoName) => ipcRenderer.invoke('get-repo-file-tree', { project, repoName }),
  pickFile: () => ipcRenderer.invoke('pick-file'),

  // Events from main → renderer
  onPrList: (cb) => ipcRenderer.on('pr-list', (_e, prs) => cb(prs)),
  onPrError: (cb) => ipcRenderer.on('pr-error', (_e, msg) => cb(msg)),
  onPatStatus: (cb) => ipcRenderer.on('pat-status', (_e, status) => cb(status)),
  onReviewUpdate: (cb) => ipcRenderer.on('review-update', (_e, data) => cb(data)),
  onReviewOutput: (cb) => ipcRenderer.on('review-output', (_e, data) => cb(data)),
  onShowSettings: (cb) => ipcRenderer.on('show-settings', () => cb()),
});
