You are implementing an Azure DevOps work item.

**Context:**
- Organization: `{{ORG}}`
- Project: `{{PROJECT}}`
- Repository: `{{REPO}}`
- Work Item ID: `{{WORK_ITEM_ID}}`
- Base branch: `{{BASE_BRANCH}}`
- Working branch (already created): `{{BRANCH_NAME}}`

**Your task:**

1. Use `mcp__ado__wit_get_work_item` to fetch the work item's title, description, acceptance criteria, and any linked items.
2. Inspect the repository to understand the codebase. Read the README and relevant source before changing anything.
3. Implement the change on branch `{{BRANCH_NAME}}` (already checked out). Stay focused on the work item's stated scope; flag any out-of-scope concerns as comments rather than fixing them.
4. Add or update tests covering the new behavior. If tests don't exist for the affected area, follow the project's existing test conventions.
5. Run the project's verification commands (build, lint, test) to confirm your changes don't break anything. If you can't determine the right commands, say so and stop.
6. Commit your work with clear messages that reference the work item: `feat(WI-{{WORK_ITEM_ID}}): <summary>`.
7. Push the branch and open a pull request via `mcp__ado__repo_create_pull_request`. Title should include `WI-{{WORK_ITEM_ID}}`. Description should summarize the change and reference the work item.
8. Link the work item to the PR via `mcp__ado__wit_link_work_item_to_pull_request`.

**Style:**

- Make minimal, focused changes. Refactors that are not strictly necessary belong in a separate work item.
- Match the existing code style (indentation, naming, file organization).
- Do not commit secrets, generated files, or `.env` content.
- If the work item is ambiguous, post a question on the work item via `mcp__ado__wit_add_work_item_comment` and stop without committing speculative work.
