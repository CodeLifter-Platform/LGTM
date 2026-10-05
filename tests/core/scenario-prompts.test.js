'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ScenarioPrompts, AGENT_PREAMBLE_HEADINGS } = require('../../src/main/scenario-prompts');
const { tempDir } = require('../helpers/fakes');

const REAL_PROMPTS = path.join(__dirname, '..', '..', 'resources', 'prompts');

function loaded() {
  const sp = new ScenarioPrompts();
  sp.loadAll();
  return sp;
}

test('The_shipped_prompt_files_load_with_a_preamble_for_every_agent_and_every_scenario', () => {
  const sp = loaded();
  assert.equal(sp.promptsDir, REAL_PROMPTS);
  for (const agentId of Object.keys(AGENT_PREAMBLE_HEADINGS)) {
    assert.ok(sp.getPreamble(agentId).length > 50, `${agentId} preamble is empty`);
  }
  for (const scenario of ['pr-review', 'resolve-comments', 'implement-ticket']) {
    assert.ok(sp.getScenario(scenario).includes('## Context'), `${scenario} has no Context section`);
  }
});

test('A_missing_scenario_file_fails_at_load_naming_the_file', () => {
  const dir = tempDir();
  fs.copyFileSync(path.join(REAL_PROMPTS, '00-agent-preambles.md'), path.join(dir, '00-agent-preambles.md'));
  const sp = new ScenarioPrompts();
  sp.promptsDir = dir;
  assert.throws(() => sp.loadAll(), /01-pr-review\.md/);
});

test('A_preamble_file_without_the_agent_heading_fails_at_load_naming_the_heading', () => {
  const dir = tempDir();
  for (const f of fs.readdirSync(REAL_PROMPTS)) fs.copyFileSync(path.join(REAL_PROMPTS, f), path.join(dir, f));
  const preambles = fs.readFileSync(path.join(dir, '00-agent-preambles.md'), 'utf8').replace('## Codex', '## Kodex');
  fs.writeFileSync(path.join(dir, '00-agent-preambles.md'), preambles);
  const sp = new ScenarioPrompts();
  sp.promptsDir = dir;
  assert.throws(() => sp.loadAll(), /"## Codex" not found/);
});

test('A_dispatch_prompt_is_preamble_then_scenario_then_injected_context_in_declared_order_then_extra_sections', () => {
  const sp = loaded();
  const prompt = sp.buildDispatchPrompt('claude', 'pr-review', {
    REVIEWER_IDENTITY: 'Ada (ada)',
    SOURCE_BRANCH: 'feature/x',
    TARGET_BRANCH: 'main',
    REPO_PATH: '/tmp/clone',
    PR_URL: 'https://dev.azure.com/o/p/_git/r/pullrequest/7',
    PR_ID: 7,
    EXTRA: 'yes',
    EMPTY: '',
  }, [{ title: 'Project-Specific Rules', body: 'Be kind.' }, { title: 'Skipped', body: '' }]);

  const preambleAt = prompt.indexOf(sp.getPreamble('claude'));
  const scenarioAt = prompt.indexOf(sp.getScenario('pr-review'));
  const contextAt = prompt.indexOf('## Injected Context');
  const rulesAt = prompt.indexOf('## Project-Specific Rules\nBe kind.');
  assert.equal(preambleAt, 0);
  assert.ok(scenarioAt > preambleAt && contextAt > scenarioAt && rulesAt > contextAt);

  const contextBlock = prompt.slice(contextAt, rulesAt);
  assert.equal(contextBlock.trim().split('\n').slice(1).join('\n'), [
    'PR_ID: 7',
    'PR_URL: https://dev.azure.com/o/p/_git/r/pullrequest/7',
    'REPO_PATH: /tmp/clone',
    'TARGET_BRANCH: main',
    'SOURCE_BRANCH: feature/x',
    'REVIEWER_IDENTITY: Ada (ada)',
    'EXTRA: yes',
  ].join('\n'));
  assert.ok(!prompt.includes('## Skipped'), 'empty extra sections are dropped');
});

test('A_dispatch_with_a_missing_required_variable_is_refused_naming_the_variable', () => {
  const sp = loaded();
  assert.throws(
    () => sp.buildDispatchPrompt('claude', 'implement-ticket', { WORK_ITEM_ID: 1, REPO_PATH: '/x' }),
    /Missing required context variables for scenario "implement-ticket": WORK_ITEM_URL, WORK_ITEM_TYPE, DEFAULT_BRANCH, AUTHOR_IDENTITY/,
  );
  assert.throws(() => sp.buildDispatchPrompt('nope', 'pr-review', {}), /No preamble block for agent "nope"/);
  assert.throws(() => sp.buildDispatchPrompt('claude', 'nope', {}), /Unknown scenario "nope"/);
});

test('The_final_report_is_the_last_fenced_JSON_block_that_matches_the_scenario_schema', () => {
  const sp = loaded();
  const output = [
    'thinking...',
    '```json', '{"pr_id": 7, "comments_posted": 0, "note": "first draft"}', '```',
    'more work',
    '```', '{"pr_id": 7, "comments_posted": 3}', '```',
    'trailing log line',
  ].join('\n');
  assert.deepEqual(sp.parseFinalReport('pr-review', output), { ok: true, report: { pr_id: 7, comments_posted: 3 } });
});

test('A_report_missing_a_required_key_or_a_block_that_is_not_JSON_is_a_reported_failure_never_an_exception', () => {
  const sp = loaded();
  assert.equal(sp.parseFinalReport('pr-review', '```json\n{"comments_posted": 1}\n```').ok, false);
  assert.equal(sp.parseFinalReport('pr-review', '```json\n{not json\n```').ok, false);
  assert.equal(sp.parseFinalReport('pr-review', '').ok, false);
  assert.equal(sp.parseFinalReport('pr-review', null).ok, false);
  assert.equal(sp.parseFinalReport('nope', '{}').ok, false);
  assert.match(sp.parseFinalReport('pr-review', 'no json at all').error, /no JSON block/);
});

// Regression: without fences, the brace fallback is greedy. Two objects on
// one line used to be captured as one unparsable blob and the run was
// marked report_unparseable even though a valid report was there.
test('Unfenced_output_with_several_brace_blocks_still_finds_a_matching_report', () => {
  const sp = loaded();
  const output = 'log {"not": "it"} then the report {"work_item_id": 9, "outcome": "done", "pr_id": 12}';
  const result = sp.parseFinalReport('implement-ticket', output);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.report, { work_item_id: 9, outcome: 'done', pr_id: 12 });
});
