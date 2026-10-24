/**
 * scripts/install.sh and bin/cuesheet: the command a bare PATH can still run.
 *
 * Found on the owner's machine on 2026-10-21: the installed shim pointed at a
 * runtime copy that no longer existed, and the repository's own shim was
 * documented as pointing at a checkout path that had been removed. Every call
 * failed with "entry point not found", including from Finder, which starts a
 * command with no nvm and no Homebrew on PATH.
 *
 * The install is tested against a stand-in build rather than dist/, which
 * test/install.test.ts rebuilds in place while tests run in parallel.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A build with the layout dist/ has, whose entry says which build it is. */
function fakeBuild(dir: string, label: string): string {
  const dist = join(dir, `dist-${label}`);
  mkdirSync(join(dist, "src"), { recursive: true });
  writeFileSync(join(dist, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
  writeFileSync(
    join(dist, "src", "cuesheet.js"),
    `console.log("build ${label} " + process.argv.slice(2).join(" "));\n`,
  );
  return dist;
}

function install(stage: string, dist: string) {
  return spawnSync("bash", [join(ROOT, "scripts", "install.sh"), "--no-build"], {
    encoding: "utf8",
    env: {
      HOME: join(stage, "home"),
      PATH: process.env.PATH ?? BARE_PATH,
      CUESHEET_DIST: dist,
      CUESHEET_RUNTIME: join(stage, "share", "cuesheet", "runtime"),
      CUESHEET_BIN_DIR: join(stage, "bin"),
      CUESHEET_NODE: process.execPath,
    },
  });
}

const bare = (stage: string, command: string, args: string[]) =>
  spawnSync(command, args, { encoding: "utf8", env: { HOME: join(stage, "home"), PATH: BARE_PATH } });

describe("scripts/install.sh", () => {
  it("installs a runtime copy and a shim that runs with a bare PATH", () => {
    const stage = mkdtempSync(join(tmpdir(), "cuesheet-install-"));
    try {
      mkdirSync(join(stage, "home"));
      const r = install(stage, fakeBuild(stage, "one"));
      assert.equal(r.status, 0, r.stderr);

      const shim = join(stage, "bin", "cuesheet");
      const runtime = join(stage, "share", "cuesheet", "runtime");
      assert.ok(statSync(shim).mode & 0o111, "the installed shim is executable");
      const text = readFileSync(shim, "utf8");
      assert.ok(text.includes(`INSTALLED_ROOT=${runtime}`), "the shim names the runtime it was given");
      assert.ok(text.includes(`INSTALLED_NODE=${process.execPath}`), "the shim names the node it found");
      assert.ok(existsSync(join(runtime, "src", "cuesheet.js")));
      const marker = JSON.parse(readFileSync(join(runtime, "INSTALLED.json"), "utf8"));
      assert.match(marker.commit, /^([0-9a-f]{40}|unknown)$/);

      const help = bare(stage, shim, ["--help"]);
      assert.equal(help.status, 0, help.stderr);
      assert.equal(help.stdout.trim(), "build one --help");
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it("a reinstall replaces the runtime whole and leaves nothing staged", () => {
    const stage = mkdtempSync(join(tmpdir(), "cuesheet-reinstall-"));
    try {
      mkdirSync(join(stage, "home"));
      assert.equal(install(stage, fakeBuild(stage, "one")).status, 0);
      const runtime = join(stage, "share", "cuesheet", "runtime");
      writeFileSync(join(runtime, "left-over"), "");
      const r = install(stage, fakeBuild(stage, "two"));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(bare(stage, join(stage, "bin", "cuesheet"), ["version"]).stdout.trim(), "build two version");
      assert.ok(!existsSync(join(runtime, "left-over")), "the old runtime was merged rather than replaced");
      assert.deepEqual(readdirSync(dirname(runtime)), ["runtime"]);
      assert.deepEqual(readdirSync(join(stage, "bin")), ["cuesheet"]);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it("refuses a build that has no entry point, and installs nothing", () => {
    const stage = mkdtempSync(join(tmpdir(), "cuesheet-install-empty-"));
    try {
      mkdirSync(join(stage, "home"));
      mkdirSync(join(stage, "dist-empty"));
      const r = install(stage, join(stage, "dist-empty"));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /cuesheet\.js missing/);
      assert.ok(!existsSync(join(stage, "bin", "cuesheet")));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});

describe("bin/cuesheet from a checkout", () => {
  it("runs the checkout it sits in, with a bare PATH and CUESHEET_NODE", () => {
    const r = spawnSync(join(ROOT, "bin", "cuesheet"), ["--help"], {
      encoding: "utf8",
      env: { HOME: tmpdir(), PATH: BARE_PATH, CUESHEET_NODE: process.execPath },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Subcommands:/);
  });

  it("says where it looked when the entry point is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "cuesheet-noroot-"));
    try {
      const r = spawnSync(join(ROOT, "bin", "cuesheet"), ["--help"], {
        encoding: "utf8",
        env: { HOME: tmpdir(), PATH: BARE_PATH, CUESHEET_ROOT: empty, CUESHEET_NODE: process.execPath },
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /entry point not found/);
      assert.match(r.stderr, /scripts\/install\.sh/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
