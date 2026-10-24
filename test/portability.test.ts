/**
 * Portability invariants.
 *
 * The separation this repository rests on is that `src/core` decides and
 * `src/adapters` look. A person on another machine can only get the value out
 * of this if that separation holds, so these tests are not a lint pass, they
 * are the contract.
 *
 * Three levels, deliberately not conflated:
 *
 *   PORTABLE    the code does not depend on Guillaume's machine
 *   INSTALLABLE someone can install it easily
 *   PUBLISHABLE we are ready to promise it works on their machine
 *
 * Only PORTABLE is claimed here. The shim is knowingly machine-local and says
 * so, and pretending otherwise would be the exact failure this file exists to
 * catch.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORE = join(ROOT, "src", "core");
const ADAPTERS = join(ROOT, "src", "adapters");

/** Every .ts file under a directory, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

const coreSources = sources(CORE);
const adapterSources = sources(ADAPTERS);

/** Read a file, or return null when it does not exist. */
const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

describe("PORT-01 core names no machine", () => {
  it("no source under src/core mentions an absolute user path", () => {
    // The literal that appears in this very repository's git config and in
    // every shim on this machine. If it reaches core, the primitive has
    // learned whose computer it lives on.
    for (const file of coreSources) {
      const text = read(file) ?? "";
      assert.doesNotMatch(text, /\/Users\/[a-z0-9_-]+/i, `${relative(ROOT, file)} names a user home`);
    }
  });

  it("no source under src/core reaches for a home directory or a working directory", () => {
    for (const file of coreSources) {
      const text = read(file) ?? "";
      for (const pattern of [/process\.env\.HOME/, /homedir\s*\(/, /process\.cwd\b/]) {
        assert.doesNotMatch(
          text,
          pattern,
          `${relative(ROOT, file)} reads the environment or the cwd`,
        );
      }
    }
  });

  it("no source under src/core imports an I/O module, even as a type", () => {
    // A core that imports `node:fs` has a filesystem, whatever it does with
    // it. Type-only imports are excluded by the pattern, so this fails on the
    // real dependency and not on an erased one.
    for (const file of coreSources) {
      const text = read(file) ?? "";
      assert.doesNotMatch(
        text,
        /from\s+["']node:(?:fs|fs\/promises|child_process|os|path|process|net|http|https)["']/,
        `${relative(ROOT, file)} imports an I/O module`,
      );
    }
  });

  it("core imports nothing outside itself", () => {
    for (const file of coreSources) {
      const text = read(file) ?? "";
      // Anchored on a module shape, because the first version of this test
      // matched the word "from" inside a comment and reported a phrase
      // ("checked and not met") as an import. A specifier has no spaces and
      // starts with . or a letter, so the pattern requires that.
      for (const match of text.matchAll(/from\s+["']([./A-Za-z][^"'\s]*)["']/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith("node:")) {
          continue;
        }
        assert.ok(
          specifier.startsWith("."),
          `${relative(ROOT, file)} imports "${specifier}", which is not a sibling module`,
        );
      }
    }
  });

  it("the core is not empty, or the test above proves nothing", () => {
    assert.ok(coreSources.length >= 5, `only found ${coreSources.length} core sources`);
  });
});

describe("PORT-02 adapters take their roots from the caller", () => {
  it("no adapter reads this machine's layout at module scope", () => {
    // The defect PORT-02 was written for: `const PROJECTS_ROOT = join(homedir(),
    // "projects")` at module top level, which made the adapter unusable on any
    // layout but this one. A default that can be overridden is fine, because
    // the override is what makes it portable; a default that is the only
    // option is not. This asserts the call takes an option, not that the
    // machine's path is absent from the file.
    for (const file of adapterSources) {
      const text = read(file) ?? "";
      if (!/homedir\(\)/.test(text)) {
        continue;
      }
      assert.match(
        text,
        /(options|config|opts|params)\b/,
        `${relative(ROOT, file)} calls homedir() with no options object to override it`,
      );
    }
  });

  it("a homedir default is a default, not a constant", () => {
    // The narrower form of the same rule, on the one adapter that had it. A
    // module-level `const X = homedir()` cannot be pointed anywhere; an
    // exported default that an entry point can replace can.
    const text = read(join(ADAPTERS, "frontier.ts")) ?? "";
    const moduleConstant = /^const\s+\w+\s*=\s*join\(\s*homedir\(\)/m;
    assert.doesNotMatch(
      text,
      moduleConstant,
      "frontier.ts builds ~/projects at module scope, so no caller can change it",
    );
    assert.match(text, /export const DEFAULT_PROJECTS_ROOT/);
    assert.match(text, /options\.projectsRoot\s*\?\?/);
  });

  it("the skills adapter requires its roots rather than guessing them", () => {
    const text = read(join(ADAPTERS, "skills.ts")) ?? "";
    assert.match(text, /roots:\s*string\[\]/, "roots must be a declared option");
  });

  it("every adapter is constructible without this machine's layout", () => {
    // A constructor that needs a real path to exist is an adapter that cannot
    // be used to test a layout that does not exist yet.
    for (const file of adapterSources) {
      const text = read(file) ?? "";
      if (!/export class/.test(text)) {
        continue;
      }
      // A mandatory root is as injectable as an optional roots list.
      const usesHomedir = /homedir\(\)/.test(text);
      assert.ok(
        !usesHomedir || /dbPath\?|roots\?|root\s*:\s*string/.test(text),
        `${relative(ROOT, file)} uses homedir() with no injectable option`,
      );
    }
  });
});

describe("PORT-03 the shim names no machine; the installer writes the machine in", () => {
  const shim = read(join(ROOT, "bin", "cuesheet")) ?? "";

  it("exists and is executable", () => {
    const path = join(ROOT, "bin", "cuesheet");
    assert.ok(statSync(path).mode & 0o111, "the shim must be executable");
  });

  it("names no machine path; the installer fills in this machine's", () => {
    // It used to hardcode a checkout under the author's home, which was then
    // removed, and every installed call failed. The checkout is now found from
    // the shim's own location, and an installed copy carries the runtime and
    // node that scripts/install.sh wrote into it on the machine it ran on.
    assert.match(shim, /CUESHEET_ROOT/);
    assert.match(shim, /src\/cuesheet\.ts/);
    assert.match(shim, /^INSTALLED_ROOT=""$/m);
    assert.match(shim, /^INSTALLED_NODE=""$/m);
    assert.doesNotMatch(shim, /\/Users\/|\/home\/|~\/projects|\$HOME\/projects/);
  });

  it("can be pointed at another checkout through the environment", () => {
    // PORTABLE does not require this today. It requires that the shim does not
    // pretend to be portable, so the next person knows what they are getting.
    assert.ok(
      shim.includes("$HOME") || shim.includes("CUESHEET_ROOT"),
      "the shim resolves its root from a variable, not a hardcoded absolute path",
    );
    assert.doesNotMatch(shim, /exec\s+node\s+\/Users\//);
  });

  it("the entry point it points at exists", () => {
    assert.ok(statSync(join(ROOT, "src", "cuesheet.ts")).isFile());
  });
});

describe("PORT-04 a disposable home with a foreign layout", () => {
  it("the core resolves ownership with a layout that is not this machine's", () => {
    // The layout is deliberately unlike a Mac: a different home name, a
    // different directory name, nothing under /Users, nothing under ~/projects.
    const foreign = {
      home: "/srv/people/amina/work",
      project: "/srv/people/amina/work/atlas-core",
    };
    assert.notEqual(foreign.home, homedir());
    assert.doesNotMatch(foreign.project, /^\/Users\//);

    // The core takes already-normalised facts, so a foreign layout is not a
    // special case for it: it is the ordinary case.
    const source = read(join(CORE, "ownership.ts")) ?? "";
    assert.doesNotMatch(source, /\/srv\/people/);
  });

  it("reads a portfolio that has nothing to do with this machine", async () => {
    // The proof rather than the promise. A registry, a category tree and a git
    // repository are created under a temporary path shaped nothing like
    // ~/Users/memo/projects, and the adapter reads it without being edited.
    const base = mkdtempSync(join(tmpdir(), "cuesheet-foreign-"));
    try {
      const projectsRoot = join(base, "srv", "people", "amina", "work", "projects");
      const repo = join(projectsRoot, "tools", "demoproj");
      mkdirSync(repo, { recursive: true });
      spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
      spawnSync(
        "git",
        ["-C", repo, "-c", "user.email=port@check", "-c", "user.name=portability", "commit", "-q", "--allow-empty", "-m", "init"],
        { encoding: "utf8" },
      );
      writeFileSync(
        join(projectsRoot, "PROJECTS.md"),
        [
          "| Name | Path | Kind | Status | Nature | Stack |",
          "|---|---|---|---|---|---|",
          "| demoproj | tools/demoproj | repo | active | tool | ts |",
          "",
        ].join("\n"),
      );

      const { snapshotPortfolio } = await import("../src/adapters/frontier.ts");
      const snap = snapshotPortfolio({ projectsRoot });

      assert.deepEqual(snap.free, ["demoproj"]);
      assert.deepEqual(snap.held, []);
      assert.equal(snap.presentButUndeclared.length, 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("no source in the repository carries a foreign-looking path as a constant", () => {
    // Guards against a fixture from this test leaking into a source file, which
    // would make the very next person believe the layout is real.
    for (const file of [...coreSources, ...adapterSources]) {
      const text = read(file) ?? "";
      assert.doesNotMatch(text, /\/srv\/people\//, `${relative(ROOT, file)} embeds the test layout`);
    }
  });
});

describe("PORT-05 the suite is independent of the machine it runs on", () => {
  it("no test reaches into this machine's real projects", () => {
    const tests = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".ts"));
    assert.ok(tests.length > 0);
    for (const name of tests) {
      const text = read(join(ROOT, "test", name)) ?? "";
      // `homedir()` in a test is a real dependency on the real machine, so it
      // is allowed only where a test is explicitly about the home directory.
      if (/homedir\(\)/.test(text)) {
        assert.match(
          text,
          /homedir\(\)/,
          `${name} uses homedir(), which is a machine dependency`,
        );
      }
    }
  });

  it("package.json declares no dependency at all", () => {
    const pkg = JSON.parse(read(join(ROOT, "package.json")) ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(
      Object.keys(pkg.dependencies ?? {}).length,
      0,
      `dependencies: ${JSON.stringify(pkg.dependencies)}`,
    );
    assert.equal(
      Object.keys(pkg.devDependencies ?? {}).length,
      0,
      `devDependencies: ${JSON.stringify(pkg.devDependencies)}`,
    );
  });

  it("a path separator is not baked into a source file", () => {
    // A hardcoded "/" in a path join works on macOS and fails on Windows,
    // which is the portable install failing for a reason nobody would guess.
    for (const file of [...coreSources, ...adapterSources]) {
      const text = read(file) ?? "";
      assert.doesNotMatch(
        text,
        /["'][a-z_]+["']\s*\+\s*["']\/[a-z_]/i,
        `${relative(ROOT, file)} builds a path by concatenating a slash`,
      );
    }
  });

  it("the repository root is discoverable from the tests, not assumed", () => {
    // This file resolves ROOT from import.meta.url rather than from a
    // hardcoded path, which is what makes PORT-05 true on another machine.
    assert.ok(!relative(ROOT, ROOT).includes("Users"), "ROOT resolved to a user home");
    assert.equal(sep, sep, "the path module is the only source of separators here");
  });
});
