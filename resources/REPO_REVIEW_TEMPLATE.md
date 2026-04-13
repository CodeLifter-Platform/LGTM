# Project-Specific Review Prompt
#
# Place this file in your repo as one of:
#   .lgtm/review-prompt.md
#   .github/pr-review-prompt.md
#   PR_REVIEW_PROMPT.md
#   NYLE_PR_PROMPT.md
#
# LGTM will auto-detect it and append it to the universal review rules.
# Everything below is injected AFTER the LGTM core review prompt, so
# severity levels, comment format, and re-review rules are already defined.
# Use this file for project-specific context and rules.

## Project Context

<!-- Describe your project so the reviewer understands the domain -->
- **Project:** [Your project name]
- **Stack:** [e.g., .NET 8, React 18, SQL Server, Azure Service Bus]
- **Architecture:** [e.g., Clean Architecture with CQRS, microservices, monolith]
- **Key patterns:** [e.g., MediatR handlers, repository pattern, event sourcing]

## Project-Specific Review Rules

<!-- Add rules that apply to YOUR codebase -->

### Always flag as [CRITICAL]
<!-- Things that are critical in your project specifically -->
- Example: Direct database access outside of repository classes
- Example: Missing audit logging on any endpoint that modifies financial data
- Example: Any use of `DateTime.Now` instead of `IDateTimeProvider`

### Always flag as [MAJOR]
<!-- Things that are important in your project -->
- Example: Missing input validation on public API endpoints
- Example: Not using the standard `Result<T>` pattern for service returns
- Example: Raw SQL without parameterized queries

### Never flag (ignore these)
<!-- Things the reviewer should not comment on -->
- Example: We use tabs not spaces — this is enforced by EditorConfig
- Example: Regions (`#region`) are used intentionally in this codebase
- Example: `var` vs explicit types — we allow both per developer preference

## Domain-Specific Terminology

<!-- Help the reviewer understand your business domain -->
<!-- e.g.:
- "Commodity" = a tradeable financial instrument (not a physical good)
- "Position" = the net exposure to a commodity
- "Blotter" = a real-time view of trades
-->

## File/Folder Conventions

<!-- Describe where things go -->
<!-- e.g.:
- `src/Domain/` — entities, value objects, domain events (no dependencies)
- `src/Application/` — use cases, MediatR handlers, DTOs
- `src/Infrastructure/` — EF Core, external API clients, message bus
- `tests/` — mirrors `src/` structure, one test class per production class
-->

## Testing Requirements

<!-- What level of testing do you expect? -->
<!-- e.g.:
- All new MediatR handlers must have at least one happy-path integration test
- Domain entities must have unit tests for all business rule methods
- We do NOT require tests for simple CRUD endpoints
-->
