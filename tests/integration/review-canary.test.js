'use strict';
/**
 * The integration canary: the exact wiring the app ships for a PR review,
 * in-process, with only the two things we cannot have in a test replaced
 * by fakes at the network edge: Azure DevOps (an http server speaking the
 * SDK's protocol) and the agent CLI (a child process reading the prompt
 * on stdin and printing a report). Everything between them is real:
 * DevOpsClient on the real SDK, RepoCloner on real git against a real
 * bare repo, PromptResolver, ScenarioPrompts from resources/prompts,
 * prompt-attachments, AgentRunner.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AgentRunner } = require('../../src/main/agent-runner');
const { DevOpsClient } = require('../../src/main/devops-client');
const { RepoCloner } = require('../../src/main/repo-cloner');
const { PromptResolver } = require('../../src/main/prompt-resolver');
const { MemoryStore, startFakeAdo, adoPr, hasGit, makeBareRepo, tempDir, collectNotify, fakeRegistry, realScenarioPrompts } = require('../helpers/fakes');

const gitless = hasGit() ? false : 'git is not installed on this machine';
const cleanups = [];
after(async () => { for (const c of cleanups) await c(); });

test('A_PR_review_runs_end_to_end_cloning_then_running_then_completed_with_the_report_parsed_and_the_PAT_kept_out_of_argv_and_output', { skip: gitless }, async () => {
  const PAT = 'canary-pat-0123456789';
  const repo = makeBareRepo({ promptBody: 'Repo rule: be kind.' });
  cleanups.push(() => repo.remove());

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ado = await startFakeAdo({
    pat: PAT,
    projects: [{ id: 'p-alpha', name: 'Alpha' }],
    repos: { Alpha: [{ id: 'r-web', name: 'web' }] },
    prs: {
      'r-web': [adoPr({
        id: 7, title: 'Add feature', repoId: 'r-web', repoName: 'web', project: 'Alpha',
        created: '2026-03-01T00:00:00Z', source: `refs/heads/${repo.featureBranch}`, target: 'refs/heads/main',
        reviewers: [{ vote: 0 }],
        description: '<p>Adds the thing.<br><img src="http://127.0.0.1:PORT/_apis/wit/attachments/9?fileName=shot.png" alt="screen"><img src="https://i.imgur.com/leak.png"></p>',
      })],
    },
    threads: { 7: [{ id: 11, status: 1, comments: [{ content: 'Rename this please', commentType: 1, author: { displayName: 'Bob' } }] }] },
    attachments: { '/_apis/wit/attachments/9': { contentType: 'image/png', body: png } },
  });
  cleanups.push(() => ado.close());
  const saveLog = console.log; const saveWarn = console.warn; const saveErr = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  cleanups.push(() => { console.log = saveLog; console.warn = saveWarn; console.error = saveErr; });

  const client = new DevOpsClient(PAT, ado.orgUrl);
  // The description's image URL points at this very server, whose port is
  // only known now: patch the placeholder as the PR body comes off the wire.
  const original = client.getPullRequest.bind(client);
  client.getPullRequest = async (...args) => {
    const full = await original(...args);
    return { ...full, description: full.description.replace('PORT', String(ado.port)) };
  };

  const tmp = tempDir('lgtm-canary-');
  const cloner = new RepoCloner(PAT, ado.orgUrl, { cloneUrlFor: () => repo.url, tmpDir: tmp, log: () => {} });
  const config = new MemoryStore({ repoConfigs: {}, promptPath: '' });
  const notify = collectNotify();
  const registry = fakeRegistry({ mode: 'ok' });
  const runner = new AgentRunner(config, {
    notify,
    registry,
    scenarioPrompts: realScenarioPrompts(),
    promptResolver: new PromptResolver(config),
    createCloner: () => cloner,
    createDevopsClient: () => client,
    cleanupDelayMs: 0,
  });
  runner.setCredentials(PAT, ado.orgUrl);
  runner.setIdentity(await client.getMe());

  const prs = await client.getAllOpenPRs();
  assert.equal(prs.length, 1);
  const pr = prs[0];
  const key = 'Alpha/web/7';

  assert.deepEqual(await runner.startReview(pr, 'claude', 'claude-opus-4-6', 'review'), { success: true });
  const final = await notify.waitForStatus(key, 'completed', 30000);

  // Status flow and report.
  assert.deepEqual(notify.statuses(key).filter((s, i, a) => a.indexOf(s) === i), ['cloning', 'running', 'completed']);
  assert.equal(final.reportStatus, 'parsed');
  assert.deepEqual(final.report, { pr_id: 7, comments_posted: 1, summary: 'fake review' });

  // The prompt the agent actually received.
  const detail = runner.getReviewDetail(key);
  const prompt = detail.prompt;
  assert.ok(prompt.startsWith(runner.scenarioPrompts.getPreamble('claude')), 'claude preamble first');
  assert.match(prompt, /^PR_ID: 7$/m);
  assert.match(prompt, new RegExp(`^PR_URL: ${ado.orgUrl}/Alpha/_git/web/pullrequest/7$`, 'm'));
  assert.match(prompt, /^SOURCE_BRANCH: feature\/x$/m);
  assert.match(prompt, /^TARGET_BRANCH: main$/m);
  assert.match(prompt, /^REVIEWER_IDENTITY: Test User \(user-1\)$/m);
  assert.match(prompt, new RegExp(`^REPO_PATH: ${detail.clonePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.ok(prompt.includes('## LGTM Project Rules'), 'universal rules from resources/');
  assert.ok(prompt.includes('## Project-Specific Rules\nRepo rule: be kind.'), 'the repo prompt discovered in the clone');
  assert.equal(detail.promptSource, 'discovered');
  assert.match(prompt, /## PR Description\nAdds the thing\.\n\[image: \.lgtm-attachments\/img-001-[0-9a-f]{8}\.png — "screen"\]/);
  assert.match(prompt, /## Attached Images[\s\S]*- `\.lgtm-attachments\/img-001-[0-9a-f]{8}\.png` — "screen"/);
  assert.ok(prompt.includes('## Pre-fetched Existing Review Threads\n- Thread #11 [Active]: Rename this please'));
  assert.ok(!prompt.includes(PAT), 'the PAT is not in the prompt');

  // The PAT reached the agent through the environment and nowhere else.
  const output = detail.output;
  assert.match(output, /AZURE_DEVOPS_PAT present: yes/);
  assert.match(output, /NODE_OPTIONS present: no/);
  assert.ok(!output.includes(PAT), 'the PAT is not in the output');
  assert.ok(!registry.buildCommand('claude').args.some((a) => a.includes(PAT)), 'the PAT is not in argv');
  assert.match(output, /prompt chars: \d{3,}/);

  // Only the org-hosted image was fetched, with the PAT; imgur was never contacted.
  const attachmentCalls = ado.requests.filter((r) => r.url.includes('/attachments/9'));
  assert.equal(attachmentCalls.length, 1);
  assert.equal(attachmentCalls[0].headers.authorization, `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`);
  assert.ok(!ado.requests.some((r) => r.url.includes('imgur')));

  // The clone (and the attachments inside it) are gone once the run finished.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(detail.clonePath), false, 'clone removed');
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.ok(!fs.existsSync(path.join(detail.clonePath, '.lgtm-attachments')));
});
