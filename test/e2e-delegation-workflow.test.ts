import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStore } from "../src/core/store.ts";
import { runAgentLoop } from "../src/core/loop.ts";
import { WorkspaceToolRunner } from "../src/adapters/workspace-tool-runner.ts";
import { DeterministicCodingModel } from "./fixtures/deterministic-coding-model.ts";
import { capture } from "../src/adapters/artifact-capture.ts";
import { runAgainstArtifact } from "../src/adapters/artifact-verifier.ts";

/**
 * End-to-end: a real development task flows through Cuesheet end to end.
 *
 * 1. A workspace with a buggy file (the task's raw material).
 * 2. An in-memory event log — the single source of truth.
 * 3. A deterministic model adapter (no provider key, no network) — proves
 *    model-agnosticism: the same loop works with any adapter.
 * 4. A workspace-bounded tool runner (list_files, read_file, write_file).
 * 5. runAgentLoop: observe, compile, infer, act, append, repeat.
 * 6. Capture: freeze the workspace, content-addressed.
 * 7. Verify: run the repository's own tests against the capture only.
 * 8. Report: intent, outcome, evidence, artifact, verdict.
 *
 * No provider credential is required. Swap the adapter for OpenRouter or
 * Anthropic and the same loop, runner, capture and verifier apply.
 */

test("end-to-end: task → delegate → execute → capture → verify → report", async () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-e2e-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });

    // 1. A workspace with a buggy file: add returns a - b instead of a + b.
    writeFileSync(
      join(workspace, "math.js"),
      `function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n`,
      "utf8",
    );

    // 2. The event log — pure, in memory, append-only.
    const store = new EventStore("e2e-session", () => Date.now());

    // 3. Tools: one workspace, bounded verbs, no shell, no credentials.
    const tools = new WorkspaceToolRunner({ workspace, outputBytes: 4000 });

    // 4. Model: deterministic, one known fix. Injects in place of a provider.
    const model = new DeterministicCodingModel({
      path: "math.js",
      contents: `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`,
      goalContains: "fix",
    });

    // 5. Run the loop. Events are streamed to a collector for observability.
    const events: Array<{ kind: string; data: unknown }> = [];
    const outcome = await runAgentLoop(store, model, tools, {
      subject: "builder",
      goal: "fix the add function in math.js so it returns a + b",
      maxSteps: 5,
      onEvent: (e) => events.push(e),
    });

    // 6. The loop produced events: goal, action, observation(s).
    assert.ok(events.length > 0, "the loop produced at least one event");
    const writeActions = events.filter(
      (e) => e.kind === "action" && e.data.tool === "write_file",
    );
    assert.strictEqual(
      writeActions.length,
      1,
      "exactly one write_file action was executed",
    );
    const writeAction = writeActions[0]!;
    assert.strictEqual(writeAction.data.input.path, "math.js");

    // 7. The workspace now has the corrected file.
    const corrected = readFileSync(join(workspace, "math.js"), "utf8");
    assert.ok(
      corrected.includes("return a + b;"),
      "the add function now returns a + b",
    );

    // 8. Capture: freeze the workspace once, content-addressed.
    const artifact = capture({
      sessionId: "e2e-session",
      effectId: "E1",
      workspace,
      root: join(root, "artifacts"),
    });
    assert.ok(artifact.artifactId.startsWith("A-"), "content-addressed id");
    assert.ok(artifact.covers.includes("math.js"), "capture covers the file");
    assert.strictEqual(
      artifact.producerEffectId,
      "E1",
      "artifact names its producer",
    );

    // 9. Verify independently against the capture only — never the live
    //    workspace, so a later vandalism cannot move the verdict.
    const verification = runAgainstArtifact({
      artifact,
      command: process.execPath,
      args: [
        "-e",
        "const m = require('./math.js'); process.exit(m.add(2, 3) === 5 ? 0 : 1)",
        "math.js",
      ],
      verificationId: "verify-e1",
    });
    assert.strictEqual(verification.verdict, "VERIFIED", "independent check passes");
    assert.ok(
      verification.evidence.some((e) => e.kind === "target_digest"),
      "evidence names the artifact evaluated",
    );

    // 10. The execution report: intent, outcome, evidence, artifact, verdict.
    const report = {
      goal: "fix the add function in math.js so it returns a + b",
      outcome: outcome.stop,
      evidenceCount: outcome.session.evidence.length,
      artifactId: artifact.artifactId,
      verdict: verification.verdict,
    };
    assert.strictEqual(report.verdict, "VERIFIED");
    assert.ok(typeof report.outcome === "object");
    assert.ok(report.evidenceCount >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a model that proposes nothing still produces an honest report", async () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-e2e-null-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(workspace, "math.js"),
      `function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n`,
      "utf8",
    );

    const store = new EventStore("e2e-null-session", () => Date.now());
    const tools = new WorkspaceToolRunner({ workspace });

    // A model that refuses to act: no tool calls, just text.
    const silentModel: DeterministicCodingModel = new DeterministicCodingModel({
      path: "math.js",
      contents: `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`,
      goalContains: "zzz-nothing-matches-this",
    });

    const events: Array<{ kind: string }> = [];
    const outcome = await runAgentLoop(store, silentModel, tools, {
      subject: "builder",
      goal: "fix the add function",
      maxSteps: 2,
      onEvent: (e) => events.push(e),
    });

    // No file was written — the model did nothing, and the log shows it.
    const writeActions = events.filter(
      (e) => e.kind === "action" && e.data.tool === "write_file",
    );
    assert.strictEqual(writeActions.length, 0, "no write happened");

    // The loop stopped because the budget ran out, not because work succeeded.
    assert.strictEqual(outcome.stop.reason, "budget-exhausted");

    // Capturing and verifying still works: the artifact holds the buggy file,
    // so the independent check rejects it. The producer's silence is not
    // mistaken for success.
    const artifact = capture({
      sessionId: "e2e-null-session",
      effectId: "E2",
      workspace,
      root: join(root, "artifacts"),
    });
    const verification = runAgainstArtifact({
      artifact,
      command: process.execPath,
      args: [
        "-e",
        "const m = require('./math.js'); process.exit(m.add(2, 3) === 5 ? 0 : 1)",
        "math.js",
      ],
      verificationId: "verify-e2",
    });
    assert.strictEqual(
      verification.verdict,
      "REJECTED",
      "a silent producer is rejected, not verified",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
