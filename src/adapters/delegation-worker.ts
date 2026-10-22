/**
 * Adapter: a single delegation worker process.
 *
 * Invoked from the command line with four arguments:
 *
 *   <journalRoot> <sessionId> <expectedRevision> <eventJson>
 *
 * It attempts one `appendIfCurrent` against the shared journal and prints one
 * JSON line to stdout:
 *
 *   { ok: true, seq: number }            the event was appended
 *   { ok: false, refusal: string }        the journal had moved; nothing written
 *
 * The worker knows nothing about other workers. It reads the journal, judges
 * against the revision it was handed, and writes at most once. The lock file
 * in `SessionStore` is what keeps two concurrent workers from both succeeding
 * against the same revision.
 *
 * This is a process boundary: nothing here is shared in memory with the
 * controller or with any other worker. Two workers communicate only through
 * the journal on disk.
 *
 * The module body runs nothing on import (LOAD-01 / LOAD-03 import every
 * module under `src`). The work only happens when this file is the entry
 * point, guarded by `import.meta.url` below.
 */

import { SessionStore } from "./session-store.ts";
import type { Event } from "../core/store.ts";

function run(args: string[]): { ok: boolean; seq?: number; refusal?: string } | never {
  const [journalRoot, sessionId, expectedRevisionText, eventJson] = args;

  if (!journalRoot || !sessionId || expectedRevisionText === undefined || !eventJson) {
    console.error(
      "usage: delegation-worker.ts <journalRoot> <sessionId> <expectedRevision> <eventJson>",
    );
    process.exit(2);
  }

  const expectedRevision = Number(expectedRevisionText);
  if (!Number.isFinite(expectedRevision)) {
    console.error(`invalid expectedRevision: ${JSON.stringify(expectedRevisionText)}`);
    process.exit(2);
  }

  let event: Omit<Event, "seq" | "at">;
  try {
    event = JSON.parse(eventJson) as Omit<Event, "seq" | "at">;
  } catch (cause) {
    console.error(
      `invalid event JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    process.exit(2);
  }

  const store = new SessionStore({ root: journalRoot });

  const current = store.revision(sessionId);
  if (current !== expectedRevision) {
    return {
      ok: false,
      refusal: `journal moved: expected revision ${expectedRevision}, is ${current}`,
    };
  }

  const written = store.appendIfCurrent(sessionId, expectedRevision, event);
  if (written === null) {
    return {
      ok: false,
      refusal: `append refused: journal no longer at revision ${expectedRevision}`,
    };
  }

  return { ok: true, seq: written.seq };
}

// Only run when this file is the entry point, never on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exit(0);
}
