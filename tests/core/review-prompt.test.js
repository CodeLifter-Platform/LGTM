'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { htmlToText } = require('../../src/main/core/html-text');
const {
  formatIdentity, selectReviewThreads, summarizeThreads, renderWorkItemDetails, THREAD_PREVIEW_CHARS,
} = require('../../src/main/core/review-prompt');
const { buildPrDetailPrompt, buildWorkItemDetailPrompt } = require('../../src/main/core/detail-prompts');

test('HTML_from_Azure_DevOps_becomes_readable_text_with_paragraphs_kept_and_entities_decoded', () => {
  const html = '<p>Line one<br/>Line two</p><p>Para &amp; &lt;tag&gt; &quot;q&quot;&nbsp;end</p><p></p><p></p><p>last</p>';
  assert.equal(htmlToText(html), 'Line one\nLine two\n\nPara & <tag> "q" end\n\nlast');
  assert.equal(htmlToText(null), '');
});

test('The_injected_identity_is_display_name_with_id_and_degrades_to_whichever_is_present', () => {
  assert.equal(formatIdentity({ displayName: 'Ada', id: 'u1' }), 'Ada (u1)');
  assert.equal(formatIdentity({ email: 'a@x', id: 'u1' }), 'a@x (u1)');
  assert.equal(formatIdentity({ displayName: 'Ada' }), 'Ada');
  assert.equal(formatIdentity({ id: 'u1' }), 'u1');
  assert.equal(formatIdentity(null), '');
});

test('Only_human_review_threads_are_summarised_and_long_first_comments_are_cut_at_200_characters', () => {
  const long = 'x'.repeat(THREAD_PREVIEW_CHARS + 50);
  const threads = [
    { id: 1, status: 1, comments: [{ content: 'Please rename this', commentType: 1 }] },
    { id: 2, status: 4, comments: [{ content: 'Ada voted 10', commentType: 2 }] },   // system thread
    { id: 3, status: 9, comments: [] },                                               // empty
    { id: 4, status: 2, comments: [{ content: long, commentType: 1 }] },
  ];
  const selected = selectReviewThreads(threads);
  assert.deepEqual(selected.map((t) => t.id), [1, 4]);
  const summary = summarizeThreads(selected);
  assert.equal(summary.split('\n')[0], '- Thread #1 [Active]: Please rename this');
  assert.equal(summary.split('\n')[1], `- Thread #4 [Fixed]: ${'x'.repeat(THREAD_PREVIEW_CHARS)}…`);
  assert.equal(summarizeThreads([{ id: 5, status: 42, comments: [{ content: 'c', commentType: 1 }] }]), '- Thread #5 [Unknown(42)]: c');
});

test('Work_item_details_render_every_present_field_and_strip_HTML_after_image_substitution', () => {
  const subs = new Map([['<img src="https://h/1.png">', '[image: .lgtm-attachments/img-001.png]']]);
  const text = renderWorkItemDetails({
    id: 9, type: 'Bug', title: 'Crash', state: 'Active', priority: 1, severity: '2 - High', tags: 'a; b',
    description: '<p>Steps<br><img src="https://h/1.png"></p>',
    reproSteps: '<ol><li>one</li></ol>',
    systemInfo: '',
    acceptanceCriteria: 'AC',
  }, { project: 'Alpha', repo: 'web' }, subs);
  assert.equal(text, [
    'Project: Alpha', 'Repo: web', 'ID: 9', 'Type: Bug', 'Title: Crash', 'State: Active',
    'Priority: 1', 'Severity: 2 - High', 'Tags: a; b',
    '', '### Description', 'Steps\n[image: .lgtm-attachments/img-001.png]',
    '', '### Repro Steps', 'one',
    '', '### Acceptance Criteria', 'AC',
  ].join('\n'));
});

test('The_PR_detail_prompt_layers_rules_then_PR_facts_then_the_task_with_short_branch_names', () => {
  const prompt = buildPrDetailPrompt({
    pr: { project: 'Alpha', repo: 'web', id: 7, title: 'T', createdBy: 'Ada', sourceBranch: 'refs/heads/feature/x', targetBranch: 'refs/heads/main', webUrl: 'https://u' },
    prDescription: '  desc  ',
    universalPrompt: 'UNIVERSAL',
    repoPrompt: 'REPO',
  });
  const lines = prompt.split('\n');
  assert.equal(lines[0], '# LGTM Review Rules');
  assert.ok(prompt.indexOf('# Repo-specific Rules\n\nREPO') > prompt.indexOf('UNIVERSAL'));
  assert.ok(prompt.includes('- PR ID: !7\n- Title: T\n- Author: Ada\n- Source branch: feature/x\n- Target branch: main\n- URL: https://u'));
  assert.ok(prompt.includes('## Description\n\ndesc'));
  assert.ok(prompt.includes('`git diff main...feature/x`'));
  assert.ok(!buildPrDetailPrompt({ pr: { project: 'A', repo: 'r', id: 1 }, prDescription: '', universalPrompt: '', repoPrompt: '' }).includes('# LGTM Review Rules'));
});

test('The_work_item_detail_prompt_prefers_fetched_details_over_the_list_row_and_omits_empty_sections', () => {
  const prompt = buildWorkItemDetailPrompt({
    workItem: { id: 3, type: 'Bug', project: 'Alpha', title: 'old title', webUrl: 'https://wi' },
    details: { id: 3, type: 'Bug', title: 'new title', state: 'New', description: '<b>why</b>', priority: null },
    repoInfo: { repo: 'web' },
    repoPrompt: '',
  });
  assert.ok(prompt.startsWith('# Bug #3\n'));
  assert.ok(prompt.includes('- Title: new title'));
  assert.ok(prompt.includes('- URL: https://wi'));
  assert.ok(prompt.includes('## Description\n\nwhy'));
  assert.ok(!prompt.includes('## Repro Steps'));
  assert.ok(!prompt.includes('- Priority'));
  assert.ok(!prompt.includes('# Repo-specific Rules'));
});
