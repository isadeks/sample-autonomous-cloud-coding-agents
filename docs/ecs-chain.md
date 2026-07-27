# ECS Chain

This document describes the ECS chain and will be expanded with further details as the design evolves.

The ECS chain describes how ABCA agent tasks are executed as isolated workloads on AWS Elastic Container Service (ECS) with the Fargate launch type. Each submitted coding task is dispatched to a dedicated Fargate task that runs the bundled agent runtime in its own network- and filesystem-isolated environment, sized according to the configurable task-size defaults or per-task overrides. This isolation ensures that concurrent agent runs cannot interfere with one another, that resource limits are enforced per task, and that the orchestrator can reliably track each container's lifecycle from launch through completion.
