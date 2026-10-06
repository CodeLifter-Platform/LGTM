'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentRegistry, AGENTS } = require('../../src/main/agent-registry');
const { applySessionFlags } = require('../../src/main/core/session-flags');
const { serializeAgents } = require('../../src/main/core/serialize-agents');
const { buildSpawnEnv } = require('../../src/main/agent-runner');

const whichAll = (name) => `/opt/bin/${name}`;
const whichNone = () => null;

test('Each_agent_command_carries_its_non_interactive_flags_the_model_and_the_resolved_binary_and_pipes_the_prompt_on_stdin', () => {
  const reg = new AgentRegistry({ which: whichAll });
  assert.deepEqual(reg.buildCommand('claude', 'p', 'claude-opus-4-6'), {
    command: '/opt/bin/claude',
    args: ['-p', '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'claude-opus-4-6'],
    stdinPrompt: true,
  });
  assert.deepEqual(reg.buildCommand('codex', 'p', null), { command: '/opt/bin/codex', args: ['--quiet'], stdinPrompt: true });
  assert.deepEqual(reg.buildCommand('augment', 'p', 'default'), { command: '/opt/bin/auggie', args: ['--print'], stdinPrompt: true });
  assert.deepEqual(reg.buildCommand('augment', 'p', 'o3').args, ['--print', '--model', 'o3']);
  for (const agent of AGENTS) {
    const { args } = reg.buildCommand(agent.id, 'the prompt text', null);
    assert.ok(!args.some((a) => a.includes('the prompt text')), `${agent.id} must not put the prompt in argv`);
  }
});

test('An_agent_whose_CLI_is_not_on_PATH_is_listed_as_unavailable_and_an_unknown_agent_is_refused', () => {
  const reg = new AgentRegistry({ which: (name) => (name === 'claude' ? '/opt/bin/claude' : null) });
  const byId = Object.fromEntries(reg.getAll().map((a) => [a.id, a]));
  assert.equal(byId.claude.available, true);
  assert.equal(byId.codex.available, false);
  assert.equal(byId.augment.available, false);
  assert.equal(reg.getResolvedPath('claude'), '/opt/bin/claude');
  assert.equal(reg.getResolvedPath('codex'), null);
  assert.equal(reg.get('nope'), null);
  assert.throws(() => reg.buildCommand('nope', 'p'), /Unknown agent: nope/);
  assert.equal(reg.buildCommand('codex', 'p').command, 'codex', 'falls back to the bare name when unresolved');
});

test('Augment_is_found_under_any_of_its_known_binary_names', () => {
  const reg = new AgentRegistry({ which: (name) => (name === 'augcode' ? '/x/augcode' : null) });
  assert.equal(reg.get('augment').available, true);
  assert.equal(reg.buildCommand('augment', 'p').command, '/x/augcode');
});

test('Discovered_models_overlay_the_hardcoded_list_per_agent_and_a_failing_discoverer_keeps_the_fallback', async () => {
  const reg = new AgentRegistry({
    which: whichAll,
    discover: async (id) => {
      if (id === 'claude') return [{ id: 'claude-next', label: 'Next' }];
      if (id === 'codex') throw new Error('no key');
      return null;
    },
  });
  const status = await reg.refreshModels();
  assert.deepEqual(status, { claude: 'updated', codex: 'fallback', augment: 'fallback' });
  assert.deepEqual(reg.get('claude').models, [{ id: 'claude-next', label: 'Next' }]);
  assert.deepEqual(reg.get('codex').models, AGENTS.find((a) => a.id === 'codex').models);
  const none = new AgentRegistry({ which: whichNone, discover: async () => { throw new Error('must not run'); } });
  assert.deepEqual(await none.refreshModels(), { claude: 'unavailable', codex: 'unavailable', augment: 'unavailable' });
});

test('Session_flags_create_a_claude_session_on_the_first_turn_and_resume_it_after_and_continue_auggie_from_turn_two', () => {
  const base = ['-p'];
  assert.deepEqual(applySessionFlags('claude', base, { sessionId: 'abc', firstTurn: true }), ['-p', '--session-id', 'abc']);
  assert.deepEqual(applySessionFlags('claude', base, { sessionId: 'abc', firstTurn: false }), ['-p', '--resume', 'abc']);
  assert.deepEqual(applySessionFlags('claude', base, { sessionId: null, firstTurn: false }), ['-p']);
  assert.deepEqual(applySessionFlags('augment', base, { firstTurn: true }), ['-p']);
  assert.deepEqual(applySessionFlags('augment', base, { firstTurn: false }), ['-p', '--continue']);
  assert.deepEqual(applySessionFlags('codex', base, { sessionId: 'abc', firstTurn: false }), ['-p']);
  assert.deepEqual(base, ['-p'], 'input array is not mutated');
});

test('Agents_crossing_IPC_lose_their_functions_and_keep_everything_else', () => {
  const reg = new AgentRegistry({ which: whichAll });
  const out = serializeAgents(reg.getAll());
  for (const a of out) {
    assert.ok(!Object.values(a).some((v) => typeof v === 'function'), `${a.id} still carries a function`);
    assert.equal(a.available, true);
    assert.ok(Array.isArray(a.models) && a.models.length > 0);
  }
  assert.ok(reg.getAll()[0].buildCmd, 'the registry itself keeps buildCmd');
});

test('The_spawn_environment_scrubs_debugger_variables_and_exposes_the_connection_token_under_its_conventional_names', () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_OPTIONS = '--inspect';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.NODE_INSPECT = '1';
    process.env.KEEP_ME = 'yes';
    // `agentEnv()` of an Azure DevOps connection: the token under the names its prompts reference.
    const env = buildSpawnEnv({ AZURE_DEVOPS_PAT: 'tok', AZURE_DEVOPS_EXT_PAT: 'tok', SYSTEM_ACCESSTOKEN: 'tok' });
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.NODE_INSPECT, undefined);
    assert.equal(env.KEEP_ME, 'yes');
    assert.equal(env.AZURE_DEVOPS_PAT, 'tok');
    assert.equal(env.AZURE_DEVOPS_EXT_PAT, 'tok');
    assert.equal(env.SYSTEM_ACCESSTOKEN, 'tok');
    const noPat = buildSpawnEnv(null);
    assert.equal(noPat.AZURE_DEVOPS_PAT, undefined);
    const gh = buildSpawnEnv({ GITHUB_TOKEN: 'g', GH_TOKEN: 'g' });
    assert.equal(gh.GITHUB_TOKEN, 'g');
    assert.equal(gh.AZURE_DEVOPS_PAT, undefined, 'a GitHub connection hands over only its own token');
    assert.equal(process.env.NODE_OPTIONS, '--inspect', 'the real environment is untouched');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
