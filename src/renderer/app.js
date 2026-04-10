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

const sPromptPath  = $('#s-prompt-path');
const sWebhookPort = $('#s-webhook-port');
const sPollInterval = $('#s-poll-interval');
const settingsSave = $('#settings-save');
const settingsBack = $('#settings-back');
const disconnectBtn = $('#disconnect-btn');
const subtitleEl   = $('#subtitle');

// ── State ────────────────────────────────────────────────────────
let currentPrs = [];
let reviewStatuses = {}; // key → { status }

// ── Navigation ───────────────────────────────────────────────────
function showView(view) {
  [patSetup, prListView, settingsView].forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

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

    // Determine which dot to show: review status takes priority over PR review status
    const dotClass = reviewStatus || pr.reviewStatus || 'pending';

    const item = document.createElement('div');
    item.className = 'pr-item';
    item.innerHTML = `
      <div class="status-dot ${dotClass}" title="${dotClass}"></div>
      <div class="pr-info">
        <div class="pr-path">${esc(pr.repo)}/${pr.id}/${esc(pr.title)}</div>
        <div class="pr-title">by ${esc(pr.createdBy)} · ${esc(pr.project)}</div>
      </div>
      ${reviewStatus ? `<span class="pr-review-badge ${reviewStatus}">${reviewStatus}</span>` : ''}
    `;

    item.addEventListener('click', () => startReview(pr));
    prListEl.appendChild(item);
  });
}

async function startReview(pr) {
  const key = `${pr.project}/${pr.repo}/${pr.id}`;
  if (reviewStatuses[key] && reviewStatuses[key].status === 'running') {
    return; // already running
  }

  const result = await window.lgtm.reviewPr(pr);
  if (result.success) {
    reviewStatuses[key] = { status: 'running' };
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
  const s = await window.lgtm.getSettings();
  sPromptPath.value = s.promptPath || '';
  sWebhookPort.value = s.webhookPort || 3847;
  sPollInterval.value = Math.round((s.pollingIntervalMs || 60000) / 1000);
  showView(settingsView);
});

settingsSave.addEventListener('click', async () => {
  await window.lgtm.saveSettings({
    promptPath: sPromptPath.value.trim(),
    webhookPort: parseInt(sWebhookPort.value) || 3847,
    pollingIntervalMs: (parseInt(sPollInterval.value) || 60) * 1000,
  });
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

window.lgtm.onPatStatus((status) => {
  if (status.hasPat) {
    showView(prListView);
    subtitleEl.textContent = (status.orgUrl || '').replace('https://dev.azure.com/', '');
  } else {
    showView(patSetup);
  }
});

window.lgtm.onReviewUpdate((data) => {
  reviewStatuses[data.key] = { status: data.status };
  renderPrList(currentPrs);
});

window.lgtm.onShowSettings(async () => {
  const s = await window.lgtm.getSettings();
  sPromptPath.value = s.promptPath || '';
  sWebhookPort.value = s.webhookPort || 3847;
  sPollInterval.value = Math.round((s.pollingIntervalMs || 60000) / 1000);
  showView(settingsView);
});

// ── Helpers ──────────────────────────────────────────────────────
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}
