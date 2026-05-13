const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
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
// Flipped to true if a stored PAT was rejected by the org at startup.
// Tied to !currentPat in get-pat-status so it auto-clears the moment
// the user enters a fresh valid PAT.
let patRejectedAtStartup = false;

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
    // Filter state for the Bugs / Tickets tabs. scope: 'mine' | 'all'.
    // prFilter: 'all' | 'has' | 'none' — restricts to items with /
    // without a linked PR. Defaults match what the user asked for:
    // assigned-to-me, items without a PR (the "do something next" pile).
    bugsFilters: { scope: 'mine', prFilter: 'none' },
    ticketsFilters: { scope: 'mine', prFilter: 'none' },
  },
});

/**
 * Drop work items that don't match the requested PR-linkage filter.
 * 'all' → no-op, 'has' → only items with a linked PR, 'none' → only
 * items without one. Items carry the `hasLinkedPR` flag from
 * DevOpsClient (populated via $expand=Relations).
 */
function applyPrFilter(items, prFilter) {
  if (!Array.isArray(items)) return [];
  if (prFilter === 'has')  return items.filter((it) => it.hasLinkedPR);
  if (prFilter === 'none') return items.filter((it) => !it.hasLinkedPR);
  return items;
}

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

/**
 * Cheapest authenticated round-trip against Azure DevOps. Hits
 * `_apis/ConnectionData?connectOptions=none` — the SDK uses this
 * under the hood for `getMe()` but going via axios skips the SDK
 * client warmup and gives us a tight timeout we control.
 *
 * Returns:
 *   { ok: true }                       — PAT works
 *   { ok: false, reason: 'rejected' }  — org responded but auth failed
 *   { ok: false, reason: 'unreachable' } — DNS / timeout / network
 *
 * The reason matters: a rejected PAT forces re-entry, but a network
 * blip should let the user into the app with whatever's cached.
 */
async function quickValidatePat(pat, orgUrl) {
  const parsed = DevOpsClient.parseOrgUrl(orgUrl);
  if (!parsed.orgUrl) return { ok: false, reason: 'rejected' };
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const url = `${parsed.orgUrl}/_apis/ConnectionData?connectOptions=none&api-version=7.0`;
  try {
    const res = await axios.get(url, {
      timeout: 4000,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      validateStatus: () => true,            // we want to inspect the code ourselves
      maxRedirects: 0,                       // ADO redirects unauth'd traffic to the sign-in page
    });
    const user = res.data && res.data.authenticatedUser;
    // ADO's "your PAT is bad" signal is a 203 with HTML, not a 401 —
    // hence the explicit user.id check.
    if (res.status === 200 && user && user.id) {
      return { ok: true };
    }
    if (res.status === 401 || res.status === 403 || res.status === 203) {
      return { ok: false, reason: 'rejected' };
    }
    return { ok: false, reason: 'unreachable' };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT'
        || code === 'ECONNABORTED' || code === 'EAI_AGAIN' || code === 'ENETUNREACH') {
      return { ok: false, reason: 'unreachable' };
    }
    // Unknown failure mode — be conservative and don't lock the user out.
    console.warn('[LGTM] quickValidatePat error (treating as unreachable):', err.message);
    return { ok: false, reason: 'unreachable' };
  }
}

// ── App lifecycle ────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();

  patStore = new PatStore();
  agentRegistry = new AgentRegistry();
  agentRunner = new AgentRunner(config);

  // Load the saved PAT and wire up clients BEFORE creating the
  // window. The renderer pulls PAT status via `get-pat-status` on
  // boot; if we created the window first, there'd be a race where
  // the renderer could invoke the IPC handler before currentPat
  // was populated. Doing it first guarantees the answer is ready.
  //
  // We also fast-validate the stored PAT here. The whole point is
  // that a dead PAT never lets the main UI open — the renderer
  // sees hasPat=false and lands on the setup form. We deliberately
  // await the validation so the answer to get-pat-status is final
  // by the time the renderer asks.
  const existingPat = await patStore.get();
  const orgUrl = config.get('orgUrl');
  if (existingPat && orgUrl) {
    const t0 = Date.now();
    const check = await quickValidatePat(existingPat, orgUrl);
    console.log(`[LGTM] Startup PAT check: ${check.ok ? 'ok' : check.reason} in ${Date.now() - t0}ms`);
    if (check.ok) {
      currentPat = existingPat;
      agentRunner.setCredentials(existingPat, DevOpsClient.parseOrgUrl(orgUrl).orgUrl);
      initDevOps(existingPat, orgUrl).catch((err) => {
        console.warn('[LGTM] initDevOps error (background):', err.message);
      });
    } else if (check.reason === 'rejected') {
      // Force re-entry: leave currentPat null so the renderer's
      // boot flow lands on the PAT setup view with patExpired set.
      patRejectedAtStartup = true;
    } else {
      // Network blip — give the cached PAT the benefit of the doubt
      // so the user isn't locked out offline. initDevOps will retry
      // on its own polling cadence once connectivity returns.
      currentPat = existingPat;
      agentRunner.setCredentials(existingPat, DevOpsClient.parseOrgUrl(orgUrl).orgUrl);
      initDevOps(existingPat, orgUrl).catch((err) => {
        console.warn('[LGTM] initDevOps error (background):', err.message);
      });
    }
  }

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
});

// Renderer asks for PAT status as part of its own boot sequence —
// guaranteed to arrive at a moment when the renderer is ready to
// react to the answer.
//
// `patExpired` lets the renderer pre-fill the org URL and tell the
// user *why* they're back on the setup screen. It's gated on
// !currentPat so it auto-clears as soon as a fresh PAT is accepted.
ipcMain.handle('get-pat-status', () => ({
  hasPat: !!currentPat,
  orgUrl: config.get('orgUrl') || '',
  patExpired: patRejectedAtStartup && !currentPat,
}));

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
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    minWidth: 760,
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
  patRejectedAtStartup = false;
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

ipcMain.handle('refresh-bugs', async (_event, params = {}) => {
  if (!devopsClient) return { success: false, error: 'Not authenticated' };
  const { scope = 'mine', prFilter = 'none' } = params || {};
  try {
    const bugs = await devopsClient.getOpenBugs({ assignedToMeOnly: scope !== 'all' });
    return { success: true, bugs: applyPrFilter(bugs, prFilter) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('refresh-workitems', async (_event, params = {}) => {
  if (!devopsClient) return { success: false, error: 'Not authenticated' };
  const { scope = 'mine', prFilter = 'none' } = params || {};
  try {
    const items = await devopsClient.getOpenWorkItems({ assignedToMeOnly: scope !== 'all' });
    return { success: true, items: applyPrFilter(items, prFilter) };
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

// Strip non-serializable members (functions) before crossing the IPC
// boundary. Electron's structured-clone serialization throws on any
// function value, which silently rejects the renderer's promise and
// leaves dropdowns/settings stuck. Drop everything that's a function
// so adding new ones (next agent driver, etc.) doesn't relapse this.
function serializeAgents(agentList) {
  return agentList.map((agent) => {
    const out = {};
    for (const [k, v] of Object.entries(agent)) {
      if (typeof v !== 'function') out[k] = v;
    }
    return out;
  });
}

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
  // Surface the PAT under common conventional names so prompts can
  // authenticate REST calls without us templating the secret in.
  // The detail-mode flow runs against real PRs and absolutely needs
  // this; the test-mode "is the agent working" flow benefits too if
  // the user asks the agent to ping ADO.
  if (currentPat) {
    env.AZURE_DEVOPS_PAT = currentPat;
    env.AZURE_DEVOPS_EXT_PAT = currentPat;
    env.SYSTEM_ACCESSTOKEN = currentPat;
  }
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

/**
 * Inject the agent-specific session-continuity flags on top of the
 * args buildCommand handed back. Mutates a fresh array; doesn't touch
 * the registry's defaults.
 *
 * Claude split: `--session-id <uuid>` CREATES a session with that ID
 * and refuses if one already exists ("session ID is already in use").
 * To continue, use `--resume <uuid>`. So turn 1 creates, turns 2+
 * resume.
 */
function applySessionFlags(agentId, args) {
  const out = [...args];
  if (agentId === 'claude' && testSessionId) {
    if (testFirstTurn) {
      out.push('--session-id', testSessionId);
    } else {
      out.push('--resume', testSessionId);
    }
  } else if (agentId === 'augment' && !testFirstTurn) {
    out.push('--continue');
  }
  return out;
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
  const finalArgs = applySessionFlags(agentId, args);

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

function loadUniversalReviewPrompt() {
  const p1 = path.join(__dirname, '..', '..', 'resources', 'LGTM_REVIEW_PROMPT.md');
  const p2 = path.join(process.resourcesPath || '', 'LGTM_REVIEW_PROMPT.md');
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

function buildWorkItemDetailPrompt({ workItem, details, repoInfo, repoPrompt }) {
  const stripHtml = (html) => (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = [];
  if (repoPrompt && repoPrompt.trim()) {
    lines.push('# Repo-specific Rules', '', repoPrompt.trim(), '');
  }
  lines.push(`# ${details.type || workItem.type || 'Work Item'} #${details.id || workItem.id}`, '');
  lines.push(`- Project: ${details.project || workItem.project}`);
  lines.push(`- Repo: ${repoInfo.repo}`);
  lines.push(`- Title: ${details.title || workItem.title || ''}`);
  lines.push(`- State: ${details.state || ''}`);
  if (details.priority != null) lines.push(`- Priority: ${details.priority}`);
  if (details.severity) lines.push(`- Severity: ${details.severity}`);
  if (details.tags) lines.push(`- Tags: ${details.tags}`);
  if (workItem.webUrl) lines.push(`- URL: ${workItem.webUrl}`);

  const desc = stripHtml(details.description);
  if (desc) lines.push('', '## Description', '', desc);
  const repro = stripHtml(details.reproSteps);
  if (repro) lines.push('', '## Repro Steps', '', repro);
  const sys = stripHtml(details.systemInfo);
  if (sys) lines.push('', '## System Info', '', sys);
  const ac = stripHtml(details.acceptanceCriteria);
  if (ac) lines.push('', '## Acceptance Criteria', '', ac);

  lines.push('', '# Task', '');
  lines.push(
    `Investigate this work item against the cloned repo. Read the relevant code, ` +
    `propose a fix or implementation plan, and discuss with the user before making changes. ` +
    `The user may follow up with questions — answer them based on the repo and work-item context.`,
  );
  return lines.join('\n');
}

function buildPrDetailPrompt({ pr, prDescription, universalPrompt, repoPrompt }) {
  const sourceBranch = (pr.sourceBranch || '').replace(/^refs\/heads\//, '');
  const targetBranch = (pr.targetBranch || '').replace(/^refs\/heads\//, '');
  const lines = [];
  if (universalPrompt.trim()) {
    lines.push('# LGTM Review Rules', '', universalPrompt.trim(), '');
  }
  if (repoPrompt.trim()) {
    lines.push('# Repo-specific Rules', '', repoPrompt.trim(), '');
  }
  lines.push('# Pull Request', '');
  lines.push(`- Project: ${pr.project}`);
  lines.push(`- Repo: ${pr.repo}`);
  lines.push(`- PR ID: !${pr.id}`);
  lines.push(`- Title: ${pr.title || ''}`);
  lines.push(`- Author: ${pr.createdBy || ''}`);
  lines.push(`- Source branch: ${sourceBranch}`);
  lines.push(`- Target branch: ${targetBranch}`);
  if (pr.webUrl) lines.push(`- URL: ${pr.webUrl}`);
  if (prDescription && prDescription.trim()) {
    lines.push('', '## Description', '', prDescription.trim());
  }
  lines.push('');
  lines.push('# Task');
  lines.push('');
  lines.push(
    `You are reviewing this PR interactively. Start by reading the diff between ` +
    `\`${targetBranch}\` and \`${sourceBranch}\` (use \`git diff ${targetBranch}...${sourceBranch}\` ` +
    `or read changed files directly). Apply the rules above, then summarize what you find. ` +
    `The user may follow up with questions — answer them based on the repo and PR context.`,
  );
  return lines.join('\n');
}

ipcMain.handle('agent-detail-prepare', async (_event, { target, agentId, model }) => {
  if (!agentRunner || !agentRunner.cloner) {
    return { success: false, error: 'Not authenticated yet — set up your PAT first.' };
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
      const result = await agentRunner.cloner.clone(pr, {});
      clonePath = result.clonePath;
      cleanup = result.cleanup;

      const universalPrompt = loadUniversalReviewPrompt();
      const repoPrompt = loadRepoPromptIfAny(pr, clonePath);
      let prDescription = '';
      try {
        const full = await agentRunner.devopsClient.getPullRequest(pr.project, pr.repoId, pr.id);
        prDescription = full.description || '';
      } catch (err) {
        console.warn(`[LGTM] detail-prepare: could not fetch PR description: ${err.message}`);
      }
      prompt = buildPrDetailPrompt({ pr, prDescription, universalPrompt, repoPrompt });
    } else if (target.kind === 'workItem' && target.workItem && target.repoInfo) {
      const { workItem, repoInfo } = target;
      const result = await agentRunner.cloner.cloneRepo(repoInfo.project, repoInfo.repo, workItem.id, {});
      clonePath = result.clonePath;
      cleanup = result.cleanup;

      // Pull full work-item details for description/repro/etc.
      let details = workItem;
      try {
        details = await agentRunner.devopsClient.getWorkItemDetails(workItem.id);
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
  const finalArgs = [...args];
  if (agentId === 'claude' && detailRun.sessionId) {
    finalArgs.push(detailRun.firstTurn ? '--session-id' : '--resume', detailRun.sessionId);
  } else if (agentId === 'augment' && !detailRun.firstTurn) {
    finalArgs.push('--continue');
  }

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
  bugsFilters: config.get('bugsFilters'),
  ticketsFilters: config.get('ticketsFilters'),
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
  if (settings.bugsFilters !== undefined) config.set('bugsFilters', settings.bugsFilters);
  if (settings.ticketsFilters !== undefined) config.set('ticketsFilters', settings.ticketsFilters);
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
