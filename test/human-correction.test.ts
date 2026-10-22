import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { SessionStore } from "../src/adapters/session-store.ts";
import { effectRequested, effectStatuses } from "../src/effects.ts";
import type { Event } from "../src/core/store.ts";

/* H06.4 — correction humaine, rebase, remplacement après crash.

Scénario 1 — rebase : un worker lit la révision R, une directive humaine
avance l'état à R+1, le worker tente de committer contre R → refusé (null),
il re-lit, re-déirve contre R+1, et committe avec succès. Rien n'est perdu.

Scénario 2 — remplacement après crash : un worker lance un effet, meurt
avant d'écrire un reçu. Un autre worker lit le journal, voit l'effet en
état `requested` sans observation, et peut reprendre. L'effet n'est ni
succès ni échec : il est `requested` (unobserved), et l'intention
survit.

Les modules sous test n'existent pas encore : ce test est rouge par
construction. */

/** Lance un processus qui tente un append conditionnel, puis imprime le résultat JSON. */
function spawnAppendWorker(
  journalRoot: string,
  sessionId: string,
  expectedRevision: number,
  event: Omit<Event, "seq" | "at">,
): { ok: boolean; seq?: number; refusal?: string } {
  const worker = join(
    import.meta.dirname,
    "..",
    "src",
    "adapters",
    "delegation-worker.ts",
  );
  const result = spawnSync(process.execPath, [
    worker,
    journalRoot,
    sessionId,
    String(expectedRevision),
    JSON.stringify(event),
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      `delegation worker failed: status=${result.status} stderr=${result.stderr ?? ""}`,
    );
  }
  return JSON.parse(result.stdout.trim()) as { ok: boolean; seq?: number; refusal?: string };
}

/** Événement "directive humaine" qui avance l'état de la session. */
function humanDirective(
  sessionId: string,
  text: string,
  against: number,
): Omit<Event, "seq" | "at"> {
  return {
    kind: "directive",
    subject: sessionId,
    data: { text, against },
  };
}

test("a human correction bumps the revision: stale commit refused, worker rebases and commits", () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-h064-"));
  try {
    const store = new SessionStore({ root });
    const sessionId = "session-rebase";

    // Baseline : une intention est staged à la révision 1.
    const goalEvent: Omit<Event, "seq" | "at"> = {
      kind: "goal",
      subject: sessionId,
      data: { text: "fix the parser", staged: false },
    };
    const written = store.appendIfCurrent(sessionId, -1, goalEvent);
    assert.ok(written !== null, "goal append should succeed");
    assert.strictEqual(store.revision(sessionId), 1);

    // Un worker lit la révision 1 et prépare une action contre elle.
    const actionEvent: Omit<Event, "seq" | "at"> = {
      kind: "action",
      subject: "worker-alpha",
      data: { text: "edit parser.ts", against: 1 },
    };

    // Entre-temps, une directive humaine arrive et avance l'état à la révision 2.
    const directive = humanDirective(sessionId, "stop, focus Spotlight instead", 1);
    const directiveWritten = store.appendIfCurrent(sessionId, 1, directive);
    assert.ok(directiveWritten !== null, "directive append should succeed");
    assert.strictEqual(store.revision(sessionId), 2);

    // Le worker tente de committer contre la révision 1 (stale) : refusé.
    const refused = spawnAppendWorker(root, sessionId, 1, actionEvent);
    assert.strictEqual(refused.ok, false, "stale commit must be refused");
    assert.ok(refused.refusal, "refusal must carry a reason");
    assert.strictEqual(store.revision(sessionId), 2, "revision unchanged after refusal");

    // Le worker re-lit la révision (maintenant 2) et re-déirve contre elle.
    const rebased = spawnAppendWorker(root, sessionId, 2, actionEvent);
    assert.strictEqual(rebased.ok, true, "rebased commit should succeed");
    assert.strictEqual(rebased.seq, 3, "rebased commit lands at sequence 3");
    assert.strictEqual(store.revision(sessionId), 3);

    // Le journal contient : goal(1), directive(2), action-rebased(3). Pas de trou.
    const events = store.read(sessionId);
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(events.map((e) => e.seq), [1, 2, 3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an effect requested but never observed survives a crash", () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-h064b-"));
  try {
    const store = new SessionStore({ root });
    const sessionId = "session-crash";

    // Un effet est demandé (EffectRequested E42) et écrit dans le journal.
    const requestEvent = effectRequested({
      id: "E42",
      effect: "SpawnAgent",
      subject: sessionId,
      affordance: "go",
      reads: { staged: "known" },
      revision: 0,
    });
    store.appendIfCurrent(sessionId, -1, requestEvent);
    assert.strictEqual(store.revision(sessionId), 1);

    // Le worker meurt avant d'écrire un reçu. Le journal ne contient que la
    // demande, aucune observation. L'effet est `requested` (unobserved).
    const statuses = effectStatuses(store.read(sessionId));
    const status = statuses.get("E42");
    assert.ok(status, "effect E42 should be recorded");
    if (status && status.status === "requested") {
      assert.strictEqual(status.request.id, "E42");
    } else {
      assert.fail(`effect E42 should be "requested", got ${JSON.stringify(status)}`);
    }

    // Un autre worker lit le journal et voit l'effet en attente, sans avoir
    // besoin du transcript du premier worker.
    const events = store.read(sessionId);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.kind, "effect_requested");
    assert.strictEqual(events[0]!.data.effectId, "E42");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
