const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lgtm', {
  // PAT
  validatePat: (pat, orgUrl) => ipcRenderer.invoke('validate-pat', { pat, orgUrl }),
  getPatStatus: () => ipcRenderer.invoke('get-pat-status'),
  clearPat: () => ipcRenderer.invoke('clear-pat'),
  getMe: () => ipcRenderer.invoke('get-me'),
  onCurrentUser: (cb) => ipcRenderer.on('current-user', (_e, u) => cb(u)),

  // PRs
  refreshPrs: () => ipcRenderer.invoke('refresh-prs'),

  // Bugs
  refreshBugs: () => ipcRenderer.invoke('refresh-bugs'),

  // Work items (non-bug tickets)
  refreshWorkItems: () => ipcRenderer.invoke('refresh-workitems'),


  // External
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  reviewPr: ({ pr, agentId, model, mode }) => ipcRenderer.invoke('review-pr', { pr, agentId, model, mode }),
  startWorkItemAction: ({ workItem, repoInfo, agentId, model, promptFile }) =>
    ipcRenderer.invoke('start-workitem-action', { workItem, repoInfo, agentId, model, promptFile }),
  getReposForProject: (project) => ipcRenderer.invoke('get-repos-for-project', project),
  cancelReview: (key) => ipcRenderer.invoke('cancel-review', key),
  getReviews: () => ipcRenderer.invoke('get-reviews'),
  getReviewOutput: (key) => ipcRenderer.invoke('get-review-output', key),
  getReviewDetail: (key) => ipcRenderer.invoke('get-review-detail', key),
  rerunReview: ({ key, agentId, model }) => ipcRenderer.invoke('rerun-review', { key, agentId, model }),
  openPath: (path) => ipcRenderer.invoke('open-path', path),
  saveLogFile: ({ key, suggestedName }) => ipcRenderer.invoke('save-log-file', { key, suggestedName }),

  // Agents
  getAgents: () => ipcRenderer.invoke('get-agents'),
  refreshAgents: () => ipcRenderer.invoke('refresh-agents'),
  onAgentsUpdated: (cb) => ipcRenderer.on('agents-updated', (_e, agents) => cb(agents)),

  // Agent test sandbox
  agentTestVersion: (agentId) => ipcRenderer.invoke('agent-test-version', { agentId }),
  agentTestSend: (agentId, model, message) => ipcRenderer.invoke('agent-test-send', { agentId, model, message }),
  agentTestStop: () => ipcRenderer.invoke('agent-test-stop'),
  onAgentTestOutput: (cb) => ipcRenderer.on('agent-test-output', (_e, data) => cb(data)),

  // Agent detail (chat against a real PR/work item)
  agentDetailPrepare: (target, agentId, model) => ipcRenderer.invoke('agent-detail-prepare', { target, agentId, model }),
  agentDetailSend: (message) => ipcRenderer.invoke('agent-detail-send', { message }),
  agentDetailStop: () => ipcRenderer.invoke('agent-detail-stop'),
  agentDetailCleanup: () => ipcRenderer.invoke('agent-detail-cleanup'),
  onAgentDetailOutput: (cb) => ipcRenderer.on('agent-detail-output', (_e, data) => cb(data)),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  getPromptConventions: () => ipcRenderer.invoke('get-prompt-conventions'),
  getRepoFileTree: (project, repoName) => ipcRenderer.invoke('get-repo-file-tree', { project, repoName }),
  pickFile: () => ipcRenderer.invoke('pick-file'),

  // Starred repos
  getStarredRepos: () => ipcRenderer.invoke('get-settings').then((s) => s.starredRepos || []),
  saveStarredRepos: (repos) => ipcRenderer.invoke('save-settings', { starredRepos: repos }),

  // Auto-updater
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', () => cb()),
  onUpdateDownloadProgress: (cb) => ipcRenderer.on('update-download-progress', (_e, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),

  // Events from main → renderer
  onPrList: (cb) => ipcRenderer.on('pr-list', (_e, prs) => cb(prs)),
  onPrError: (cb) => ipcRenderer.on('pr-error', (_e, msg) => cb(msg)),
  onPatStatus: (cb) => ipcRenderer.on('pat-status', (_e, status) => cb(status)),
  onReviewUpdate: (cb) => ipcRenderer.on('review-update', (_e, data) => cb(data)),
  onReviewOutput: (cb) => ipcRenderer.on('review-output', (_e, data) => cb(data)),
  onShowSettings: (cb) => ipcRenderer.on('show-settings', () => cb()),
});
