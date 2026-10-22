import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DelegationContract, DelegationRole } from "../src/delegation-contract.ts";
import {
  chooseRole,
  admitDelegation,
  roleFromRequirements,
} from "../src/delegation-contract.ts";

/* A contract carries what a delegator promises before a worker spawns:
 * worker identity, objective, revision, unit of work, expected result,
 * read/write scope, capabilities, budget. Nothing here reaches the world:
 * it is a data shape, like every contract in this repository. */

/** A minimal valid contract, for the happy path. */
function baseContract(overrides: Partial<DelegationContract> = {}): DelegationContract {
  return {
    id: "d-1",
    workerId: "worker-alpha",
    objective: "fix the parser",
    revision: 3,
    task: { id: "t-1", subject: "parser", state: "asked" },
    expectedResult: "parser compiles on the target checkout",
    capabilities: [{ kind: "skill", name: "typescript" }],
    budget: { maxTokens: 4000, maxCostCents: 50 },
    readScope: ["src/parser.ts"],
    writeScope: ["src/parser.ts"],
    ...overrides,
  };
}

test("a contract with all required fields is a valid delegation", () => {
  const c = baseContract();
  assert.strictEqual(c.id, "d-1");
  assert.strictEqual(c.workerId, "worker-alpha");
  assert.strictEqual(c.objective, "fix the parser");
  assert.strictEqual(c.revision, 3);
  assert.strictEqual(c.task.id, "t-1");
  assert.strictEqual(c.expectedResult, "parser compiles on the target checkout");
  assert.deepStrictEqual(c.readScope, ["src/parser.ts"]);
  assert.deepStrictEqual(c.writeScope, ["src/parser.ts"]);
});

test("admitting a contract whose capabilities are all available succeeds", () => {
  const c = baseContract();
  const available = [{ kind: "skill", name: "typescript", version: "5.7", source: "registry" }];
  const result = admitDelegation(c, available);
  assert.strictEqual(result.admitted, true);
});

test("admitting a contract whose capabilities are missing is refused", () => {
  const c = baseContract();
  const available: { kind: string; name: string; version: string; source: string }[] = [];
  const result = admitDelegation(c, available);
  assert.strictEqual(result.admitted, false);
  assert.ok(result.refusal);
  assert.ok(typeof result.refusal === "string" && result.refusal.length > 0);
});

test("admitting a contract with an unknown capability kind is refused", () => {
  const c = baseContract({ capabilities: [{ kind: "mcp", name: "github" }] });
  const available: { kind: string; name: string; version: string; source: string }[] = [];
  const result = admitDelegation(c, available);
  assert.strictEqual(result.admitted, false);
  assert.ok(result.refusal);
});

/* Role choice: the delegator does not pick a role by hand. The scheduler
 * derives it from the capabilities the work needs. A skill means research,
 * a tool means build, anything else leaves the role unspecified (null). */

test("a skill requirement chooses research", () => {
  const requirements = [{ kind: "skill", name: "typescript" }];
  assert.strictEqual(roleFromRequirements(requirements), "research");
});

test("a tool requirement chooses build", () => {
  const requirements = [{ kind: "tool", name: "esbuild" }];
  assert.strictEqual(roleFromRequirements(requirements), "build");
});

test("no clear role returns null", () => {
  const requirements: { kind: string; name: string }[] = [];
  assert.strictEqual(roleFromRequirements(requirements), null);
});

/* DelegationRole is a closed union. */
const role: DelegationRole = "review";
assert.strictEqual(role, "review");
