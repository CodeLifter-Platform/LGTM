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

// Review detail
const reviewBackBtn     = $('#review-back-btn');
const reviewDetailTitle = $('#review-detail-title');
const reviewDetailMeta  = $('#review-detail-meta');
const reviewDetailDot   = $('#review-detail-dot');
const reviewOutputEl    = $('#review-output');

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
let knownRepos = new Set();  // "project/repo" strings from PR list
let autoReviewRunning = false;

// ── Navigation ───────────────────────────────────────────────────
function showView(view) {
  [patSetup, prListView, settingsView, reviewDetailView].forEach((v) => v.classList.add('hidden'));
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
  renderAgentSelect();
}

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
    setPatMsg(`Connected! Found ${result.projects.length} project(s).`, 'success');
    await loadAgents();
    setTimeout(() => {
      showView(prListView);
      subtitleEl.textContent = orgUrl.replace('https://dev.azure.com/', '');
    }, 800);
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
        item.className = `pr-item grouped${isOld ? ' stale' : ''}`;

        // Status dot
        const dot = document.createElement('div');
        dot.className = `status-dot ${dotClass}`;
        dot.title = dotClass;

        // Age label
        const ageStr = prAgeDays === 0 ? 'today' : prAgeDays === 1 ? '1d ago' : `${prAgeDays}d ago`;

        // Info — show just PR number + title since repo is in the header
        const info = document.createElement('div');
        info.className = 'pr-info';
        info.innerHTML = `
          <div class="pr-path">#${pr.id} ${esc(pr.title)}</div>
          <div class="pr-title">by ${esc(pr.createdBy)} · ${ageStr}</div>
        `;

        // Badge + view button for active reviews
        const actions = document.createElement('div');
        actions.className = 'pr-actions';

        if (reviewStatus) {
          const badge = document.createElement('span');
          badge.className = `pr-review-badge ${reviewStatus}`;
          badge.textContent = reviewStatus === 'cloning' ? 'cloning\u2026' : reviewStatus;
          actions.appendChild(badge);

          if (reviewStatus === 'running' || reviewStatus === 'completed' || reviewStatus === 'failed' || reviewStatus === 'cloning') {
            const viewBtn = document.createElement('button');
            viewBtn.className = 'btn-view-review';
            viewBtn.textContent = '\u25B8';  // ▸
            viewBtn.title = 'View review output';
            viewBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              openReviewDetail(key, pr, reviewStatus, reviewAgent);
            });
            actions.appendChild(viewBtn);
          }
        }

        item.appendChild(dot);
        item.appendChild(info);
        item.appendChild(actions);

        // Click to start review (only if not already running)
        item.addEventListener('click', () => {
          if (reviewStatus === 'running' || reviewStatus === 'cloning') {
            openReviewDetail(key, pr, reviewStatus, reviewAgent);
          } else {
            startReview(pr);
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

  // Optimistically show cloning state
  reviewStatuses[key] = { status: 'cloning', agentId, output: '' };
  renderPrList(currentPrs);

  const result = await window.lgtm.reviewPr({ pr, agentId, model });
  if (!result.success) {
    reviewStatuses[key].status = 'failed';
    reviewStatuses[key].output = result.error || 'Failed to start review.';
    renderPrList(currentPrs);
    alert(result.error);
  }
}

// ── Review detail panel ──────────────────────────────────────────
async function openReviewDetail(key, pr, status, agentId) {
  activeDetailKey = key;

  reviewDetailTitle.textContent = `${pr.repo}/#${pr.id}`;
  reviewDetailMeta.textContent = `${pr.title} · ${agentId || 'unknown'}`;
  reviewDetailDot.className = `status-dot ${status}`;

  // Load existing output
  const existingOutput = await window.lgtm.getReviewOutput(key);
  const localOutput = reviewStatuses[key] ? reviewStatuses[key].output : '';
  const output = existingOutput || localOutput || '';

  renderMarkdown(output);
  showView(reviewDetailView);

  // Auto-scroll to bottom
  reviewOutputEl.scrollTop = reviewOutputEl.scrollHeight;
}

function renderMarkdown(text) {
  // Simple markdown-ish rendering: escape HTML, then convert code blocks and basics
  let html = escHtml(text);

  // Code blocks: ```lang\n...\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');

  reviewOutputEl.innerHTML = html;
}

reviewBackBtn.addEventListener('click', () => {
  activeDetailKey = null;
  showView(prListView);
});

// ── Refresh ──────────────────────────────────────────────────────
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '⟳';
  const result = await window.lgtm.refreshPrs();
  if (result.success) renderPrList(result.prs);
  refreshBtn.disabled = false;
  refreshBtn.textContent = '↻';
});

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

disconnectBtn.addEventListener('click', async () => {
  if (confirm('Disconnect and remove your PAT from secure storage?')) {
    await window.lgtm.clearPat();
    reviewStatuses = {};
    knownRepos.clear();
    showView(patSetup);
    subtitleEl.textContent = '';
  }
});

// ── IPC listeners ────────────────────────────────────────────────
window.lgtm.onPrList((prs) => renderPrList(prs));
window.lgtm.onPrError((msg) => console.error('[LGTM] PR fetch error:', msg));

window.lgtm.onPatStatus(async (status) => {
  if (status.hasPat) {
    await loadAgents();
    showView(prListView);
    subtitleEl.textContent = (status.orgUrl || '').replace('https://dev.azure.com/', '');
  } else {
    showView(patSetup);
  }
});

window.lgtm.onReviewUpdate((data) => {
  if (!reviewStatuses[data.key]) reviewStatuses[data.key] = { output: '' };
  reviewStatuses[data.key].status = data.status;
  reviewStatuses[data.key].agentId = data.agentId;
  renderPrList(currentPrs);

  // Update detail panel if it's showing this review
  if (activeDetailKey === data.key) {
    reviewDetailDot.className = `status-dot ${data.status}`;
  }
});

window.lgtm.onReviewOutput((data) => {
  if (!reviewStatuses[data.key]) reviewStatuses[data.key] = { output: '', status: 'running' };
  reviewStatuses[data.key].output += data.chunk;

  // Update detail panel if it's showing this review
  if (activeDetailKey === data.key) {
    renderMarkdown(reviewStatuses[data.key].output);
    // Auto-scroll if near bottom
    const el = reviewOutputEl;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) el.scrollTop = el.scrollHeight;
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
