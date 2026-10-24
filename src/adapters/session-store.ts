/**
 * Adapter: the filesystem as the event log's home.
 *
 * The store in core is pure, so somebody has to own durability, and this is
 * that somebody. One file per session, one JSON event per line, appended and
 * never rewritten. The format is append-only text rather than a database
 * because a database choice here would be a decision made before any replay
 * measurement justifies it, and because an append-only log that is trivially
 * greppable is the one you can debug at 3am with a text editor.
 *
 * The write discipline: append a line, fsync the file descriptor, and only
 * then report success. A session that claims an event it did not persist is
 * worse than one that failed, because the gap is invisible until it matters.
 *
 * Everything else in this file exists because a file on disk can be wrong in
 * ways a value in memory cannot, and because the wrong answer this store used to
 * give was a *confident* one. It reported three durable events as a lost
 * session, it reported a dead process's refusal as a lost race, and it reported
 * a full disk as a journal that had moved. Each of those is a claim about the
 * world made on behalf of a machine that had no such claim to make.
 *
 * So the rule the whole file runs on is one the rest of this repository already
 * runs on, applied to bytes:
 *
 * ```text
 * a line that cannot be read is not a line that was never there
 * a journal is attested up to the first line that stops making sense
 * nothing past that point is claimed, including its absence
 * ```
 *
 * And the second rule, which is what makes a refusal answerable:
 *
 * ```text
 * a refusal that is not a conflict must be loud and must carry a reason
 * ```
 *
 * The two write paths keep their different meanings. `appendIfCurrent` is a
 * decision: it goes stale when the journal moves, it never waits, and null means
 * exactly one thing, which is "the journal is no longer where you read it". A
 * fact is not a judgement, so `appendFact` writes whatever the revision is now.
 * What a fact does *not* get is a sequence that collides with bytes nobody can
 * read, and that refusal names itself.
 *
 * The measurements behind all of it are in `docs/store-adversary.md`, including
 * the three that found nothing.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type { Event } from "../core/store.ts";

export interface SessionStoreOptions {
  /** Directory holding one file per session. Created if absent. */
  root: string;
}

/**
 * Why a write did not happen, for a caller that has to decide what to do next.
 *
 * The point of a reason is that a caller can branch on it. A caller that
 * receives a refusal has exactly three questions, and only one of them is a
 * conflict:
 *
 * ```text
 *   null                          the journal moved: re-read and decide again
 *   journal_damaged               this session can commit nothing, not a conflict
 *   write_refused                 the disk refused the bytes, not a conflict
 *   lock_unreleased               a lock outlived its writer and stayed, not a conflict
 * ```
 *
 * A caller that cannot tell these apart re-reads on a conflict that will never
 * clear, and waits. That is the failure this vocabulary removes.
 */
export type SessionStoreFailure = "journal_damaged" | "write_refused" | "lock_unreleased";

/**
 * A store failure, carrying the reason as a value rather than as prose.
 *
 * The message is for a human and the reason is for the code, because a message
 * that a program has to parse is a message that will be parsed wrongly one day.
 */
export class SessionStoreError extends Error {
  readonly reason: SessionStoreFailure;

  constructor(reason: SessionStoreFailure, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionStoreError";
    this.reason = reason;
  }
}

/**
 * Where a session file stopped being a log, and why.
 *
 * Nothing here is a guess about what the rest of the file contains. A line that
 * will not parse claims nothing, not even that it was an event. The two content
 * cases are separate because they mean different things to whoever has to
 * repair the file: `unreadable` at the last line is what a crash looks like,
 * and `out_of_sequence` is a duplicate, a hole or a rewrite, which no crash
 * produces on its own.
 */
export type JournalDamage =
  /** Bytes that are not an event. A torn write, or something that was never one. */
  | { readonly why: "unreadable"; readonly line: number; readonly linesAfter: number; readonly claims: null }
  /** An event that is not the next one: a duplicate, a hole, a reorder, no sequence. */
  | {
      readonly why: "out_of_sequence";
      readonly line: number;
      readonly linesAfter: number;
      readonly claims: number | null;
    }
  /** The file could not be read at all. No claim is made about what is in it. */
  | { readonly why: "unreadable_file"; readonly code: string };

/**
 * A session file, split into what it attests and where it stops attesting.
 *
 * `events` is a contiguous run of sequences, because a log whose sequences skip
 * is not a log a revision can be read from. The first line defines where the run
 * starts, so a journal restored from elsewhere is not damage by being numbered
 * from somewhere other than 1.
 */
export interface AttestedLog {
  readonly events: Event[];
  readonly damage: JournalDamage | null;
}

/** What a lock this store recognises is holding, and whether it still matters. */
export interface LockState {
  /** The lock file, named after the revision it was taken at. */
  readonly file: string;
  /** The revision the holder acquired at. It is in the name, so nobody is trusted. */
  readonly revision: number;
  /** Where the journal actually is, measured now. */
  readonly journalAt: number;
  /**
   * True once the journal is past `revision`, which is the only evidence anyone
   * needs and the only evidence available: a holder commits at most once per
   * acquisition, in revision + 1, so a lock left behind at that revision can
   * never be protecting a commit that has not happened yet.
   */
  readonly orphaned: boolean;
}

/**
 * How many times one acquisition reclaims an orphaned lock before refusing.
 *
 * Bounded because this is not a wait. The journal only moves one way, so the
 * orphan condition is monotone and the loop settles; the bound is there so that
 * a pathological interleaving of processes cannot turn a non waiting refusal
 * into a spin. Reaching it means the journal was already observed past the
 * revision, so the null it returns is a true statement rather than a shrug.
 */
const ORPHAN_RECLAIMS = 8;

/** The errno of a failed syscall, or undefined if it carried none. */
const errnoOf = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;

/**
 * What one journal file attests, read without touching anything else.
 *
 * The same reading `SessionStore.attest` gives, for a caller that must not
 * construct a store: the constructor creates its root, and a reader that
 * creates directories is not a reader. Opens the file for reading and nothing
 * more.
 */
export function attestJournal(file: string): AttestedLog {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = errnoOf(err);
    // A session that was never created is not damage. It is the honest
    // reading the rest of this class already gives an absent file.
    if (code === "ENOENT") return { events: [], damage: null };
    return { events: [], damage: { why: "unreadable_file", code: code ?? "unknown" } };
  }

  const rows = raw.split("\n").filter((line) => line.trim().length > 0);
  const events: Event[] = [];
  let lastSeq: number | undefined;
  for (const [index, row] of rows.entries()) {
    const linesAfter = rows.length - index - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
    } catch {
      return {
        events,
        damage: { why: "unreadable", line: index + 1, linesAfter, claims: null },
      };
    }
    const seq = (parsed as { seq?: unknown }).seq;
    if (typeof seq !== "number" || !Number.isInteger(seq)) {
      // Valid JSON that is not an event, or an event with no sequence. Either
      // way it names no position, so the run ends here rather than guessing
      // where the author meant it to be.
      return {
        events,
        damage: { why: "out_of_sequence", line: index + 1, linesAfter, claims: null },
      };
    }
    // The first line defines where the run starts; every line after it has to
    // be the next one. A duplicate and a hole are the same finding with a
    // different sign, and both mean the sequence a decision compared against
    // no longer names the line it named on disk.
    if (lastSeq !== undefined && seq !== lastSeq + 1) {
      return {
        events,
        damage: { why: "out_of_sequence", line: index + 1, linesAfter, claims: seq },
      };
    }
    events.push(parsed as Event);
    lastSeq = seq;
  }
  return { events, damage: null };
}

/** One file per session, so a corrupt session costs one session, not all. */
export class SessionStore {
  private readonly root: string;

  constructor(options: SessionStoreOptions) {
    this.root = options.root;
    mkdirSync(this.root, { recursive: true });
  }

  private path(sessionId: string): string {
    // A session id is used as a filename, so anything that could escape the
    // directory is rejected rather than sanitised: a name that does not look
    // like an id is a caller bug, and a rewritten path is how you lose a log.
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      throw new Error(`unsafe session id: ${JSON.stringify(sessionId)}`);
    }
    return join(this.root, `${sessionId}.jsonl`);
  }

  /**
   * The lock a decision at this revision contends on.
   *
   * The revision is in the name, and that is the whole of the fix for a leftover
   * lock. A lock whose name carries no revision blocks every writer that follows
   * it, including writers committing against a perfectly current read, and the
   * refusal it produces is for a revision that no longer exists. Putting the
   * revision in the name makes that impossible rather than unlikely: a lock at r
   * can only ever contend with a writer that wanted r.
   *
   * It stays a lock, not a lease. There is no PID in it, no expiry, no clock.
   */
  private lockPath(sessionId: string, revision: number): string {
    return `${this.path(sessionId)}.r${revision}.lock`;
  }

  /**
   * Everything a session file attests, and where it stops.
   *
   * This never throws about the contents of a file. A caller that asked for a
   * log has to be told when there is not one, and that is `read`. A caller that
   * asked what survived has to be given the part that did, and that is this.
   */
  attest(sessionId: string): AttestedLog {
    return attestJournal(this.path(sessionId));
  }

  /** The one place a damaged journal becomes an exception, with its reason. */
  private assertAttestable(sessionId: string): void {
    const { damage } = this.attest(sessionId);
    if (!damage) return;
    throw new SessionStoreError(
      "journal_damaged",
      `session ${sessionId} is not a journal: ${describe(damage)}. ` +
        "Nothing is claimed past that point, and nothing may be appended onto it.",
    );
  }

  /**
   * Append one fact durably. The store gives it its place.
   *
   * `seq` is not a parameter, and that is the whole point. Three call sites used
   * to compute `revision + 1` themselves, which made the sequence a value three
   * files agreed on rather than one the store owned. `chat.ts` still does, and
   * it is why the duplicate-sequence invariant could not be closed in the
   * adapter alone: locking the store fixed the store's own path and left the
   * surface's untouched.
   *
   * So the rule is now structural rather than conventional. A caller supplies a
   * fact; the store assigns its order. A caller that already holds a sequenced
   * event is replaying, not writing, and uses `replayAll`.
   *
   * Returns the stored event, so a caller that needs to know where its fact
   * landed can read it rather than having predicted it.
   */
  append(sessionId: string, event: Omit<Event, "seq">): Event {
    const stamped: Event = { ...event, seq: this.nextSeq(sessionId) } as Event;
    this.appendStamped(sessionId, stamped);
    return stamped;
  }

  /**
   * The sequence this fact will occupy, and nothing else decides.
   *
   * `revision + 1` for a journal that has events, and 1 for one that has none:
   * an empty journal sits at -1 because sequence 1 is the first event, so a plain
   * `revision + 1` would make the first event sequence 0. Three call sites had
   * that off-by-one independently at one point or another, which is what happens
   * when a value is recomputed instead of read from its owner.
   */
  nextSeq(sessionId: string): number {
    const at = this.revision(sessionId);
    return at < 0 ? 1 : at + 1;
  }

  /**
   * Write a sequence of already-sequenced events, in order.
   *
   * Replay is the one place a caller legitimately knows the order, because the
   * order comes from the log being replayed. Re-numbering would rewrite history,
   * so the sequences are preserved and a gap is an error rather than something
   * to paper over.
   */
  replayAll(sessionId: string, events: readonly Event[]): void {
    let expected = 1;
    for (const event of events) {
      if (event.seq !== expected) {
        throw new SessionStoreError(
          "journal_damaged",
          `replay into ${sessionId} expected sequence ${expected} and found ${event.seq}`,
        );
      }
      this.appendStamped(sessionId, event);
      expected += 1;
    }
  }

  /**
   * Write an event that already has its place in the history.
   *
   * Only for replay, where the sequence comes from the log being replayed and
   * inventing a new one would rewrite history. Nothing else should call it: a
   * live write that went through here would be a caller choosing its own order,
   * which is the defect this file now prevents.
   */
  private appendStamped(sessionId: string, event: Event): void {
    const file = this.path(sessionId);
    // Every write path funnels through here, so this is the one place that has
    // to know appending onto unattested bytes is unsafe: the new sequence would
    // equal one something behind the break already claims. It is the last
    // unguarded door, and closing it here closes it for the fact path, the
    // decision path and a raw append alike.
    this.assertAttestable(sessionId);
    const line = JSON.stringify(event) + "\n";
    const fd = openSync(file, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The revision on disk: the sequence of the last event in the file.
   *
   * `-1` for a session that does not exist, which is the honest value: there
   * was nothing to read, and a caller that read nothing must not claim to have
   * read revision 0.
   *
   * Throws for a journal that is not a journal, rather than returning a number
   * from a partial file. A revision read from three intact events out of four is
   * a claim about a log that does not exist, and a decision taken against it is
   * the exact failure P10 exists to prevent.
   */
  revision(sessionId: string): number {
    const events = this.read(sessionId);
    return events.length === 0 ? -1 : events[events.length - 1]!.seq;
  }

  /**
   * Append only if the file is still where the caller read it.
   *
   * Two surfaces in one process would be handled by the in-memory store. Two
   * *processes* share only the file, and reading it then appending is itself a
   * race: both could read 41, both could write 42, and the log would then hold
   * two events claiming the same sequence with one of them silently lost.
   *
   * So the check and the append happen under an exclusive lock file. Creating a
   * file with `wx` fails if it already exists, which the filesystem guarantees
   * atomically, and that is the only primitive here doing the work. It is not a
   * waiting lock: a second writer is told the state moved and goes away, which
   * is the right answer for a decision that was made against something else.
   *
   * Returns the event written, or null when the journal had moved. Null wrote
   * nothing at all, so the losing surface can re-read without having to undo.
   *
   * Null now means one thing and only that. It used to mean three: the journal
   * moved, a lock was held, and the disk said no. Two of those are not conflicts
   * and a caller cannot act on them by re-reading, so they leave as exceptions
   * with a `reason` instead. A refusal that a caller might report as an
   * observation of the world is the one thing this method must never produce.
   */
  appendIfCurrent(sessionId: string, expectedRevision: number, event: Event): Event | null {
    const lock = this.lockPath(sessionId, expectedRevision);
    const fd = this.acquire(sessionId, expectedRevision, lock);
    if (fd === null) return null;
    try {
      if (this.revision(sessionId) !== expectedRevision) return null;
      const stamped: Event = { ...event, seq: expectedRevision < 0 ? 1 : expectedRevision + 1 };
      this.appendStamped(sessionId, stamped);
      return stamped;
    } finally {
      closeSync(fd);
      this.release(lock);
    }
  }

  /**
   * Take the lock, or refuse without waiting.
   *
   * `EEXIST` is the only failure that means a writer is here. Every other errno
   * is the machine saying no, and it used to be folded into the same null as a
   * lost race, which turned a full disk into a story about the world that
   * re-reading could never disprove.
   *
   * An orphan is reclaimed rather than waited on, and the safety argument needs
   * no liveness at all. A lock naming r is stale once the journal is past r,
   * because the holder could only ever commit r+1, and a writer that needed r+1
   * has to pass `revision() === r`, which is false by then. Removing the file
   * therefore cannot let a second commit through at r+1: the recheck after
   * taking it is what refuses. The holder being alive is irrelevant, which is
   * the only reason this works at all.
   */
  private acquire(sessionId: string, expectedRevision: number, lock: string): number | null {
    for (let attempt = 0; attempt < ORPHAN_RECLAIMS; attempt += 1) {
      try {
        return openSync(lock, "wx");
      } catch (err) {
        if (errnoOf(err) !== "EEXIST") {
          throw new SessionStoreError(
            "write_refused",
            `could not take the session lock for ${sessionId} at revision ${expectedRevision}: ` +
              `${errnoOf(err) ?? "unknown"}. The disk refused; nothing is contending here.`,
            err,
          );
        }
        // A damaged journal cannot arbitrate anything, and saying so loudly
        // beats refusing for a reason the caller would read as a conflict.
        const journalAt = this.revision(sessionId);
        if (journalAt <= expectedRevision) return null;
        this.reclaim(lock);
      }
    }
    // Only reachable after observing a journal past this revision, so this null
    // is a true statement about the journal rather than an admission of defeat.
    return null;
  }

  /** Remove a lock the journal has already moved past. */
  private reclaim(lock: string): void {
    try {
      unlinkSync(lock);
    } catch (err) {
      // Somebody else got there first, which is the rule working, not a failure.
      if (errnoOf(err) === "ENOENT") return;
      throw new SessionStoreError(
        "lock_unreleased",
        `could not reclaim the orphaned session lock: ${lock}: ${errnoOf(err) ?? "unknown"}`,
        err,
      );
    }
  }

  /** Give the lock back, tolerating the case where the orphan rule took it. */
  private release(lock: string): void {
    try {
      unlinkSync(lock);
    } catch (err) {
      if (errnoOf(err) === "ENOENT") return;
      // A lock that cannot be removed is a lock that will refuse every future
      // writer. Better to fail loudly here than to strand the session quietly.
      throw new SessionStoreError(
        "lock_unreleased",
        `could not release the session lock: ${lock}: ${errnoOf(err) ?? "unknown"}`,
        err,
      );
    }
  }

  /**
   * What the lock at this revision is holding, and whether it still matters.
   *
   * A read, so it can be asked before writing as well as after a refusal. The
   * case it exists for is the one no derivation can settle: a holder that died
   * before it wrote anything leaves a lock naming the revision the journal is
   * still at, and `orphaned` is false because nothing moved. That is not a
   * conflict, and without this the only way a caller could tell is to guess. It
   * stays a guess here too, but now a guess with the two numbers next to it.
   */
  lockState(sessionId: string, atRevision: number): LockState | null {
    const file = this.lockPath(sessionId, atRevision);
    if (!existsSync(file)) return null;
    const journalAt = this.revision(sessionId);
    return { file, revision: atRevision, journalAt, orphaned: journalAt > atRevision };
  }

  /**
   * Append a fact someone observed, whatever the revision is now.
   *
   * This is the other half of `appendIfCurrent`, and the distinction falls out
   * of what the two events mean.
   *
   * A decision is a judgement about a state, so it goes stale when the state
   * moves: "approving was allowed at 41" stops being true at 42, and writing it
   * anyway would be acting on a state that no longer exists.
   *
   * A fact is not a judgement. A worker really did produce a result, and that
   * happened whether or not somebody else typed something in between. Refusing
   * to record it because the journal advanced would mean throwing away
   * evidence of the world on the grounds that we were busy, which is the same
   * mistake as the optimistic success this repository stopped making three
   * milestones ago.
   *
   * So the condition is asymmetric on purpose, and the only thing a fact shares
   * with a decision is that it is still sequenced at the current revision. One
   * log, one sequence, two rules about staleness.
   *
   * A damaged journal refuses a fact, and the reason it is not the staleness
   * rule is the point: there is no sequence left to give it that does not
   * collide with bytes nobody can read.
   */
  appendFact(sessionId: string, event: Omit<Event, "seq" | "at">): Event {
    const stamped: Event = { ...event, seq: this.nextSeq(sessionId), at: Date.now() };
    this.appendStamped(sessionId, stamped);
    return stamped;
  }

  /**
   * Every event for a session, in append order, or a loud failure.
   *
   * A missing session is empty. A damaged one is not empty and not partial: it
   * throws, because a caller that asked for every event and received three out
   * of four has been given a wrong answer to a question that had a right one.
   * `attest` is the same read for a caller that can use what survived.
   */
  read(sessionId: string): Event[] {
    const attested = this.attest(sessionId);
    if (attested.damage) {
      throw new SessionStoreError(
        "journal_damaged",
        `session ${sessionId} is not a journal: ${describe(attested.damage)}`,
      );
    }
    return attested.events;
  }

  /**
   * Every session on disk, newest first by last event timestamp.
   *
   * A damaged session is listed with the number of events that survived and
   * `damaged: true`, which is the pair a caller needs. The previous version
   * answered `events: -1` with the goal set to the string "(unreadable)", and
   * both halves of that were wrong: three durable events out of four were
   * reported as no events at all, and a literal was placed in a field whose
   * every other value is goal text, where a renderer would print it as one.
   */
  list(): Array<{ id: string; events: number; lastAt: number; goal: string; damaged: boolean }> {
    let files: string[];
    try {
      files = readdirSync(this.root).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const out: Array<{ id: string; events: number; lastAt: number; goal: string; damaged: boolean }> = [];
    for (const file of files) {
      const id = file.replace(/\.jsonl$/, "");
      let events: Event[] = [];
      let damaged = false;
      try {
        const attested = this.attest(id);
        events = attested.events;
        damaged = attested.damage !== null;
      } catch {
        // Only reachable for a file on disk whose name is not a session id, which
        // no public call can create. The session exists and nothing is claimed
        // from it, which is what the row then says.
        damaged = true;
      }
      const goal = events.find((e) => e.kind === "goal");
      const lastAt = events.length > 0 ? events[events.length - 1]!.at : 0;
      out.push({
        id,
        events: events.length,
        lastAt,
        goal: goal ? String((goal.data as { text?: unknown }).text ?? "") : "",
        damaged,
      });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /** Rehydrate a core store from disk, replaying every persisted event. */
  restore(sessionId: string, now: () => number): { events: Event[] } {
    const events = this.read(sessionId);
    return { events };
  }

  /** Start a fresh log, refusing to clobber an existing one. */
  create(sessionId: string, seed: Event[]): void {
    const file = this.path(sessionId);
    if (existsSync(file)) {
      throw new Error(`session ${sessionId} already exists; refusing to overwrite`);
    }
    // An empty session still gets a file. Without this, a session created with
    // no events leaves nothing on disk, the clobber guard never fires, and the
    // second create silently succeeds and destroys the first one's identity.
    const fd = openSync(file, "a");
    closeSync(fd);
    // A seed is a history being replayed, so its sequences are preserved rather
    // than re-derived. `replayAll` checks them instead of trusting them.
    this.replayAll(sessionId, seed);
  }
}

/** One line about what stopped being a log, for a message a human will read. */
const describe = (damage: JournalDamage): string => {
  switch (damage.why) {
    case "unreadable":
      return `line ${damage.line} is not an event, and ${damage.linesAfter} line(s) follow it`;
    case "out_of_sequence":
      return damage.claims === null
        ? `line ${damage.line} names no sequence, and ${damage.linesAfter} line(s) follow it`
        : `line ${damage.line} claims sequence ${damage.claims}, which is not the next one, ` +
          `and ${damage.linesAfter} line(s) follow it`;
    case "unreadable_file":
      return `the file could not be read (${damage.code})`;
  }
};
