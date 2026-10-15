# Task prompts

Use one job per prompt. Keep detailed requirements and acceptance tests in a
task-specific spec file, then reference its path and section. Keep data-safety
rules and edge cases explicit; remove repeated background and standing rules
already in `AGENTS.md`. These templates are optional, not startup instructions.

## Implement

> Implement [spec path, section]. Scope: [platforms and boundaries]. Preserve
> [important existing behaviour]. Complete its acceptance tests. Report what
> changed, checks, limitations and a short phone checklist; then stop.

## Review only

> Review [prompt/spec/diff] for [specific concerns]. Do not edit files. Report
> actionable issues by severity with evidence and suggested corrections.

## Audit code

> Audit [commit range/files] against [spec section]. Do not change production
> code. Check implementation and tests, especially [data-loss cases]. Report
> reproducible findings with file/line references and missing coverage.

## Fix findings

> Fix [finding IDs or findings-file section]. Preserve unrelated changes. Add
> regression coverage for the failures, run required checks, and report results.
> [Commit the fixes / Leave changes uncommitted.]

## Resume

> Continue [task/spec section]. Inspect the current diff and existing results;
> finish outstanding work without repeating completed checks on unchanged code.

Replace brackets with concrete details. For an independent job, a fresh thread
with the spec path avoids carrying unrelated discussion. For unfinished work,
continue its thread or supply a short handoff: objective, changes, checks and
remaining work. Specify whether to commit or build when relevant.

This separation of short standing rules and task-specific context follows
[OpenAI's guidance on lean instructions](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
