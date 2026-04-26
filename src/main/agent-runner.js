/**
 * AgentRunner — Launches PR reviews using any supported AI agent.
 *
 * Flow:
 *   1. Shallow-clone the repo into a temp directory
 *   2. Resolve the review prompt (per-repo → convention → global)
 *   3. Spawn the agent as a child process with piped stdout/stderr
 *   4. Stream output to the renderer in real time via IPC
 *   5. Clean up the temp clone when done
 */

const { spawn, execSync } = require('child_process');
const { BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentRegistry } = require('./agent-registry');
const { RepoCloner } = require('./repo-cloner');
const { PromptResolver } = require('./prompt-resolver');
const { DevOpsClient } = require('./devops-client');
const { ScenarioPrompts } = require('./scenario-prompts');

function formatIdentity(user) {
  if (!user) return '';
  const name = user.displayName || user.email || '';
  const id = user.id || '';
  if (name && id) return `${name} (${id})`;
  return name || id || '';
}

/**
 * Strip Node-debugger env vars before spawning child agents. Electron's
 * dev mode (and `electron --inspect`) inject NODE_OPTIONS=--inspect and
 * friends, which then leak into any node-shebang CLI we spawn (e.g.
 * auggie), making it print "Debugger listening on ws://..." and attach
 * a debugger to itself. Harmless but noisy in the detail panel.
 */
function buildSpawnEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_INSPECT;
  delete env.NODE_INSPECT_RESUME_ON_START;
  return env;
}

function detectDefaultBranch(clonePath) {
  try {
    const out = execSync('git symbolic-ref --short refs/remotes/origin/HEAD', {
      cwd: clonePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.replace(/^origin\//, '');
  } catch {
    try {
      const out = execSync('git remote show origin', {
        cwd: clonePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/HEAD branch:\s*(\S+)/);
      if (m) return m[1];
    } catch { /* ignore */ }
    return 'main';
  }
}

class AgentRunner {
  constructor(config) {
    this.config = config;
    this.registry = new AgentRegistry();
    this.promptResolver = new PromptResolver(config);
    this.scenarioPrompts = new ScenarioPrompts();
    this.scenarioPrompts.loadAll(); // fail fast at startup if files missing
    this.cloner = null;       // initialised once we have a PAT
    this.devopsClient = null;  // for fetching existing threads
    this.currentUser = null;   // set after auth — used for REVIEWER_/AUTHOR_IDENTITY
    this.activeReviews = new Map(); // key → review object
  }

  /**
   * Set/update the PAT and org URL (called after authentication).
   */
  setCredentials(pat, orgUrl) {
    this.cloner = new RepoCloner(pat, orgUrl);
    this.devopsClient = new DevOpsClient(pat, orgUrl);
  }

  /**
   * Set the authenticated ADO user. Used to populate REVIEWER_IDENTITY and
   * AUTHOR_IDENTITY in dispatched scenario prompts.
   */
  setIdentity(user) {
    this.currentUser = user || null;
  }

  /**
   * Update review.status and append a timeline entry. The renderer reads
   * `timeline` to draw the cloning → running → completed pill row.
   */
  _setStatus(review, status) {
    if (review.status === status) return;
    review.status = status;
    review.timeline = review.timeline || [];
    review.timeline.push({ status, at: Date.now() });
  }

  /**
   * Append a diagnostic line to the agent output (and stream it to the
   * renderer) so the user can see what the orchestrator is doing — what
   * we spawned, when the process exited, etc. These show up alongside
   * the agent's real stdout in the detail panel.
   */
  _pushDiag(key, review, line) {
    const formatted = (line.endsWith('\n') ? line : line + '\n');
    review.output += formatted;
    this._notifyRendererChunk(key, formatted, review);
  }

  /**
   * Two-stage watchdog:
   *
   *   1. First-output watchdog — fires once after `firstOutputMs` if the
   *      agent hasn't emitted anything yet. Points at the most common
   *      causes (auth / API key / warmup).
   *
   *   2. Ongoing-silence watchdog — fires every `ongoingSilenceMs` of no
   *      new output, even after the agent has produced something. Tells
   *      the user the run isn't dead (the orchestrator is still alive)
   *      and reminds them they can hit the Cancel button if they're done
   *      waiting. Re-arms after each fire so a long-stuck run keeps
   *      nudging.
   *
   * Callers must call `onOutput()` on every chunk and `cancel()` when the
   * process exits.
   */
  _armSilenceWatchdog(
    key, review, agentId,
    firstOutputMs = 60000,
    ongoingSilenceMs = 150000,  // 2.5 min
  ) {
    let firedFirstOutput = false;
    let lastOutputAt = Date.now();
    let lastNudgeAt = Date.now();

    const initialTimer = setTimeout(() => {
      if (firedFirstOutput) return;
      if (review.status !== 'running') return;
      this._pushDiag(key, review,
        `[LGTM] No output from ${agentId} after ${Math.round(firstOutputMs / 1000)}s. ` +
        `Common causes: the CLI needs first-time auth (try running it once in a terminal), ` +
        `a required API key env var is missing, or the agent is still warming up.`
      );
    }, firstOutputMs);

    // Poll every 30s; we fire the nudge ourselves when enough time has
    // elapsed since either the last output OR the last nudge. (A naive
    // setInterval(ongoingSilenceMs) would fire even right after a chunk
    // arrived if the chunk landed at the wrong moment.)
    const ongoingTimer = setInterval(() => {
      if (review.status !== 'running') return;
      const now = Date.now();
      const silenceFor = now - lastOutputAt;
      const sinceLastNudge = now - lastNudgeAt;
      if (silenceFor >= ongoingSilenceMs && sinceLastNudge >= ongoingSilenceMs) {
        const mins = Math.round(silenceFor / 60000);
        this._pushDiag(key, review,
          `[LGTM] Still waiting on ${agentId} — no output for ~${mins} min. ` +
          `Press Cancel above if you want to abort, otherwise the run will continue.`
        );
        lastNudgeAt = now;
      }
    }, 30000);

    return {
      onOutput: () => {
        lastOutputAt = Date.now();
        if (!firedFirstOutput) {
          firedFirstOutput = true;
          clearTimeout(initialTimer);
        }
      },
      cancel: () => {
        clearTimeout(initialTimer);
        clearInterval(ongoingTimer);
      },
    };
  }

  /**
   * Start a review for the given PR.
   *
   * @param {object} pr      - Normalised PR object from DevOpsClient
   * @param {string} agentId - e.g. 'claude', 'codex', 'augment'
   * @param {string} model   - e.g. 'claude-opus-4-6' (optional)
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async startReview(pr, agentId, model, mode = 'review') {
    const key = `${pr.project}/${pr.repo}/${pr.id}`;

    if (this.activeReviews.has(key) && this.activeReviews.get(key).status === 'running') {
      return { success: false, error: 'Review already in progress for this PR.' };
    }

    // Validate agent
    const agent = this.registry.get(agentId);
    if (!agent) return { success: false, error: `Unknown agent: ${agentId}` };
    if (!agent.available) return { success: false, error: `${agent.name} is not installed.` };

    // Create review record immediately so UI shows "cloning" state
    const now = Date.now();
    const review = {
      pr,
      agentId,
      model,
      mode,
      status: 'cloning',
      output: '',
      prompt: '',
      timeline: [{ status: 'cloning', at: now }],
      startedAt: now,
      cleanup: null,
      child: null,
      cloneChild: null,
      cancelled: false,
    };
    this.activeReviews.set(key, review);
    this._notifyRenderer(key, review);

    try {
      // ── Step 1: Clone the repo ─────────────────────────────
      if (!this.cloner) {
        throw new Error('Not authenticated — no PAT available for cloning.');
      }

      const onCloneChild = (c) => {
        review.cloneChild = c;
        if (review.cancelled && c && !c.killed) {
          try { c.kill('SIGTERM'); } catch { /* ignore */ }
        }
      };
      const { clonePath, cleanup } = await this.cloner.clone(pr, { onChild: onCloneChild });
      review.cloneChild = null;
      review.cleanup = cleanup;
      review.clonePath = clonePath;

      // If cancelled while cloning, abort before spawning the agent.
      if (review.cancelled) {
        this._setStatus(review, 'cancelled');
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        if (review.cleanup) review.cleanup();
        return { success: true, cancelled: true };
      }

      // ── Step 2: Build the review prompt ───────────────────────

      // Layer A: LGTM universal review prompt (severity system, comment format, re-review rules)
      const universalPromptPath = path.join(__dirname, '..', '..', 'resources', 'LGTM_REVIEW_PROMPT.md');
      let universalPrompt = '';
      try {
        universalPrompt = fs.readFileSync(universalPromptPath, 'utf8');
      } catch {
        // Fallback: try the extraResources path (in packaged app)
        try {
          const packagedPath = path.join(process.resourcesPath, 'LGTM_REVIEW_PROMPT.md');
          universalPrompt = fs.readFileSync(packagedPath, 'utf8');
        } catch {
          console.warn('[LGTM] Could not load LGTM_REVIEW_PROMPT.md — using minimal fallback');
          universalPrompt = '';
        }
      }

      // Layer B: Repo-specific prompt (project context, custom rules)
      const { path: repoPromptPath, source: promptSource } = this.promptResolver.resolve(pr, clonePath);
      let repoPrompt = '';
      review.promptSource = promptSource;

      if (repoPromptPath) {
        try {
          repoPrompt = fs.readFileSync(repoPromptPath, 'utf8');
        } catch {
          console.warn(`[LGTM] Could not read repo prompt at ${repoPromptPath}`);
        }
      }

      // Fetch existing PR threads for re-review awareness
      let existingThreadsSummary = '';
      try {
        const threads = await this.devopsClient.getPrThreads(pr.project, pr.repoId, pr.id);
        const reviewThreads = threads.filter((t) =>
          t.comments.length > 0 && t.comments[0].commentType === 1
        );

        if (reviewThreads.length > 0) {
          const threadLines = reviewThreads.map((t) => {
            const statusMap = { 1: 'Active', 2: 'Fixed', 3: 'WontFix', 4: 'Closed', 5: 'ByDesign', 6: 'Pending' };
            const status = statusMap[t.status] || `Unknown(${t.status})`;
            const firstComment = t.comments[0].content.substring(0, 200);
            return `- Thread #${t.id} [${status}]: ${firstComment}${t.comments[0].content.length > 200 ? '…' : ''}`;
          });
          existingThreadsSummary = [
            '\n## Existing Review Threads',
            '',
            'The following review comments already exist on this PR. Follow the re-review rules strictly:',
            '',
            ...threadLines,
          ].join('\n');
        }
      } catch (err) {
        console.warn(`[LGTM] Could not fetch existing threads: ${err.message}`);
      }

      const sourceBranch = pr.sourceBranch.replace('refs/heads/', '');
      const targetBranch = pr.targetBranch.replace('refs/heads/', '');

      const scenarioId = mode === 'resolve' ? 'resolve-comments' : 'pr-review';
      review.scenarioId = scenarioId;

      const identity = formatIdentity(this.currentUser);
      const contextVars = {
        PR_ID: pr.id,
        PR_URL: pr.webUrl,
        REPO_PATH: clonePath,
        SOURCE_BRANCH: sourceBranch,
        TARGET_BRANCH: targetBranch,
      };
      if (scenarioId === 'pr-review') {
        contextVars.REVIEWER_IDENTITY = identity || 'unknown';
      } else {
        contextVars.AUTHOR_IDENTITY = identity || 'unknown';
      }

      const extraSections = [];
      if (universalPrompt) {
        extraSections.push({ title: 'LGTM Project Rules', body: universalPrompt });
      }
      if (repoPrompt) {
        extraSections.push({ title: 'Project-Specific Rules', body: repoPrompt });
      }
      if (existingThreadsSummary) {
        extraSections.push({
          title: 'Pre-fetched Existing Review Threads',
          body: existingThreadsSummary.replace(/^\n## Existing Review Threads\n\n[^\n]*\n\n/, ''),
        });
      } else if (scenarioId === 'resolve-comments') {
        extraSections.push({
          title: 'Pre-fetched Existing Review Threads',
          body: '(No review threads pre-fetched. If the SDK confirms there are none, exit without making changes.)',
        });
      }

      const prompt = this.scenarioPrompts.buildDispatchPrompt(
        agentId, scenarioId, contextVars, extraSections,
      );
      review.prompt = prompt;

      // ── Step 3: Spawn the agent ────────────────────────────
      this._setStatus(review, 'running');
      this._notifyRenderer(key, review);

      const { command, args, stdinPrompt } = this.registry.buildCommand(agentId, prompt, model);

      console.log(`[LGTM] Launching ${agentId} in ${clonePath}`);
      console.log(`[LGTM]   Command: ${command} ${args.join(' ')}`);
      console.log(`[LGTM]   Prompt length: ${prompt.length} chars, stdin: ${!!stdinPrompt}`);

      // Surface the same info to the user in the detail panel so a
      // silently-hung agent isn't a black box.
      this._pushDiag(key, review,
        `[LGTM] Launching ${agentId} (model: ${model || 'default'}) in ${clonePath}`);
      this._pushDiag(key, review,
        `[LGTM]   $ ${command} ${args.join(' ')}`);
      this._pushDiag(key, review,
        `[LGTM]   prompt: ${prompt.length.toLocaleString()} chars via ${stdinPrompt ? 'stdin' : 'argv'}`);

      // Write prompt to a temp file so we can pipe it via stdin.
      // This avoids shell escaping issues with large prompts containing
      // special characters (pipes, backticks, quotes, etc.)
      const promptFile = path.join(os.tmpdir(), `lgtm-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf8');

      const child = spawn(command, args, {
        cwd: clonePath,
        stdio: [stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
        env: buildSpawnEnv(),
      });
      review.child = child;

      // Pipe the prompt via stdin then close it
      if (stdinPrompt && child.stdin) {
        const promptStream = fs.createReadStream(promptFile);
        promptStream.pipe(child.stdin);
        promptStream.on('end', () => {
          // Clean up temp file after it's been read
          try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        });
        child.stdin.on('error', (err) => {
          // EPIPE is expected if the agent dies before reading the prompt.
          if (err && err.code !== 'EPIPE') {
            this._pushDiag(key, review, `[LGTM] stdin error: ${err.message}`);
          }
        });
      } else {
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      }

      const watchdog = this._armSilenceWatchdog(key, review, agentId);

      // ── Step 4: Stream output ──────────────────────────────
      child.stdout.on('data', (data) => {
        watchdog.onOutput();
        const chunk = data.toString();
        review.output += chunk;
        this._notifyRendererChunk(key, chunk, review);
      });

      child.stderr.on('data', (data) => {
        watchdog.onOutput();
        const chunk = data.toString();
        review.output += chunk;
        this._notifyRendererChunk(key, chunk, review);
      });

      child.on('close', (code, signal) => {
        watchdog.cancel();
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        this._pushDiag(key, review, `[LGTM] ${agentId} finished — ${reason}`);

        if (review.cancelled) {
          this._setStatus(review, 'cancelled');
        } else {
          this._setStatus(review, code === 0 ? 'completed' : 'failed');
        }
        review.finishedAt = Date.now();
        this._extractAndAttachReport(review);
        this._notifyRenderer(key, review);
        console.log(`[LGTM] Review ${key} finished with code ${code}${review.cancelled ? ' (cancelled)' : ''}`);

        // ── Step 5: Cleanup ────────────────────────────────
        if (review.cleanup) {
          setTimeout(() => review.cleanup(), 5000); // brief delay so agent can finish writing
        }

        // Keep in map for UI display, then purge
        setTimeout(() => this.activeReviews.delete(key), 10 * 60 * 1000);
      });

      child.on('error', (err) => {
        watchdog.cancel();
        this._pushDiag(key, review,
          `[LGTM] Failed to spawn ${agentId}: ${err.message}` +
          (err.code === 'ENOENT' ? ` (is "${command}" on your PATH?)` : ''));
        this._setStatus(review, 'failed');
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        if (review.cleanup) review.cleanup();
      });

      return { success: true };

    } catch (err) {
      this._setStatus(review, review.cancelled ? 'cancelled' : 'failed');
      if (!review.cancelled) review.output += `\nError: ${err.message}`;
      review.finishedAt = Date.now();
      this._notifyRenderer(key, review);
      if (review.cleanup) review.cleanup();
      return { success: !!review.cancelled, error: review.cancelled ? null : err.message, cancelled: !!review.cancelled };
    }
  }

  /**
   * Start an agent action on a work item (bug or ticket). Unlike PRs, the
   * caller chooses which repo to clone. The agent gets the work item's
   * title, description, and repro steps as context.
   *
   * @param {object} workItem - { id, title, type, project, webUrl }
   * @param {object} repoInfo - { project, repo } (the repo to clone)
   * @param {string} agentId
   * @param {string} model
   */
  async startWorkItemAction(workItem, repoInfo, agentId, model, options = {}) {
    const key = `${repoInfo.project}/${repoInfo.repo}/wi-${workItem.id}`;

    if (this.activeReviews.has(key) && this.activeReviews.get(key).status === 'running') {
      return { success: false, error: 'Agent already running for this work item.' };
    }

    const agent = this.registry.get(agentId);
    if (!agent) return { success: false, error: `Unknown agent: ${agentId}` };
    if (!agent.available) return { success: false, error: `${agent.name} is not installed.` };

    const now = Date.now();
    const review = {
      workItem,
      repoInfo,
      agentId,
      model,
      options,
      status: 'cloning',
      output: '',
      prompt: '',
      timeline: [{ status: 'cloning', at: now }],
      startedAt: now,
      cleanup: null,
      child: null,
      cloneChild: null,
      cancelled: false,
      // Shape a minimal pr-like object so the detail panel can render it.
      pr: {
        id: workItem.id,
        title: workItem.title,
        project: repoInfo.project,
        repo: repoInfo.repo,
        webUrl: workItem.webUrl,
        createdBy: '',
        createdDate: '',
      },
    };
    this.activeReviews.set(key, review);
    this._notifyRenderer(key, review);

    try {
      if (!this.cloner) {
        throw new Error('Not authenticated — no PAT available for cloning.');
      }

      const onCloneChild = (c) => {
        review.cloneChild = c;
        if (review.cancelled && c && !c.killed) {
          try { c.kill('SIGTERM'); } catch { /* ignore */ }
        }
      };
      const { clonePath, cleanup } = await this.cloner.cloneRepo(
        repoInfo.project,
        repoInfo.repo,
        workItem.id,
        { onChild: onCloneChild },
      );
      review.cloneChild = null;
      review.cleanup = cleanup;
      review.clonePath = clonePath;

      if (review.cancelled) {
        this._setStatus(review, 'cancelled');
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        if (review.cleanup) review.cleanup();
        return { success: true, cancelled: true };
      }

      // Fetch full work item details (description, repro steps, etc.)
      let details = workItem;
      try {
        if (this.devopsClient) {
          details = await this.devopsClient.getWorkItemDetails(workItem.id);
        }
      } catch (err) {
        console.warn(`[LGTM] Could not fetch work item details: ${err.message}`);
      }

      const scenarioId = 'implement-ticket';
      review.scenarioId = scenarioId;

      const defaultBranch = detectDefaultBranch(clonePath);
      const identity = formatIdentity(this.currentUser);
      const contextVars = {
        WORK_ITEM_ID: details.id || workItem.id,
        WORK_ITEM_URL: details.webUrl || workItem.webUrl,
        WORK_ITEM_TYPE: details.type || workItem.type || 'WorkItem',
        REPO_PATH: clonePath,
        DEFAULT_BRANCH: defaultBranch,
        AUTHOR_IDENTITY: identity || 'unknown',
      };

      const extraSections = [
        { title: 'Pre-fetched Work Item Details', body: this._renderWorkItemDetails(details, repoInfo) },
      ];

      // Append repo-specific prompt file if configured.
      if (options.promptFile) {
        const repoPromptPath = path.join(clonePath, options.promptFile);
        try {
          const repoPrompt = fs.readFileSync(repoPromptPath, 'utf8');
          extraSections.push({
            title: `Repo Prompt (${options.promptFile})`,
            body: repoPrompt,
          });
          review.promptSource = `repo:${options.promptFile}`;
          console.log(`[LGTM] Appended repo prompt from ${options.promptFile}`);
        } catch (err) {
          console.warn(`[LGTM] Could not read repo prompt at ${options.promptFile}: ${err.message}`);
        }
      }

      const prompt = this.scenarioPrompts.buildDispatchPrompt(
        agentId, scenarioId, contextVars, extraSections,
      );
      review.prompt = prompt;

      this._setStatus(review, 'running');
      this._notifyRenderer(key, review);

      const { command, args, stdinPrompt } = this.registry.buildCommand(agentId, prompt, model);

      console.log(`[LGTM] Launching ${agentId} in ${clonePath} for work item #${workItem.id}`);
      console.log(`[LGTM]   Command: ${command} ${args.join(' ')}`);

      this._pushDiag(key, review,
        `[LGTM] Launching ${agentId} (model: ${model || 'default'}) in ${clonePath}`);
      this._pushDiag(key, review,
        `[LGTM]   $ ${command} ${args.join(' ')}`);
      this._pushDiag(key, review,
        `[LGTM]   prompt: ${prompt.length.toLocaleString()} chars via ${stdinPrompt ? 'stdin' : 'argv'}`);

      const promptFile = path.join(os.tmpdir(), `lgtm-wi-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf8');

      const child = spawn(command, args, {
        cwd: clonePath,
        stdio: [stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
        env: buildSpawnEnv(),
      });
      review.child = child;

      if (stdinPrompt && child.stdin) {
        const promptStream = fs.createReadStream(promptFile);
        promptStream.pipe(child.stdin);
        promptStream.on('end', () => {
          try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        });
        child.stdin.on('error', (err) => {
          if (err && err.code !== 'EPIPE') {
            this._pushDiag(key, review, `[LGTM] stdin error: ${err.message}`);
          }
        });
      } else {
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      }

      const watchdog = this._armSilenceWatchdog(key, review, agentId);

      child.stdout.on('data', (data) => {
        watchdog.onOutput();
        const chunk = data.toString();
        review.output += chunk;
        this._notifyRendererChunk(key, chunk, review);
      });
      child.stderr.on('data', (data) => {
        watchdog.onOutput();
        const chunk = data.toString();
        review.output += chunk;
        this._notifyRendererChunk(key, chunk, review);
      });

      child.on('close', (code, signal) => {
        watchdog.cancel();
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        this._pushDiag(key, review, `[LGTM] ${agentId} finished — ${reason}`);

        if (review.cancelled) {
          this._setStatus(review, 'cancelled');
        } else {
          this._setStatus(review, code === 0 ? 'completed' : 'failed');
        }
        review.finishedAt = Date.now();
        this._extractAndAttachReport(review);
        this._notifyRenderer(key, review);
        console.log(`[LGTM] Work item action ${key} finished with code ${code}${review.cancelled ? ' (cancelled)' : ''}`);

        if (review.cleanup) {
          setTimeout(() => review.cleanup(), 5000);
        }
        setTimeout(() => this.activeReviews.delete(key), 10 * 60 * 1000);
      });

      child.on('error', (err) => {
        watchdog.cancel();
        this._pushDiag(key, review,
          `[LGTM] Failed to spawn ${agentId}: ${err.message}` +
          (err.code === 'ENOENT' ? ` (is "${command}" on your PATH?)` : ''));
        this._setStatus(review, 'failed');
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        if (review.cleanup) review.cleanup();
      });

      return { success: true };
    } catch (err) {
      this._setStatus(review, review.cancelled ? 'cancelled' : 'failed');
      if (!review.cancelled) review.output += `\nError: ${err.message}`;
      review.finishedAt = Date.now();
      this._notifyRenderer(key, review);
      if (review.cleanup) review.cleanup();
      return { success: !!review.cancelled, error: review.cancelled ? null : err.message, cancelled: !!review.cancelled };
    }
  }

  /**
   * After a sub-agent exits, locate the final JSON report in its stdout,
   * validate it against the dispatched scenario's schema, and attach it
   * to the review record. On parse failure, mark the run as
   * `report_unparseable` but do not change the run status — the raw log
   * stays on `review.output` so the user can still inspect it.
   */
  _extractAndAttachReport(review) {
    if (!review.scenarioId) return; // older flows without a scenario
    if (review.cancelled || review.status === 'cancelled') return;

    const result = this.scenarioPrompts.parseFinalReport(review.scenarioId, review.output);
    if (result.ok) {
      review.report = result.report;
      review.reportStatus = 'parsed';
      console.log(`[LGTM] Parsed final report for scenario ${review.scenarioId}`);
    } else {
      review.report = null;
      review.reportStatus = 'report_unparseable';
      review.reportError = result.error;
      console.warn(`[LGTM] Could not parse final report (${review.scenarioId}): ${result.error}`);
    }
  }

  _renderWorkItemDetails(details, repoInfo) {
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

    const parts = [
      `Project: ${details.project || repoInfo.project}`,
      `Repo: ${repoInfo.repo}`,
      `ID: ${details.id}`,
      `Type: ${details.type || ''}`,
      `Title: ${details.title || ''}`,
      `State: ${details.state || ''}`,
    ];
    if (details.priority != null) parts.push(`Priority: ${details.priority}`);
    if (details.severity) parts.push(`Severity: ${details.severity}`);
    if (details.tags) parts.push(`Tags: ${details.tags}`);

    const desc = stripHtml(details.description);
    if (desc) parts.push('', '### Description', desc);

    const repro = stripHtml(details.reproSteps);
    if (repro) parts.push('', '### Repro Steps', repro);

    const sysInfo = stripHtml(details.systemInfo);
    if (sysInfo) parts.push('', '### System Info', sysInfo);

    const ac = stripHtml(details.acceptanceCriteria);
    if (ac) parts.push('', '### Acceptance Criteria', ac);

    return parts.join('\n');
  }

  /**
   * Cancel an in-progress review. If the agent child process is running,
   * it is sent SIGTERM, then SIGKILL if it doesn't exit within 2s. If the
   * review is still cloning, kill the active git child so the clone aborts
   * immediately rather than running to completion.
   */
  cancelReview(key) {
    const review = this.activeReviews.get(key);
    if (!review) return { success: false, error: 'Review not found.' };
    if (review.status !== 'running' && review.status !== 'cloning') {
      return { success: false, error: `Cannot cancel review in status "${review.status}".` };
    }

    review.cancelled = true;
    review.output += '\n[LGTM] Review cancelled by user.\n';

    const child = review.child;
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2000);
    }

    // Kill the in-flight git clone if we're still cloning. The cloner sets
    // review.cloneChild for each git invocation it spawns; killing it makes
    // _runGit reject, the catch in startReview/startWorkItemAction triggers
    // cleanup, and the run lands in a cancelled state immediately.
    const cloneChild = review.cloneChild;
    if (cloneChild && cloneChild.exitCode === null && !cloneChild.killed) {
      try { cloneChild.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        if (cloneChild.exitCode === null && !cloneChild.killed) {
          try { cloneChild.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2000);
    }

    if (review.status === 'cloning') {
      this._notifyRenderer(key, review);
    }

    return { success: true };
  }

  /**
   * Return a snapshot of all active/recent reviews (serializable).
   */
  getActiveReviews() {
    const result = {};
    for (const [key, review] of this.activeReviews) {
      result[key] = {
        status: review.status,
        agentId: review.agentId,
        model: review.model || null,
        mode: review.mode || null,
        pr: review.pr,
        promptSource: review.promptSource || null,
        scenarioId: review.scenarioId || null,
        report: review.report || null,
        reportStatus: review.reportStatus || null,
        reportError: review.reportError || null,
        timeline: review.timeline || [],
        clonePath: review.clonePath || null,
        startedAt: review.startedAt,
        finishedAt: review.finishedAt || null,
        outputLength: (review.output || '').length,
      };
    }
    return result;
  }

  /**
   * Get the full output for a specific review.
   */
  getReviewOutput(key) {
    const review = this.activeReviews.get(key);
    return review ? review.output : '';
  }

  /**
   * Full snapshot for the detail view: prompt, timeline, clone path, etc.
   * Returns null if no review is found.
   */
  getReviewDetail(key) {
    const review = this.activeReviews.get(key);
    if (!review) return null;
    return {
      key,
      status: review.status,
      agentId: review.agentId,
      model: review.model || null,
      mode: review.mode || null,
      pr: review.pr,
      workItem: review.workItem || null,
      repoInfo: review.repoInfo || null,
      scenarioId: review.scenarioId || null,
      promptSource: review.promptSource || null,
      prompt: review.prompt || '',
      timeline: review.timeline || [],
      report: review.report || null,
      reportStatus: review.reportStatus || null,
      reportError: review.reportError || null,
      clonePath: review.clonePath || null,
      output: review.output || '',
      startedAt: review.startedAt,
      finishedAt: review.finishedAt || null,
      cancelled: !!review.cancelled,
    };
  }

  /**
   * Re-dispatch a previously-run review with the same target. Optionally
   * override the agent and/or model. Used by the detail view's "Re-run"
   * button.
   */
  async rerunReview(key, overrides = {}) {
    const prev = this.activeReviews.get(key);
    if (!prev) return { success: false, error: 'No review found for that key.' };
    if (prev.status === 'cloning' || prev.status === 'running') {
      return { success: false, error: 'Cannot re-run while the previous run is still in progress.' };
    }

    const agentId = overrides.agentId || prev.agentId;
    const model = overrides.model !== undefined ? overrides.model : prev.model;

    if (prev.workItem) {
      // Work-item dispatch (scenario 3).
      return this.startWorkItemAction(
        prev.workItem,
        prev.repoInfo,
        agentId,
        model,
        { promptFile: (prev.options && prev.options.promptFile) || undefined },
      );
    }
    return this.startReview(prev.pr, agentId, model, prev.mode || 'review');
  }

  /**
   * Push a status update to the renderer.
   */
  _notifyRenderer(key, review) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('review-update', {
        key,
        status: review.status,
        agentId: review.agentId,
        mode: review.mode || null,
        pr: review.pr,
        promptSource: review.promptSource || null,
        scenarioId: review.scenarioId || null,
        report: review.report || null,
        reportStatus: review.reportStatus || null,
        reportError: review.reportError || null,
        timeline: review.timeline || [],
        clonePath: review.clonePath || null,
        startedAt: review.startedAt,
        finishedAt: review.finishedAt || null,
      });
    }
  }

  /**
   * Push a streaming output chunk to the renderer.
   */
  _notifyRendererChunk(key, chunk, review) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('review-output', {
        key,
        chunk,
        status: review.status,
      });
    }
  }
}

module.exports = { AgentRunner };
