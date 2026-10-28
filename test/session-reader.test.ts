/**
 * `cuesheet sessions --format json`: the session listing other programs read.
 *
 * Memo Orbit shows a project's sessions, and it reads them through this command
 * and nothing else. So the tests here are about the three things a reader
 * outside this repository is promised:
 *
 * - the listing writes nothing, proved on a store it cannot write to;
 * - both stores appear, empty and damaged logs included, never hidden;
 * - the shape is the one the README documents, at `"version": 1`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { listSessions, sessionRoots, SESSION_LISTING_VERSION } from "../src/adapters/session-reader.ts";
import { terminalSessionRoot } from "../src/adapters/terminal-session.ts";

const ROOT = process.cwd();
const ENTRY = join(ROOT, "src", "cuesheet.ts");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const T0 = Date.parse("2026-10-01T08:00:00.000Z");
const HOUR = 3_600_000;

const line = (seq: number, at: number, kind: string, subject: string, data: Record<string, unknown>) =>
  JSON.stringify({ seq, at, kind, subject, data }) + "\n";

/** A home holding both stores, laid out the way their writers lay them out. */
function fixtureHome(): { home: string; runs: string; terminal: string } {
  const home = mkdtempSync(join(tmpdir(), "cuesheet-reader-"));
  const runs = join(home, ".cuesheet", "sessions");
  const terminal = join(home, ".local", "state", "cuesheet", "terminal", "sessions");
  mkdirSync(runs, { recursive: true });
  mkdirSync(terminal, { recursive: true });

  // run and chat
  writeFileSync(join(runs, "chat-empty.jsonl"), "");
  writeFileSync(
    join(runs, "run-closed.jsonl"),
    line(1, T0, "goal", "builder", { text: "ship" }) + line(2, T0 + HOUR, "evidence", "builder", { claim: "done", backing: "test" }),
  );
  writeFileSync(join(runs, "ses_open.jsonl"), line(1, T0 + 2 * HOUR, "goal", "builder", { text: "open" }));
  writeFileSync(join(runs, "chat-damaged.jsonl"), line(1, T0, "note", "chat", {}) + "{not json\n");
  // noise a reader must not list
  writeFileSync(join(runs, "chat-gone.jsonl.trash"), "");
  writeFileSync(join(runs, "run-closed.jsonl.r2.lock"), "");

  // terminal
  const meta = (id: string, cwd: string, createdAt: number) =>
    writeFileSync(join(terminal, `${id}.meta.json`), JSON.stringify({ version: 1, id, cwd, createdAt }));
  meta("t-atlas", "/srv/work/atlas", T0 + 3 * HOUR);
  writeFileSync(join(terminal, "t-atlas.jsonl"), line(1, T0 + 3 * HOUR, "goal", "terminal", { text: "fix" }));
  writeFileSync(join(terminal, "t-atlas.view.jsonl"), line(1, T0 + 5 * HOUR, "note", "terminal.view", { control: {} }));
  writeFileSync(join(terminal, "t-atlas.writer-1-abc.lock"), "");
  meta("t-sibling", "/srv/work/atlas-other", T0 - 48 * HOUR);
  writeFileSync(join(terminal, "t-sibling.jsonl"), "");
  writeFileSync(join(terminal, "t-sibling.view.jsonl"), "");
  writeFileSync(join(terminal, "t-orphan.jsonl"), "");
  return { home, runs, terminal };
}

/** Run the installed dispatcher with nothing from this machine's environment. */
function cli(home: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [ENTRY, "sessions", ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra },
  });
}

/** Every path under a directory with what a write would change about it. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      out[relative(dir, p)] = `${s.isDirectory() ? "d" : "f"} ${s.size} ${s.mtimeMs} ${s.mode}`;
      if (s.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function setMode(dir: string, dirs: number, files: number) {
  chmodSync(dir, dirs);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) setMode(p, dirs, files);
    else chmodSync(p, files);
  }
}

describe("cuesheet sessions --format json writes nothing", () => {
  it("reads a read-only store and leaves every file and directory as it was", () => {
    const { home } = fixtureHome();
    try {
      const before = snapshot(home);
      setMode(home, 0o555, 0o444);
      const locked = snapshot(home);
      const r = cli(home, ["--format", "json"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(snapshot(home), locked, "the listing created, removed or changed something");
      assert.equal(JSON.parse(r.stdout).sessions.length, 7);
      setMode(home, 0o755, 0o644);
      assert.deepEqual(Object.keys(snapshot(home)), Object.keys(before));
    } finally {
      setMode(home, 0o755, 0o644);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an absent store is reported absent, not created", () => {
    const home = mkdtempSync(join(tmpdir(), "cuesheet-reader-empty-"));
    try {
      const r = cli(home, ["--format", "json"]);
      assert.equal(r.status, 0, r.stderr);
      const listing = JSON.parse(r.stdout);
      assert.deepEqual(listing.stores.map((s: { state: string }) => s.state), ["absent", "absent"]);
      assert.deepEqual(listing.sessions, []);
      assert.deepEqual(readdirSync(home), [], "the listing created a directory in an empty home");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the text listing does not create the store either", () => {
    const home = mkdtempSync(join(tmpdir(), "cuesheet-reader-text-"));
    try {
      const r = cli(home, []);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /no sessions yet/);
      assert.deepEqual(readdirSync(home), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cuesheet sessions --format json lists both stores", () => {
  const { home, runs, terminal } = fixtureHome();
  const r = cli(home, ["--format", "json"]);
  const listing = JSON.parse(r.stdout);
  const byId = Object.fromEntries(listing.sessions.map((s: { id: string }) => [s.id, s]));
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));

  it("is version 1 and names each store it read", () => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(listing.version, 1);
    assert.deepEqual(listing.stores, [
      { kinds: ["run", "chat"], path: runs, state: "read", error: null },
      { kinds: ["terminal"], path: terminal, state: "read", error: null },
    ]);
    assert.deepEqual(listing.filters, { since: null, cwd: null });
  });

  it("lists every session once, and nothing that is not one", () => {
    assert.deepEqual(Object.keys(byId).sort(), [
      "chat-damaged",
      "chat-empty",
      "run-closed",
      "ses_open",
      "t-atlas",
      "t-orphan",
      "t-sibling",
    ]);
  });

  it("an empty log is listed with zero events", () => {
    const empty = byId["chat-empty"];
    assert.equal(empty.kind, "chat");
    assert.equal(empty.events, 0);
    assert.equal(empty.lastEventAt, null);
    assert.match(empty.createdAt, ISO, "an empty log is dated by its file");
    assert.equal(empty.status, null);
  });

  it("status is the fold's goal state", () => {
    assert.equal(byId["run-closed"].status, "closed");
    assert.equal(byId["run-closed"].kind, "run");
    assert.equal(byId["run-closed"].events, 2);
    assert.equal(byId["run-closed"].createdAt, new Date(T0).toISOString());
    assert.equal(byId["run-closed"].lastEventAt, new Date(T0 + HOUR).toISOString());
    assert.equal(byId["ses_open"].status, "open");
    assert.equal(byId["t-atlas"].status, "open");
  });

  it("damage is reported with what survived, never as an empty log", () => {
    assert.deepEqual(byId["chat-damaged"].damage, { why: "unreadable", line: 2 });
    assert.equal(byId["chat-damaged"].events, 1);
    assert.deepEqual(byId["t-orphan"].damage, { why: "metadata_missing", line: null });
    assert.equal(byId["t-atlas"].damage, null);
  });

  it("a terminal session carries its cwd, and its conversation dates its last activity", () => {
    const atlas = byId["t-atlas"];
    assert.equal(atlas.kind, "terminal");
    assert.equal(atlas.cwd, "/srv/work/atlas");
    assert.equal(atlas.createdAt, new Date(T0 + 3 * HOUR).toISOString());
    assert.equal(atlas.lastEventAt, new Date(T0 + 5 * HOUR).toISOString());
    assert.equal(atlas.file, join(terminal, "t-atlas.jsonl"));
    assert.equal(byId["run-closed"].cwd, null, "run journals record no cwd, so none is claimed");
  });

  it("is sorted by last activity, most recent first", () => {
    const activity = listing.sessions.map((s: { lastEventAt: string | null; createdAt: string }) =>
      Date.parse(s.lastEventAt ?? s.createdAt),
    );
    assert.deepEqual(activity, [...activity].sort((a, b) => b - a));
    const ids = listing.sessions.map((s: { id: string }) => s.id);
    assert.ok(ids.indexOf("t-atlas") < ids.indexOf("ses_open"));
  });
});

describe("cuesheet sessions filters", () => {
  it("--cwd matches a directory and what is inside it, not a sibling sharing its prefix", () => {
    const { home } = fixtureHome();
    try {
      const r = cli(home, ["--format", "json", "--cwd", "/srv/work/atlas/"]);
      assert.equal(r.status, 0, r.stderr);
      const listing = JSON.parse(r.stdout);
      assert.equal(listing.filters.cwd, "/srv/work/atlas");
      assert.deepEqual(listing.sessions.map((s: { id: string }) => s.id), ["t-atlas"]);
      const parent = JSON.parse(cli(home, ["--format", "json", "--cwd", "/srv/work"]).stdout);
      assert.deepEqual(parent.sessions.map((s: { id: string }) => s.id).sort(), ["t-atlas", "t-sibling"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--since keeps sessions active at or after the instant", () => {
    const { home } = fixtureHome();
    try {
      const since = new Date(T0 + 2 * HOUR).toISOString();
      const r = cli(home, ["--format", "json", "--since", since]);
      assert.equal(r.status, 0, r.stderr);
      const listing = JSON.parse(r.stdout);
      assert.equal(listing.filters.since, since);
      const ids = listing.sessions.map((s: { id: string }) => s.id);
      // Empty logs are dated by their file, which this test has just created.
      assert.deepEqual(ids.sort(), ["chat-empty", "ses_open", "t-atlas", "t-orphan"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a date it cannot read, and filters without --format json", () => {
    const home = mkdtempSync(join(tmpdir(), "cuesheet-reader-flags-"));
    try {
      assert.equal(cli(home, ["--format", "json", "--since", "yesterday"]).status, 2);
      assert.equal(cli(home, ["--format", "yaml"]).status, 2);
      assert.equal(cli(home, ["--cwd", "/srv"]).status, 2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the reader resolves the stores the way their writers do", () => {
  it("matches the terminal writer's root for every override", () => {
    for (const env of [
      { HOME: "/srv/people/amina" },
      { HOME: "/srv/people/amina", XDG_STATE_HOME: "/srv/state" },
      { HOME: "/srv/people/amina", CUESHEET_SESSIONS: "/srv/one" },
    ]) {
      assert.equal(sessionRoots(env).terminal, terminalSessionRoot(env));
    }
    assert.equal(sessionRoots({ HOME: "/srv/people/amina" }).runs, "/srv/people/amina/.cuesheet/sessions");
  });

  it("reads one shared root once when CUESHEET_SESSIONS points both writers at it", () => {
    const { home, runs, terminal } = fixtureHome();
    try {
      for (const name of readdirSync(terminal)) {
        writeFileSync(join(runs, name), readFileSync(join(terminal, name)));
      }
      const listing = listSessions(sessionRoots({ HOME: home, CUESHEET_SESSIONS: runs }));
      assert.deepEqual(listing.stores, [{ kinds: ["run", "chat", "terminal"], path: runs, state: "read", error: null }]);
      const ids = listing.sessions.map((s) => s.id);
      assert.equal(ids.length, new Set(ids).size, "a session was listed twice");
      assert.equal(ids.length, 7);
      assert.ok(!ids.some((id) => id.endsWith(".view")), "a conversation journal was listed as a session");
      assert.ok(existsSync(join(runs, "t-atlas.view.jsonl")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the README documents the shape this command prints", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const block = /<!-- sessions-json:begin -->\s*```json\n([\s\S]*?)```\s*<!-- sessions-json:end -->/.exec(readme);

  it("holds one example listing between its markers", () => {
    assert.ok(block, "README.md lost the sessions-json example");
  });

  it("the example has the version and exactly the keys the command prints", () => {
    const example = JSON.parse(block![1]);
    assert.equal(example.version, SESSION_LISTING_VERSION);
    const { home } = fixtureHome();
    try {
      const real = JSON.parse(cli(home, ["--format", "json"]).stdout);
      assert.deepEqual(Object.keys(example).sort(), Object.keys(real).sort());
      assert.deepEqual(Object.keys(example.stores[0]).sort(), Object.keys(real.stores[0]).sort());
      assert.deepEqual(Object.keys(example.filters).sort(), Object.keys(real.filters).sort());
      for (const session of example.sessions) {
        assert.ok(["run", "chat", "terminal"].includes(session.kind));
        assert.deepEqual(Object.keys(session).sort(), Object.keys(real.sessions[0]).sort());
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
