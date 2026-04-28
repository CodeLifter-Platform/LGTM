// ContainerRunner — backend-agnostic interface.
// Today: only LocalDockerRunner is implemented.
// Tomorrow: AzureContainerAppsRunner can drop in here without changing callers.

const { LocalDockerRunner } = require('./LocalDockerRunner');

/**
 * @typedef {Object} RunSpec
 * @property {'claude'|'codex'|'auggie'} agent
 * @property {'review'|'implement'} mode
 * @property {string} runId
 * @property {string} [model]                   - optional; agent default if absent
 * @property {Object} context
 * @property {string} context.adoOrg
 * @property {string} context.adoProject
 * @property {string} context.adoRepo
 * @property {string} [context.prId]            - required for review
 * @property {string} [context.workItemId]      - required for implement
 * @property {string} [context.baseBranch='main']
 * @property {Object} secrets
 * @property {string} secrets.anthropicApiKey
 * @property {string} [secrets.openaiApiKey]
 * @property {string} [secrets.augmentApiKey]
 */

/**
 * @typedef {Object} RunHandle
 * @property {EventEmitter} events  - emits 'event' (parsed JSONL) and 'done' (terminal)
 * @property {Function} cancel       - kill the run
 * @property {Promise<RunResult>} result
 */

/**
 * @typedef {Object} RunResult
 * @property {boolean} success
 * @property {string}  summary
 * @property {number}  exitCode
 * @property {string}  [error]
 * @property {Array<{kind:string, path:string}>} artifacts
 */

/**
 * Create a runner. Pass { backend: 'docker-local' } today.
 * @param {{backend:'docker-local'|'container-apps'}} opts
 */
function createContainerRunner(opts = { backend: 'docker-local' }) {
  switch (opts.backend) {
    case 'docker-local':
      return new LocalDockerRunner(opts);
    default:
      throw new Error(`Unknown container backend: ${opts.backend}`);
  }
}

module.exports = { createContainerRunner };
