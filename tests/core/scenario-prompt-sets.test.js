const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ScenarioPrompts, PROMPT_SETS } = require('../../src/main/scenario-prompts');

const promptsDir = path.join(__dirname, '..', '..', 'resources', 'prompts');
const origLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = origLog; });

test('every registered provider ships a complete prompt set that loads at startup', () => {
  const sp = new ScenarioPrompts({ promptsDir });
  sp.loadAll();
  assert.deepEqual(Object.keys(PROMPT_SETS), ['azure-devops', 'github']);
  for (const providerId of Object.keys(PROMPT_SETS)) {
    for (const agentId of ['claude', 'codex', 'augment']) assert.ok(sp.getPreamble(agentId, providerId).length > 50);
    for (const scenarioId of ['pr-review', 'resolve-comments', 'implement-ticket']) assert.ok(sp.getScenario(scenarioId, providerId).length > 500);
  }
});

test('the GitHub set talks to GitHub and the ADO set to Azure DevOps, never the other way round', () => {
  const sp = new ScenarioPrompts({ promptsDir });
  for (const scenarioId of ['pr-review', 'resolve-comments', 'implement-ticket']) {
    const gh = sp.getScenario(scenarioId, 'github');
    const ado = sp.getScenario(scenarioId, 'azure-devops');
    assert.match(gh, /api\.github\.com/);
    assert.match(gh, /GITHUB_TOKEN/);
    assert.doesNotMatch(gh, /Azure DevOps|dev\.azure\.com|vstfs|_apis/);
    assert.match(ado, /dev\.azure\.com/);
    assert.doesNotMatch(ado, /api\.github\.com/);
  }
  for (const agentId of ['claude', 'codex', 'augment']) {
    assert.match(sp.getPreamble(agentId, 'github'), /GITHUB_TOKEN/);
    assert.doesNotMatch(sp.getPreamble(agentId, 'github'), /Azure DevOps/);
    assert.match(sp.getPreamble(agentId, 'azure-devops'), /Azure DevOps/);
  }
});

test('buildDispatchPrompt composes preamble + scenario + injected context for the chosen provider', () => {
  const sp = new ScenarioPrompts({ promptsDir });
  const vars = { PR_ID: 42, PR_URL: 'https://github.com/acme/widgets/pull/42', REPO_PATH: '/tmp/x', TARGET_BRANCH: 'main', SOURCE_BRANCH: 'feat', REVIEWER_IDENTITY: 'Alice (@alice)', REPO_OWNER: 'acme', REPO_NAME: 'widgets' };
  const prompt = sp.buildDispatchPrompt('claude', 'pr-review', vars, [{ title: 'Extra', body: 'rules here' }], 'github');
  assert.ok(prompt.startsWith('You are running as Claude Code'));
  assert.match(prompt, /## GitHub access/);
  assert.match(prompt, /## Injected Context\nPR_ID: 42\nPR_URL: https:\/\/github\.com\/acme\/widgets\/pull\/42\n/);
  assert.match(prompt, /REPO_OWNER: acme/);
  assert.match(prompt, /## Extra\nrules here/);
  assert.ok(prompt.indexOf('## Injected Context') < prompt.indexOf('## Extra'));

  const ado = sp.buildDispatchPrompt('claude', 'pr-review', vars);
  assert.match(ado, /## Azure DevOps access/);
});

test('a missing required variable is refused with its name, before anything is dispatched', () => {
  const sp = new ScenarioPrompts({ promptsDir });
  assert.throws(() => sp.buildDispatchPrompt('claude', 'pr-review', { PR_ID: 1 }, [], 'github'), /Missing required context variables.*PR_URL/);
  assert.throws(() => sp.buildDispatchPrompt('claude', 'nope', {}), /Unknown scenario/);
  assert.throws(() => sp.getScenario('pr-review', 'gitlab'), /No prompt set/);
});

test('parseFinalReport takes the last JSON block that matches the scenario schema', () => {
  const sp = new ScenarioPrompts({ promptsDir });
  const out = 'noise\n```json\n{"pr_id": 1}\n```\nmore\n```json\n{"pr_id": 42, "comments_posted": 3}\n```\ntrailing log';
  const r = sp.parseFinalReport('pr-review', out);
  assert.equal(r.ok, true);
  assert.equal(r.report.comments_posted, 3);
  assert.equal(sp.parseFinalReport('pr-review', 'no json here').ok, false);
  assert.equal(sp.parseFinalReport('implement-ticket', '{"work_item_id": 7, "outcome": "success", "pr_id": 9}').ok, true);
});
