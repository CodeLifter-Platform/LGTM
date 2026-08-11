// LocalDockerRunner — runs lgtm-worker containers against the local Docker engine.
//
// Designed to drop into the Electron main process. No renderer assumptions.

const Docker = require('dockerode');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { EventStreamParser } = require('./EventStreamParser');
const { TokenManager } = require('./TokenManager');
const { AgentCatalog } = require('./AgentCatalog');

const IMAGE = process.env.LGTM_WORKER_IMAGE || 'lgtm-worker:latest';

class LocalDockerRunner {
  constructor(opts = {}) {
    this.docker = new Docker(opts.dockerOpts || {});
    this.image = opts.image || IMAGE;
    this.tokens = opts.tokenManager || new TokenManager();
    this.catalog = opts.catalog || AgentCatalog.builtin();
  }

  /**
   * Verify the worker image exists locally. Throws with a helpful message if not.
   */
  async ensureImage() {
    try {
      const img = this.docker.getImage(this.image);
      await img.inspect();
    } catch {
      throw new Error(
        `Worker image "${this.image}" not found. Build it first: ` +
        `cd containers && ./build.sh`,
      );
    }
  }

  /**
   * Expose the agent/model catalog so the renderer's UI can populate
   * its model picker without spawning a container.
   */
  getCatalog() {
    return this.catalog.toJSON();
  }

  /**
   * Run a worker container.
   * @param {RunSpec} spec
   * @returns {Promise<RunHandle>}
   */
  async run(spec) {
    await this.ensureImage();
    this._validateSpec(spec);

    // Resolve and validate the model BEFORE spawning the container.
    // The worker will re-validate inside the container as a safety net,
    // but failing fast here saves a container start + Docker pull on
    // a misconfigured run.
    const model = spec.model || this.catalog.defaultModel(spec.agent);
    if (!this.catalog.supports(spec.agent, model)) {
      throw new Error(
        `Agent "${spec.agent}" does not support model "${model}". ` +
        `Supported: ${this.catalog.supportedModels(spec.agent).join(', ')}`,
      );
    }

    const events = new EventEmitter();
    const parser = new EventStreamParser({ runId: spec.runId });
    parser.on('event', (evt) => events.emit('event', evt));

    const adoToken = await this.tokens.getAdoToken();

    const env = this._buildEnv(spec, adoToken, model);
    const artifactsHostDir = this._artifactsHostDir(spec.runId);
    fs.mkdirSync(artifactsHostDir, { recursive: true });

    const container = await this.docker.createContainer({
      Image: this.image,
      Env: env,
      HostConfig: {
        AutoRemove: true,
        Memory: 2 * 1024 * 1024 * 1024,        // 2GB default
        Mounts: [
          { Type: 'volume', Source: 'lgtm-cache', Target: '/cache' },
          {
            Type: 'bind',
            Source: artifactsHostDir,
            Target: `/artifacts/${spec.runId}`,
          },
        ],
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '10m', 'max-file': '3' },
        },
      },
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    container.modem.demuxStream(
      stream,
      parser.stdoutStream(),
      parser.stderrStream(),
    );

    await container.start();

    const result = (async () => {
      const wait = await container.wait();
      const exitCode = wait.StatusCode;

      parser.flush();

      const artifacts = this._collectArtifacts(spec.runId);
      const finalEvent = parser.lastDoneEvent();
      const success = exitCode === 0 && finalEvent && finalEvent.success;

      const runResult = {
        success: !!success,
        summary: finalEvent ? finalEvent.summary : '',
        exitCode,
        error: success ? undefined : this._diagnoseFailure(exitCode, finalEvent),
        artifacts,
        // Echo the resolved model so callers can record what actually ran
        model,
      };

      events.emit('done', runResult);
      return runResult;
    })();

    return {
      events,
      cancel: async () => {
        try {
          await container.kill();
        } catch {
          // Already gone
        }
      },
      result,
    };
  }

  _validateSpec(spec) {
    if (!spec.agent) throw new Error('agent is required');
    if (!spec.mode) throw new Error('mode is required');
    if (!spec.runId) throw new Error('runId is required');
    if (!spec.context) throw new Error('context is required');
    if (spec.mode === 'review' && !spec.context.prId) {
      throw new Error('context.prId is required for review mode');
    }
    if (spec.mode === 'implement' && !spec.context.workItemId) {
      throw new Error('context.workItemId is required for implement mode');
    }
    // Per-agent secret validation: only require the key for the agent in use,
    // since LGTM users may not have keys for all three providers.
    if (!spec.secrets) throw new Error('secrets is required');
    if (spec.agent === 'claude' && !spec.secrets.anthropicApiKey) {
      throw new Error('secrets.anthropicApiKey is required for claude agent');
    }
    if (spec.agent === 'codex' && !spec.secrets.openaiApiKey) {
      throw new Error('secrets.openaiApiKey is required for codex agent');
    }
    if (spec.agent === 'auggie' && !spec.secrets.augmentApiKey) {
      throw new Error('secrets.augmentApiKey is required for auggie agent');
    }
  }

  _buildEnv(spec, adoToken, resolvedModel) {
    const e = [
      `LGTM_AGENT=${spec.agent}`,
      `LGTM_MODE=${spec.mode}`,
      `LGTM_MODEL=${resolvedModel}`,
      `LGTM_RUN_ID=${spec.runId}`,
      `ADO_ORG=${spec.context.adoOrg}`,
      `ADO_PROJECT=${spec.context.adoProject}`,
      `ADO_REPO=${spec.context.adoRepo}`,
      `ADO_MCP_AUTH_TOKEN=${adoToken}`,
      `BASE_BRANCH=${spec.context.baseBranch || 'main'}`,
    ];
    if (spec.context.prId) e.push(`PR_ID=${spec.context.prId}`);
    if (spec.context.workItemId) e.push(`WORK_ITEM_ID=${spec.context.workItemId}`);

    // Forward only the API key the chosen agent needs.
    // Don't leak the others into the container even if available.
    if (spec.agent === 'claude' && spec.secrets.anthropicApiKey) {
      e.push(`ANTHROPIC_API_KEY=${spec.secrets.anthropicApiKey}`);
    }
    if (spec.agent === 'codex' && spec.secrets.openaiApiKey) {
      e.push(`OPENAI_API_KEY=${spec.secrets.openaiApiKey}`);
    }
    if (spec.agent === 'auggie' && spec.secrets.augmentApiKey) {
      e.push(`AUGMENT_API_KEY=${spec.secrets.augmentApiKey}`);
    }
    return e;
  }

  _artifactsHostDir(runId) {
    const base = process.env.LGTM_ARTIFACTS_DIR
      || path.join(require('os').homedir(), '.lgtm', 'artifacts');
    return path.join(base, runId);
  }

  _collectArtifacts(runId) {
    const dir = this._artifactsHostDir(runId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith('.'))
      .map((name) => ({
        kind: path.extname(name).slice(1) || 'file',
        path: path.join(dir, name),
      }));
  }

  _diagnoseFailure(exitCode, lastEvent) {
    if (exitCode === 137) return 'Container was OOM-killed (exit 137). Increase memory.';
    if (exitCode === 2)   return 'Worker rejected its inputs (exit 2). Check env vars / model name.';
    if (exitCode === 143) return 'Container was terminated (SIGTERM).';
    if (exitCode !== 0)   return `Worker exited with code ${exitCode}.`;
    if (lastEvent && lastEvent.success === false) return lastEvent.summary || 'Run failed.';
    return 'Run did not emit a terminal event.';
  }
}

module.exports = { LocalDockerRunner };
