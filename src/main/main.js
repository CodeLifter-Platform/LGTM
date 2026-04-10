const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const { PatStore } = require('./pat-store');
const { DevOpsClient } = require('./devops-client');
const { ClaudeRunner } = require('./claude-runner');
const { WebhookServer } = require('./webhook-server');
const ElectronStore = require('electron-store');

// ── Globals ──────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let patStore = null;
let devopsClient = null;
let claudeRunner = null;
let webhookServer = null;
const config = new ElectronStore({
  defaults: {
    orgUrl: '',
    webhookPort: 3847,
    promptPath: '',         // user-override path to NYLE_PR_PROMPT.md
    pollingIntervalMs: 60000,
  },
});

// ── Single-instance lock ─────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// ── App lifecycle ────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Hide dock icon on macOS – this is a menu-bar-only app
  if (process.platform === 'darwin') app.dock.hide();

  patStore = new PatStore();
  claudeRunner = new ClaudeRunner(config);

  createTray();
  createWindow();

  // Check if PAT already stored
  const existingPat = await patStore.get();
  const orgUrl = config.get('orgUrl');
  if (existingPat && orgUrl) {
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

app.on('window-all-closed', (e) => e.preventDefault()); // keep tray alive

// ── Tray ─────────────────────────────────────────────────────────────
function createTray() {
  // Use a simple template image; on macOS the "Template" suffix enables dark/light
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-iconTemplate.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch {
    // Fallback: 16x16 transparent image
    icon = nativeImage.createEmpty();
  }
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
    width: 420,
    height: 600,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('blur', () => {
    if (!mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.hide();
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function toggleWindow() {
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    positionWindowByTray();
    mainWindow.show();
    mainWindow.focus();
  }
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

  // Start polling
  pollPrs();
  setInterval(pollPrs, config.get('pollingIntervalMs'));

  // Start webhook server
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
  // Azure DevOps sends events like 'git.pullrequest.created', 'git.pullrequest.updated', etc.
  if (event.eventType && event.eventType.startsWith('git.pullrequest')) {
    pollPrs(); // refresh immediately
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────

// PAT validation & save
ipcMain.handle('validate-pat', async (_event, { pat, orgUrl }) => {
  try {
    const client = new DevOpsClient(pat, orgUrl);
    const projects = await client.getProjects();
    if (projects && projects.length > 0) {
      await patStore.set(pat);
      config.set('orgUrl', orgUrl);
      await initDevOps(pat, orgUrl);
      return { success: true, projects: projects.map((p) => p.name) };
    }
    return { success: false, error: 'PAT valid but no projects found.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Fetch PRs on demand
ipcMain.handle('refresh-prs', async () => {
  if (!devopsClient) return { success: false, error: 'Not authenticated' };
  try {
    const prs = await devopsClient.getAllOpenPRs();
    return { success: true, prs };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Launch Claude Code review for a PR
ipcMain.handle('review-pr', async (_event, pr) => {
  const promptPath = resolvePromptPath();
  return claudeRunner.startReview(pr, promptPath);
});

// Get running reviews
ipcMain.handle('get-reviews', () => {
  return claudeRunner.getActiveReviews();
});

// Settings
ipcMain.handle('get-settings', () => {
  return {
    orgUrl: config.get('orgUrl'),
    webhookPort: config.get('webhookPort'),
    promptPath: config.get('promptPath'),
    pollingIntervalMs: config.get('pollingIntervalMs'),
  };
});

ipcMain.handle('save-settings', async (_event, settings) => {
  if (settings.promptPath !== undefined) config.set('promptPath', settings.promptPath);
  if (settings.webhookPort !== undefined) config.set('webhookPort', settings.webhookPort);
  if (settings.pollingIntervalMs !== undefined) config.set('pollingIntervalMs', settings.pollingIntervalMs);
  return { success: true };
});

ipcMain.handle('clear-pat', async () => {
  await patStore.delete();
  config.set('orgUrl', '');
  devopsClient = null;
  if (webhookServer) webhookServer.stop();
  return { success: true };
});

// ── Helpers ──────────────────────────────────────────────────────────
function resolvePromptPath() {
  const userPath = config.get('promptPath');
  if (userPath) return userPath;
  // Bundled default
  return path.join(process.resourcesPath || path.join(__dirname, '..', '..', 'resources'), 'NYLE_PR_PROMPT.md');
}
