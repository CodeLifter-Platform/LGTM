/**
 * LGTM — Renderer process (UI logic)
 */

// ── DOM refs ─────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const patSetup          = $('#pat-setup');
const prListView        = $('#pr-list-view');
const settingsView      = $('#settings-view');
const reviewDetailView  = $('#review-detail-view');

const orgUrlInput   = $('#org-url');
const patInput      = $('#pat-input');
const patSubmit     = $('#pat-submit');
const patStatusMsg  = $('#pat-status-msg');

const prListEl      = $('#pr-list');
const noPrsEl       = $('#no-prs');
const refreshBtn    = $('#refresh-btn');
const settingsBtn   = $('#settings-btn');
const agentSelect   = $('#agent-select');

// Tabs
const tabPrsBtn     = $('#tab-prs');
const tabBugsBtn    = $('#tab-bugs');
const tabTicketsBtn = $('#tab-tickets');
const tabPanePrs    = $('#tab-pane-prs');
const tabPaneBugs   = $('#tab-pane-bugs');
const tabPaneTickets = $('#tab-pane-tickets');
const bugsTabCount  = $('#bugs-tab-count');
const ticketsTabCount = $('#tickets-tab-count');

// Bugs
const bugListEl     = $('#bug-list');
const noBugsEl      = $('#no-bugs');

// Tickets
const ticketListEl  = $('#ticket-list');
const noTicketsEl   = $('#no-tickets');

// Per-tab toolbars
const bugsAgentSelect      = $('#bugs-agent-select');
const bugsSettingsBtn      = $('#bugs-settings-btn');
const ticketsAgentSelect   = $('#tickets-agent-select');
const ticketsSettingsBtn   = $('#tickets-settings-btn');

// Per-tab settings views
const bugsSettingsView     = $('#bugs-settings-view');
const bugsAgentConfigList  = $('#bugs-agent-config-list');
const bugsRepoPromptList   = $('#bugs-repo-prompt-list');
const bugsAddRepoBtn       = $('#bugs-add-repo-btn');
const bugsSettingsSave     = $('#bugs-settings-save');
const bugsSettingsBack     = $('#bugs-settings-back');

const ticketsSettingsView    = $('#tickets-settings-view');
const ticketsAgentConfigList = $('#tickets-agent-config-list');
const ticketsRepoPromptList  = $('#tickets-repo-prompt-list');
const ticketsAddRepoBtn      = $('#tickets-add-repo-btn');
const ticketsSettingsSave    = $('#tickets-settings-save');
const ticketsSettingsBack    = $('#tickets-settings-back');

// Review detail
const reviewBackBtn     = $('#review-back-btn');
const reviewDetailTitle = $('#review-detail-title');
const reviewDetailMeta  = $('#review-detail-meta');
const reviewDetailDot   = $('#review-detail-dot');
const reviewDetailCancelBtn = $('#review-detail-cancel-btn');
const reviewOutputEl    = $('#review-output');
const reviewElapsedEl   = $('#review-elapsed');
const rdOpenAdoBtn      = $('#rd-open-ado');
const rdOpenCloneBtn    = $('#rd-open-clone');
const rdCopyBtn         = $('#rd-copy');
const rdSaveBtn         = $('#rd-save');
const rdRerunBtn        = $('#rd-rerun');
const rdRerunMenuBtn    = $('#rd-rerun-menu');
const rdRerunPopover    = $('#rd-rerun-popover');
const rdRerunAgentSel   = $('#rd-rerun-agent');
const rdRerunModelSel   = $('#rd-rerun-model');
const rdRerunConfirmBtn = $('#rd-rerun-confirm');
const rdRerunCancelBtn  = $('#rd-rerun-cancel');
const rdTimelineEl      = $('#rd-timeline');
const rdReportEl        = $('#rd-report');
const rdPromptSection   = $('#rd-prompt-section');
const rdPromptEl        = $('#rd-prompt');
const rdPromptMetaEl    = $('#rd-prompt-meta');
const rdOutputSection   = $('#rd-output-section');
const rdOutputMetaEl    = $('#rd-output-meta');
const rdSearchInput     = $('#rd-search');
const rdFollowTail      = $('#rd-follow-tail');
const rdJumpBottomBtn   = $('#rd-jump-bottom');

// Settings
const sPromptPath       = $('#s-prompt-path');
const sWebhookPort      = $('#s-webhook-port');
const sPollInterval     = $('#s-poll-interval');
const sMaxPrAge         = $('#s-max-pr-age');
const agentConfigList   = $('#agent-config-list');
const repoConfigList    = $('#repo-config-list');
const conventionHint    = $('#convention-hint');
const settingsSave      = $('#settings-save');
const settingsBack      = $('#settings-back');
const disconnectBtn     = $('#disconnect-btn');
const subtitleEl        = $('#subtitle');

// ── State ────────────────────────────────────────────────────────
let currentPrs = [];
let reviewStatuses = {};     // key → { status, agentId, output }
let agents = [];
let selectedAgent = null;
let agentModels = {};
let repoConfigs = {};
let starredRepos = new Set(); // "project/repo" strings — starred repos float to top & auto-review first
let maxPrAgeDays = 7;        // only auto-review PRs within this age
let activeDetailKey = null;  // which review is shown in the detail panel
let detailSourceTab = 'prs'; // which tab to return to when back is clicked
let knownRepos = new Set();  // "project/repo" strings from PR list
let autoReviewRunning = false;
let currentBugs = [];
let activeTab = 'prs';
let bugsLoaded = false;
let currentTickets = [];
let ticketsLoaded = false;
let collapsedBugProjects = {};     // project → boolean (true = collapsed)
let collapsedTicketProjects = {};  // project → boolean (true = collapsed)
let revealedRows = new Set();       // row keys currently showing Play/dismiss
let lastUsedRepos = {};             // { project: repoName } — remembered picker default
let repoCache = {};                 // { project: [{ id, name }] } — per-session repo list

// Authenticated user (so we can flag "my PRs")
let currentUser = null;
let prModeOverrides = {};  // "project/repo/id" → 'review' | 'resolve'
try {
  prModeOverrides = JSON.parse(localStorage.getItem('lgtm-pr-modes') || '{}');
} catch { prModeOverrides = {}; }

function savePrModes() {
  try { localStorage.setItem('lgtm-pr-modes', JSON.stringify(prModeOverrides)); } catch { /* ignore */ }
}

function defaultPrMode(pr) {
  if (currentUser && pr.createdBy && pr.createdBy === currentUser.displayName) {
    return 'resolve';
  }
  return 'review';
}

function getPrMode(pr) {
  const key = `${pr.project}/${pr.repo}/${pr.id}`;
  return prModeOverrides[key] || defaultPrMode(pr);
}

function togglePrMode(pr) {
  const key = `${pr.project}/${pr.repo}/${pr.id}`;
  const current = getPrMode(pr);
  prModeOverrides[key] = current === 'review' ? 'resolve' : 'review';
  savePrModes();
}

// Per-tab agent + prompt config
let bugsSelectedAgent = null;
let bugsAgentModels = {};
let bugsRepoConfigs = {};           // { "project/repo": "relative/prompt.md" }
let ticketsSelectedAgent = null;
let ticketsAgentModels = {};
let ticketsRepoConfigs = {};

// ── Theme toggle ─────────────────────────────────────────────────
const themeToggleBtn = $('#theme-toggle');
function applyThemeIcon() {
  const isLight = document.documentElement.classList.contains('light');
  // ☀ sun when light (click → dark), ☾ crescent when dark (click → light)
  themeToggleBtn.innerHTML = isLight ? '&#9728;' : '&#9790;';
  themeToggleBtn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
}
themeToggleBtn.addEventListener('click', () => {
  const nextIsLight = !document.documentElement.classList.contains('light');
  document.documentElement.classList.toggle('light', nextIsLight);
  try { localStorage.setItem('lgtm-theme', nextIsLight ? 'light' : 'dark'); } catch { /* ignore */ }
  applyThemeIcon();
});
applyThemeIcon();

// ── Navigation ───────────────────────────────────────────────────
function showView(view) {
  [patSetup, prListView, settingsView, reviewDetailView, bugsSettingsView, ticketsSettingsView]
    .forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

// ── Agent discovery & toolbar dropdown ───────────────────────────
async function loadAgents() {
  agents = await window.lgtm.getAgents();
  const settings = await window.lgtm.getSettings();
  selectedAgent = settings.defaultAgent || 'claude';
  agentModels = settings.agentModels || {};
  repoConfigs = settings.repoConfigs || {};
  starredRepos = new Set(settings.starredRepos || []);
  maxPrAgeDays = settings.maxPrAgeDays || 7;
  lastUsedRepos = settings.lastUsedRepos || {};

  // Per-tab agent + prompt config
  bugsSelectedAgent = settings.bugsAgent || selectedAgent;
  bugsAgentModels = settings.bugsAgentModels || {};
  bugsRepoConfigs = settings.bugsRepoConfigs || {};
  ticketsSelectedAgent = settings.ticketsAgent || selectedAgent;
  ticketsAgentModels = settings.ticketsAgentModels || {};
  ticketsRepoConfigs = settings.ticketsRepoConfigs || {};

  renderAgentSelect();
  renderTabAgentSelects();
}

function renderTabAgentSelects() {
  [
    { el: bugsAgentSelect,    current: bugsSelectedAgent,    setter: (v) => (bugsSelectedAgent = v) },
    { el: ticketsAgentSelect, current: ticketsSelectedAgent, setter: (v) => (ticketsSelectedAgent = v) },
  ].forEach(({ el, current }) => {
    if (!el) return;
    el.innerHTML = '';
    agents.forEach((agent) => {
      const opt = document.createElement('option');
      opt.value = agent.id;
      opt.textContent = agent.name + (agent.available ? '' : ' (not installed)');
      opt.disabled = !agent.available;
      if (agent.id === current) opt.selected = true;
      el.appendChild(opt);
    });
  });
}

bugsAgentSelect && bugsAgentSelect.addEventListener('change', async () => {
  bugsSelectedAgent = bugsAgentSelect.value;
  await window.lgtm.saveSettings({ bugsAgent: bugsSelectedAgent });
});
ticketsAgentSelect && ticketsAgentSelect.addEventListener('change', async () => {
  ticketsSelectedAgent = ticketsAgentSelect.value;
  await window.lgtm.saveSettings({ ticketsAgent: ticketsSelectedAgent });
});

function renderAgentSelect() {
  agentSelect.innerHTML = '';
  agents.forEach((agent) => {
    const opt = document.createElement('option');
    opt.value = agent.id;
    opt.textContent = agent.name;
    opt.disabled = !agent.available;
    if (!agent.available) opt.textContent += ' (not installed)';
    if (agent.id === selectedAgent) opt.selected = true;
    agentSelect.appendChild(opt);
  });
}

agentSelect.addEventListener('change', () => { selectedAgent = agentSelect.value; });

// ── PAT flow ─────────────────────────────────────────────────────
patSubmit.addEventListener('click', async () => {
  const pat = patInput.value.trim();
  const orgUrl = orgUrlInput.value.trim();
  if (!pat || !orgUrl) { setPatMsg('Please fill in both fields.', 'error'); return; }

  patSubmit.disabled = true;
  patSubmit.textContent = 'Validating…';
  setPatMsg('');

  const result = await window.lgtm.validatePat(pat, orgUrl);
  if (result.success) {
    // Load agents + settings BEFORE switching views — the toolbar
    // agent dropdown, per-tab agent dropdowns, repo config buttons,
    // and starred-repo state all render against the `agents` /
    // `repoConfigs` / `starredRepos` globals that this populates.
    // It's two fast IPC calls (<100ms), no network — safe to await.
    try {
      await loadAgents();
    } catch (err) {
      console.warn('[LGTM] loadAgents failed:', err.message);
    }

    showView(prListView);
    subtitleEl.textContent = orgUrl.replace('https://dev.azure.com/', '');
    setPatMsg('');

    if (!bugsLoaded) {
      bugsLoaded = true;
      window.lgtm.refreshBugs().then((r) => {
        if (r && r.success) renderBugList(r.bugs);
      }).catch(() => {});
    }
    if (!ticketsLoaded) {
      ticketsLoaded = true;
      window.lgtm.refreshWorkItems().then((r) => {
        if (r && r.success) renderTicketList(r.items);
      }).catch(() => {});
    }
  } else {
    setPatMsg(result.error, 'error');
  }
  patSubmit.disabled = false;
  patSubmit.textContent = 'Validate & Connect';
});

function setPatMsg(msg, type = '') {
  patStatusMsg.className = 'status-msg ' + type;
  patStatusMsg.innerHTML = '';
  if (!msg) return;
  const text = document.createElement('span');
  text.textContent = msg;
  patStatusMsg.appendChild(text);
  if (type === 'error') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy';
    copyBtn.title = 'Copy error to clipboard';
    copyBtn.textContent = '⧉';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(msg).then(() => {
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '⧉'; }, 1500);
      });
    });
    patStatusMsg.appendChild(copyBtn);
  }
}

// ── PR list rendering ────────────────────────────────────────────
let collapsedRepos = {};  // repoKey → boolean (true = collapsed)
let openConfigPopover = null; // currently open popover element

function renderPrList(prs) {
  currentPrs = prs;
  prListEl.innerHTML = '';

  // Track known repos for settings
  (prs || []).forEach((pr) => knownRepos.add(`${pr.project}/${pr.repo}`));

  if (!prs || prs.length === 0) {
    prListEl.classList.add('hidden');
    noPrsEl.classList.remove('hidden');
    return;
  }

  prListEl.classList.remove('hidden');
  noPrsEl.classList.add('hidden');

  // Group PRs by repo
  const grouped = {};
  prs.forEach((pr) => {
    const repoKey = `${pr.project}/${pr.repo}`;
    if (!grouped[repoKey]) grouped[repoKey] = [];
    grouped[repoKey].push(pr);
  });

  // Sort: starred repos first, then alphabetical within each group
  const repoKeys = Object.keys(grouped).sort((a, b) => {
    const aStarred = starredRepos.has(a) ? 0 : 1;
    const bStarred = starredRepos.has(b) ? 0 : 1;
    if (aStarred !== bStarred) return aStarred - bStarred;
    return a.localeCompare(b);
  });

  // Render each repo group
  repoKeys.forEach((repoKey) => {
    const repoPrs = grouped[repoKey];
    const isCollapsed = collapsedRepos[repoKey] || false;
    const cfg = repoConfigs[repoKey] || { mode: 'default' };
    const isStarred = starredRepos.has(repoKey);

    // ── Group header ──────────────────────────────────
    const header = document.createElement('div');
    header.className = `repo-group-header${isStarred ? ' starred' : ''}`;

    // Star button
    const starBtn = document.createElement('button');
    starBtn.className = `repo-star-btn${isStarred ? ' active' : ''}`;
    starBtn.innerHTML = isStarred ? '&#9733;' : '&#9734;';  // ★ / ☆
    starBtn.title = isStarred ? 'Unstar repo (removes from auto-review priority)' : 'Star repo (auto-review priority)';
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStar(repoKey);
    });

    const chevron = document.createElement('span');
    chevron.className = `repo-chevron${isCollapsed ? ' collapsed' : ''}`;
    chevron.textContent = '\u25BE';  // ▾

    const repoName = document.createElement('span');
    repoName.className = 'repo-group-name';
    repoName.textContent = repoKey;

    const prCount = document.createElement('span');
    prCount.className = 'repo-group-count';
    prCount.textContent = repoPrs.length;

    // Custom prompt indicator (only shown when a repo file is configured)
    const customIndicator = document.createElement('span');
    customIndicator.className = 'repo-prompt-indicator';
    if (cfg.mode === 'repo' && cfg.repoFile) {
      customIndicator.textContent = cfg.repoFile.split('/').pop();  // show just filename
      customIndicator.title = `Custom prompt: ${cfg.repoFile}`;
    }

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    // Gear button
    const gearBtn = document.createElement('button');
    gearBtn.className = 'repo-gear-btn';
    gearBtn.innerHTML = '&#9881;';  // ⚙
    gearBtn.title = 'Set a custom review prompt from this repo';
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleRepoConfigPopover(repoKey, gearBtn);
    });

    header.appendChild(starBtn);
    header.appendChild(chevron);
    header.appendChild(repoName);
    header.appendChild(prCount);
    header.appendChild(customIndicator);
    header.appendChild(spacer);
    header.appendChild(gearBtn);

    // Toggle collapse on header click (but not gear)
    header.addEventListener('click', () => {
      collapsedRepos[repoKey] = !collapsedRepos[repoKey];
      renderPrList(currentPrs);
    });

    prListEl.appendChild(header);

    // ── PR items (if not collapsed) ───────────────────
    if (!isCollapsed) {
      repoPrs.forEach((pr) => {
        const key = `${pr.project}/${pr.repo}/${pr.id}`;
        const review = reviewStatuses[key];
        const reviewStatus = review ? review.status : null;
        const reviewAgent = review ? review.agentId : null;
        const dotClass = reviewStatus || pr.reviewStatus || 'pending';

        const item = document.createElement('div');
        const prAgeMs = pr.createdDate ? (Date.now() - new Date(pr.createdDate).getTime()) : 0;
        const prAgeDays = Math.floor(prAgeMs / (24 * 60 * 60 * 1000));
        const isOld = prAgeDays > maxPrAgeDays;
        const isCloning = reviewStatus === 'cloning';
        item.className = `pr-item grouped${isOld ? ' stale' : ''}${isCloning ? ' cloning' : ''}`;

        // Status dot
        const dot = document.createElement('div');
        dot.className = `status-dot ${dotClass}`;
        dot.title = dotClass;

        // Age label
        const ageStr = prAgeDays === 0 ? 'today' : prAgeDays === 1 ? '1d ago' : `${prAgeDays}d ago`;

        // Info — show just PR number + title since repo is in the header
        const info = document.createElement('div');
        info.className = 'pr-info';
        const showRunning = reviewStatus === 'running' || reviewStatus === 'cloning';
        info.innerHTML = `
          <div class="pr-path">#${pr.id} ${esc(pr.title)}</div>
          <div class="pr-title">by ${esc(pr.createdBy)} · ${ageStr}</div>
          ${showRunning ? `<div class="pr-running-line" data-running-key="${esc(key)}">${esc(statusLineFor(key))}</div>` : ''}
        `;

        // Badge + view button for active reviews
        const actions = document.createElement('div');
        actions.className = 'pr-actions';

        if (reviewStatus) {
          if (isCloning) {
            const loader = document.createElement('span');
            loader.className = 'row-loader';
            loader.setAttribute('aria-label', 'Cloning repo');
            const ring = document.createElement('span');
            ring.className = 'spinner-ring';
            const label = document.createElement('span');
            label.textContent = 'cloning\u2026';
            loader.appendChild(ring);
            loader.appendChild(label);
            actions.appendChild(loader);

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn-cancel-review';
            cancelBtn.textContent = '✕';
            cancelBtn.title = 'Cancel';
            cancelBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              cancelReview(key);
            });
            actions.appendChild(cancelBtn);
          } else {
            const badge = document.createElement('span');
            badge.className = `pr-review-badge ${reviewStatus}`;
            badge.textContent = reviewStatus;
            actions.appendChild(badge);

            if (reviewStatus === 'running') {
              const cancelBtn = document.createElement('button');
              cancelBtn.className = 'btn-cancel-review';
              cancelBtn.textContent = '✕';
              cancelBtn.title = 'Cancel review';
              cancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                cancelReview(key);
              });
              actions.appendChild(cancelBtn);
            }

            const viewBtn = document.createElement('button');
            viewBtn.className = 'btn-view-review';
            viewBtn.textContent = '\u25B8';
            viewBtn.title = 'View review output';
            viewBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              openReviewDetail(key, pr, reviewStatus, reviewAgent);
            });
            actions.appendChild(viewBtn);
          }
        } else {
          // Mode chip — visible whenever no review is active. Click toggles.
          const mode = getPrMode(pr);
          const modeChip = document.createElement('button');
          modeChip.className = `pr-mode-chip ${mode}`;
          modeChip.textContent = mode;
          modeChip.title = mode === 'resolve'
            ? 'Resolve mode: address review comments and push back. Click to switch to review.'
            : 'Review mode: post review comments. Click to switch to resolve.';
          modeChip.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePrMode(pr);
            renderPrList(currentPrs);
          });
          actions.appendChild(modeChip);
        }

        if (!reviewStatus && revealedRows.has(key)) {
          // Reveal state: Play + dismiss
          const mode = getPrMode(pr);
          const playBtn = document.createElement('button');
          playBtn.className = 'btn-play-row';
          playBtn.textContent = '▶';  // ▶
          playBtn.title = mode === 'resolve' ? 'Address review comments and push' : 'Start review';
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            revealedRows.delete(key);
            startReview(pr);
          });
          actions.appendChild(playBtn);

          const dismissBtn = document.createElement('button');
          dismissBtn.className = 'btn-dismiss-row';
          dismissBtn.textContent = '✕';  // ✕
          dismissBtn.title = 'Cancel';
          dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            revealedRows.delete(key);
            renderPrList(currentPrs);
          });
          actions.appendChild(dismissBtn);
        }

        item.appendChild(dot);
        item.appendChild(info);
        item.appendChild(actions);

        // Click: if a review exists, open the detail; otherwise toggle reveal.
        // While cloning, the row is locked — only the inline Cancel button works.
        item.addEventListener('click', () => {
          if (isCloning) return;
          if (reviewStatus) {
            openReviewDetail(key, pr, reviewStatus, reviewAgent);
          } else if (revealedRows.has(key)) {
            revealedRows.delete(key);
            renderPrList(currentPrs);
          } else {
            revealedRows.add(key);
            renderPrList(currentPrs);
          }
        });

        prListEl.appendChild(item);
      });
    }
  });
}

// ── Repo config popover (gear icon) ─────────────────────────────
function toggleRepoConfigPopover(repoKey, anchorEl) {
  // Close any open popover
  closeConfigPopover();

  const cfg = repoConfigs[repoKey] || {};
  const hasCustom = cfg.mode === 'repo' && cfg.repoFile;

  const popover = document.createElement('div');
  popover.className = 'repo-config-popover';

  const titleEl = document.createElement('div');
  titleEl.className = 'popover-title';
  titleEl.textContent = 'Custom Review Prompt';
  popover.appendChild(titleEl);

  const hintEl = document.createElement('div');
  hintEl.className = 'popover-hint';
  hintEl.textContent = 'Pick a prompt file from this repo to use instead of the default.';
  popover.appendChild(hintEl);

  // ── Autocomplete input for repo file ──
  const autocomplete = createAutocompleteInput(
    repoKey,
    cfg.repoFile || '',
    'Search for a file in the repo\u2026',
  );
  popover.appendChild(autocomplete);

  // ── Button row: Save + Reset ──
  const btnRow = document.createElement('div');
  btnRow.className = 'popover-btn-row';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'popover-reset-btn';
  resetBtn.textContent = 'Use Default';
  resetBtn.title = 'Remove custom prompt and use the built-in LGTM template';
  if (!hasCustom) resetBtn.disabled = true;
  resetBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    delete repoConfigs[repoKey];

    const settings = await window.lgtm.getSettings();
    settings.repoConfigs = { ...settings.repoConfigs };
    delete settings.repoConfigs[repoKey];
    await window.lgtm.saveSettings(settings);

    closeConfigPopover();
    renderPrList(currentPrs);
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'popover-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const inp = popover.querySelector('.repo-config-input');
    const repoFile = inp ? inp.value.trim() : '';

    if (repoFile) {
      repoConfigs[repoKey] = { mode: 'repo', repoFile };
    } else {
      delete repoConfigs[repoKey];
    }

    const settings = await window.lgtm.getSettings();
    settings.repoConfigs = { ...repoConfigs };
    await window.lgtm.saveSettings(settings);

    closeConfigPopover();
    renderPrList(currentPrs);
  });

  btnRow.appendChild(resetBtn);
  btnRow.appendChild(saveBtn);
  popover.appendChild(btnRow);

  // Position the popover below the gear button
  const rect = anchorEl.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.right = `${window.innerWidth - rect.right}px`;

  document.body.appendChild(popover);
  openConfigPopover = popover;

  // Auto-focus the input
  const inp = popover.querySelector('.repo-config-input');
  if (inp) setTimeout(() => inp.focus(), 50);

  // Close on outside click (deferred to avoid immediate close)
  setTimeout(() => {
    document.addEventListener('click', onOutsidePopoverClick);
  }, 10);
}

function onOutsidePopoverClick(e) {
  if (openConfigPopover && !openConfigPopover.contains(e.target)) {
    closeConfigPopover();
  }
}

function closeConfigPopover() {
  if (openConfigPopover) {
    openConfigPopover.remove();
    openConfigPopover = null;
    document.removeEventListener('click', onOutsidePopoverClick);
  }
}

// ── Star toggle ─────────────────────────────────────────────────
async function toggleStar(repoKey) {
  if (starredRepos.has(repoKey)) {
    starredRepos.delete(repoKey);
  } else {
    starredRepos.add(repoKey);
  }
  await window.lgtm.saveStarredRepos(Array.from(starredRepos));
  renderPrList(currentPrs);
}

// ── Auto-review (processes starred repos first) ─────────────────
async function startAutoReview() {
  if (autoReviewRunning) return;
  autoReviewRunning = true;
  updateAutoReviewBtn();

  // Filter by age, then sort: starred repos first, then unstarred
  const cutoffMs = maxPrAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const queue = [...currentPrs]
    .filter((pr) => {
      if (!pr.createdDate) return true;  // include if no date (shouldn't happen)
      return (now - new Date(pr.createdDate).getTime()) <= cutoffMs;
    })
    .sort((a, b) => {
      const aKey = `${a.project}/${a.repo}`;
      const bKey = `${b.project}/${b.repo}`;
      const aStarred = starredRepos.has(aKey) ? 0 : 1;
      const bStarred = starredRepos.has(bKey) ? 0 : 1;
      if (aStarred !== bStarred) return aStarred - bStarred;
      return aKey.localeCompare(bKey);
    });

  for (const pr of queue) {
    if (!autoReviewRunning) break;  // user cancelled

    const key = `${pr.project}/${pr.repo}/${pr.id}`;
    const existing = reviewStatuses[key];
    // Skip PRs that are already running, cloning, or completed
    if (existing && (existing.status === 'running' || existing.status === 'cloning' || existing.status === 'completed')) {
      continue;
    }

    // Start the review and wait for it to finish before moving to next
    await startReview(pr);

    // Wait for this review to complete before starting the next one
    await waitForReviewComplete(key);
  }

  autoReviewRunning = false;
  updateAutoReviewBtn();
}

function stopAutoReview() {
  autoReviewRunning = false;
  updateAutoReviewBtn();
}

function waitForReviewComplete(key) {
  return new Promise((resolve) => {
    const check = () => {
      const review = reviewStatuses[key];
      if (!review || review.status === 'completed' || review.status === 'failed') {
        resolve();
      } else if (!autoReviewRunning) {
        resolve();  // cancelled
      } else {
        setTimeout(check, 1000);
      }
    };
    // Start checking after a brief delay to allow the status to be set
    setTimeout(check, 500);
  });
}

function updateAutoReviewBtn() {
  const btn = document.getElementById('auto-review-btn');
  if (!btn) return;
  if (autoReviewRunning) {
    btn.textContent = '\u25A0';  // ■ stop
    btn.title = 'Stop auto-review';
    btn.classList.add('running');
  } else {
    btn.textContent = '\u25B6';  // ▶ play
    btn.title = 'Auto-review all PRs (starred repos first)';
    btn.classList.remove('running');
  }
}

async function startReview(pr) {
  const key = `${pr.project}/${pr.repo}/${pr.id}`;
  if (reviewStatuses[key] && (reviewStatuses[key].status === 'running' || reviewStatuses[key].status === 'cloning')) return;

  const agentId = selectedAgent || 'claude';
  const model = agentModels[agentId] || null;
  const mode = getPrMode(pr);

  // Optimistically show cloning state
  reviewStatuses[key] = { status: 'cloning', agentId, output: '' };
  renderPrList(currentPrs);

  const result = await window.lgtm.reviewPr({ pr, agentId, model, mode });
  if (!result.success) {
    reviewStatuses[key].status = 'failed';
    reviewStatuses[key].output = result.error || 'Failed to start review.';
    renderPrList(currentPrs);
    alert(result.error);
  }
}

// ── Cancel review ────────────────────────────────────────────────
async function cancelReview(key) {
  const result = await window.lgtm.cancelReview(key);
  if (!result.success) {
    console.warn('[LGTM] Cancel failed:', result.error);
    return;
  }
  if (reviewStatuses[key]) {
    reviewStatuses[key].status = 'cancelled';
  }
  rerenderForKey(key);
  if (activeDetailKey === key) {
    reviewDetailDot.className = 'status-dot cancelled';
    reviewDetailCancelBtn.classList.add('hidden');
  }
}

function rerenderForKey(key) {
  if (key && key.includes('/wi-')) {
    if (currentBugs.length)    renderBugList(currentBugs);
    if (currentTickets.length) renderTicketList(currentTickets);
  } else {
    renderPrList(currentPrs);
  }
}

// ── Review detail panel ──────────────────────────────────────────
let detailState = {
  key: null,
  detail: null,        // last full snapshot from getReviewDetail
  followTail: true,
  searchTerm: '',
  rawOutput: '',
};
let elapsedTimer = null;

function updateDetailCancelVisibility(status) {
  if (status === 'running' || status === 'cloning') {
    reviewDetailCancelBtn.classList.remove('hidden');
  } else {
    reviewDetailCancelBtn.classList.add('hidden');
  }
}

async function openReviewDetail(key, pr, status, agentId) {
  activeDetailKey = key;
  detailSourceTab = activeTab;
  detailState = { key, detail: null, followTail: true, searchTerm: '', rawOutput: '' };
  rdSearchInput.value = '';
  rdFollowTail.checked = true;
  rdJumpBottomBtn.classList.add('hidden');

  const titleLeft = pr && pr.repo ? `${pr.repo}/#${pr.id}` : (pr ? `#${pr.id}` : key);
  reviewDetailTitle.textContent = titleLeft;
  reviewDetailMeta.textContent = `${pr && pr.title ? pr.title + ' · ' : ''}${agentId || 'unknown'}`;
  reviewDetailDot.className = `status-dot ${status || 'pending'}`;
  updateDetailCancelVisibility(status);

  showView(reviewDetailView);
  startElapsedTimer();

  // Pull full detail (prompt, timeline, report, clone path) from main.
  let detail = null;
  try { detail = await window.lgtm.getReviewDetail(key); } catch { /* ignore */ }
  detailState.detail = detail;

  // Output: prefer main's authoritative copy, fall back to local mirror.
  const localOutput = reviewStatuses[key] ? reviewStatuses[key].output : '';
  detailState.rawOutput = (detail && detail.output) || localOutput || '';

  // Hydrate UI from detail (if available).
  if (detail) {
    reviewDetailMeta.textContent = formatDetailMeta(detail);
    renderTimeline(detail);
    renderReportCard(detail);
    renderPromptPanel(detail);
    updateActionButtons(detail);
  } else {
    rdTimelineEl.innerHTML = '';
    rdReportEl.classList.add('hidden');
    rdPromptEl.textContent = '';
    rdPromptMetaEl.textContent = '';
    updateActionButtons(null);
  }

  renderOutput();
  scheduleScrollToBottom();
}

function formatDetailMeta(detail) {
  const parts = [];
  if (detail.pr && detail.pr.title) parts.push(detail.pr.title);
  if (detail.agentId) parts.push(detail.agentId + (detail.model ? `:${detail.model}` : ''));
  if (detail.scenarioId) parts.push(detail.scenarioId);
  if (detail.mode && detail.mode !== 'review') parts.push(`mode=${detail.mode}`);
  return parts.join(' · ');
}

function startElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  const tick = () => {
    const d = detailState.detail;
    if (!d) { reviewElapsedEl.textContent = ''; return; }
    const end = (d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled')
      ? (d.finishedAt || Date.now())
      : Date.now();
    const ms = Math.max(0, end - (d.startedAt || end));
    reviewElapsedEl.textContent = formatDuration(ms);
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function formatDuration(ms) {
  if (ms < 1000) return '0s';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function renderTimeline(detail) {
  const timeline = detail.timeline || [];
  if (timeline.length === 0) { rdTimelineEl.innerHTML = ''; return; }
  const parts = [];
  for (let i = 0; i < timeline.length; i++) {
    const cur = timeline[i];
    const next = timeline[i + 1];
    const isLast = i === timeline.length - 1;
    let endAt;
    if (next) endAt = next.at;
    else if (isLast && (cur.status === 'completed' || cur.status === 'failed' || cur.status === 'cancelled'))
      endAt = detail.finishedAt || cur.at;
    else endAt = Date.now();
    const dur = formatDuration(Math.max(0, endAt - cur.at));
    parts.push(
      `<span class="timeline-pill ${cur.status}">` +
      `<span class="dot"></span>` +
      `<span class="label">${cur.status}</span>` +
      `<span class="duration">${dur}</span>` +
      `</span>`
    );
  }
  rdTimelineEl.innerHTML = parts.join('');
}

function renderReportCard(detail) {
  if (detail.reportStatus === 'report_unparseable') {
    rdReportEl.innerHTML = `
      <div class="report-title">Final report</div>
      <div class="report-unparseable">Could not parse final JSON report${detail.reportError ? ` — ${escHtml(detail.reportError)}` : ''}.</div>
    `;
    rdReportEl.classList.remove('hidden');
    return;
  }
  const report = detail.report;
  if (!report) { rdReportEl.classList.add('hidden'); return; }

  let html = '<div class="report-title">Final report</div><div class="report-grid">';

  if (detail.scenarioId === 'pr-review') {
    html += stat('Comments posted', report.comments_posted);
    html += stat('Files reviewed', report.files_reviewed);
    html += stat('Rule violations', report.rules_violations_flagged);
    html += stat('Suppressed dupes', report.comments_suppressed_as_duplicate);
    html += '</div>';
    if (report.severity_breakdown) {
      const sb = report.severity_breakdown;
      html += '<div class="severity-row">'
        + sevChip('blocking', sb.blocking)
        + sevChip('important', sb.important)
        + sevChip('suggestion', sb.suggestion)
        + sevChip('nit', sb.nit)
        + '</div>';
    }
  } else if (detail.scenarioId === 'resolve-comments') {
    html += stat('Threads processed', report.threads_processed);
    html += stat('Fixed', report.threads_fixed);
    html += stat('Won\'t fix', report.threads_wont_fix);
    html += stat('Cannot resolve', report.threads_cannot_resolve);
    html += stat('Commits pushed', report.commits_pushed);
    html += '</div>';
  } else if (detail.scenarioId === 'implement-ticket') {
    html += stat('Outcome', report.outcome || '—');
    html += stat('Files changed', report.files_changed);
    html += stat('Tests added', report.tests_added);
    html += stat('Tests modified', report.tests_modified);
    html += '</div>';
    if (report.pr_id && report.pr_url) {
      html += `<a class="report-link" data-href="${escHtml(report.pr_url)}">→ Open PR !${report.pr_id}</a>`;
    } else if (report.branch_name) {
      html += `<div style="font-size:11px;color:var(--text-dim);margin-top:4px">Branch: <code>${escHtml(report.branch_name)}</code></div>`;
    }
  } else {
    html += '</div>';
  }

  if (report.notes_for_human) {
    html += `<div class="report-notes">${escHtml(report.notes_for_human)}</div>`;
  }

  rdReportEl.innerHTML = html;
  rdReportEl.classList.remove('hidden');

  const linkEl = rdReportEl.querySelector('.report-link');
  if (linkEl) {
    linkEl.addEventListener('click', () => {
      const href = linkEl.getAttribute('data-href');
      if (href) window.lgtm.openExternal(href);
    });
  }

  function stat(label, value) {
    const v = (value === undefined || value === null) ? '—' : value;
    return `<div class="report-stat"><span class="label">${escHtml(label)}</span><span class="value">${escHtml(String(v))}</span></div>`;
  }
  function sevChip(kind, n) {
    const v = (n === undefined || n === null) ? 0 : n;
    return `<span class="severity-chip ${kind}">${escHtml(kind)} <strong>${v}</strong></span>`;
  }
}

function renderPromptPanel(detail) {
  const prompt = detail.prompt || '';
  rdPromptEl.textContent = prompt;
  rdPromptMetaEl.textContent = prompt
    ? `${prompt.length.toLocaleString()} chars`
    : '(not yet built)';
}

function updateActionButtons(detail) {
  const status = detail ? detail.status : null;
  rdOpenAdoBtn.disabled = !(detail && detail.pr && detail.pr.webUrl);
  rdCopyBtn.disabled = !(detail && detail.output);
  rdSaveBtn.disabled = !(detail && detail.output);
  // Reveal clone: only meaningful while we have a clone path on disk
  // (cloning/running). After the run finishes the cloner cleans it up.
  if (detail && detail.clonePath && (status === 'cloning' || status === 'running')) {
    rdOpenCloneBtn.classList.remove('hidden');
    rdOpenCloneBtn.disabled = false;
  } else {
    rdOpenCloneBtn.classList.add('hidden');
  }
  // Re-run: only when finished.
  const canRerun = !!detail && (status === 'completed' || status === 'failed' || status === 'cancelled');
  rdRerunBtn.disabled = !canRerun;
  rdRerunMenuBtn.disabled = !canRerun;
}

function renderOutput() {
  const text = detailState.rawOutput || '';
  const term = detailState.searchTerm.trim();
  let html = renderMarkdownToHtml(text);
  if (term) {
    const re = new RegExp(escapeRegex(term), 'gi');
    // Only highlight inside text nodes — but our renderer emits naive HTML;
    // safe enough to wrap matches outside tags via a heuristic split.
    html = html.replace(/(>[^<]+)/g, (chunk) => chunk.replace(re, (m) => `<mark>${m}</mark>`));
  }
  reviewOutputEl.innerHTML = html;
  if (rdOutputMetaEl) {
    const lines = text ? text.split('\n').length : 0;
    rdOutputMetaEl.textContent = `${lines.toLocaleString()} lines · ${text.length.toLocaleString()} chars${term ? ` · filter: "${term}"` : ''}`;
  }
}

function renderMarkdownToHtml(text) {
  let html = escHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scheduleScrollToBottom() {
  // Wait for DOM paint so scrollHeight is correct.
  requestAnimationFrame(() => {
    if (detailState.followTail) {
      reviewOutputEl.scrollTop = reviewOutputEl.scrollHeight;
    }
  });
}

reviewBackBtn.addEventListener('click', () => {
  activeDetailKey = null;
  stopElapsedTimer();
  setActiveTab(detailSourceTab || 'prs');
  showView(prListView);
});

reviewDetailCancelBtn.addEventListener('click', () => {
  if (activeDetailKey) cancelReview(activeDetailKey);
});

// ── Detail action bar ────────────────────────────────────────────
rdOpenAdoBtn.addEventListener('click', () => {
  const url = detailState.detail && detailState.detail.pr && detailState.detail.pr.webUrl;
  if (url) window.lgtm.openExternal(url);
});

rdOpenCloneBtn.addEventListener('click', async () => {
  const p = detailState.detail && detailState.detail.clonePath;
  if (!p) return;
  const result = await window.lgtm.openPath(p);
  if (!result || !result.success) {
    alert((result && result.error) || 'Could not open clone path.');
  }
});

rdCopyBtn.addEventListener('click', async () => {
  const text = detailState.rawOutput || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flashButton(rdCopyBtn, 'Copied');
  } catch {
    alert('Copy failed. Try Save log instead.');
  }
});

rdSaveBtn.addEventListener('click', async () => {
  if (!activeDetailKey) return;
  const suggested = sanitizeFilename(`lgtm-${activeDetailKey}.log`);
  const result = await window.lgtm.saveLogFile({ key: activeDetailKey, suggestedName: suggested });
  if (result && result.success) flashButton(rdSaveBtn, 'Saved');
  else if (result && !result.cancelled) alert(result.error || 'Could not save log.');
});

function flashButton(btn, msg) {
  const orig = btn.textContent;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1100);
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

// ── Re-run ───────────────────────────────────────────────────────
rdRerunBtn.addEventListener('click', () => doRerun(null, null));

rdRerunMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (rdRerunPopover.classList.contains('hidden')) openRerunPopover();
  else closeRerunPopover();
});

rdRerunCancelBtn.addEventListener('click', closeRerunPopover);
rdRerunConfirmBtn.addEventListener('click', () => {
  doRerun(rdRerunAgentSel.value || null, rdRerunModelSel.value || null);
  closeRerunPopover();
});

document.addEventListener('click', (e) => {
  if (rdRerunPopover.classList.contains('hidden')) return;
  if (rdRerunPopover.contains(e.target) || rdRerunMenuBtn.contains(e.target)) return;
  closeRerunPopover();
});

function openRerunPopover() {
  rdRerunAgentSel.innerHTML = '';
  agents.forEach((a) => {
    if (!a.available) return;
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    rdRerunAgentSel.appendChild(opt);
  });
  rdRerunAgentSel.value = (detailState.detail && detailState.detail.agentId) || agents.find((a) => a.available)?.id || '';
  populateRerunModels();
  rdRerunAgentSel.onchange = populateRerunModels;
  rdRerunPopover.classList.remove('hidden');
}

function populateRerunModels() {
  rdRerunModelSel.innerHTML = '';
  const agent = agents.find((a) => a.id === rdRerunAgentSel.value);
  if (!agent) return;
  agent.models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    rdRerunModelSel.appendChild(opt);
  });
  const preferred = (detailState.detail && detailState.detail.agentId === agent.id)
    ? detailState.detail.model
    : agentModels[agent.id];
  if (preferred && agent.models.some((m) => m.id === preferred)) {
    rdRerunModelSel.value = preferred;
  }
}

function closeRerunPopover() { rdRerunPopover.classList.add('hidden'); }

async function doRerun(agentId, model) {
  if (!activeDetailKey) return;
  // Wipe the cached output / report so we don't see the previous run's
  // content stitched onto the new run. The new dispatch reuses the same key.
  detailState.rawOutput = '';
  detailState.detail = null;
  rdReportEl.classList.add('hidden');
  rdTimelineEl.innerHTML = '';
  rdPromptEl.textContent = '';
  rdPromptMetaEl.textContent = '';
  reviewOutputEl.innerHTML = '';
  rdJumpBottomBtn.classList.add('hidden');
  detailState.followTail = true;
  rdFollowTail.checked = true;
  if (reviewStatuses[activeDetailKey]) reviewStatuses[activeDetailKey].output = '';

  const result = await window.lgtm.rerunReview({
    key: activeDetailKey,
    agentId,
    model,
  });
  if (!result || !result.success) {
    alert((result && result.error) || 'Re-run failed.');
    return;
  }

  // Pull a fresh detail snapshot so the timeline/prompt panels populate
  // immediately for the new run.
  const detail = await window.lgtm.getReviewDetail(activeDetailKey).catch(() => null);
  if (detail && activeDetailKey === detail.key) {
    detailState.detail = detail;
    renderTimeline(detail);
    renderPromptPanel(detail);
    updateActionButtons(detail);
    startElapsedTimer();
  }
}

// ── Output toolbar (search + follow tail) ────────────────────────
rdSearchInput.addEventListener('input', () => {
  detailState.searchTerm = rdSearchInput.value || '';
  renderOutput();
});

rdFollowTail.addEventListener('change', () => {
  detailState.followTail = rdFollowTail.checked;
  if (detailState.followTail) {
    reviewOutputEl.scrollTop = reviewOutputEl.scrollHeight;
    rdJumpBottomBtn.classList.add('hidden');
  }
});

reviewOutputEl.addEventListener('scroll', () => {
  const el = reviewOutputEl;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  if (nearBottom) {
    detailState.followTail = true;
    rdFollowTail.checked = true;
    rdJumpBottomBtn.classList.add('hidden');
  } else {
    if (detailState.followTail) {
      // User scrolled away from the tail — disable follow.
      detailState.followTail = false;
      rdFollowTail.checked = false;
    }
    if (detailState.detail && (detailState.detail.status === 'cloning' || detailState.detail.status === 'running')) {
      rdJumpBottomBtn.classList.remove('hidden');
    }
  }
});

rdJumpBottomBtn.addEventListener('click', () => {
  detailState.followTail = true;
  rdFollowTail.checked = true;
  reviewOutputEl.scrollTop = reviewOutputEl.scrollHeight;
  rdJumpBottomBtn.classList.add('hidden');
});

// ── Refresh (refreshes the active tab) ───────────────────────────
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '⟳';
  try {
    if (activeTab === 'bugs') {
      const result = await window.lgtm.refreshBugs();
      if (result.success) renderBugList(result.bugs);
    } else if (activeTab === 'tickets') {
      const result = await window.lgtm.refreshWorkItems();
      if (result.success) renderTicketList(result.items);
    } else {
      const result = await window.lgtm.refreshPrs();
      if (result.success) renderPrList(result.prs);
    }
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '↻';
  }
});

// ── Tabs ─────────────────────────────────────────────────────────
function setActiveTab(tab) {
  activeTab = tab;
  const tabs = [
    { key: 'prs',     btn: tabPrsBtn,     pane: tabPanePrs },
    { key: 'bugs',    btn: tabBugsBtn,    pane: tabPaneBugs },
    { key: 'tickets', btn: tabTicketsBtn, pane: tabPaneTickets },
  ];
  tabs.forEach(({ key, btn, pane }) => {
    const active = key === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    pane.classList.toggle('hidden', !active);
  });

  if (tab === 'bugs' && !bugsLoaded) {
    bugsLoaded = true;
    refreshBugs();
  }
  if (tab === 'tickets' && !ticketsLoaded) {
    ticketsLoaded = true;
    refreshTickets();
  }
}

tabPrsBtn.addEventListener('click', () => setActiveTab('prs'));
tabBugsBtn.addEventListener('click', () => setActiveTab('bugs'));
tabTicketsBtn.addEventListener('click', () => setActiveTab('tickets'));

// ── Bugs: render & refresh ───────────────────────────────────────
function renderBugList(bugs) {
  currentBugs = bugs || [];
  bugListEl.innerHTML = '';

  // Update tab count badge
  if (currentBugs.length > 0) {
    bugsTabCount.textContent = currentBugs.length;
    bugsTabCount.classList.remove('hidden');
  } else {
    bugsTabCount.classList.add('hidden');
  }

  if (currentBugs.length === 0) {
    bugListEl.classList.add('hidden');
    noBugsEl.classList.remove('hidden');
    return;
  }
  bugListEl.classList.remove('hidden');
  noBugsEl.classList.add('hidden');

  // Group by project, preserving the priority-sorted order from the backend.
  const groups = {};
  currentBugs.forEach((bug) => {
    if (!groups[bug.project]) groups[bug.project] = [];
    groups[bug.project].push(bug);
  });

  const projectNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  projectNames.forEach((project) => {
    const items = groups[project];
    const isCollapsed = collapsedBugProjects[project] || false;

    const header = document.createElement('div');
    header.className = 'repo-group-header';

    const chevron = document.createElement('span');
    chevron.className = `repo-chevron${isCollapsed ? ' collapsed' : ''}`;
    chevron.textContent = '▾';

    const name = document.createElement('span');
    name.className = 'repo-group-name';
    name.textContent = project;

    const count = document.createElement('span');
    count.className = 'repo-group-count';
    count.textContent = items.length;

    header.appendChild(chevron);
    header.appendChild(name);
    header.appendChild(count);

    header.addEventListener('click', () => {
      collapsedBugProjects[project] = !collapsedBugProjects[project];
      renderBugList(currentBugs);
    });

    bugListEl.appendChild(header);

    if (isCollapsed) return;

    items.forEach((bug) => {
      renderWorkItemRow(bugListEl, bug, 'Bug');
    });
  });
}

async function refreshBugs() {
  bugListEl.innerHTML = '<div class="loading">Loading bugs…</div>';
  noBugsEl.classList.add('hidden');
  const result = await window.lgtm.refreshBugs();
  if (result.success) {
    renderBugList(result.bugs);
  } else {
    bugListEl.innerHTML = `<div class="loading">Failed to load bugs: ${esc(result.error || '')}</div>`;
  }
}

// ── Work item row (shared by Bugs & Tickets) ─────────────────────
function findWorkItemReview(project, id) {
  const suffix = `/wi-${id}`;
  for (const k of Object.keys(reviewStatuses)) {
    if (k.startsWith(`${project}/`) && k.endsWith(suffix)) {
      return { key: k, review: reviewStatuses[k] };
    }
  }
  return null;
}

function renderWorkItemRow(container, wi, typeLabel) {
  const revealKey = `wi-${wi.project}-${wi.id}`;
  const running = findWorkItemReview(wi.project, wi.id);
  const reviewStatus = running ? running.review.status : null;
  const reviewAgent = running ? running.review.agentId : null;
  const runtimeKey = running ? running.key : null;

  const pri = typeof wi.priority === 'number' ? wi.priority : null;
  const priClass = pri ? `p${pri}` : 'pnone';
  const priLabel = pri ? `P${pri}` : '—';

  const row = document.createElement('div');
  const isCloning = reviewStatus === 'cloning';
  row.className = `pr-item grouped${isCloning ? ' cloning' : ''}`;

  const priEl = document.createElement('span');
  priEl.className = `bug-pri ${priClass}`;
  priEl.textContent = priLabel;
  priEl.title = pri ? `Priority ${pri}` : 'No priority set';

  const typeEl = document.createElement('span');
  typeEl.className = `wi-type ${typeClassFor(typeLabel)}`;
  typeEl.textContent = typeLabel;

  // Meta line: state + optional sprint name + age
  let meta = esc(wi.state || '');
  if (!wi.isBacklog && wi.iterationName) meta = `${esc(wi.iterationName)} · ${meta}`;
  if (wi.isBacklog) meta = `Backlog · ${meta}`;

  const info = document.createElement('div');
  info.className = 'pr-info';
  const showRunning = reviewStatus === 'running' || reviewStatus === 'cloning';
  info.innerHTML = `
    <div class="pr-path">#${wi.id} ${esc(wi.title)}</div>
    <div class="pr-title">${meta}</div>
    ${showRunning && runtimeKey ? `<div class="pr-running-line" data-running-key="${esc(runtimeKey)}">${esc(statusLineFor(runtimeKey))}</div>` : ''}
  `;

  const actions = document.createElement('div');
  actions.className = 'pr-actions';

  if (reviewStatus) {
    if (isCloning) {
      const loader = document.createElement('span');
      loader.className = 'row-loader';
      loader.setAttribute('aria-label', 'Cloning repo');
      const ring = document.createElement('span');
      ring.className = 'spinner-ring';
      const label = document.createElement('span');
      label.textContent = 'cloning…';
      loader.appendChild(ring);
      loader.appendChild(label);
      actions.appendChild(loader);

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-cancel-review';
      cancelBtn.textContent = '✕';
      cancelBtn.title = 'Cancel';
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelReview(runtimeKey);
      });
      actions.appendChild(cancelBtn);
    } else {
      const badge = document.createElement('span');
      badge.className = `pr-review-badge ${reviewStatus}`;
      badge.textContent = reviewStatus;
      actions.appendChild(badge);

      if (reviewStatus === 'running') {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-cancel-review';
        cancelBtn.textContent = '✕';
        cancelBtn.title = 'Cancel';
        cancelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          cancelReview(runtimeKey);
        });
        actions.appendChild(cancelBtn);
      }

      const viewBtn = document.createElement('button');
      viewBtn.className = 'btn-view-review';
      viewBtn.textContent = '▸';
      viewBtn.title = 'View output';
      viewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openReviewDetail(runtimeKey, running.review.pr || wiAsPr(wi), reviewStatus, reviewAgent);
      });
      actions.appendChild(viewBtn);
    }
  } else if (revealedRows.has(revealKey)) {
    const playBtn = document.createElement('button');
    playBtn.className = 'btn-play-row';
    playBtn.textContent = '▶';
    playBtn.title = 'Start agent';
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRepoPickerForWorkItem(wi, playBtn);
    });
    actions.appendChild(playBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn-dismiss-row';
    dismissBtn.textContent = '✕';
    dismissBtn.title = 'Cancel';
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      revealedRows.delete(revealKey);
      rerenderActiveWorkItemList();
    });
    actions.appendChild(dismissBtn);
  }

  row.appendChild(priEl);
  row.appendChild(typeEl);
  row.appendChild(info);
  row.appendChild(actions);

  row.addEventListener('click', () => {
    if (isCloning) return;
    if (reviewStatus) {
      openReviewDetail(runtimeKey, running.review.pr || wiAsPr(wi), reviewStatus, reviewAgent);
    } else if (revealedRows.has(revealKey)) {
      revealedRows.delete(revealKey);
      rerenderActiveWorkItemList();
    } else {
      revealedRows.add(revealKey);
      rerenderActiveWorkItemList();
    }
  });

  container.appendChild(row);
}

function wiAsPr(wi) {
  // Minimal shape so openReviewDetail renders a sensible header for a work item.
  return {
    id: wi.id,
    title: wi.title,
    project: wi.project,
    repo: '',
    webUrl: wi.webUrl,
  };
}

function rerenderActiveWorkItemList() {
  if (activeTab === 'bugs') renderBugList(currentBugs);
  else if (activeTab === 'tickets') renderTicketList(currentTickets);
}

// ── Repo picker popover (for work-item agent actions) ────────────
let openRepoPicker = null;

async function openRepoPickerForWorkItem(wi, anchorEl) {
  closeRepoPicker();

  const popover = document.createElement('div');
  popover.className = 'repo-config-popover repo-picker';

  const title = document.createElement('div');
  title.className = 'popover-title';
  title.textContent = `Start agent on ${wi.type || 'work item'} #${wi.id}`;
  popover.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'popover-hint';
  hint.textContent = 'Pick a repo to clone. The agent will work on its default branch.';
  popover.appendChild(hint);

  const loading = document.createElement('div');
  loading.className = 'popover-hint';
  loading.textContent = 'Loading repos…';
  popover.appendChild(loading);

  positionRepoPicker(popover, anchorEl);
  document.body.appendChild(popover);
  openRepoPicker = popover;
  setTimeout(() => document.addEventListener('click', onOutsideRepoPickerClick), 10);

  // Load repos (cache per session)
  let repos = repoCache[wi.project];
  if (!repos) {
    const result = await window.lgtm.getReposForProject(wi.project);
    if (result && result.success) {
      repos = result.repos;
      repoCache[wi.project] = repos;
    } else {
      loading.textContent = `Failed to load repos: ${result?.error || ''}`;
      return;
    }
  }

  if (!repos || repos.length === 0) {
    loading.textContent = 'No repos found in this project.';
    return;
  }

  // Replace loading with select + go button
  loading.remove();

  const select = document.createElement('select');
  select.className = 'repo-picker-select';
  const sorted = [...repos].sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.name;
    opt.textContent = r.name;
    select.appendChild(opt);
  });
  const defaultRepo = lastUsedRepos[wi.project];
  if (defaultRepo && sorted.some((r) => r.name === defaultRepo)) {
    select.value = defaultRepo;
  }
  popover.appendChild(select);

  const btnRow = document.createElement('div');
  btnRow.className = 'popover-btn-row';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'popover-reset-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeRepoPicker();
  });

  const goBtn = document.createElement('button');
  goBtn.className = 'popover-save-btn';
  goBtn.textContent = 'Start';
  goBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const repoName = select.value;
    const repoInfo = { project: wi.project, repo: repoName };

    // Tab-specific agent/model and per-repo prompt file.
    const isBugs = activeTab === 'bugs';
    const tabAgent  = isBugs ? bugsSelectedAgent : ticketsSelectedAgent;
    const tabModels = isBugs ? bugsAgentModels   : ticketsAgentModels;
    const tabRepoCfgs = isBugs ? bugsRepoConfigs : ticketsRepoConfigs;

    const agentId = tabAgent || selectedAgent || 'claude';
    const model = tabModels[agentId] || agentModels[agentId] || null;
    const repoKey = `${wi.project}/${repoName}`;
    const promptFile = tabRepoCfgs[repoKey] || '';

    // Optimistic local state
    lastUsedRepos[wi.project] = repoName;
    const optimisticKey = `${wi.project}/${repoName}/wi-${wi.id}`;
    reviewStatuses[optimisticKey] = {
      status: 'cloning',
      agentId,
      output: '',
      pr: wiAsPr(wi),
    };
    revealedRows.delete(`wi-${wi.project}-${wi.id}`);
    closeRepoPicker();
    rerenderActiveWorkItemList();

    const result = await window.lgtm.startWorkItemAction({
      workItem: wi,
      repoInfo,
      agentId,
      model,
      promptFile,
    });
    if (!result || !result.success) {
      reviewStatuses[optimisticKey].status = 'failed';
      reviewStatuses[optimisticKey].output = result?.error || 'Failed to start agent.';
      rerenderActiveWorkItemList();
      alert(result?.error || 'Failed to start agent.');
    }
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(goBtn);
  popover.appendChild(btnRow);

  // Reposition after content change and focus the select
  positionRepoPicker(popover, anchorEl);
  setTimeout(() => select.focus(), 30);
}

function positionRepoPicker(popover, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  popover.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 200)}px`;
  popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
}

function onOutsideRepoPickerClick(e) {
  if (openRepoPicker && !openRepoPicker.contains(e.target)) {
    closeRepoPicker();
  }
}

function closeRepoPicker() {
  if (openRepoPicker) {
    openRepoPicker.remove();
    openRepoPicker = null;
    document.removeEventListener('click', onOutsideRepoPickerClick);
  }
}

// ── Tickets (non-bug work items) ─────────────────────────────────
function renderTicketList(items) {
  currentTickets = items || [];
  ticketListEl.innerHTML = '';

  if (currentTickets.length > 0) {
    ticketsTabCount.textContent = currentTickets.length;
    ticketsTabCount.classList.remove('hidden');
  } else {
    ticketsTabCount.classList.add('hidden');
  }

  if (currentTickets.length === 0) {
    ticketListEl.classList.add('hidden');
    noTicketsEl.classList.remove('hidden');
    return;
  }
  ticketListEl.classList.remove('hidden');
  noTicketsEl.classList.add('hidden');

  // Group by project, then sort items within each group by sprint recency
  // (finishDate desc, backlog items last).
  const groups = {};
  currentTickets.forEach((item) => {
    if (!groups[item.project]) groups[item.project] = [];
    groups[item.project].push(item);
  });

  const sprintRank = (item) => {
    if (item.isBacklog) return -Infinity;
    const f = item.iterationFinish ? new Date(item.iterationFinish).getTime() : null;
    const s = item.iterationStart ? new Date(item.iterationStart).getTime() : null;
    return f ?? s ?? 0;
  };

  const projectNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  projectNames.forEach((project) => {
    const items = groups[project].slice().sort((a, b) => {
      if (a.isBacklog && !b.isBacklog) return 1;
      if (!a.isBacklog && b.isBacklog) return -1;
      return sprintRank(b) - sprintRank(a);
    });

    const isCollapsed = collapsedTicketProjects[project] || false;

    const header = document.createElement('div');
    header.className = 'repo-group-header';

    const chevron = document.createElement('span');
    chevron.className = `repo-chevron${isCollapsed ? ' collapsed' : ''}`;
    chevron.textContent = '▾';

    const name = document.createElement('span');
    name.className = 'repo-group-name';
    name.textContent = project;

    const count = document.createElement('span');
    count.className = 'repo-group-count';
    count.textContent = items.length;

    header.appendChild(chevron);
    header.appendChild(name);
    header.appendChild(count);

    header.addEventListener('click', () => {
      collapsedTicketProjects[project] = !collapsedTicketProjects[project];
      renderTicketList(currentTickets);
    });

    ticketListEl.appendChild(header);

    if (isCollapsed) return;

    items.forEach((item) => {
      renderWorkItemRow(ticketListEl, item, item.type || 'Item');
    });
  });
}

function typeClassFor(type) {
  const t = (type || '').toLowerCase();
  if (t === 'user story' || t === 'story') return 'story';
  if (t === 'task') return 'task';
  if (t === 'feature') return 'feature';
  if (t === 'epic') return 'epic';
  if (t === 'issue') return 'issue';
  return 'other';
}

async function refreshTickets() {
  ticketListEl.innerHTML = '<div class="loading">Loading tickets…</div>';
  noTicketsEl.classList.add('hidden');
  const result = await window.lgtm.refreshWorkItems();
  if (result.success) {
    renderTicketList(result.items);
  } else {
    ticketListEl.innerHTML = `<div class="loading">Failed to load tickets: ${esc(result.error || '')}</div>`;
  }
}

// ── Auto-review button ──────────────────────────────────────────
document.getElementById('auto-review-btn').addEventListener('click', () => {
  if (autoReviewRunning) {
    stopAutoReview();
  } else {
    startAutoReview();
  }
});

// ── Settings ─────────────────────────────────────────────────────
settingsBtn.addEventListener('click', async () => {
  await populateSettings();
  showView(settingsView);
});

async function populateSettings() {
  const s = await window.lgtm.getSettings();
  sPromptPath.value = s.promptPath || '';
  sWebhookPort.value = s.webhookPort || 3847;
  sPollInterval.value = Math.round((s.pollingIntervalMs || 60000) / 1000);
  sMaxPrAge.value = s.maxPrAgeDays || 7;
  agentModels = s.agentModels || {};
  repoConfigs = s.repoConfigs || {};
  starredRepos = new Set(s.starredRepos || []);
  maxPrAgeDays = s.maxPrAgeDays || 7;

  agents = await window.lgtm.refreshAgents();
  renderAgentConfig(s.defaultAgent || 'claude');

  const conventions = await window.lgtm.getPromptConventions();
  conventionHint.textContent = `Auto-detected filenames: ${conventions.join(', ')}`;
  renderRepoConfig();
}

// ── Agent config (settings) ──────────────────────────────────────
function renderAgentConfig(defaultAgentId) {
  agentConfigList.innerHTML = '';
  agents.forEach((agent) => {
    const row = document.createElement('div');
    row.className = `agent-config-row${agent.available ? '' : ' disabled'}`;

    const header = document.createElement('div');
    header.className = 'agent-config-header';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'default-agent';
    radio.value = agent.id;
    radio.checked = agent.id === defaultAgentId;
    radio.disabled = !agent.available;
    radio.id = `radio-${agent.id}`;

    const label = document.createElement('label');
    label.htmlFor = `radio-${agent.id}`;
    label.className = 'agent-config-name';
    label.textContent = agent.name;

    const badge = document.createElement('span');
    badge.className = `agent-status-badge ${agent.available ? 'installed' : 'missing'}`;
    badge.textContent = agent.available ? 'installed' : 'not found';

    header.appendChild(radio);
    header.appendChild(label);
    header.appendChild(badge);

    const modelRow = document.createElement('div');
    modelRow.className = 'agent-config-model';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'agent-config-model-label';
    modelLabel.textContent = 'Model:';
    const modelSelect = document.createElement('select');
    modelSelect.className = 'agent-model-select';
    modelSelect.disabled = !agent.available;
    modelSelect.dataset.agentId = agent.id;
    agent.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (agentModels[agent.id] === m.id) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    modelRow.appendChild(modelLabel);
    modelRow.appendChild(modelSelect);

    row.appendChild(header);
    row.appendChild(modelRow);
    agentConfigList.appendChild(row);
  });
}

// ── Repo prompt config (settings) ────────────────────────────────

// Cache of file trees per repo key
const repoFileTreeCache = {};

async function fetchRepoFileTree(repoKey) {
  if (repoFileTreeCache[repoKey]) return repoFileTreeCache[repoKey];
  const [project, repoName] = repoKey.split('/');
  const result = await window.lgtm.getRepoFileTree(project, repoName);
  if (result.success) {
    repoFileTreeCache[repoKey] = result.files;
    return result.files;
  }
  return [];
}

function createAutocompleteInput(repoKey, initialValue, placeholder) {
  const wrapper = document.createElement('div');
  wrapper.className = 'autocomplete-wrapper';

  const inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.className = 'repo-config-input';
  inputEl.dataset.repoKey = repoKey;
  inputEl.placeholder = placeholder;
  inputEl.value = initialValue || '';
  inputEl.autocomplete = 'off';

  const dropdown = document.createElement('div');
  dropdown.className = 'autocomplete-dropdown hidden';

  let activeIndex = -1;

  async function updateSuggestions() {
    const query = inputEl.value.toLowerCase();
    if (!query) { dropdown.classList.add('hidden'); return; }

    const files = await fetchRepoFileTree(repoKey);
    const matches = files
      .filter((f) => f.toLowerCase().includes(query))
      .slice(0, 30);

    if (matches.length === 0) { dropdown.classList.add('hidden'); return; }

    dropdown.innerHTML = '';
    activeIndex = -1;
    matches.forEach((filePath, idx) => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';

      // Highlight the matching portion
      const lowerFile = filePath.toLowerCase();
      const matchStart = lowerFile.indexOf(query);
      if (matchStart >= 0) {
        item.innerHTML =
          esc(filePath.slice(0, matchStart)) +
          '<strong>' + esc(filePath.slice(matchStart, matchStart + query.length)) + '</strong>' +
          esc(filePath.slice(matchStart + query.length));
      } else {
        item.textContent = filePath;
      }

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();   // prevent blur before click registers
        inputEl.value = filePath;
        dropdown.classList.add('hidden');
      });
      item.addEventListener('mouseenter', () => {
        setActive(idx);
      });
      dropdown.appendChild(item);
    });
    dropdown.classList.remove('hidden');
  }

  function setActive(idx) {
    const items = dropdown.querySelectorAll('.autocomplete-item');
    items.forEach((el) => el.classList.remove('active'));
    activeIndex = idx;
    if (idx >= 0 && idx < items.length) items[idx].classList.add('active');
  }

  let debounceTimer = null;
  inputEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(updateSuggestions, 150);
  });

  inputEl.addEventListener('focus', () => {
    if (inputEl.value) updateSuggestions();
  });

  inputEl.addEventListener('blur', () => {
    // Small delay so mousedown on item fires first
    setTimeout(() => dropdown.classList.add('hidden'), 120);
  });

  inputEl.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.autocomplete-item');
    if (dropdown.classList.contains('hidden') || items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, items.length - 1));
      items[activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
      items[activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < items.length) {
        inputEl.value = items[activeIndex].textContent;
        dropdown.classList.add('hidden');
      }
    } else if (e.key === 'Escape') {
      dropdown.classList.add('hidden');
    }
  });

  wrapper.appendChild(inputEl);
  wrapper.appendChild(dropdown);
  return wrapper;
}

function createFilePickerInput(repoKey, initialValue, placeholder) {
  const wrapper = document.createElement('div');
  wrapper.className = 'file-picker-wrapper';

  const inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.className = 'repo-config-input';
  inputEl.dataset.repoKey = repoKey;
  inputEl.placeholder = placeholder;
  inputEl.value = initialValue || '';

  const browseBtn = document.createElement('button');
  browseBtn.className = 'btn-browse';
  browseBtn.textContent = 'Browse…';
  browseBtn.type = 'button';
  browseBtn.addEventListener('click', async () => {
    const result = await window.lgtm.pickFile();
    if (!result.canceled) {
      inputEl.value = result.filePath;
    }
  });

  wrapper.appendChild(inputEl);
  wrapper.appendChild(browseBtn);
  return wrapper;
}

function renderRepoConfig() {
  repoConfigList.innerHTML = '';

  const repos = Array.from(knownRepos).sort();
  if (repos.length === 0) {
    repoConfigList.innerHTML = '<p class="hint">No repos discovered yet. Open PRs will populate this list.</p>';
    return;
  }

  repos.forEach((repoKey) => {
    const cfg = repoConfigs[repoKey] || {};

    const row = document.createElement('div');
    row.className = 'repo-config-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'repo-config-name';
    nameEl.textContent = repoKey;

    const statusEl = document.createElement('div');
    statusEl.className = 'hint';
    if (cfg.mode === 'repo' && cfg.repoFile) {
      statusEl.textContent = `Custom prompt: ${cfg.repoFile}`;
    } else {
      statusEl.textContent = 'Using default template';
    }

    row.appendChild(nameEl);
    row.appendChild(statusEl);
    repoConfigList.appendChild(row);
  });
}

// ── Save settings ────────────────────────────────────────────────
settingsSave.addEventListener('click', async () => {
  // Agent models
  const newAgentModels = {};
  agentConfigList.querySelectorAll('.agent-model-select').forEach((sel) => {
    newAgentModels[sel.dataset.agentId] = sel.value;
  });
  const defaultRadio = agentConfigList.querySelector('input[name="default-agent"]:checked');
  const defaultAgent = defaultRadio ? defaultRadio.value : 'claude';

  // Repo configs — managed via popover on PR list, just preserve current state
  const newMaxPrAge = parseInt(sMaxPrAge.value) || 7;
  await window.lgtm.saveSettings({
    promptPath: sPromptPath.value.trim(),
    webhookPort: parseInt(sWebhookPort.value) || 3847,
    pollingIntervalMs: (parseInt(sPollInterval.value) || 60) * 1000,
    defaultAgent,
    agentModels: newAgentModels,
    repoConfigs,
    maxPrAgeDays: newMaxPrAge,
  });
  maxPrAgeDays = newMaxPrAge;

  selectedAgent = defaultAgent;
  agentModels = newAgentModels;
  renderAgentSelect();
  showView(prListView);
});

settingsBack.addEventListener('click', () => showView(prListView));

// ── Per-tab settings: Bugs / Tickets ─────────────────────────────
bugsSettingsBtn.addEventListener('click', async () => {
  await populateTabSettings('bugs');
  showView(bugsSettingsView);
});
ticketsSettingsBtn.addEventListener('click', async () => {
  await populateTabSettings('tickets');
  showView(ticketsSettingsView);
});

bugsSettingsBack.addEventListener('click', () => showView(prListView));
ticketsSettingsBack.addEventListener('click', () => showView(prListView));

async function populateTabSettings(kind) {
  agents = await window.lgtm.refreshAgents();
  const settings = await window.lgtm.getSettings();

  if (kind === 'bugs') {
    bugsSelectedAgent = settings.bugsAgent || settings.defaultAgent || 'claude';
    bugsAgentModels = settings.bugsAgentModels || {};
    bugsRepoConfigs = settings.bugsRepoConfigs || {};
    renderTabAgentConfig('bugs');
    renderTabRepoPromptConfig('bugs');
  } else {
    ticketsSelectedAgent = settings.ticketsAgent || settings.defaultAgent || 'claude';
    ticketsAgentModels = settings.ticketsAgentModels || {};
    ticketsRepoConfigs = settings.ticketsRepoConfigs || {};
    renderTabAgentConfig('tickets');
    renderTabRepoPromptConfig('tickets');
  }
}

function renderTabAgentConfig(kind) {
  const listEl = kind === 'bugs' ? bugsAgentConfigList : ticketsAgentConfigList;
  const selected = kind === 'bugs' ? bugsSelectedAgent : ticketsSelectedAgent;
  const models = kind === 'bugs' ? bugsAgentModels : ticketsAgentModels;
  const radioName = `tab-agent-${kind}`;

  listEl.innerHTML = '';
  agents.forEach((agent) => {
    const row = document.createElement('div');
    row.className = `agent-config-row${agent.available ? '' : ' disabled'}`;

    const header = document.createElement('div');
    header.className = 'agent-config-header';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = radioName;
    radio.value = agent.id;
    radio.checked = agent.id === selected;
    radio.disabled = !agent.available;
    radio.id = `${radioName}-${agent.id}`;

    const label = document.createElement('label');
    label.htmlFor = radio.id;
    label.className = 'agent-config-name';
    label.textContent = agent.name;

    const badge = document.createElement('span');
    badge.className = `agent-status-badge ${agent.available ? 'installed' : 'missing'}`;
    badge.textContent = agent.available ? 'installed' : 'not found';

    header.appendChild(radio);
    header.appendChild(label);
    header.appendChild(badge);

    const modelRow = document.createElement('div');
    modelRow.className = 'agent-config-model';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'agent-config-model-label';
    modelLabel.textContent = 'Model:';
    const modelSelect = document.createElement('select');
    modelSelect.className = 'agent-model-select';
    modelSelect.disabled = !agent.available;
    modelSelect.dataset.agentId = agent.id;
    agent.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (models[agent.id] === m.id) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    modelRow.appendChild(modelLabel);
    modelRow.appendChild(modelSelect);

    row.appendChild(header);
    row.appendChild(modelRow);
    listEl.appendChild(row);
  });
}

function renderTabRepoPromptConfig(kind) {
  const listEl = kind === 'bugs' ? bugsRepoPromptList : ticketsRepoPromptList;
  const cfgs = kind === 'bugs' ? bugsRepoConfigs : ticketsRepoConfigs;

  listEl.innerHTML = '';
  const repoKeys = Object.keys(cfgs).sort();
  if (repoKeys.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No repos configured yet. Click "+ Add repo" to pick a repo and a prompt file.';
    listEl.appendChild(empty);
    return;
  }

  repoKeys.forEach((repoKey) => {
    const row = document.createElement('div');
    row.className = 'repo-config-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'repo-config-name';
    nameEl.textContent = repoKey;

    const inputWrapper = createAutocompleteInput(repoKey, cfgs[repoKey] || '', 'Search for a file in the repo…');
    const input = inputWrapper.querySelector('.repo-config-input');
    input.addEventListener('input', () => {
      cfgs[repoKey] = input.value.trim();
    });

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '6px';
    btnRow.style.marginTop = '6px';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      delete cfgs[repoKey];
      renderTabRepoPromptConfig(kind);
    });
    btnRow.appendChild(removeBtn);

    row.appendChild(nameEl);
    row.appendChild(inputWrapper);
    row.appendChild(btnRow);
    listEl.appendChild(row);
  });
}

bugsAddRepoBtn.addEventListener('click',    () => promptAddRepoConfig('bugs'));
ticketsAddRepoBtn.addEventListener('click', () => promptAddRepoConfig('tickets'));

async function promptAddRepoConfig(kind) {
  // Build a project/repo picker. Fetch all projects + their repos.
  const projects = await fetchAllProjectsWithRepos();
  if (!projects || projects.length === 0) {
    alert('No projects / repos available.');
    return;
  }
  const options = [];
  projects.forEach((p) => {
    (p.repos || []).forEach((r) => options.push(`${p.name}/${r.name}`));
  });
  if (options.length === 0) { alert('No repos found.'); return; }

  // Simple prompt-based picker for now.
  const input = prompt(`Pick a repo to configure (type exact match):\n\n${options.slice(0, 40).join('\n')}${options.length > 40 ? '\n…' : ''}`, options[0]);
  if (!input) return;
  if (!options.includes(input)) {
    alert(`"${input}" is not in the list of repos.`);
    return;
  }
  const cfgs = kind === 'bugs' ? bugsRepoConfigs : ticketsRepoConfigs;
  if (!cfgs[input]) cfgs[input] = '';
  renderTabRepoPromptConfig(kind);
}

// Cache projects + repos across a session (reuses repoCache from picker).
async function fetchAllProjectsWithRepos() {
  // Discover project names from known work items & PRs plus any cached repos.
  const projectNames = new Set();
  currentPrs.forEach((pr) => projectNames.add(pr.project));
  currentBugs.forEach((b) => projectNames.add(b.project));
  currentTickets.forEach((t) => projectNames.add(t.project));
  Object.keys(repoCache).forEach((p) => projectNames.add(p));

  const results = [];
  for (const name of Array.from(projectNames).sort()) {
    let repos = repoCache[name];
    if (!repos) {
      const r = await window.lgtm.getReposForProject(name);
      if (r && r.success) {
        repos = r.repos;
        repoCache[name] = repos;
      } else {
        repos = [];
      }
    }
    results.push({ name, repos });
  }
  return results;
}

bugsSettingsSave.addEventListener('click', async () => {
  await saveTabSettings('bugs');
  showView(prListView);
});
ticketsSettingsSave.addEventListener('click', async () => {
  await saveTabSettings('tickets');
  showView(prListView);
});

async function saveTabSettings(kind) {
  const listEl = kind === 'bugs' ? bugsAgentConfigList : ticketsAgentConfigList;
  const radioName = `tab-agent-${kind}`;

  const newModels = {};
  listEl.querySelectorAll('.agent-model-select').forEach((sel) => {
    newModels[sel.dataset.agentId] = sel.value;
  });
  const radio = listEl.querySelector(`input[name="${radioName}"]:checked`);
  const agent = radio ? radio.value : 'claude';

  if (kind === 'bugs') {
    bugsSelectedAgent = agent;
    bugsAgentModels = newModels;
    await window.lgtm.saveSettings({
      bugsAgent: agent,
      bugsAgentModels: newModels,
      bugsRepoConfigs,
    });
    renderTabAgentSelects();
  } else {
    ticketsSelectedAgent = agent;
    ticketsAgentModels = newModels;
    await window.lgtm.saveSettings({
      ticketsAgent: agent,
      ticketsAgentModels: newModels,
      ticketsRepoConfigs,
    });
    renderTabAgentSelects();
  }
}

disconnectBtn.addEventListener('click', async () => {
  if (confirm('Disconnect and remove your PAT from secure storage?')) {
    await window.lgtm.clearPat();
    reviewStatuses = {};
    knownRepos.clear();
    currentBugs = [];
    bugsLoaded = false;
    bugsTabCount.classList.add('hidden');
    currentTickets = [];
    ticketsLoaded = false;
    ticketsTabCount.classList.add('hidden');
    collapsedBugProjects = {};
    collapsedTicketProjects = {};
    setActiveTab('prs');
    showView(patSetup);
    subtitleEl.textContent = '';
  }
});

// ── IPC listeners ────────────────────────────────────────────────
window.lgtm.onPrList((prs) => renderPrList(prs));
window.lgtm.onPrError((msg) => console.error('[LGTM] PR fetch error:', msg));

// Background model discovery completed — overlay the freshly
// discovered models on top of the hardcoded fallback so the toolbar
// and tab dropdowns pick up new releases (e.g. Opus 4.7) without a
// restart. Settings panels re-render when reopened.
window.lgtm.onAgentsUpdated((updated) => {
  if (!Array.isArray(updated) || updated.length === 0) return;
  agents = updated;
  renderAgentSelect();
  renderTabAgentSelects();
});

window.lgtm.onCurrentUser((u) => {
  currentUser = u;
  if (currentPrs.length) renderPrList(currentPrs);
});

window.lgtm.onPatStatus(async (status) => {
  if (status.hasPat) {
    await loadAgents();
    // Pull current user — main may have already cached it.
    try {
      const u = await window.lgtm.getMe();
      if (u) currentUser = u;
    } catch { /* ignore */ }
    showView(prListView);
    subtitleEl.textContent = (status.orgUrl || '').replace('https://dev.azure.com/', '');
    // Background-prefetch bugs so the tab badge populates without a click.
    if (!bugsLoaded) {
      bugsLoaded = true;
      window.lgtm.refreshBugs().then((result) => {
        if (result && result.success) renderBugList(result.bugs);
      }).catch(() => {});
    }
    if (!ticketsLoaded) {
      ticketsLoaded = true;
      window.lgtm.refreshWorkItems().then((result) => {
        if (result && result.success) renderTicketList(result.items);
      }).catch(() => {});
    }
  } else {
    showView(patSetup);
  }
});

window.lgtm.onReviewUpdate((data) => {
  if (!reviewStatuses[data.key]) reviewStatuses[data.key] = { output: '' };
  reviewStatuses[data.key].status = data.status;
  reviewStatuses[data.key].agentId = data.agentId;
  if (data.pr) reviewStatuses[data.key].pr = data.pr;
  rerenderForKey(data.key);

  // Update detail panel if it's showing this review
  if (activeDetailKey === data.key) {
    reviewDetailDot.className = `status-dot ${data.status}`;
    updateDetailCancelVisibility(data.status);

    // Merge the update into our cached detail snapshot so timeline / report
    // / clonePath stay current without an extra round-trip.
    if (detailState.detail) {
      Object.assign(detailState.detail, {
        status: data.status,
        timeline: data.timeline || detailState.detail.timeline,
        clonePath: data.clonePath || detailState.detail.clonePath,
        report: data.report !== undefined ? data.report : detailState.detail.report,
        reportStatus: data.reportStatus !== undefined ? data.reportStatus : detailState.detail.reportStatus,
        reportError: data.reportError !== undefined ? data.reportError : detailState.detail.reportError,
        finishedAt: data.finishedAt || detailState.detail.finishedAt,
      });
    }

    // When the run finishes, refetch the full detail so we get the
    // dispatched prompt and the parsed report's authoritative copy.
    if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
      window.lgtm.getReviewDetail(data.key).then((detail) => {
        if (activeDetailKey !== data.key || !detail) return;
        detailState.detail = detail;
        detailState.rawOutput = detail.output || detailState.rawOutput;
        renderTimeline(detail);
        renderReportCard(detail);
        renderPromptPanel(detail);
        updateActionButtons(detail);
        renderOutput();
      }).catch(() => {});
    } else if (detailState.detail) {
      renderTimeline(detailState.detail);
      updateActionButtons(detailState.detail);
    }
  }
});

window.lgtm.onReviewOutput((data) => {
  if (!reviewStatuses[data.key]) reviewStatuses[data.key] = { output: '', status: 'running' };
  reviewStatuses[data.key].output += data.chunk;

  // Update the inline running line on whatever list contains this row.
  updateRunningLineEls(data.key);

  // Update detail panel if it's showing this review
  if (activeDetailKey === data.key) {
    detailState.rawOutput += data.chunk;
    renderOutput();
    if (detailState.followTail) {
      reviewOutputEl.scrollTop = reviewOutputEl.scrollHeight;
    } else if (detailState.detail && (detailState.detail.status === 'cloning' || detailState.detail.status === 'running')) {
      rdJumpBottomBtn.classList.remove('hidden');
    }
  }
});

window.lgtm.onShowSettings(async () => {
  await populateSettings();
  showView(settingsView);
});

// ── Auto-updater UI ─────────────────────────────────────────────
const updateBanner = document.getElementById('update-banner');
const updateMessage = document.getElementById('update-message');
const updateActionBtn = document.getElementById('update-action-btn');
const updateDismissBtn = document.getElementById('update-dismiss-btn');

let updateState = 'idle'; // idle | available | downloading | ready

window.lgtm.onUpdateAvailable((info) => {
  updateState = 'available';
  updateMessage.textContent = `Version ${info.version} is available!`;
  updateActionBtn.textContent = 'Download';
  updateBanner.classList.remove('hidden');
});

window.lgtm.onUpdateNotAvailable(() => {
  updateState = 'idle';
});

window.lgtm.onUpdateDownloadProgress((progress) => {
  updateMessage.innerHTML = `Downloading update… <span class="progress-text">${progress.percent}%</span>`;
});

window.lgtm.onUpdateDownloaded(() => {
  updateState = 'ready';
  updateMessage.textContent = 'Update ready!';
  updateActionBtn.textContent = 'Restart';
});

updateActionBtn.addEventListener('click', () => {
  if (updateState === 'available') {
    updateState = 'downloading';
    updateMessage.textContent = 'Downloading update…';
    updateActionBtn.textContent = 'Downloading…';
    updateActionBtn.disabled = true;
    window.lgtm.downloadUpdate();
  } else if (updateState === 'ready') {
    window.lgtm.installUpdate();
  }
});

updateDismissBtn.addEventListener('click', () => {
  updateBanner.classList.add('hidden');
});

// ── Helpers ──────────────────────────────────────────────────────
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}

function escHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripAnsi(s) {
  // Drop ANSI color/control sequences agents emit on stdout.
  return (s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

function lastMeaningfulLine(output) {
  const stripped = stripAnsi(output || '');
  const lines = stripped.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  return '';
}

function statusLineFor(key) {
  const review = reviewStatuses[key];
  if (!review) return '';
  if (review.status === 'cloning') return 'Cloning repo…';
  return lastMeaningfulLine(review.output) || 'Running…';
}

function updateRunningLineEls(key) {
  const text = statusLineFor(key);
  document.querySelectorAll('[data-running-key]').forEach((el) => {
    if (el.dataset.runningKey === key) el.textContent = text;
  });
}
