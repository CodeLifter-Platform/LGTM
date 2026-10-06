#!/usr/bin/env node
'use strict';
/**
 * A stand-in for an agent CLI (claude / auggie / codex). Behaves exactly
 * like the real ones at the process boundary LGTM cares about: reads the
 * whole prompt from stdin, streams some output, prints a fenced JSON
 * report, exits with a code.
 *
 *   --mode ok        print a report (from --report, else a pr-review one) and exit 0
 *   --mode garbage   print prose with no JSON block, exit 0
 *   --mode fail      print to stderr, exit 3
 *   --mode hang      ignore SIGTERM and stay alive until SIGKILL
 *   --mode slow      like ok, after a 400ms pause
 *   --report <json>  the report object to print in the fence
 *
 * It never prints the value of any env var; it only says whether the PAT
 * variables were present, so a test can prove the PAT reached the agent's
 * environment without the PAT ever appearing in the output stream.
 */

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
};
const mode = flag('--mode', 'ok');
const reportJson = flag('--report', null);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => run());
// If stdin is not piped at all, still run.
if (process.stdin.isTTY) run();

function report() {
  if (reportJson) return JSON.parse(reportJson);
  const m = prompt.match(/^PR_ID:\s*(\S+)/m);
  return { pr_id: m ? Number(m[1]) : 0, comments_posted: 1, summary: 'fake review' };
}

function run() {
  const hasPat = !!process.env.AZURE_DEVOPS_PAT;
  process.stdout.write(`[fake-agent] prompt chars: ${prompt.length}\n`);
  process.stdout.write(`[fake-agent] cwd: ${process.cwd()}\n`);
  process.stdout.write(`[fake-agent] AZURE_DEVOPS_PAT present: ${hasPat ? 'yes' : 'no'}\n`);
  process.stdout.write(`[fake-agent] NODE_OPTIONS present: ${process.env.NODE_OPTIONS ? 'yes' : 'no'}\n`);

  switch (mode) {
    case 'garbage':
      process.stdout.write('I looked at the code and it seems fine. No JSON for you.\n');
      process.exit(0);
      break;
    case 'fail':
      process.stderr.write('[fake-agent] simulated crash: API key missing\n');
      process.exit(3);
      break;
    case 'hang':
      process.on('SIGTERM', () => { process.stdout.write('[fake-agent] ignoring SIGTERM\n'); });
      process.stdout.write('[fake-agent] hanging\n');
      setInterval(() => {}, 1000);
      break;
    case 'slow':
      setTimeout(finish, 400);
      break;
    default:
      finish();
  }
}

function finish() {
  process.stdout.write('Review complete. Final report:\n');
  process.stdout.write('```json\n' + JSON.stringify(report(), null, 2) + '\n```\n');
  process.stdout.write('Done.\n');
  process.exit(0);
}
