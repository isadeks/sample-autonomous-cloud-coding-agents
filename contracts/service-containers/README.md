# Service-container config parity fixtures

Golden `(service_containers) → errors` cases shared by the two validators of the
RepoTable `service_containers` field (docs/design/COMPUTE.md, "Service containers"):

- **CLI (TypeScript):** [`cli/test/service-containers.test.ts`](../../cli/test/service-containers.test.ts)
  runs each case through `validateServiceContainers` in `cli/src/service-containers.ts`
  (`bgagent repo onboard --service-containers`, so a typo fails at onboarding).
- **CDK (TypeScript):** [`cdk/test/handlers/shared/ecs-service-containers.test.ts`](../../cdk/test/handlers/shared/ecs-service-containers.test.ts)
  runs the same cases through `validateServiceContainers` in
  `cdk/src/handlers/shared/ecs-service-containers.ts` (the orchestrator, at task start,
  because a row can be hand-edited).

The packages cannot import each other, so the rules are written twice; this corpus is
how a drift between them fails a test. Each case lists `valid: true`, or the substrings
the error messages must contain.
