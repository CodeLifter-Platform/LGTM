const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog, Notification } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const ElectronStore = require('electron-store');
const { TokenStore } = require('./token-store');
const { PROVIDER_IDS, getProvider, describeProvider, Connection } = require('./providers');
const { AgentRunner } = require('./agent-runner');
const { AgentRegistry, initPath: initAgentPath } = require('./agent-registry');
const { PromptResolver } = require('./prompt-resolver');
const { PrPoller } = require('./pr-poller');
const { WebhookServer } = require('./webhook-server');
const { rawHttp } = require('./raw-http');
const { createRendererNotifier } = require('./renderer-notify');
const { createSettingsStore, readSettings, writeSettings } = require('./settings');
const { applyPrFilter } = require('./core/pr-filter');
const { applySessionFlags } = require('./core/session-flags');
const { serializeAgents } = require('./core/serialize-agents');
const { buildPrDetailPrompt, buildWorkItemDetailPrompt } = require('./core/detail-prompts');
const { validateConnection } = require('./core/validate-pat');

// ── Globals ──────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let tokenStore = null;
let agentRunner = null;
let agentRegistry = null;
let webhookServer = null;

// One Connection per connected git service, keyed by provider id. Each
// carries its own PrPoller (`conn.poller`) so services poll independently
// and a re-connect replaces the old poller instead of stacking a second
// interval. A service whose stored token was rejected at startup lands in
// `rejectedAtStartup` so the renderer can say why the user is back on the
// connect screen; the flag clears the moment a fresh token is accepted.
// `storageWarnings` holds, per provider, why the OS keychain refused to
// store or hand back the token, so the renderer can say the token lives
// in memory only for this session.
const connections = new Map();
const rejectedAtStartup = new Set();
const storageWarnings = new Map();

// Settings live in config.json under userData. Every key, its default and
// the corrupt-file guard are in ./settings.js; this file only wires the
// Electron-aware store class in.
const config = createSettingsStore(ElectronStore);

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ── Auto-updater ────────────────────────────────────────────────────
autoUpdater.autoDownload = false;       // Don't download until user says so
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = console;

/**
 * Show a native OS notification that opens the tray window when clicked.
 * No-op when the OS doesn't support notifications (rare). We hold a
 * reference for the lifetime of the notification because GC can drop
 * it mid-flight on some platforms otherwise.
 */
let activeUpdateNotification = null;
function notifyUpdate(title, body) {
  if (!Notification.isSupported()) return;
  if (activeUpdateNotification) {
    try { activeUpdateNotification.close(); } catch { /* ignore */ }
  }
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) {
      try { positionWindowByTray(); } catch { /* ignore — tray not ready */ }
      mainWindow.show();
    }
    mainWindow.focus();
  });
  n.show();
  activeUpdateNotification = n;
}

function initAutoUpdater() {
  autoUpdater.on('update-available', (info) => {
    console.log('[LGTM] Update available:', info.version);
    // Native OS alert — visible even with the tray window hidden, which
    // is the default state of this app on macOS (dock hidden, tray-only).
    notifyUpdate('LGTM update available', `Version ${info.version} is ready to download.`);
    // Tray tooltip — persistent indicator after the notification fades.
    if (tray) tray.setToolTip(`LGTM — Update v${info.version} available`);
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
    notifyUpdate('LGTM update ready', 'Click to open LGTM and restart to install.');
    if (tray) tray.setToolTip('LGTM — Update ready to install');
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
// On macOS and Windows the tray is a dependable entry point, so the window can be a
// frameless popover hanging off it. On Linux it is not: tray support varies by desktop
// (GNOME needs an extension) and Electron's tray.getBounds() is unsupported there, so a
// tray-only app can end up with no way to open it at all. Linux therefore gets an
// ordinary window — framed, in the taskbar, shown at launch.
const TRAY_ONLY = process.platform === 'darwin' || process.platform === 'win32';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// Relaunching from the launcher should surface the existing instance rather than
// silently doing nothing. This matters most on Linux: closing the window only hides it,
// and without a dependable tray icon that would otherwise leave the app unreachable.
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

function storedUrlFor(providerId) {
  if (providerId === 'azure-devops') return config.get('orgUrl') || '';
  const urls = config.get('providerUrls') || {};
  return urls[providerId] || '';
}

function storeUrlFor(providerId, url) {
  if (providerId === 'azure-devops') { config.set('orgUrl', url); return; }
  const urls = { ...(config.get('providerUrls') || {}) };
  if (url) urls[providerId] = url; else delete urls[providerId];
  config.set('providerUrls', urls);
}

function activeProviderId() {
  const stored = config.get('activeProvider');
  if (stored && connections.has(stored)) return stored;
  const first = connections.keys().next();
  return first.done ? '' : first.value;
}

/** Renderer-safe snapshot of every provider: connected or not, and why. */
function connectionStatus() {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const conn = connections.get(id);
    providers[id] = conn
      ? conn.toStatus()
      : { providerId: id, label: getProvider(id).label, short: getProvider(id).short, connected: false, url: storedUrlFor(id), rejected: rejectedAtStartup.has(id) };
    providers[id].storageWarning = storageWarnings.get(id) || null;
  }
  return { providers, activeProvider: activeProviderId(), hasConnection: connections.size > 0 };
}

function broadcastConnectionStatus() {
  sendToRenderer('connection-status', connectionStatus());
}

/**
 * Restore every provider that has a stored token. The token is fast-checked
 * so a dead one never lets the main UI open for that service — the renderer
 * sees it disconnected with `rejected: true`. A network blip gives the
 * cached token the benefit of the doubt so the user isn't locked out
 * offline.
 */
async function restoreConnections() {
  for (const providerId of PROVIDER_IDS) {
    const stored = await tokenStore.get(providerId);
    if (stored.error) storageWarnings.set(providerId, stored.error);
    const token = stored.token;
    const url = storedUrlFor(providerId);
    if (!token || !url) continue;
    const provider = getProvider(providerId);
    const t0 = Date.now();
    const check = await provider.quickValidate(token, url, rawHttp);
    console.log(`[LGTM] Startup ${provider.label} token check: ${check.ok ? 'ok' : check.reason} in ${Date.now() - t0}ms`);
    if (check.ok || check.reason === 'unreachable') {
      activateConnection(new Connection(providerId, token, url));
    } else {
      rejectedAtStartup.add(providerId);
    }
  }
}

/**
 * Register a connection everywhere it is needed and kick off its data. A
 * second connect for the same service (re-validating a token) replaces the
 * first: its poller is stopped before the new one starts.
 */
function activateConnection(conn) {
  const previous = connections.get(conn.providerId);
  if (previous) teardownConnection(previous);
  connections.set(conn.providerId, conn);
  rejectedAtStartup.delete(conn.providerId);
  agentRunner.setConnection(conn);
  if (!config.get('activeProvider') || !connections.has(config.get('activeProvider'))) {
    config.set('activeProvider', conn.providerId);
  }
  initConnection(conn).catch((err) => {
    console.warn(`[LGTM] init ${conn.label} error (background):`, err.message);
  });
  broadcastConnectionStatus();
}

// ── App lifecycle ────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();

  // Rebuild PATH from the user's login shell before any CLI lookup. This
  // used to run at import time of agent-registry.js, which spawned a shell
  // for every module that required it (tests included).
  initAgentPath();

  tokenStore = new TokenStore();
  agentRegistry = new AgentRegistry();
  agentRunner = new AgentRunner(config, {
    registry: agentRegistry,
    notify: createRendererNotifier(),
  });

  // Restore saved connections and wire up clients BEFORE creating the
  // window. The renderer pulls connection status on boot; if we created
  // the window first, there'd be a race where the renderer could invoke
  // the IPC handler before the connections were populated. Doing it
  // first guarantees the answer is ready, and we deliberately await the
  // token checks so the answer is final by the time the renderer asks.
  await restoreConnections();

  // A tray failure must never take the app down with it. On macOS/Windows that would be
  // fatal anyway (the tray is the only entry point), but on Linux the window stands on
  // its own, so a desktop without tray support should degrade to a normal app.
  try {
    createTray();
  } catch (err) {
    if (TRAY_ONLY) throw err;
    console.warn('[LGTM] tray unavailable on this desktop — continuing without it:', err.message);
  }
  createWindow();
  // Linux has no dependable tray to click, so the window has to appear on its own.
  if (!TRAY_ONLY) { mainWindow.show(); mainWindow.focus(); }
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
});

// Renderer asks for connection status as part of its own boot sequence —
// guaranteed to arrive at a moment when the renderer is ready to react to
// the answer. A provider with `rejected: true` lets the renderer pre-fill
// its URL and tell the user *why* they're back on the connect screen.
ipcMain.handle('get-connection-status', () => connectionStatus());
ipcMain.handle('get-providers', () => PROVIDER_IDS.map(describeProvider));

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
    width: 960,
    height: 700,
    show: false,
    frame: !TRAY_ONLY,
    resizable: true,
    skipTaskbar: TRAY_ONLY,
    alwaysOnTop: TRAY_ONLY,
    minWidth: 760,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Hide-on-blur is popover behaviour. On a normal windowed app it makes the window
  // vanish the moment you click anything else, so it stays off on Linux.
  if (TRAY_ONLY) {
    mainWindow.on('blur', () => {
      if (!mainWindow.webContents.isDevToolsOpened()) mainWindow.hide();
    });
  }

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function toggleWindow() {
  if (mainWindow.isVisible()) { mainWindow.hide(); }
  else { positionWindowByTray(); mainWindow.show(); mainWindow.focus(); }
}

function positionWindowByTray() {
  // tray.getBounds() is macOS/Windows only; on Linux it returns zeroes, which would
  // park the window off-screen. Centre instead.
  if (!TRAY_ONLY || !tray) { mainWindow.center(); return; }
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

// ── Connection initialisation ───────────────────────────────────────
async function initConnection(conn) {
  // Identify the authenticated user so the UI can flag "my PRs" and the
  // agent prompts can name who they act as.
  try {
    conn.user = await conn.client.getMe();
    console.log(`[LGTM] ${conn.label}: authenticated as ${conn.describeUser()}`);
    sendToRenderer('current-user', { provider: conn.providerId, user: conn.toStatus().user });
    agentRunner.setIdentity(conn.providerId, conn.user);
  } catch (err) {
    console.warn(`[LGTM] ${conn.label}: could not resolve current user:`, err.message);
    conn.user = null;
    agentRunner.setIdentity(conn.providerId, null);
  }
  // A newer connect or a disconnect raced us while getMe was in flight:
  // the newer one owns the service; don't start a poller for a dead one.
  if (connections.get(conn.providerId) !== conn) return;

  // One poller per service. A fetch that throws reports the error and keeps
  // the last good list on screen; the next success clears it (pr-poller.js).
  conn.poller = new PrPoller({
    fetch: () => conn.client.getAllOpenPRs(),
    intervalMs: config.get('pollingIntervalMs'),
    onList: (prs) => sendToRenderer('pr-list', { provider: conn.providerId, prs }),
    onError: (message) => sendToRenderer('pr-error', { provider: conn.providerId, message }),
    log: console.log,
  });
  conn.poller.start();
  await ensureWebhookServer();
}

/** Stop a connection's poller; the webhook server is shared and stays. */
function teardownConnection(conn) {
  if (conn && conn.poller) {
    conn.poller.stop();
    conn.poller = null;
  }
}

/**
 * The webhook server is shared by every connected service and started
 * once. A port already in use is reported, not fatal: polling still works.
 */
async function ensureWebhookServer() {
  if (webhookServer) return;
  const server = new WebhookServer(config.get('webhookPort'), (event, headers) => handleWebhookEvent(event, headers), {
    host: config.get('webhookHost'),
    secret: config.get('webhookSecret'),
    log: console.log,
  });
  webhookServer = server;
  try {
    await server.start();
  } catch (err) {
    console.warn(`[LGTM] Webhook server could not start on ${config.get('webhookHost') || 'loopback'}:${config.get('webhookPort')}: ${err.message}`);
    if (webhookServer === server) webhookServer = null;
  }
}

async function stopWebhookServer() {
  const server = webhookServer;
  webhookServer = null;
  if (server) await server.stop();
}

/** Re-poll one service now (webhook event, manual refresh). No-op when not connected. */
function pollPrs(providerId) {
  const conn = connections.get(providerId);
  return conn && conn.poller ? conn.poller.pollNow() : Promise.resolve();
}

/** Route a webhook to whichever connected service recognises it. */
function handleWebhookEvent(event, headers) {
  for (const conn of connections.values()) {
    if (conn.provider.isWebhookEvent(event, headers)) {
      pollPrs(conn.providerId);
      return;
    }
  }
}

// ── IPC: Authentication ──────────────────────────────────────────────

ipcMain.handle('connect-provider', async (_event, { providerId, token, url }) => {
  let provider;
  try { provider = getProvider(providerId); } catch (err) { return { success: false, error: err.message }; }
  if (!token || !url) return { success: false, error: 'Both the URL and the token are required.' };

  let conn;
  try {
    conn = new Connection(providerId, token, url);
  } catch (err) {
    return { success: false, error: err.message };
  }
  console.log(`[LGTM] Connecting to ${provider.label}: ${conn.display}`);

  // The one network call we await is the one that proves the token works
  // against this service; every failure mode is mapped to a sentence in
  // core/validate-pat.js. getMe(), the webhook server and the PR poll run in
  // the background after we return.
  const result = await validateConnection({ token, url, provider, createClient: () => conn.client });
  if (!result.success) return result;

  // In-memory state is set synchronously so subsequent IPC calls
  // (loadAgents, getSettings, refresh-prs) work immediately.
  storeUrlFor(providerId, url);
  config.set('activeProvider', providerId);
  activateConnection(conn);

  // Persist the token to the OS keychain. The write is capped at a few
  // seconds, and its outcome is reported, not assumed: a refusing keychain
  // means the token is in memory for this session only, and the renderer
  // says so.
  const storage = await tokenStore.set(providerId, token);
  if (storage.ok) storageWarnings.delete(providerId);
  else {
    storageWarnings.set(providerId, storage.error);
    console.warn(`[LGTM] ${provider.label} token not persisted: ${storage.error}`);
  }

  return {
    ...result,
    providerId,
    display: conn.display,
    status: connectionStatus(),
    storage,
  };
});

ipcMain.handle('disconnect-provider', async (_event, providerId) => {
  try { getProvider(providerId); } catch (err) { return { success: false, error: err.message }; }
  const removed = await tokenStore.delete(providerId);
  storeUrlFor(providerId, '');
  teardownConnection(connections.get(providerId));
  connections.delete(providerId);
  rejectedAtStartup.delete(providerId);
  storageWarnings.delete(providerId);
  agentRunner.removeConnection(providerId);
  if (config.get('activeProvider') === providerId) config.set('activeProvider', activeProviderId());
  if (connections.size === 0) await stopWebhookServer();
  if (!removed.ok) console.warn(`[LGTM] disconnect ${providerId}: ${removed.error}`);
  broadcastConnectionStatus();
  return { success: true, status: connectionStatus(), warning: removed.ok ? null : removed.error };
});

ipcMain.handle('set-active-provider', (_event, providerId) => {
  if (!connections.has(providerId)) return { success: false, error: `${providerId} is not connected.` };
  config.set('activeProvider', providerId);
  return { success: true, status: connectionStatus() };
});

ipcMain.handle('get-me', (_event, providerId) => {
  const conn = connections.get(providerId || activeProviderId());
  return conn && conn.user ? conn.toStatus().user : null;
});

// ── IPC: PRs ─────────────────────────────────────────────────────────

function connectionOrError(params) {
  const providerId = (params && params.provider) || activeProviderId();
  const conn = connections.get(providerId);
  if (!conn) return { error: { success: false, error: `Not connected to ${providerId || 'any service'}` } };
  return { conn };
}

ipcMain.handle('refresh-prs', async (_event, params = {}) => {
  const { conn, error } = connectionOrError(params);
  if (error) return error;
  try {
    const prs = await conn.client.getAllOpenPRs();
    return { success: true, provider: conn.providerId, prs };
  } catch (err) {
    return { success: false, provider: conn.providerId, error: err.message };
  }
});

// ── IPC: Bugs ────────────────────────────────────────────────────────

ipcMain.handle('refresh-bugs', async (_event, params = {}) => {
  const { conn, error } = connectionOrError(params);
  if (error) return error;
  const { scope = 'mine', prFilter = 'none' } = params || {};
  try {
    const bugs = await conn.client.getOpenBugs({ assignedToMeOnly: scope !== 'all' });
    return { success: true, provider: conn.providerId, bugs: applyPrFilter(bugs, prFilter) };
  } catch (err) {
    return { success: false, provider: conn.providerId, error: err.message };
  }
});

ipcMain.handle('refresh-workitems', async (_event, params = {}) => {
  const { conn, error } = connectionOrError(params);
  if (error) return error;
  const { scope = 'mine', prFilter = 'none' } = params || {};
  try {
    const items = await conn.client.getOpenWorkItems({ assignedToMeOnly: scope !== 'all' });
    return { success: true, provider: conn.providerId, items: applyPrFilter(items, prFilter) };
  } catch (err) {
    return { success: false, provider: conn.providerId, error: err.message };
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

ipcMain.handle('get-repos-for-project', async (_event, params) => {
  const { project, provider } = typeof params === 'string' ? { project: params } : (params || {});
  const { conn, error } = connectionOrError({ provider });
  if (error) return { ...error, repos: [] };
  try {
    const repos = await conn.client.getRepos(project);
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

ipcMain.handle('get-agents', () => serializeAgents(agentRegistry.getAll()));

ipcMain.handle('refresh-agents', async () => {
  agentRegistry.refresh();
  // User-triggered refresh from settings — wait for discovery so the
  // returned list reflects what the dropdown will show.
  await agentRegistry.refreshModels();
  return serializeAgents(agentRegistry.getAll());
});

// ── IPC: Agent test sandbox ──────────────────────────────────────────
//
// Every user message spawns a fresh agent process in --print mode
// with the message piped via stdin, but the spawn carries
// agent-specific flags that pin it to a per-chat session so the
// agent remembers prior turns:
//
//   claude → --session-id <uuid>     (first call creates the session,
//                                     subsequent calls continue it)
//   auggie → --continue              (after the first turn — picks
//                                     the most recent session in
//                                     this cwd, which we own)
//
// Each Start click resets: new tmpdir, new session UUID, first-turn
// flag re-armed. Picking a different agent in the dropdown also
// triggers a reset on the next Start.
const { randomUUID } = require('crypto');

let testProcess = null;     // the in-flight agent child, if any
let testCwd = null;         // tmp dir owned by the current test session
let testSessionId = null;   // UUID for Claude's --session-id; null otherwise
let testFirstTurn = true;   // controls auggie's --continue
let testAgentInUse = null;  // last agent id Started with — for change detection

function buildTestSpawnEnv() {
  const env = { ...process.env };
  // Same scrub as agent-runner — keep node-shebang CLIs from auto-attaching
  // to Electron's debugger when launched in dev mode.
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_INSPECT;
  delete env.NODE_INSPECT_RESUME_ON_START;
  // Surface every connected service's token under the conventional names
  // its prompts reference so the agent can authenticate REST calls without
  // us templating a secret in. The detail-mode flow runs against real PRs
  // and needs this; the test-mode flow benefits too if the user asks the
  // agent to ping a service.
  for (const conn of connections.values()) Object.assign(env, conn.agentEnv());
  return env;
}

/**
 * Wipe any previous test sandbox and start fresh: new cwd, new
 * session ID, first-turn flag re-armed. Called from Start.
 */
function resetTestSession(agentId) {
  if (testCwd) {
    try { fs.rmSync(testCwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-test-'));
  testSessionId = (agentId === 'claude') ? randomUUID() : null;
  testFirstTurn = true;
  testAgentInUse = agentId;
}

ipcMain.handle('agent-test-version', async (_event, { agentId }) => {
  const agent = agentRegistry.get(agentId);
  if (!agent) return { success: false, error: `Unknown agent: ${agentId}` };
  if (!agent.available) return { success: false, error: `${agent.name} is not installed.` };

  // Pre-flight auth so the user gets the same actionable error as a real run.
  if (typeof agent.authCheck === 'function') {
    const auth = agent.authCheck();
    if (!auth.ok) {
      const msg = auth.hint ? `${auth.error} ${auth.hint}` : auth.error;
      return { success: false, error: msg };
    }
  }

  const bin = agentRegistry.getResolvedPath(agentId);
  if (!bin) return { success: false, error: `Could not resolve binary for ${agentId}` };

  // Start always resets: new tmpdir, new session UUID, first-turn flag re-armed.
  resetTestSession(agentId);

  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, env: buildTestSpawnEnv() }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: `${bin} --version failed: ${err.message}`, stderr: (stderr || '').slice(-500) });
        return;
      }
      const banner = (stdout || '').trim() || `${agent.name} ready.`;
      resolve({
        success: true,
        bin,
        banner,
        cwd: testCwd,
        sessionId: testSessionId, // null for non-Claude; UI can show it if non-null
      });
    });
  });
});

ipcMain.handle('agent-test-send', async (event, { agentId, model, message }) => {
  if (testProcess) {
    return { success: false, error: 'Another message is already in flight. Press Stop first.' };
  }
  const agent = agentRegistry.get(agentId);
  if (!agent || !agent.available) {
    return { success: false, error: 'Agent unavailable' };
  }
  if (!testCwd || agentId !== testAgentInUse) {
    return { success: false, error: 'Click Start before sending a message.' };
  }

  let command, args, stdinPrompt;
  try {
    ({ command, args, stdinPrompt } = agentRegistry.buildCommand(agentId, message, model));
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Layer on session-continuity flags so the agent remembers prior turns
  // in this chat. Claude pins a UUID; auggie uses --continue from turn 2 on.
  const finalArgs = applySessionFlags(agentId, args, { sessionId: testSessionId, firstTurn: testFirstTurn });

  const child = spawn(command, finalArgs, {
    cwd: testCwd,
    stdio: [stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
    env: buildTestSpawnEnv(),
  });
  testProcess = child;

  if (stdinPrompt && child.stdin) {
    child.stdin.on('error', () => { /* EPIPE if agent dies before reading */ });
    child.stdin.write(message);
    child.stdin.end();
  }

  const send = (chunk) => {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send('agent-test-output', { chunk });
    }
  };
  child.stdout.on('data', (d) => send(d.toString()));
  child.stderr.on('data', (d) => send(d.toString()));

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      if (testProcess === child) testProcess = null;
      // Mark first turn done only on a clean exit. If the call failed
      // mid-init (no session got persisted), keep firstTurn=true so
      // the next attempt doesn't try to --continue a session that
      // doesn't exist.
      if (code === 0) testFirstTurn = false;
      resolve({
        success: code === 0,
        exitCode: code,
        signal,
      });
    });
    child.on('error', (err) => {
      if (testProcess === child) testProcess = null;
      resolve({ success: false, error: err.message });
    });
  });
});

ipcMain.handle('agent-test-stop', () => {
  if (!testProcess) return { success: false, error: 'No agent running' };
  try { testProcess.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    if (testProcess && testProcess.exitCode === null && !testProcess.killed) {
      try { testProcess.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 1500);
  return { success: true };
});

// ── IPC: Agent Detail (chat against a real PR/work item) ──────────────
//
// Flow:
//   1. Renderer calls `agent-detail-prepare`. Main clones the repo and
//      assembles a prompt that's a simplified-but-realistic version of
//      what the full scenario reviewer uses (LGTM rules + repo prompt
//      + PR context). Returns the prompt for display.
//   2. User reviews the prompt in the chat as the first message.
//   3. User clicks Start → `agent-detail-send` spawns the agent with
//      that prompt via stdin, in the cloned repo, threading
//      `--session-id <uuid>` so follow-ups can resume.
//   4. Subsequent messages → same handler with `isFirstTurn: false`,
//      uses `--resume <uuid>` (claude) or `--continue` (auggie).
//   5. Back button → `agent-detail-cleanup` kills any running child
//      and wipes the clone.
//
// State is a singleton — one detail session at a time. Opening another
// auto-cleans the previous.
let detailRun = null;     // { agentId, model, clonePath, cleanup, sessionId, firstTurn, prompt, target }
let detailProcess = null;

async function cleanupDetailRun() {
  if (detailProcess) {
    try { detailProcess.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      if (detailProcess && detailProcess.exitCode === null && !detailProcess.killed) {
        try { detailProcess.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 1500);
    detailProcess = null;
  }
  if (detailRun && typeof detailRun.cleanup === 'function') {
    try { detailRun.cleanup(); } catch { /* ignore */ }
  }
  detailRun = null;
}

function loadUniversalReviewPrompt(providerId) {
  const file = getProvider(providerId || 'azure-devops').universalPromptFile;
  const p1 = path.join(__dirname, '..', '..', 'resources', file);
  const p2 = path.join(process.resourcesPath || '', file);
  for (const p of [p1, p2]) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* try next */ }
  }
  return '';
}

function loadRepoPromptIfAny(pr, clonePath) {
  // PromptResolver lives on agentRunner; reuse it.
  try {
    const resolved = agentRunner.promptResolver.resolve(pr, clonePath);
    if (resolved && resolved.path) {
      return fs.readFileSync(resolved.path, 'utf8');
    }
  } catch { /* ignore */ }
  return '';
}

ipcMain.handle('agent-detail-prepare', async (_event, { target, agentId, model }) => {
  if (!agentRunner || !agentRunner.hasConnection) {
    return { success: false, error: 'Not connected yet — connect a git service first.' };
  }
  const agent = agentRegistry.get(agentId);
  if (!agent) return { success: false, error: `Unknown agent: ${agentId}` };
  if (!agent.available) return { success: false, error: `${agent.name} is not installed.` };
  if (typeof agent.authCheck === 'function') {
    const auth = agent.authCheck();
    if (!auth.ok) {
      return { success: false, error: auth.hint ? `${auth.error} ${auth.hint}` : auth.error };
    }
  }

  // Replace any active detail session.
  await cleanupDetailRun();

  if (!target) {
    return { success: false, error: 'No target supplied.' };
  }

  let clonePath, cleanup, prompt;
  try {
    if (target.kind === 'pr' && target.pr) {
      const pr = target.pr;
      const conn = agentRunner.connectionFor(pr);
      const result = await conn.cloner.clone(pr, {});
      clonePath = result.clonePath;
      cleanup = result.cleanup;

      const universalPrompt = loadUniversalReviewPrompt(conn.providerId);
      const repoPrompt = loadRepoPromptIfAny(pr, clonePath);
      let prDescription = '';
      try {
        const full = await conn.client.getPullRequest(pr.project, pr.repoId, pr.id);
        prDescription = full.description || '';
      } catch (err) {
        console.warn(`[LGTM] detail-prepare: could not fetch PR description: ${err.message}`);
      }
      prompt = buildPrDetailPrompt({ pr, prDescription, universalPrompt, repoPrompt });
    } else if (target.kind === 'workItem' && target.workItem && target.repoInfo) {
      const { workItem, repoInfo } = target;
      const conn = agentRunner.connectionFor(workItem);
      const result = await conn.cloner.cloneRepo(repoInfo.project, repoInfo.repo, workItem.id, {});
      clonePath = result.clonePath;
      cleanup = result.cleanup;

      // Pull full work-item details for description/repro/etc.
      let details = workItem;
      try {
        details = await conn.client.getWorkItemDetails(workItem);
      } catch (err) {
        console.warn(`[LGTM] detail-prepare: could not fetch work item details: ${err.message}`);
      }

      // Optional per-repo prompt override (configured under bugs/tickets settings).
      let repoPrompt = '';
      if (target.promptFile) {
        try {
          repoPrompt = fs.readFileSync(path.join(clonePath, target.promptFile), 'utf8');
        } catch (err) {
          console.warn(`[LGTM] detail-prepare: could not read repo prompt ${target.promptFile}: ${err.message}`);
        }
      }
      prompt = buildWorkItemDetailPrompt({ workItem, details, repoInfo, repoPrompt });
    } else {
      return { success: false, error: `Unsupported target kind: ${target.kind}` };
    }
  } catch (err) {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } }
    return { success: false, error: `Prepare failed: ${err.message}` };
  }

  detailRun = {
    target,
    agentId,
    model,
    clonePath,
    cleanup,
    sessionId: (agentId === 'claude') ? require('crypto').randomUUID() : null,
    firstTurn: true,
    prompt,
  };

  return { success: true, prompt, clonePath, sessionId: detailRun.sessionId };
});

ipcMain.handle('agent-detail-send', async (event, { message }) => {
  if (!detailRun) return { success: false, error: 'No detail session prepared. Click Details first.' };
  if (detailProcess) return { success: false, error: 'Another message is in flight.' };

  const { agentId, model, clonePath } = detailRun;

  let command, args, stdinPrompt;
  try {
    ({ command, args, stdinPrompt } = agentRegistry.buildCommand(agentId, message, model));
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Layer on session-continuity flags. First turn for claude creates
  // the session via --session-id; later turns resume. Auggie uses
  // --continue from turn 2 onwards in the same cwd.
  const finalArgs = applySessionFlags(agentId, args, { sessionId: detailRun.sessionId, firstTurn: detailRun.firstTurn });

  const child = spawn(command, finalArgs, {
    cwd: clonePath,
    stdio: [stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
    env: buildTestSpawnEnv(),
  });
  detailProcess = child;

  if (stdinPrompt && child.stdin) {
    child.stdin.on('error', () => { /* EPIPE if agent dies first */ });
    child.stdin.write(message);
    child.stdin.end();
  }

  const send = (chunk) => {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send('agent-detail-output', { chunk });
    }
  };
  child.stdout.on('data', (d) => send(d.toString()));
  child.stderr.on('data', (d) => send(d.toString()));

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      if (detailProcess === child) detailProcess = null;
      if (code === 0 && detailRun) detailRun.firstTurn = false;
      resolve({ success: code === 0, exitCode: code, signal });
    });
    child.on('error', (err) => {
      if (detailProcess === child) detailProcess = null;
      resolve({ success: false, error: err.message });
    });
  });
});

ipcMain.handle('agent-detail-stop', () => {
  if (!detailProcess) return { success: false, error: 'No agent running' };
  try { detailProcess.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    if (detailProcess && detailProcess.exitCode === null && !detailProcess.killed) {
      try { detailProcess.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 1500);
  return { success: true };
});

ipcMain.handle('agent-detail-cleanup', async () => {
  await cleanupDetailRun();
  return { success: true };
});

// ── IPC: Settings ────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => ({
  ...readSettings(config),
  activeProvider: activeProviderId(),
}));

ipcMain.handle('save-settings', async (_event, settings) => {
  writeSettings(config, settings);
  return { success: true };
});

// ── IPC: Prompt conventions (for settings UI) ────────────────────────

ipcMain.handle('get-prompt-conventions', () => {
  return PromptResolver.getConventionPaths();
});

// ── IPC: Repo file tree (for autocomplete) ──────────────────────────

ipcMain.handle('get-repo-file-tree', async (_event, { project, repoName, provider }) => {
  const { conn, error } = connectionOrError({ provider });
  if (error) return { ...error, files: [] };
  try {
    const files = await conn.client.getRepoFileTree(project, repoName);
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
