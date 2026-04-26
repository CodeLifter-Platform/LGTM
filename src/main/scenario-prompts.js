/**
 * ScenarioPrompts — Loads the verbatim agent preambles + scenario prompt files
 * from disk at startup and composes the three-part dispatch prompt
 * (preamble + scenario + injected context) at dispatch time.
 *
 * Files live in resources/prompts/ in dev and process.resourcesPath/prompts/
 * in a packaged build (see package.json `extraResources`).
 *
 * The four files are read-only inputs — they must not be edited or templated.
 * The orchestrator only injects required variables under the
 * `## Injected Context` heading.
 */

const fs = require('fs');
const path = require('path');

const PREAMBLE_FILE = '00-agent-preambles.md';

const SCENARIOS = {
  'pr-review':         { file: '01-pr-review.md',        requiredReportKeys: ['pr_id', 'comments_posted'] },
  'resolve-comments':  { file: '02-resolve-comments.md', requiredReportKeys: ['pr_id', 'threads_processed'] },
  'implement-ticket':  { file: '03-implement-ticket.md', requiredReportKeys: ['work_item_id', 'outcome', 'pr_id'] },
};

// agent-registry IDs → preamble heading text in 00-agent-preambles.md
const AGENT_PREAMBLE_HEADINGS = {
  claude:  'Claude Code',
  codex:   'Codex',
  augment: 'AugmentCode',
};

function resolvePromptsDir() {
  // Dev layout
  const devDir = path.join(__dirname, '..', '..', 'resources', 'prompts');
  if (fs.existsSync(devDir)) return devDir;

  // Packaged layout (electron-builder extraResources)
  if (process.resourcesPath) {
    const packagedDir = path.join(process.resourcesPath, 'prompts');
    if (fs.existsSync(packagedDir)) return packagedDir;
  }

  return devDir; // let the caller fail with a clear ENOENT
}

/**
 * Pull the fenced code-block payload out of a `## <heading>` section.
 * Returns the body text inside the first ``` fence under that heading.
 */
function extractFencedPreamble(fileContent, heading) {
  const lines = fileContent.split('\n');
  const headingRe = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`);

  let i = 0;
  while (i < lines.length && !headingRe.test(lines[i])) i++;
  if (i >= lines.length) return null;

  // Find opening fence after heading, but before next `## ` heading
  while (i < lines.length && !/^```/.test(lines[i])) {
    if (/^##\s/.test(lines[i]) && !headingRe.test(lines[i])) return null;
    i++;
  }
  if (i >= lines.length) return null;
  i++; // step past opening fence

  const body = [];
  while (i < lines.length && !/^```/.test(lines[i])) {
    body.push(lines[i]);
    i++;
  }
  return body.join('\n').trim();
}

class ScenarioPrompts {
  constructor() {
    this.promptsDir = resolvePromptsDir();
    this.preambles = {};       // agentId → string
    this.scenarios = {};       // scenarioId → string
    this.loaded = false;
  }

  /**
   * Read every prompt file from disk. Throws if any file is missing or any
   * preamble heading is absent. Call this at app startup so failures
   * surface immediately, not at dispatch time.
   */
  loadAll() {
    const preamblePath = path.join(this.promptsDir, PREAMBLE_FILE);
    let preambleContent;
    try {
      preambleContent = fs.readFileSync(preamblePath, 'utf8');
    } catch (err) {
      throw new Error(`[LGTM] Cannot read preamble file at ${preamblePath}: ${err.message}`);
    }

    for (const [agentId, heading] of Object.entries(AGENT_PREAMBLE_HEADINGS)) {
      const block = extractFencedPreamble(preambleContent, heading);
      if (!block) {
        throw new Error(`[LGTM] Preamble heading "## ${heading}" not found or has no fenced body in ${PREAMBLE_FILE}`);
      }
      this.preambles[agentId] = block;
    }

    for (const [scenarioId, def] of Object.entries(SCENARIOS)) {
      const scenarioPath = path.join(this.promptsDir, def.file);
      try {
        this.scenarios[scenarioId] = fs.readFileSync(scenarioPath, 'utf8');
      } catch (err) {
        throw new Error(`[LGTM] Cannot read scenario prompt at ${scenarioPath}: ${err.message}`);
      }
    }

    this.loaded = true;
    console.log(`[LGTM] Loaded scenario prompts from ${this.promptsDir}`);
  }

  getPreamble(agentId) {
    if (!this.loaded) this.loadAll();
    const block = this.preambles[agentId];
    if (!block) {
      throw new Error(`[LGTM] No preamble block for agent "${agentId}". Add a "## ${AGENT_PREAMBLE_HEADINGS[agentId] || agentId}" section to ${PREAMBLE_FILE} or pick a supported agent.`);
    }
    return block;
  }

  getScenario(scenarioId) {
    if (!this.loaded) this.loadAll();
    const body = this.scenarios[scenarioId];
    if (!body) {
      throw new Error(`[LGTM] Unknown scenario "${scenarioId}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
    }
    return body;
  }

  /**
   * Build the final prompt the sub-agent receives:
   *   <preamble>
   *
   *   <scenario prompt verbatim>
   *
   *   ## Injected Context
   *   KEY: value
   *   ...
   *
   * `extraSections` is an array of { title, body } pairs appended after the
   * injected context. This is how the existing layered prompts
   * (LGTM_REVIEW_PROMPT.md, REPO_REVIEW_TEMPLATE.md, existing PR threads)
   * are passed alongside the scenario without being interleaved into it.
   */
  buildDispatchPrompt(agentId, scenarioId, contextVars, extraSections = []) {
    const preamble = this.getPreamble(agentId);
    const scenario = this.getScenario(scenarioId);

    const required = this.getRequiredVariables(scenarioId);
    const missing = required.filter((k) => !(k in contextVars) || contextVars[k] == null || contextVars[k] === '');
    if (missing.length > 0) {
      throw new Error(`[LGTM] Missing required context variables for scenario "${scenarioId}": ${missing.join(', ')}`);
    }

    const contextLines = [];
    // Render required keys first, in their declared order, then any extras.
    const seen = new Set();
    for (const key of required) {
      contextLines.push(`${key}: ${contextVars[key]}`);
      seen.add(key);
    }
    for (const [key, val] of Object.entries(contextVars)) {
      if (seen.has(key) || val == null || val === '') continue;
      contextLines.push(`${key}: ${val}`);
    }

    const parts = [
      preamble,
      '',
      scenario,
      '',
      '## Injected Context',
      ...contextLines,
    ];

    for (const section of extraSections) {
      if (!section || !section.body) continue;
      parts.push('', `## ${section.title}`, section.body);
    }

    return parts.join('\n');
  }

  /**
   * Source-of-truth list of required injected variables per scenario.
   * Verified against the `## Context` section of each prompt file.
   */
  getRequiredVariables(scenarioId) {
    switch (scenarioId) {
      case 'pr-review':
        return ['PR_ID', 'PR_URL', 'REPO_PATH', 'TARGET_BRANCH', 'SOURCE_BRANCH', 'REVIEWER_IDENTITY'];
      case 'resolve-comments':
        return ['PR_ID', 'PR_URL', 'REPO_PATH', 'SOURCE_BRANCH', 'TARGET_BRANCH', 'AUTHOR_IDENTITY'];
      case 'implement-ticket':
        return ['WORK_ITEM_ID', 'WORK_ITEM_URL', 'WORK_ITEM_TYPE', 'REPO_PATH', 'DEFAULT_BRANCH', 'AUTHOR_IDENTITY'];
      default:
        throw new Error(`[LGTM] Unknown scenario "${scenarioId}"`);
    }
  }

  /**
   * Locate the last fenced JSON block in raw sub-agent stdout, parse it,
   * and validate that the discriminator keys for the scenario are present.
   *
   * Returns { ok: true, report } on success, or { ok: false, error, raw }
   * on parse/validation failure. Never throws — callers shouldn't crash
   * when a sub-agent produces malformed output.
   */
  parseFinalReport(scenarioId, output) {
    if (!output || typeof output !== 'string') {
      return { ok: false, error: 'empty output' };
    }

    const candidates = [];

    // 1. Fenced ```json blocks (preferred — what the prompts ask for).
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = fenceRe.exec(output)) !== null) {
      candidates.push(match[1]);
    }

    // 2. Fallback: if no fences, scan for top-level `{...}` objects.
    if (candidates.length === 0) {
      const braceRe = /\{[\s\S]*\}/g;
      while ((match = braceRe.exec(output)) !== null) {
        candidates.push(match[0]);
      }
    }

    const def = SCENARIOS[scenarioId];
    if (!def) return { ok: false, error: `unknown scenario "${scenarioId}"` };

    // Try the last candidate first, then walk back. Be tolerant of trailing
    // log lines or commentary after the report.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const text = candidates[i].trim();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

      const missing = def.requiredReportKeys.filter((k) => !(k in parsed));
      if (missing.length === 0) {
        return { ok: true, report: parsed };
      }
    }

    return { ok: false, error: 'no JSON block matching scenario schema found' };
  }
}

module.exports = { ScenarioPrompts, AGENT_PREAMBLE_HEADINGS };
