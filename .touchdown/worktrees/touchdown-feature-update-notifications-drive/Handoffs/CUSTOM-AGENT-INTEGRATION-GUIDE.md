# Integration Task: Wire Scenario Prompts into the Orchestrator

You are working on an existing local CLI orchestrator that monitors Azure DevOps and dispatches sub-agents (Claude Code, AugmentCode, Codex) to handle three scenarios. The orchestrator is mostly built. Your task is to integrate four prompt files plus this usage guide into the existing codebase so the orchestrator loads them at runtime and passes them to sub-agents correctly.

**You are not redesigning the orchestrator.** Match its existing structure, conventions, and patterns. If something here conflicts with how the existing code does things, follow the existing code and flag the conflict in your final summary rather than refactoring.

## Files Provided

You are receiving five markdown files alongside this prompt:

- `00-agent-preambles.md` — short per-agent runtime instructions (one block per supported agent: Claude Code, AugmentCode, Codex)
- `01-pr-review.md` — Scenario 1 prompt: review an unreviewed PR
- `02-resolve-comments.md` — Scenario 2 prompt: resolve review comments on the user's own PR
- `03-implement-ticket.md` — Scenario 3 prompt: implement a bug or feature from an unattached work item
- This file — the usage guide

Read all four prompt files end-to-end before writing any integration code. Each declares a `## Context` section listing the variables the orchestrator must inject, and a `## Final Report Format` section specifying the JSON schema the sub-agent will emit.

## What You're Building

Three things, in order:

### 1. Place the prompt files where the orchestrator can load them

Put `00-agent-preambles.md` and the three scenario files in the location the existing app expects to load prompts from. If there is no such location yet, create a `prompts/` directory at a sensible spot in the project (e.g., alongside the binary, or in a resources/assets folder following the runtime's conventions) and load from there. The path should be configurable but have a sane default.

The files are loaded verbatim at dispatch time. Do not embed them as string constants in source code, do not preprocess them, do not template them at build time.

### 2. Compose the final prompt at dispatch time

For each dispatch, the orchestrator builds the final prompt the sub-agent receives by concatenating three pieces in this order:

```
<selected agent's preamble block from 00-agent-preambles.md>

<full scenario prompt content for the matched scenario>

## Injected Context
<key>: <value>
<key>: <value>
...
```

Specifics:

- **Agent preamble selection.** `00-agent-preambles.md` contains three labeled sections (`## Claude Code`, `## AugmentCode`, `## Codex`). Parse the file once at startup, extract the three blocks, and select the one matching the configured agent for this dispatch. If the configured agent has no matching section, fail fast with a clear error — don't fall back silently.
- **Scenario prompt content.** Pass the file content verbatim. No paraphrasing, no trimming, no variable substitution inside the prompt body. The prompt declares its required variables; you supply them in the injected context block, not by editing the prompt.
- **Injected context block.** Render it as a simple `key: value` list (one per line) under the `## Injected Context` heading. Each scenario prompt's `## Context` section enumerates the variables you must populate. Populate every variable that section declares — missing variables is a defect, not an optional optimization. Use absolute paths for any path-shaped variable (e.g., `REPO_PATH`).

### 3. Parse the final report from sub-agent output

Each scenario prompt ends with a `## Final Report Format` section showing a JSON schema. The sub-agent emits this as the last fenced JSON block in its output. Add (or extend) parsing logic to:

- Locate the **last** valid JSON object in the sub-agent's stdout. Be tolerant of trailing whitespace, log lines, or commentary after the report.
- Validate it against the schema for the dispatched scenario (the three schemas differ — Scenario 1 has `comments_posted`, Scenario 2 has `threads_processed`, Scenario 3 has `outcome` and `pr_id`).
- Record the parsed report in whatever run-history store the orchestrator already uses.
- On parse failure, do not crash the orchestrator. Mark the run as `report_unparseable`, preserve the raw log, and continue.

## Required Variables Per Scenario

Quick reference — the source of truth is each prompt's `## Context` section. Verify against the files.

**Scenario 1 (`01-pr-review.md`):**
`PR_ID`, `PR_URL`, `REPO_PATH`, `TARGET_BRANCH`, `SOURCE_BRANCH`, `REVIEWER_IDENTITY`

**Scenario 2 (`02-resolve-comments.md`):**
`PR_ID`, `PR_URL`, `REPO_PATH`, `SOURCE_BRANCH`, `TARGET_BRANCH`, `AUTHOR_IDENTITY`

**Scenario 3 (`03-implement-ticket.md`):**
`WORK_ITEM_ID`, `WORK_ITEM_URL`, `WORK_ITEM_TYPE`, `REPO_PATH`, `DEFAULT_BRANCH`, `AUTHOR_IDENTITY`

If the existing orchestrator already has plumbing that produces some of these (e.g., it computes `SOURCE_BRANCH` for other reasons), reuse it rather than re-deriving.

## Hard Constraints

- **The four prompt files are read-only inputs.** Do not modify them. Do not split them into smaller files. Do not generate them from templates. If you believe a prompt has a bug, surface it in your final summary; do not edit.
- **No prompt content embedded in source.** Loaded from disk at runtime, every dispatch. The orchestrator must not break if the prompts are updated without a recompile.
- **Verbatim pass-through.** No paraphrasing or summarizing of the scenario prompt or preamble before sending to the sub-agent.
- **Match the existing app's conventions.** File layout, error handling style, logging, config schema — follow what's already there. If you must add a new dependency, keep it minimal and consistent with the existing dependency style.
- **Fail fast on missing prompts.** If a prompt file is absent or unreadable at startup, the orchestrator should error out clearly at startup, not silently at dispatch time.

## Stop Conditions

You are done when:

1. The four files are placed in the correct location for the existing app to load them.
2. The orchestrator composes the three-part prompt (preamble + scenario + injected context) correctly at dispatch time, with all required variables populated for each scenario.
3. The orchestrator parses the final JSON report from sub-agent output and records it.
4. Existing tests still pass; new code paths have at least minimal coverage matching the project's existing test conventions.
5. You have produced a short summary noting any conflicts you found between this guide and the existing codebase, and any decisions you made that the user should be aware of.

## What Not to Do

- Do not redesign the orchestrator's CLI, config, or run-history schema.
- Do not add ADO write logic to the orchestrator. The sub-agents handle all ADO mutations via their SDK from inside the workspace.
- Do not add detection or scheduling logic — that already exists.
- Do not "improve" the prompts. They are tuned; small edits have non-obvious effects on sub-agent behavior.
- Do not collapse the three scenario prompts into one parameterized template. They are intentionally separate for prompt-quality reasons.
