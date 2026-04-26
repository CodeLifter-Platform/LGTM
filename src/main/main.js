const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { PatStore } = require('./pat-store');
const { DevOpsClient } = require('./devops-client');
const { AgentRunner } = require('./agent-runner');
const { AgentRegistry } = require('./agent-registry');
const { PromptResolver } = require('./prompt-resolver');
const { WebhookServer } = require('./webhook-server');
const ElectronStore = require('electron-store');

// ── Globals ──────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let patStore = null;
let devopsClient = null;
let agentRunner = null;
let agentRegistry = null;
let webhookServer = null;
let currentPat = null;
let currentUser = null;

const config = new ElectronStore({
  defaults: {
    orgUrl: '',
    webhookPort: 3847,
    promptPath: '',           // global fallback prompt path
    pollingIntervalMs: 60000,
    defaultAgent: 'claude',
    agentModels: {},          // { agentId: selectedModelId }
    repoConfigs: {},          // { "project/repo": { mode, repoFile, customPath } }
    starredRepos: [],         // ["project/repo", ...] — starred repos are reviewed first
    maxPrAgeDays: 7,          // only auto-review PRs created within this many days
    lastUsedRepos: {},        // { [project]: "repoName" } — default for work item repo picker
    bugsAgent: '',            // agent ID for bug runs (empty = fall back to defaultAgent)
    bugsAgentModels: {},      // { [agentId]: modelId } for bug runs
    bugsRepoConfigs: {},      // { "project/repo": "relative/path/to/prompt.md" }
    ticketsAgent: '',         // agent ID for ticket runs
    ticketsAgentModels: {},
    ticketsRepoConfigs: {},
  },
});

// ── Auto-updater ────────────────────────────────────────────────────
autoUpdater.autoDownload = false;       // Don't download until user says so
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = console;

function initAutoUpdater() {
  autoUpdater.on('update-available', (info) => {
    console.log('[LGTM] Update available:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes || '',
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[LGTM] App is up to date');
    if (mainWindow) mainWindow.webContents.send('update-not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-download-progress', {
        percent: Math.round(progress.percent),
      });
    }
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('[LGTM] Update downloaded, ready to install');
    if (mainWindow) mainWindow.webContents.send('update-downloaded');
  });

  autoUpdater.on('error', (err) => {
    console.error('[LGTM] Auto-updater error:', err.message);
  });

  // Check on launch, then every 4 hours
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── Single-instance lock ─────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// ── App lifecycle ────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();

  patStore = new PatStore();
  agentRegistry = new AgentRegistry();
  agentRunner = new AgentRunner(config);

  createTray();
  createWindow();
  initAutoUpdater();

  // Kick off background model discovery — non-blocking. UI shows the
  // hardcoded fallback list immediately, then refreshes when this
  // resolves. This is how Opus 4.7 (or whatever ships next week)
  // appears without a code change.
  agentRegistry.refreshModels()
    .then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agents-updated', serializeAgents(agentRegistry.getAll()));
      }
    })
    .catch((err) => console.warn('[LGTM] Background model discovery failed:', err.message));

  const existingPat = await patStore.get();
  const orgUrl = config.get('orgUrl');
  if (existingPat && orgUrl) {
    currentPat = existingPat;
    agentRunner.setCredentials(existingPat, DevOpsClient.parseOrgUrl(orgUrl).orgUrl);
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('pat-status', { hasPat: true, orgUrl });
    });
    await initDevOps(existingPat, orgUrl);
  } else {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('pat-status', { hasPat: false, orgUrl: '' });
    });
  }
});

app.on('window-all-closed', (e) => e.preventDefault());

// ── Tray ─────────────────────────────────────────────────────────────
function createTray() {
  // macOS uses "Template" images (monochrome, auto-themed by the OS).
  // Windows needs a full-colour .ico for the system tray.
  const iconFile = process.platform === 'darwin'
    ? 'tray-iconTemplate.png'
    : 'tray-icon-win.png';
  const iconPath = path.join(__dirname, '..', 'assets', iconFile);
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.warn('[LGTM] Tray icon not found at', iconPath, '— using fallback');
    // 16x16 black dot as a visible fallback so the tray item always appears
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR42mNk+M9Qz0BBoAIGBob/DAwM9QQUMIwaMGrAqAGjBgyrMAAAFTsEEfnVaYoAAAAASUVORK5CYII='
    );
    if (process.platform === 'darwin') icon.setTemplateImage(true);
  }
  if (process.platform === 'win32') icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('LGTM — PR Reviewer');
  tray.on('click', toggleWindow);
  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show LGTM', click: toggleWindow },
      { type: 'separator' },
      { label: 'Settings…', click: () => showSettings() },
      { label: 'Quit LGTM', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.popUpContextMenu(contextMenu);
  });
}

// ── Window ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 700,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    minWidth: 380,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('blur', () => {
    if (!mainWindow.webContents.isDevToolsOpened()) mainWindow.hide();
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function toggleWindow() {
  if (mainWindow.isVisible()) { mainWindow.hide(); }
  else { positionWindowByTray(); mainWindow.show(); mainWindow.focus(); }
}

function positionWindowByTray() {
  const trayBounds = tray.getBounds();
  const winBounds = mainWindow.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  const y = process.platform === 'darwin'
    ? trayBounds.y + trayBounds.height + 4
    : trayBounds.y - winBounds.height - 4;
  mainWindow.setPosition(x, y, false);
}

function showSettings() {
  mainWindow.webContents.send('show-settings');
  if (!mainWindow.isVisible()) toggleWindow();
}

// ── DevOps initialisation ────────────────────────────────────────────
async function initDevOps(pat, orgUrl) {
  devopsClient = new DevOpsClient(pat, orgUrl);

  // Identify the authenticated user so the UI can flag "my PRs".
  try {
    currentUser = await devopsClient.getMe();
    console.log(`[LGTM] Authenticated as: ${currentUser.displayName || currentUser.email || currentUser.id}`);
    if (mainWindow) mainWindow.webContents.send('current-user', currentUser);
    if (agentRunner) agentRunner.setIdentity(currentUser);
  } catch (err) {
    console.warn('[LGTM] Could not resolve current user:', err.message);
    currentUser = null;
    if (agentRunner) agentRunner.setIdentity(null);
  }

  pollPrs();
  setInterval(pollPrs, config.get('pollingIntervalMs'));

  webhookServer = new WebhookServer(config.get('webhookPort'), (event) => {
    handleWebhookEvent(event);
  });
  webhookServer.start();
}

async function pollPrs() {
  try {
    const prs = await devopsClient.getAllOpenPRs();
    mainWindow.webContents.send('pr-list', prs);
  } catch (err) {
    mainWindow.webContents.send('pr-error', err.message);
  }
}

function handleWebhookEvent(event) {
  if (event.eventType && event.eventType.startsWith('git.pullrequest')) {
    pollPrs();
  }
}

// ── IPC: Authentication ──────────────────────────────────────────────

/**
 * Race a promise against a timeout. Used to guarantee the PAT-validation
 * IPC always returns to the renderer in bounded time, even if the
 * underlying SDK call hangs (DevOps slow path, DNS issue, keychain
 * prompt firing invisibly behind LGTM).
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    )),
  ]);
}

ipcMain.handle('validate-pat', async (_event, { pat, orgUrl }) => {
  try {
    const client = new DevOpsClient(pat, orgUrl);
    const parsed = DevOpsClient.parseOrgUrl(orgUrl);
    console.log(`[LGTM] Connecting to org: ${parsed.orgUrl}${parsed.project ? ` (project filter: ${parsed.project})` : ''}`);

    // The ONLY thing we await is the call that proves the PAT actually
    // works against this org. Everything else (keychain persistence,
    // getMe(), webhook server, PR poll) runs in the background after
    // we return — the renderer hooks events for whatever it needs.
    const projects = await withTimeout(client.getProjects(), 20000, 'getProjects');
    if (!projects || projects.length === 0) {
      return { success: false, error: 'PAT valid but no projects found.' };
    }

    // In-memory state is set synchronously so subsequent IPC calls
    // (loadAgents, getSettings, refresh-prs) work immediately.
    config.set('orgUrl', orgUrl);
    currentPat = pat;
    agentRunner.setCredentials(pat, parsed.orgUrl);

    // Persist the PAT and finish wiring up DevOps in the background.
    // electron-store writes to disk synchronously, so even if keytar
    // hangs on a hidden keychain prompt the fallback store still has
    // the PAT for next launch.
    patStore.set(pat).catch((err) => {
      console.warn('[LGTM] PAT persistence failed (in-memory still works):', err.message);
    });
    initDevOps(pat, orgUrl).catch((err) => {
      console.warn('[LGTM] initDevOps error (background):', err.message);
    });

    return {
      success: true,
      projects: projects.map((p) => p.name),
      filterNote: parsed.project ? ` Filtered to project "${parsed.project}".` : '',
    };
  } catch (err) {
    const status = err.response?.status;
    const parsed = DevOpsClient.parseOrgUrl(orgUrl);
    let msg = err.message;
    if (status === 404) msg = `404 Not Found — API call to ${parsed.orgUrl}/_apis/projects failed. Check your org URL.`;
    else if (status === 401 || status === 403) msg = `${status} — PAT was rejected. Make sure it hasn't expired and has Code (Read) scope.`;
    return { success: false, error: msg };
  }
});

ipcMain.handle('clear-pat', async () => {
  await patStore.delete();
  config.set('orgUrl', '');
  currentPat = null;
  currentUser = null;
  devopsClient = null;
  if (webhookServer) webhookServer.stop();
  return { success: true };
});

ipcMain.handle('get-me', () => currentUser);

// ── IPC: PRs ─────────────────────────────────────────────────────────

ipcMain.handle('refresh-prs', async () => {
  if (!devopsClient) return { success: false, error: 'Not authenticated' };
  try {
    const prs = await devopsClient.getAllOpenPRs();
    return { success: true, prs };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── IPC: Bugs ────────────────────────────────────────────────────────

ipcMain.handle('refresh-bugs', async () => {
  if (!devopsClient) return { success: false, error: 'Not authenticated' };
  try {
    const bugs = await devopsClient.getMyOpenBugs();
    return { success: true, bugs };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('refresh-workitems', async () => {
  if (!devopsClient) return { success: false, error: 'Not authenticated' };
  try {
    const items = await devopsClient.getMyOpenWorkItems();
    return { success: true, items };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── IPC: Reviews ─────────────────────────────────────────────────────

ipcMain.handle('review-pr', async (_event, { pr, agentId, model, mode }) => {
  const agent = agentId || config.get('defaultAgent') || 'claude';
  const mdl = model || config.get('agentModels')[agent] || null;
  return agentRunner.startReview(pr, agent, mdl, mode || 'review');
});

ipcMain.handle('start-workitem-action', async (_event, { workItem, repoInfo, agentId, model, promptFile }) => {
  const agent = agentId || config.get('defaultAgent') || 'claude';
  const mdl = model || config.get('agentModels')[agent] || null;
  // Persist last-used repo per project so the picker can default to it.
  const lastUsed = { ...(config.get('lastUsedRepos') || {}) };
  lastUsed[repoInfo.project] = repoInfo.repo;
  config.set('lastUsedRepos', lastUsed);
  return agentRunner.startWorkItemAction(workItem, repoInfo, agent, mdl, { promptFile });
});

ipcMain.handle('get-repos-for-project', async (_event, project) => {
  if (!devopsClient) return { success: false, error: 'Not authenticated', repos: [] };
  try {
    const repos = await devopsClient.getRepos(project);
    return {
      success: true,
      repos: (repos || []).map((r) => ({ id: r.id, name: r.name })),
    };
  } catch (err) {
    return { success: false, error: err.message, repos: [] };
  }
});

ipcMain.handle('get-reviews', () => {
  return agentRunner.getActiveReviews();
});

ipcMain.handle('cancel-review', (_event, key) => {
  return agentRunner.cancelReview(key);
});

ipcMain.handle('get-review-output', (_event, key) => {
  return agentRunner.getReviewOutput(key);
});

ipcMain.handle('get-review-detail', (_event, key) => {
  return agentRunner.getReviewDetail(key);
});

ipcMain.handle('rerun-review', async (_event, { key, agentId, model }) => {
  return agentRunner.rerunReview(key, { agentId, model });
});

ipcMain.handle('open-path', (_event, p) => {
  if (typeof p !== 'string' || !p) return { success: false, error: 'No path provided' };
  // Pass to the OS shell — it picks Finder/Explorer based on platform.
  return shell.openPath(p).then((err) => err ? { success: false, error: err } : { success: true });
});

ipcMain.handle('save-log-file', async (_event, { key, suggestedName }) => {
  const review = agentRunner.getReviewDetail(key);
  if (!review) return { success: false, error: 'No review found' };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save agent log',
    defaultPath: suggestedName || `lgtm-${key.replace(/[\\/:*?"<>|]/g, '_')}.log`,
    filters: [{ name: 'Log', extensions: ['log', 'txt'] }, { name: 'All', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, cancelled: true };
  try {
    require('fs').writeFileSync(result.filePath, review.output || '', 'utf8');
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── IPC: Agents ──────────────────────────────────────────────────────

function serializeAgents(agentList) {
  return agentList.map(({ buildCmd, ...rest }) => rest);
}

ipcMain.handle('get-agents', () => serializeAgents(agentRegistry.getAll()));

ipcMain.handle('refresh-agents', async () => {
  agentRegistry.refresh();
  // User-triggered refresh from settings — wait for discovery so the
  // returned list reflects what the dropdown will show.
  await agentRegistry.refreshModels();
  return serializeAgents(agentRegistry.getAll());
});

// ── IPC: Settings ────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => ({
  orgUrl: config.get('orgUrl'),
  webhookPort: config.get('webhookPort'),
  promptPath: config.get('promptPath'),
  pollingIntervalMs: config.get('pollingIntervalMs'),
  defaultAgent: config.get('defaultAgent'),
  agentModels: config.get('agentModels'),
  repoConfigs: config.get('repoConfigs'),
  starredRepos: config.get('starredRepos'),
  maxPrAgeDays: config.get('maxPrAgeDays'),
  lastUsedRepos: config.get('lastUsedRepos'),
  bugsAgent: config.get('bugsAgent'),
  bugsAgentModels: config.get('bugsAgentModels'),
  bugsRepoConfigs: config.get('bugsRepoConfigs'),
  ticketsAgent: config.get('ticketsAgent'),
  ticketsAgentModels: config.get('ticketsAgentModels'),
  ticketsRepoConfigs: config.get('ticketsRepoConfigs'),
}));

ipcMain.handle('save-settings', async (_event, settings) => {
  if (settings.promptPath !== undefined) config.set('promptPath', settings.promptPath);
  if (settings.webhookPort !== undefined) config.set('webhookPort', settings.webhookPort);
  if (settings.pollingIntervalMs !== undefined) config.set('pollingIntervalMs', settings.pollingIntervalMs);
  if (settings.defaultAgent !== undefined) config.set('defaultAgent', settings.defaultAgent);
  if (settings.agentModels !== undefined) config.set('agentModels', settings.agentModels);
  if (settings.repoConfigs !== undefined) config.set('repoConfigs', settings.repoConfigs);
  if (settings.starredRepos !== undefined) config.set('starredRepos', settings.starredRepos);
  if (settings.maxPrAgeDays !== undefined) config.set('maxPrAgeDays', settings.maxPrAgeDays);
  if (settings.lastUsedRepos !== undefined) config.set('lastUsedRepos', settings.lastUsedRepos);
  if (settings.bugsAgent !== undefined) config.set('bugsAgent', settings.bugsAgent);
  if (settings.bugsAgentModels !== undefined) config.set('bugsAgentModels', settings.bugsAgentModels);
  if (settings.bugsRepoConfigs !== undefined) config.set('bugsRepoConfigs', settings.bugsRepoConfigs);
  if (settings.ticketsAgent !== undefined) config.set('ticketsAgent', settings.ticketsAgent);
  if (settings.ticketsAgentModels !== undefined) config.set('ticketsAgentModels', settings.ticketsAgentModels);
  if (settings.ticketsRepoConfigs !== undefined) config.set('ticketsRepoConfigs', settings.ticketsRepoConfigs);
  return { success: true };
});

// ── IPC: Prompt conventions (for settings UI) ────────────────────────

ipcMain.handle('get-prompt-conventions', () => {
  return PromptResolver.getConventionPaths();
});

// ── IPC: Repo file tree (for autocomplete) ──────────────────────────

ipcMain.handle('get-repo-file-tree', async (_event, { project, repoName }) => {
  if (!devopsClient) return { success: false, error: 'Not authenticated', files: [] };
  try {
    const files = await devopsClient.getRepoFileTree(project, repoName);
    return { success: true, files };
  } catch (err) {
    console.error(`[LGTM] Failed to fetch file tree for ${project}/${repoName}:`, err.message);
    return { success: false, error: err.message, files: [] };
  }
});

// ── IPC: External URL ────────────────────────────────────────────────

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url !== 'string') return { success: false };
  // Only allow http(s) to avoid opening arbitrary schemes from the renderer.
  if (!/^https?:\/\//i.test(url)) return { success: false };
  shell.openExternal(url);
  return { success: true };
});

// ── IPC: Auto-updater ──────────────────────────────────────────────

ipcMain.handle('check-for-update', () => autoUpdater.checkForUpdates().catch(() => null));
ipcMain.handle('download-update', () => autoUpdater.downloadUpdate().catch(() => null));
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall(false, true));
ipcMain.handle('get-app-version', () => app.getVersion());

// ── IPC: Native file picker ─────────────────────────────────────────

ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a prompt file',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'txt', 'markdown'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, filePath: result.filePaths[0] };
});
