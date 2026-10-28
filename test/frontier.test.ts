import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSnapshotFrontier,
  renderFrontier,
  snapshotPortfolio,
} from "../src/adapters/frontier.ts";
import type { DurableObject } from "../src/core/memory.ts";
import { childEnv } from "./fixtures/hermetic-env.ts";

const obj = (over: Partial<DurableObject> = {}): DurableObject => ({
  id: "o1",
  kind: "FutureTrigger",
  horizon: "sleep",
  what: "a runtime is justified",
  why: "ADR-001 forbids it until measured",
  evidence: [{ source: "bench", observed: "0 observed", at: "2026-09-29" }],
  status: "active",
  related_to: [],
  ...over,
});

/**
 * A portfolio built in a temporary directory, so the assertions below are a
 * function of this file rather than of whatever the machine is doing.
 *
 * These two tests used to call `snapshotPortfolio()` with no arguments, which
 * reads the developer's live portfolio. Every claim they made about "free" and
 * "held" was therefore a claim about the world at that moment: a dirty
 * checkout produced a different suite than a clean one, and neither outcome
 * failed. A test that passes by reading a real thing instead of proving a
 * claim is the shape of the defects in the first five commits.
 *
 * Recorded in docs/portfolio-cost.md, where the same measurement found it.
 */
function disposablePortfolio(
  rows: Array<[name: string, rel: string, opts?: { dirty?: boolean; remote?: boolean }]>,
): { projectsRoot: string; dispose: () => void } {
  const base = mkdtempSync(join(tmpdir(), "cuesheet-frontier-"));
  const projectsRoot = join(base, "projects");

  for (const [, rel, opts = {}] of rows) {
    const dir = join(projectsRoot, rel);
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
    if (opts.remote) {
      const bare = join(base, `${rel.replace(/\//g, "-")}.bare`);
      spawnSync("git", ["clone", "-q", "--bare", dir, bare], { encoding: "utf8" });
      spawnSync("git", ["-C", dir, "remote", "add", "origin", bare], { encoding: "utf8" });
    }
    spawnSync(
      "git",
      ["-C", dir, "-c", "user.email=t@check", "-c", "user.name=frontier", "commit", "-q", "--allow-empty", "-m", "init"],
      { encoding: "utf8" },
    );
    if (opts.remote) {
      spawnSync("git", ["-C", dir, "push", "-q", "-u", "origin", "HEAD"], { encoding: "utf8" });
    }
    if (opts.dirty) {
      writeFileSync(join(dir, "uncommitted.txt"), "left behind\n");
    }
  }

  writeFileSync(
    join(projectsRoot, "PROJECTS.md"),
    [
      "| Name | Path | Kind | Status | Nature | Stack |",
      "|---|---|---|---|---|---|",
      ...rows.map(([name, rel]) => `| ${name} | ${rel} | repo | active | tool | ts |`),
      "",
    ].join("\n"),
  );

  return { projectsRoot, dispose: () => rmSync(base, { recursive: true, force: true }) };
}

describe("snapshotPortfolio", () => {
  it("holds a dirty repository and frees a clean one, on a portfolio it built", () => {
    const p = disposablePortfolio([
      ["clean-repo", "tools/clean-repo", { remote: true }],
      ["dirty-repo", "tools/dirty-repo", { dirty: true }],
    ]);
    try {
      const s = snapshotPortfolio({ projectsRoot: p.projectsRoot });

      assert.equal(s.projects.length, 2, "the registry must yield both projects");
      assert.equal(
        s.free.length + s.held.length,
        s.projects.length,
        "every repository is either free or held, never neither",
      );
      assert.ok(s.held.includes("dirty-repo"), "a dirty repository is held");
      assert.ok(!s.free.includes("dirty-repo"));
      assert.ok(s.free.includes("clean-repo"), "a clean, pushed repository is free");
    } finally {
      p.dispose();
    }
  });

  it("holds a repository whose commits were never pushed", () => {
    const p = disposablePortfolio([["unpushed-repo", "tools/unpushed-repo", { remote: true }]]);
    try {
      // Two commits, one pushed: the unpushed one is exactly the case
      // resolveOwnership holds a checkout for.
      const dir = join(p.projectsRoot, "tools", "unpushed-repo");
      spawnSync(
        "git",
        ["-C", dir, "-c", "user.email=t@check", "-c", "user.name=frontier", "commit", "-q", "--allow-empty", "-m", "second"],
        { encoding: "utf8" },
      );
      const s = snapshotPortfolio({ projectsRoot: p.projectsRoot });
      const repo = s.projects.find((r) => r.entry.name === "unpushed-repo");
      assert.equal(repo?.ahead, 1, "one commit is ahead of the upstream");
      assert.ok(s.held.includes("unpushed-repo"), "unpushed work holds the repository");
    } finally {
      p.dispose();
    }
  });

  it("reports a declared repository that is not on disk", () => {
    const p = disposablePortfolio([["ghost", "tools/ghost"]]);
    try {
      const projectsRoot = p.projectsRoot;
      rmSync(join(projectsRoot, "tools", "ghost"), { recursive: true, force: true });
      const s = snapshotPortfolio({ projectsRoot });
      assert.ok(s.declaredButMissing.includes("ghost"), "a declared but absent repository is named");
    } finally {
      p.dispose();
    }
  });

  it("tells an absent registry apart from one that declares nothing (#78)", () => {
    const base = mkdtempSync(join(tmpdir(), "cuesheet-frontier-noreg-"));
    try {
      const s = snapshotPortfolio({ projectsRoot: base });
      assert.equal(s.projects.length, 0);
      assert.equal(s.registry, null, "no PROJECTS.md is reported as such");
      writeFileSync(join(base, "PROJECTS.md"), "| Name | Path | Kind | Status | Nature | Stack |\n|---|---|---|---|---|---|\n");
      assert.equal(snapshotPortfolio({ projectsRoot: base }).registry, join(base, "PROJECTS.md"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("scans the current top level and every registry segment for undeclared repositories (#78)", () => {
    const p = disposablePortfolio([["clean-repo", "tools/clean-repo", { remote: true }]]);
    try {
      mkdirSync(join(p.projectsRoot, "research", "stray", ".git"), { recursive: true });
      mkdirSync(join(p.projectsRoot, "tools", "other", ".git"), { recursive: true });
      const s = snapshotPortfolio({ projectsRoot: p.projectsRoot });
      assert.ok(s.presentButUndeclared.includes("research/stray"), "a current top-level directory is walked");
      assert.ok(s.presentButUndeclared.includes("tools/other"), "a directory the registry names is walked");
      assert.ok(!s.presentButUndeclared.includes("tools/clean-repo"), "a declared repository is not reported");
    } finally {
      p.dispose();
    }
  });

  it("the generator refuses to publish when the registry is absent (#78)", () => {
    const base = mkdtempSync(join(tmpdir(), "cuesheet-frontier-cli-"));
    try {
      const r = spawnSync(process.execPath, ["src/frontier-cli.ts", join(base, "objects.md")], {
        encoding: "utf8",
        env: { ...childEnv({ home: base, sessions: base }), MEMOLABS_ROOT: base },
      });
      assert.notEqual(r.status, 0, "it exits with an error");
      assert.match(r.stderr, /refusing to publish an empty portfolio/);
      assert.equal(r.stdout, "", "nothing is published");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});


/**
 * A snapshot built from nothing, for the tests that only care about rendering.
 *
 * `buildSnapshotFrontier` takes an injected snapshot and falls back to reading
 * the machine's portfolio when none is given. Every rendering test left it out,
 * so each one spawned 180 git subprocesses against the developer's real
 * repositories. Passing a fixture is the same injection the adapter was made
 * injectable for.
 */
const OFFLINE_SNAPSHOT = {
  projects: [],
  declaredButMissing: [],
  presentButUndeclared: [],
  free: [],
  held: [],
};

describe("buildSnapshotFrontier", () => {
  it("reports an unevaluable condition instead of quietly not waking it", () => {
    const objects = [
      obj({
        id: "F-runtime",
        revisit_when: {
          signal: "three alignment failures",
          requires: ">= 3 reproducible failures",
          satisfiedBy: ["alignment_failures", "no_existing_primitive"],
          matched: true,
        },
      }),
    ];

    const { frontier, unevaluable } = buildSnapshotFrontier({
      objects,
      snapshot: OFFLINE_SNAPSHOT,
      measured: { alignment_failures: 4 },
    });

    assert.equal(frontier.woken.length, 0, "a missing measurement cannot wake anything");
    assert.equal(unevaluable.length, 1);
    assert.match(unevaluable[0].why, /no_existing_primitive/);
  });

  it("wakes only when the condition is both evaluable and matched", () => {
    const objects = [
      obj({
        id: "F-wakes",
        revisit_when: {
          signal: "s",
          requires: "r",
          satisfiedBy: ["m"],
          matched: true,
        },
      }),
    ];
    const { frontier } = buildSnapshotFrontier({ objects, measured: { m: 1 }, snapshot: OFFLINE_SNAPSHOT });
    assert.equal(frontier.woken.length, 1);
  });
});

describe("renderFrontier", () => {
  it("is a session-sized document, not the research corpus", () => {
    const objects = [
      obj({ id: "n1", horizon: "now", what: "own the state" }),
      obj({ id: "w1", horizon: "watch", what: "measured evolution", revisit_when: {
        signal: "s", requires: "repeated procedures", satisfiedBy: ["procedures"], matched: false } }),
    ];
    const { frontier, snapshot, unevaluable } = buildSnapshotFrontier({
      objects,
      snapshot: OFFLINE_SNAPSHOT,
      measured: {},
    });
    const md = renderFrontier(frontier, snapshot, unevaluable, frontier.woken);

    assert.ok(md.length < 8000, `frontier must stay small, got ${md.length} bytes`);
    assert.match(md, /GENERATED by/);
    assert.match(md, /Do not edit by hand/);
  });

  it("states plainly that an unevaluable condition is not a verdict", () => {
    const objects = [
      obj({ id: "u1", revisit_when: {
        signal: "s", requires: "r", satisfiedBy: ["missing_measure"], matched: true } }),
    ];
    const { frontier, snapshot, unevaluable } = buildSnapshotFrontier({
      objects,
      snapshot: OFFLINE_SNAPSHOT,
      measured: {},
    });
    const md = renderFrontier(frontier, snapshot, unevaluable, frontier.woken);

    assert.match(md, /could not be evaluated/);
    assert.match(md, /not a met condition/);
  });

  it("prints a falsified belief, its counterexample and its replacement", () => {
    const dead: DurableObject = {
      ...obj({ id: "F2", what: "hash alone suffices" }),
      status: "falsified",
      original_belief: "unchanged content does not invalidate dependants",
      counterexample: "world-kernel 15/16",
      replacement: "hash plus deriver policy identity",
    };
    const { frontier, snapshot, unevaluable } = buildSnapshotFrontier({
      objects: [dead],
      measured: {},
    });
    const md = renderFrontier(frontier, snapshot, unevaluable, frontier.woken);

    assert.match(md, /unchanged content does not invalidate dependants/);
    assert.match(md, /world-kernel 15\/16/);
    assert.match(md, /hash plus deriver policy identity/);
  });
});
