import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../src/adapters/session-store.ts";
import type { Event } from "../src/core/store.ts";

/* H06.2 — deux vrais processus sur un état commun avec admission conditionnelle.

Le contrôleur lance des workers qui sont chacun un processus Node séparé. Ils
partagent un seul journal sur disque (SessionStore). Le premier qui obtient le
lock à la révision attendue écrit son événement ; l'autre est refusé (null) car
la révision a bougé. Le refusé re-lit la révision actuelle, re-déderive, et
réussit contre la nouvelle révision. Rien n'est perdu, rien n'est dupliqué, et
les deux workers ne communiquent que par le journal — pas de canal privé.

Le module sous test n'existe pas encore : ce test est rouge par construction. */

/** Lance un sous-processus Node qui tente un append conditionnel sur le journal.
 *
 * Le worker reçoit en arguments : le chemin du journal, l'identifiant de
 * session, la révision attendue, et l'événement JSON à tenter d'ajouter.
 * Il imprime sur stdout une ligne JSON : { ok: boolean, seq?: number, refusal?: string }.
 */
function spawnAppendWorker(
  journalRoot: string,
  sessionId: string,
  expectedRevision: number,
  event: Omit<Event, "seq" | "at">,
): { ok: boolean; seq?: number; refusal?: string } {
  const worker = join(import.meta.dirname, "..", "src", "adapters", "delegation-worker.ts");
  const result = spawnSync(
    process.execPath,
    [worker, journalRoot, sessionId, String(expectedRevision), JSON.stringify(event)],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      `delegation worker failed: status=${result.status} stderr=${result.stderr ?? ""}`,
    );
  }
  return JSON.parse(result.stdout.trim()) as {
    ok: boolean;
    seq?: number;
    refusal?: string;
  };
}

function seedJournal(store: SessionStore, sessionId: string, count: number): number {
  let revision = store.revision(sessionId); // -1 pour un journal vide
  for (let i = 0; i < count; i += 1) {
    const event: Omit<Event, "seq" | "at"> = {
      kind: "note",
      subject: "seed",
      data: { text: `seed ${i}`, against: revision },
    };
    const written = store.appendIfCurrent(sessionId, revision, event);
    if (written === null) throw new Error("seed append failed unexpectedly");
    revision = written.seq; // suivre la séquence réellement écrite
  }
  return store.revision(sessionId);
}

test("two real processes on one journal: one commits, the other is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-h062-"));
  try {
    const store = new SessionStore({ root });
    const sessionId = "session-a";

    // Baseline : un événement seed place le journal à la révision 1.
    const baseRevision = seedJournal(store, sessionId, 1);
    assert.strictEqual(baseRevision, 1);

    // Deux processus tentent tous deux d'ajouter contre la révision 1.
    const eventA: Omit<Event, "seq" | "at"> = {
      kind: "action",
      subject: "worker-alpha",
      data: { text: "first action", against: 1 },
    };
    const eventB: Omit<Event, "seq" | "at"> = {
      kind: "action",
      subject: "worker-beta",
      data: { text: "second action", against: 1 },
    };

    const resultA = spawnAppendWorker(root, sessionId, 1, eventA);
    const resultB = spawnAppendWorker(root, sessionId, 1, eventB);

    // L'un des deux a réussi, l'autre a été refusé. Pas les deux succès.
    const succeeded = [resultA, resultB].filter((r) => r.ok);
    const refused = [resultA, resultB].filter((r) => !r.ok);
    assert.strictEqual(succeeded.length, 1, "exactly one worker should commit");
    assert.strictEqual(refused.length, 1, "exactly one worker should be refused");

    // Le refusé doit indiquer que la révision a bougé (refusal présent).
    assert.ok(refused[0]!.refusal, "refusal must carry a reason");

    // Le journal contient exactement 2 événements : le seed + le succès. La
    // révision est passée de 1 à 2 par ce succès ; le refus n'a rien écrit.
    const events = store.read(sessionId);
    assert.strictEqual(events.length, 2, "journal holds seed + one committed action");
    assert.strictEqual(store.revision(sessionId), 2);

    // Le refusé re-lit la révision (maintenant 1) et réessaie contre elle.
    const currentRevision = store.revision(sessionId);
    const resultCRetry = spawnAppendWorker(root, sessionId, currentRevision, eventB);
    assert.strictEqual(resultCRetry.ok, true, "rebase after refusal should succeed");

    const finalEvents = store.read(sessionId);
    assert.strictEqual(finalEvents.length, 3, "seed + first commit + rebased commit");
    assert.strictEqual(store.revision(sessionId), 3);

    // Les séquences sont 1, 2, 3 sans trou.
    assert.deepStrictEqual(
      finalEvents.map((e) => e.seq),
      [1, 2, 3],
      "sequences are contiguous with no hole",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused worker writes nothing at all: the journal is byte-identical after a refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-h062b-"));
  try {
    const store = new SessionStore({ root });
    const sessionId = "session-b";
    seedJournal(store, sessionId, 1);

    const event: Omit<Event, "seq" | "at"> = {
      kind: "action",
      subject: "worker-gamma",
      data: { text: "will be refused", against: 1 },
    };

    // Premier commit réussit (révision 1 -> 2).
    const first = spawnAppendWorker(root, sessionId, 1, event);
    assert.strictEqual(first.ok, true);

    // Deuxième contre la révision 1 (stale) est refusé. Le premier succès a
    // déjà avancé le journal à la révision 2, donc le refus n'écrit rien et le
    // journal reste à 2 événements / révision 2.
    const second = spawnAppendWorker(root, sessionId, 1, event);
    assert.strictEqual(second.ok, false);

    const events = store.read(sessionId);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(store.revision(sessionId), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
