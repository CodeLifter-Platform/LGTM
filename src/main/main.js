const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
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

const config = new ElectronStore({
  defaults: {
    orgUrl: '',
    webhookPort: 3847,
    promptPath: '',           // global fallback prompt path
    pollingIntervalMs: 60000,
    defaultAgent: 'claude',
    agentModels: {},          // { agentId: selectedModelId }
    repoConfigs: {},          // { "project/repo": { mode, repoFile, customPath } }
  },
});

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
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-iconTemplate.png');
  let icon;
  try { icon = nativeImage.createFromPath(iconPath); }
  catch { icon = nativeImage.createEmpty(); }
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

ipcMain.handle('validate-pat', async (_event, { pat, orgUrl }) => {
  try {
    const client = new DevOpsClient(pat, orgUrl);
    const parsed = DevOpsClient.parseOrgUrl(orgUrl);
    console.log(`[LGTM] Connecting to org: ${parsed.orgUrl}${parsed.project ? ` (project filter: ${parsed.project})` : ''}`);

    const projects = await client.getProjects();
    if (projects && projects.length > 0) {
      await patStore.set(pat);
      config.set('orgUrl', orgUrl);
      currentPat = pat;
      agentRunner.setCredentials(pat, parsed.orgUrl);
      await initDevOps(pat, orgUrl);

      const projectNames = projects.map((p) => p.name);
      const filterNote = parsed.project ? ` Filtered to project "${parsed.project}".` : '';
      return { success: true, projects: projectNames, filterNote };
    }
    return { success: false, error: 'PAT valid but no projects found.' };
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
  devopsClient = null;
  if (webhookServer) webhookServer.stop();
  return { success: true };
});

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

// ── IPC: Reviews ─────────────────────────────────────────────────────

ipcMain.handle('review-pr', async (_event, { pr, agentId, model }) => {
  const agent = agentId || config.get('defaultAgent') || 'claude';
  const mdl = model || config.get('agentModels')[agent] || null;
  return agentRunner.startReview(pr, agent, mdl);
});

ipcMain.handle('get-reviews', () => {
  return agentRunner.getActiveReviews();
});

ipcMain.handle('get-review-output', (_event, key) => {
  return agentRunner.getReviewOutput(key);
});

// ── IPC: Agents ──────────────────────────────────────────────────────

function serializeAgents(agentList) {
  return agentList.map(({ buildCmd, ...rest }) => rest);
}

ipcMain.handle('get-agents', () => serializeAgents(agentRegistry.getAll()));

ipcMain.handle('refresh-agents', () => {
  agentRegistry.refresh();
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
}));

ipcMain.handle('save-settings', async (_event, settings) => {
  if (settings.promptPath !== undefined) config.set('promptPath', settings.promptPath);
  if (settings.webhookPort !== undefined) config.set('webhookPort', settings.webhookPort);
  if (settings.pollingIntervalMs !== undefined) config.set('pollingIntervalMs', settings.pollingIntervalMs);
  if (settings.defaultAgent !== undefined) config.set('defaultAgent', settings.defaultAgent);
  if (settings.agentModels !== undefined) config.set('agentModels', settings.agentModels);
  if (settings.repoConfigs !== undefined) config.set('repoConfigs', settings.repoConfigs);
  return { success: true };
});

// ── IPC: Prompt conventions (for settings UI) ────────────────────────

ipcMain.handle('get-prompt-conventions', () => {
  return PromptResolver.getConventionPaths();
});
