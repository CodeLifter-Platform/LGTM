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
let activeDetailKey = null;  // which review is shown in the detail panel
let knownRepos = new Set();  // "project/repo" strings from PR list

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

  prs.forEach((pr) => {
    const key = `${pr.project}/${pr.repo}/${pr.id}`;
    const review = reviewStatuses[key];
    const reviewStatus = review ? review.status : null;
    const reviewAgent = review ? review.agentId : null;
    const dotClass = reviewStatus || pr.reviewStatus || 'pending';

    const item = document.createElement('div');
    item.className = 'pr-item';

    // Status dot
    const dot = document.createElement('div');
    dot.className = `status-dot ${dotClass}`;
    dot.title = dotClass;

    // Info
    const info = document.createElement('div');
    info.className = 'pr-info';
    info.innerHTML = `
      <div class="pr-path">${esc(pr.repo)}/${pr.id}/${esc(pr.title)}</div>
      <div class="pr-title">by ${esc(pr.createdBy)} · ${esc(pr.project)}</div>
    `;

    // Badge + view button for active reviews
    const actions = document.createElement('div');
    actions.className = 'pr-actions';

    if (reviewStatus) {
      const badge = document.createElement('span');
      badge.className = `pr-review-badge ${reviewStatus}`;
      badge.textContent = reviewStatus === 'cloning' ? 'cloning…' : reviewStatus;
      actions.appendChild(badge);

      if (reviewStatus === 'running' || reviewStatus === 'completed' || reviewStatus === 'failed' || reviewStatus === 'cloning') {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn-view-review';
        viewBtn.textContent = '▸';
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
  agentModels = s.agentModels || {};
  repoConfigs = s.repoConfigs || {};

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
    const existing = repoConfigs[repoKey] || { mode: 'auto' };

    const row = document.createElement('div');
    row.className = 'repo-config-row';

    // Repo name
    const nameEl = document.createElement('div');
    nameEl.className = 'repo-config-name';
    nameEl.textContent = repoKey;

    // Mode select
    const controlRow = document.createElement('div');
    controlRow.className = 'repo-config-controls';

    const modeSelect = document.createElement('select');
    modeSelect.className = 'repo-mode-select';
    modeSelect.dataset.repoKey = repoKey;

    [
      { value: 'auto', label: 'Auto-detect from repo' },
      { value: 'repo', label: 'Specific file in repo' },
      { value: 'custom', label: 'Custom local path' },
    ].forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (existing.mode === opt.value) o.selected = true;
      modeSelect.appendChild(o);
    });

    controlRow.appendChild(modeSelect);

    // Input container — swapped based on mode
    const inputContainer = document.createElement('div');
    inputContainer.className = 'repo-input-container';

    function buildInput(mode, value) {
      inputContainer.innerHTML = '';
      if (mode === 'auto') {
        inputContainer.classList.add('hidden');
      } else if (mode === 'repo') {
        inputContainer.classList.remove('hidden');
        const autocomplete = createAutocompleteInput(repoKey, value, 'Start typing a file path…');
        inputContainer.appendChild(autocomplete);
      } else {
        inputContainer.classList.remove('hidden');
        const picker = createFilePickerInput(repoKey, value, '/absolute/path/to/prompt.md');
        inputContainer.appendChild(picker);
      }
    }

    buildInput(existing.mode, existing.mode === 'repo' ? existing.repoFile : existing.customPath);

    modeSelect.addEventListener('change', () => {
      buildInput(modeSelect.value, '');
    });

    controlRow.appendChild(inputContainer);

    row.appendChild(nameEl);
    row.appendChild(controlRow);
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

  // Repo configs
  const newRepoConfigs = {};
  repoConfigList.querySelectorAll('.repo-config-row').forEach((row) => {
    const modeSelect = row.querySelector('.repo-mode-select');
    const inputEl = row.querySelector('.repo-config-input');
    const repoKey = modeSelect.dataset.repoKey;
    const mode = modeSelect.value;
    const inputValue = inputEl ? inputEl.value.trim() : '';

    if (mode === 'auto') {
      newRepoConfigs[repoKey] = { mode: 'auto' };
    } else if (mode === 'repo') {
      newRepoConfigs[repoKey] = { mode: 'repo', repoFile: inputValue };
    } else {
      newRepoConfigs[repoKey] = { mode: 'custom', customPath: inputValue };
    }
  });

  await window.lgtm.saveSettings({
    promptPath: sPromptPath.value.trim(),
    webhookPort: parseInt(sWebhookPort.value) || 3847,
    pollingIntervalMs: (parseInt(sPollInterval.value) || 60) * 1000,
    defaultAgent,
    agentModels: newAgentModels,
    repoConfigs: newRepoConfigs,
  });

  selectedAgent = defaultAgent;
  agentModels = newAgentModels;
  repoConfigs = newRepoConfigs;
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
