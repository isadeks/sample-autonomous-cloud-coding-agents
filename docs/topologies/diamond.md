# Diamond Topology (Fan-Out / Fan-In)

A **diamond** topology splits work from a single starting stage into two or more
independent branches that run in parallel, then joins those branches back into a
single terminal stage. The shape is named for the diamond drawn by the fan-out
from **A** and the fan-in to **D**.

```
      ┌──▶ B ──┐
A ──▶┤        ├──▶ D
      └──▶ C ──┘
```

## How it works

- **A** runs first (the *fan-out* point) and produces an output that becomes the
  input to every branch.
- **B** and **C** run **independently and in parallel**, each building on A's
  result. Neither depends on the other.
- **D** is the *fan-in* point: it cannot start until **all** of its upstream
  branches (**B** and **C**) have completed successfully. It combines their
  outputs into the final result of the topology.

## Characteristics

- **Ordering:** partially ordered — A precedes the branches, the branches
  precede D, but B and C have no ordering relative to each other.
- **Concurrency:** the middle branches can execute simultaneously, so the
  topology finishes faster than running the same work sequentially.
- **Dependencies:** D depends on every branch; a missing or failed branch
  blocks the join.
- **Failure handling:** if any branch fails, the fan-in stage does not run.
  Failures in one branch do not affect sibling branches already in flight, but
  they do prevent the diamond from completing.
- **Synchronization:** D acts as a barrier — it waits for the slowest branch
  (the critical path determines total duration).

## When to use it

Use a diamond when a single input can be processed along several independent
paths whose results must later be merged — for example, running unit tests and
integration tests in parallel after a build, then producing a combined report.
It is a good fit when the branches are genuinely independent and you want to
exploit parallelism, but still need a single consolidated result.

Avoid it when the branches actually depend on one another (that ordering is a
[linear chain](./linear-chain.md), where exactly one stage is active at a time)
or when there is no natural join point for the parallel work.

## Relationship to the linear chain

The diamond generalizes the [linear chain](./linear-chain.md) `A → B → C`. A
linear chain is strictly sequential with a single active stage at any moment; a
diamond relaxes that constraint by letting the middle stages run concurrently
before re-converging. If you collapse a diamond's parallel branches down to a
single branch, you get back a linear chain.
