# Linear Chain Topology (A→B→C)

A **linear chain** is the simplest stacked topology: a fixed sequence of stages
where each stage depends on the one before it. Work flows in a single direction,
`A → B → C`, with no branching, fan-out, or feedback loops.

```
A ──▶ B ──▶ C
```

## How it works

- **A** runs first and produces an output that becomes the input to **B**.
- **B** builds on A's result and hands its output to **C**.
- **C** is the terminal stage; its output is the result of the chain.

Each link is "stacked" on the previous one: a stage cannot start until its
predecessor has completed successfully.

## Characteristics

- **Ordering:** strictly sequential — exactly one stage is active at a time.
- **Dependencies:** each stage depends only on its immediate predecessor.
- **Failure handling:** if a stage fails, downstream stages do not run, so
  failures are contained to the point at which they occur.
- **Determinism:** the single path makes execution easy to reason about,
  reproduce, and debug.

## When to use it

Use a linear chain when tasks have a natural step-by-step order and each step
consumes the previous step's output — for example, a build → test → deploy
pipeline. It is not a good fit when stages are independent (prefer parallel
fan-out) or when later stages must feed information back to earlier ones
(prefer a cyclic or graph topology).
