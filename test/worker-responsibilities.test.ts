import { strict as assert } from "node:assert";
import { test } from "node:test";

import { projectWorkerResponsibilities, describeWorkerView, type WorkerView } from "../src/adapters/worker-responsibilities.ts";
import type { Event } from "../src/core/store.ts";

function now(): number { return Date.now(); }

function effectRequested(
  seq: number,
  effectId: string,
  subject: string,
  affordance: string = "go",
  revision: number | null = null,
  at: number = now(),
): Event {
  return {
    seq, at, kind: "effect_requested", subject,
    data: { effect: "SpawnAgent", effectId, affordance, reads: {}, revision },
  };
}

function effectObserved(
  seq: number,
  effectId: string,
  outcome: "succeeded" | "failed",
  at: number = now(),
): Event {
  return {
    seq, at, kind: "effect_observed", subject: effectId,
    data: { effectId, outcome },
  };
}

function modelUsage(
  seq: number,
  requestId: string,
  provider: string,
  model: string | null,
  phase: "started" | "observed",
  inputTokens: number | null = null,
  outputTokens: number | null = null,
  at: number = now(),
): Event {
  return {
    seq, at, kind: "note", subject: "model.usage",
    data: { version: 1, phase, requestId, provider, model,
      ...(phase === "observed" ? { inputTokens, outputTokens, cacheCreationInputTokens: null, cacheReadInputTokens: null } : {}) },
  };
}

test("an effect request makes its worker visible with a requested responsibility", () => {
  const events: Event[] = [effectRequested(1, "E1", "worker-alpha", "go", null, 1)];
  const projection = projectWorkerResponsibilities(events);
  assert.strictEqual(projection.workers.length, 1);
  const w = projection.workers[0]!;
  assert.strictEqual(w.subject, "worker-alpha");
  assert.strictEqual(w.responsibilities.length, 1);
  assert.strictEqual(w.responsibilities[0]!.effectId, "E1");
  assert.strictEqual(w.responsibilities[0]!.phase, "requested");
  assert.strictEqual(w.busy, true);
});

test("an observed effect makes the responsibility settled and the worker not busy", () => {
  const events: Event[] = [
    effectRequested(1, "E1", "worker-alpha", "go", null, 1),
    effectObserved(2, "E1", "succeeded", 2),
  ];
  const projection = projectWorkerResponsibilities(events);
  const w = projection.workers[0]!;
  assert.strictEqual(w.responsibilities[0]!.phase, "settled");
  assert.strictEqual(w.busy, false);
});

test("consumption is attributed to the worker via requestId matching effectId", () => {
  const events: Event[] = [
    effectRequested(1, "E1", "worker-alpha", "go", null, 1),
    modelUsage(2, "E1", "anthropic", "claude-3", "started", null, null, 2),
    modelUsage(3, "E1", "anthropic", "claude-3", "observed", 100, 50, 3),
  ];
  const projection = projectWorkerResponsibilities(events);
  const w = projection.workers[0]!;
  assert.strictEqual(w.consumption.inputTokens, 100);
  assert.strictEqual(w.consumption.outputTokens, 50);
  assert.strictEqual(w.consumption.requestCount, 1);
  assert.strictEqual(w.consumption.pendingCount, 0);
});

test("a pending usage receipt counts as pending", () => {
  const events: Event[] = [
    effectRequested(1, "E1", "worker-alpha", "go", null, 1),
    modelUsage(2, "E1", "anthropic", "claude-3", "started", null, null, 2),
  ];
  const projection = projectWorkerResponsibilities(events);
  const w = projection.workers[0]!;
  assert.strictEqual(w.consumption.pendingCount, 1);
  assert.strictEqual(w.consumption.requestCount, 1);
});

test("two workers are tracked independently", () => {
  const events: Event[] = [
    effectRequested(1, "E1", "worker-alpha", "go", null, 1),
    effectRequested(2, "E2", "worker-beta", "go", null, 2),
    effectObserved(3, "E1", "succeeded", 3),
  ];
  const projection = projectWorkerResponsibilities(events);
  assert.strictEqual(projection.workers.length, 2);
  const alpha = projection.workers.find((w) => w.subject === "worker-alpha")!;
  const beta = projection.workers.find((w) => w.subject === "worker-beta")!;
  assert.strictEqual(alpha.busy, false);
  assert.strictEqual(beta.busy, true);
  assert.strictEqual(alpha.responsibilities[0]!.phase, "settled");
  assert.strictEqual(beta.responsibilities[0]!.phase, "requested");
});

test("totals aggregate across workers", () => {
  const events: Event[] = [
    effectRequested(1, "E1", "worker-alpha", "go", null, 1),
    modelUsage(2, "E1", "anthropic", "claude-3", "observed", 100, 50, 2),
    effectRequested(3, "E2", "worker-beta", "go", null, 3),
    modelUsage(4, "E2", "anthropic", "claude-3", "observed", 200, 75, 4),
  ];
  const projection = projectWorkerResponsibilities(events);
  assert.strictEqual(projection.totalInputTokens, 300);
  assert.strictEqual(projection.totalOutputTokens, 125);
});

test("the projection is pure: same events, same result", () => {
  const events: Event[] = [
    effectRequested(1, "E1", "worker-alpha", "go", null, 1),
    effectObserved(2, "E1", "succeeded", 2),
  ];
  const first = projectWorkerResponsibilities(events);
  const second = projectWorkerResponsibilities(events);
  assert.deepStrictEqual(first, second);
});

test("an empty log projects no workers and zero totals", () => {
  const projection = projectWorkerResponsibilities([]);
  assert.strictEqual(projection.workers.length, 0);
  assert.strictEqual(projection.totalInputTokens, 0);
  assert.strictEqual(projection.totalOutputTokens, 0);
});

test("describeWorkerView renders a one-line summary without inventing data", () => {
  const events: Event[] = [
    effectRequested(1, "E1", "worker-alpha", "go", null, 1),
    modelUsage(2, "E1", "anthropic", "claude-3", "observed", 100, 50, 2),
  ];
  const w = projectWorkerResponsibilities(events).workers[0]!;
  const line = describeWorkerView(w);
  assert.ok(line.includes("worker-alpha"));
  assert.ok(line.includes("100"));
  assert.ok(line.includes("50"));
});
