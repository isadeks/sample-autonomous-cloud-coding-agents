---
title: Adr 024 github pr comment trigger lambda
---

# ADR-024: GitHub PR-comment trigger runs on the webhook task Lambda

**Status:** proposed
**Date:** 2026-10-15

Per the [ADR lifecycle](/sample-autonomous-cloud-coding-agents/architecture/readme#lifecycle), this decision remains proposed while its implementing PR is in review.

## Context

`@bgagent <instruction>` comments on ABCA pull requests start a `coding/pr-iteration-v1` task (see [Repository onboarding — GitHub PR-comment trigger](/sample-autonomous-cloud-coding-agents/architecture/repo-onboarding#github-pr-comment-trigger)). The GitHub webhook receiver verifies the HMAC, filters and dedups the comment, and hands it to a Lambda that resolves the pull request, applies the trust checks and calls `createTaskCore`.

`createTaskCore` needs the same environment and grants as the task API's create path: task, events, repo and budget tables, the orchestrator invoke, the input guardrail and Cognito group lookup. A dedicated Lambda adds a function, a role and a policy, and the `lambda-microvm` deployment profile is already at the 490-resource ceiling enforced by [ADR-023](/sample-autonomous-cloud-coding-agents/architecture/adr-023-cloudformation-stack-boundaries).

## Decision

1. Serve the trigger from the existing `WebhookCreateTaskFn`, which already holds exactly the `createTaskCore` grants. Its handler dispatches asynchronous invocations from the GitHub receiver to `github-comment-task.ts`; API Gateway requests keep their existing path.
2. Grant that Lambda read access to the platform GitHub token secret (needed to resolve the PR, check the commenter's permission and reply) and allow only the GitHub receiver to invoke it directly.
3. Pass the receiver's already-decided fields to the trigger rather than the raw webhook body.

## Consequences

- No new stack resources; every deployment profile stays within budget.
- The webhook ingest Lambda can now read the GitHub token. Its public surface is unchanged (API Gateway still requires the webhook authorizer), but a compromise of that function now also exposes the token. Moving the trigger to its own function becomes the preferred option once stack boundaries (#852) free resource headroom.
