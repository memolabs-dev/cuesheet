import { strict as assert } from "node:assert";
import { test } from "node:test";

import { derive, emptySurface, type Control } from "../apps/terminal/src/app/state.ts";

test("consumed control projects cumulative consumption to the surface", () => {
  let state = emptySurface;
  state = derive(state, {
    type: "consumed",
    inputTokens: 1200,
    outputTokens: 300,
    requests: 4,
    costCents: 8,
  });
  assert.ok(state.consumption);
  assert.strictEqual(state.consumption.inputTokens, 1200);
  assert.strictEqual(state.consumption.outputTokens, 300);
  assert.strictEqual(state.consumption.requests, 4);
  assert.strictEqual(state.consumption.costCents, 8);
});

test("consumed replaces rather than accumulates, so the surface shows the latest", () => {
  let state = emptySurface;
  state = derive(state, { type: "consumed", inputTokens: 100, outputTokens: 50, requests: 1, costCents: 1 });
  state = derive(state, { type: "consumed", inputTokens: 200, outputTokens: 100, requests: 2, costCents: 3 });
  assert.ok(state.consumption);
  assert.strictEqual(state.consumption.inputTokens, 200);
  assert.strictEqual(state.consumption.outputTokens, 100);
  assert.strictEqual(state.consumption.requests, 2);
  assert.strictEqual(state.consumption.costCents, 3);
});

test("empty surface has no consumption", () => {
  assert.strictEqual(emptySurface.consumption, undefined);
});

test("other controls do not touch consumption", () => {
  let state = derive(emptySurface, {
    type: "consumed",
    inputTokens: 500,
    outputTokens: 250,
    requests: 2,
    costCents: 4,
  });
  state = derive(state, { type: "compose", text: "fix the add function" });
  assert.ok(state.consumption);
  assert.strictEqual(state.consumption.inputTokens, 500);
  assert.strictEqual(state.composer, "fix the add function");
});
