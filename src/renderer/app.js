/**
 * LGTM — Renderer process (UI logic)
 */

// ── DOM refs ─────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const patSetup     = $('#pat-setup');
const prListView   = $('#pr-list-view');
const settingsView = $('#settings-view');

const orgUrlInput  = $('#org-url');
const patInput     = $('#pat-input');
const patSubmit    = $('#pat-submit');
const patStatusMsg = $('#pat-status-msg');

const prListEl     = $('#pr-list');
const noPrsEl      = $('#no-prs');
const refreshBtn   = $('#refresh-btn');
const settingsBtn  = $('#settings-btn');
const agentSelect  = $('#agent-select');

const sPromptPath   = $('#s-prompt-path');
const sWebhookPort  = $('#s-webhook-port');
const sPollInterval = $('#s-poll-interval');
const agentConfigList = $('#agent-config-list');
const settingsSave  = $('#settings-save');
const settingsBack  = $('#settings-back');
const disconnectBtn = $('#disconnect-btn');
const subtitleEl    = $('#subtitle');

// ── State ────────────────────────────────────────────────────────
let currentPrs = [];
let reviewStatuses = {};   // key → { status, agentId }
let agents = [];           // from agent registry
let selectedAgent = null;  // current agent id for the toolbar dropdown
let agentModels = {};      // { agentId: selectedModelId } from settings

// ── Navigation ───────────────────────────────────────────────────
function showView(view) {
  [patSetup, prListView, settingsView].forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

// ── Agent discovery & toolbar dropdown ───────────────────────────
async function loadAgents() {
  agents = await window.lgtm.getAgents();
  const settings = await window.lgtm.getSettings();
  selectedAgent = settings.defaultAgent || 'claude';
  agentModels = settings.agentModels || {};
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

agentSelect.addEventListener('change', () => {
  selectedAgent = agentSelect.value;
});

// ── PAT flow ─────────────────────────────────────────────────────
patSubmit.addEventListener('click', async () => {
  const pat = patInput.value.trim();
  const orgUrl = orgUrlInput.value.trim();

  if (!pat || !orgUrl) {
    setPatMsg('Please fill in both fields.', 'error');
    return;
  }

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
    item.innerHTML = `
      <div class="status-dot ${dotClass}" title="${dotClass}"></div>
      <div class="pr-info">
        <div class="pr-path">${esc(pr.repo)}/${pr.id}/${esc(pr.title)}</div>
        <div class="pr-title">by ${esc(pr.createdBy)} · ${esc(pr.project)}</div>
      </div>
      ${reviewStatus ? `<span class="pr-review-badge ${reviewStatus}">${reviewAgent ? esc(reviewAgent) + ' · ' : ''}${reviewStatus}</span>` : ''}
    `;

    item.addEventListener('click', () => startReview(pr));
    prListEl.appendChild(item);
  });
}

async function startReview(pr) {
  const key = `${pr.project}/${pr.repo}/${pr.id}`;
  if (reviewStatuses[key] && reviewStatuses[key].status === 'running') {
    return;
  }

  const agentId = selectedAgent || 'claude';
  const model = agentModels[agentId] || null;

  const result = await window.lgtm.reviewPr({ pr, agentId, model });
  if (result.success) {
    reviewStatuses[key] = { status: 'running', agentId };
    renderPrList(currentPrs);
  } else {
    alert(result.error);
  }
}

// ── Refresh ──────────────────────────────────────────────────────
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '⟳';
  const result = await window.lgtm.refreshPrs();
  if (result.success) {
    renderPrList(result.prs);
  }
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

  // Refresh agent availability
  agents = await window.lgtm.refreshAgents();
  renderAgentConfig(s.defaultAgent || 'claude');
}

function renderAgentConfig(defaultAgentId) {
  agentConfigList.innerHTML = '';

  agents.forEach((agent) => {
    const row = document.createElement('div');
    row.className = `agent-config-row${agent.available ? '' : ' disabled'}`;

    const header = document.createElement('div');
    header.className = 'agent-config-header';

    // Default radio button
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

    const statusBadge = document.createElement('span');
    statusBadge.className = `agent-status-badge ${agent.available ? 'installed' : 'missing'}`;
    statusBadge.textContent = agent.available ? 'installed' : 'not found';

    header.appendChild(radio);
    header.appendChild(label);
    header.appendChild(statusBadge);

    // Model select
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

settingsSave.addEventListener('click', async () => {
  // Gather agent model selections
  const newAgentModels = {};
  agentConfigList.querySelectorAll('.agent-model-select').forEach((sel) => {
    newAgentModels[sel.dataset.agentId] = sel.value;
  });

  // Get default agent
  const defaultRadio = agentConfigList.querySelector('input[name="default-agent"]:checked');
  const defaultAgent = defaultRadio ? defaultRadio.value : 'claude';

  await window.lgtm.saveSettings({
    promptPath: sPromptPath.value.trim(),
    webhookPort: parseInt(sWebhookPort.value) || 3847,
    pollingIntervalMs: (parseInt(sPollInterval.value) || 60) * 1000,
    defaultAgent,
    agentModels: newAgentModels,
  });

  // Update local state
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
    showView(patSetup);
    subtitleEl.textContent = '';
  }
});

// ── IPC listeners ────────────────────────────────────────────────
window.lgtm.onPrList((prs) => renderPrList(prs));

window.lgtm.onPrError((msg) => {
  console.error('[LGTM] PR fetch error:', msg);
});

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
  reviewStatuses[data.key] = { status: data.status, agentId: data.agentId };
  renderPrList(currentPrs);
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
