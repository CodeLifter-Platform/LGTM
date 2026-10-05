'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAuggieModelList, isClaudeCoderelevant, discoverModelsFor } = require('../../src/main/model-discovery');

// Fixture: the real shape of `auggie model list` output, including the
// description lines and a deprecation marker that must be ignored.
const AUGGIE_OUTPUT = `
Available models:
  - Opus 4.7 [opus4.7]
      Great for complex, multi-step agentic tasks
  - Sonnet 4.6 [sonnet4.6]
      Fast and capable
  - GPT-5 (deprecated) [gpt5]
  not a model line
  - [broken]
`;

test('The_auggie_model_list_yields_label_and_id_pairs_and_ignores_descriptions_and_malformed_lines', () => {
  assert.deepEqual(parseAuggieModelList(AUGGIE_OUTPUT), [
    { id: 'opus4.7', label: 'Opus 4.7' },
    { id: 'sonnet4.6', label: 'Sonnet 4.6' },
    { id: 'gpt5', label: 'GPT-5 (deprecated)' },
  ]);
  assert.deepEqual(parseAuggieModelList(''), []);
  assert.deepEqual(parseAuggieModelList('garbage\n\n'), []);
});

test('Only_current_opus_sonnet_and_haiku_models_count_as_relevant_for_Claude_Code', () => {
  assert.equal(isClaudeCoderelevant({ id: 'claude-opus-4-6' }), true);
  assert.equal(isClaudeCoderelevant({ id: 'claude-sonnet-4-6' }), true);
  assert.equal(isClaudeCoderelevant({ id: 'claude-haiku-4-5' }), true);
  assert.equal(isClaudeCoderelevant({ id: 'claude-2.1' }), false);
  assert.equal(isClaudeCoderelevant({ id: 'claude-instant-1.2' }), false);
  assert.equal(isClaudeCoderelevant({ id: 'gpt-4.1' }), false);
  assert.equal(isClaudeCoderelevant({}), false);
});

test('Discovery_for_an_agent_without_a_discoverer_is_null_so_the_hardcoded_list_stays', async () => {
  assert.equal(await discoverModelsFor('nope'), null);
});
