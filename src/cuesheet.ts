/**
 * CLI: the single entry point for the installed `cuesheet` command.
 *
 * This file dispatches and adds nothing. The implementations live in the CLIs
 * it calls, and it spawns them rather than importing them, because they are
 * scripts with their own arg parsing and their own exit codes. The one thing
 * this file is strict about is exit-code passthrough: a gate that refuses must
 * reach a script as exit 1, or the command is unusable as a gate.
 *
 * Machine paths appear only in the shim that installs this command, never
 * here.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "./is-entry-point.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface CommandSpec {
  file: string;
  about: string;
  style: "flags" | "subcommand";
  /** Example line, so `-h` is copy-pasteable rather than descriptive. */
  usage?: string;
  /** Subcommands of this command, forming the second level of the hierarchy. */
  sub?: Record<string, { about: string; usage?: string }>;
}

const COMMANDS: Record<string, CommandSpec> = {
  // Two calling conventions live behind one command, and the difference is
  // deliberate: cli.ts is flag-driven because portfolio-owners and the README
  // call it that way and its parser refuses unknown tokens, while cli-run.ts is
  // subcommand-driven. One style field per subcommand, and exit codes pass
  // through untouched, because a gate that refuses must still exit 1 through
  // the dispatcher.
  projects: {
    file: "cli.ts",
    about: "which projects can accept a writer right now",
    style: "flags",
    usage: "cuesheet projects --root <dir> [--root <dir>] [--minutes N]",
  },
  gate: {
    file: "cli.ts",
    about: "refuse a brief whose requirements cannot resolve",
    style: "flags",
    usage: "cuesheet gate --requirements <file> --skill-root <dir>",
  },
  run: {
    file: "cli-run.ts",
    about: "run a goal under a session that owns its state",
    style: "subcommand",
    usage: "cuesheet run <goal> --in <dir> [--session <id>] [--max-steps N]",
  },
  resume: {
    file: "cli-run.ts",
    about: "replay a session and continue it",
    style: "subcommand",
    usage: "cuesheet resume <session> --in <dir>",
  },
  sessions: {
    file: "cli-run.ts",
    about: "list the sessions stored on this machine",
    style: "subcommand",
    usage: "cuesheet sessions [--format json] [--since <iso>] [--cwd <dir>]",
    sub: {
      list: { about: "list the sessions stored on this machine", usage: "cuesheet sessions list" },
    },
  },
  inspect: {
    file: "cli-run.ts",
    about: "print a session log, event by event",
    style: "subcommand",
    usage: "cuesheet inspect <session>",
  },
  capabilities: {
    file: "cli-run.ts",
    about: "resolve the live skill registry",
    style: "subcommand",
    usage: "cuesheet capabilities [--format json]",
  },
  frontier: {
    file: "frontier-cli.ts",
    about: "regenerate the portfolio frontier",
    style: "subcommand",
    usage: "cuesheet frontier [<objects-file>]",
  },
  surface: {
    file: "surface-cli.ts",
    about: "the human surface (this is what plain `cuesheet` does)",
    style: "subcommand",
    usage: "cuesheet surface [--provider NAME] [--model ID] [--max-tokens N] [--base-url URL] [--verify check.mjs] [--session ID]",
  },
  chat: {
    file: "chat.ts",
    about: "the diagnostic chat, with every internal fact printed",
    style: "subcommand",
    usage: "cuesheet chat",
  },
  version: {
    file: "cuesheet.ts",
    about: "print the version",
    style: "subcommand",
    usage: "cuesheet version",
  },
};

/** The version is read from package.json rather than restated here. */
function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function usage(): never {
  console.log(`cuesheet, a session that owns its own state

Subcommands:

${Object.entries(COMMANDS)
  .map(([name, c]) => {
    const nested = c.sub
      ? "\n" +
        Object.entries(c.sub)
          .map(([s, spec]) => `    ${(name + " " + s).padEnd(22)}${spec.about}`)
          .join("\n")
      : "";
    return `  ${name.padEnd(14)}${c.about}${nested}`;
  })
  .join("\n")}

Options:

  -h, --help      show this help, also works on any subcommand
  -v, --version   print the version

Every subcommand takes --help. Commands that print a report also take
--format json, because a verdict a machine cannot read is not a verdict.

A run needs a model. The default uses the local opencode binary. The terminal
also accepts --provider openrouter|openai|compatible|anthropic and --model ID. Credentials:
OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or optional CUESHEET_API_KEY for a compatible
endpoint selected with --base-url URL. See cuesheet surface --help.
`);
  process.exit(2);
}

/** Per-command help. Same content, narrowed to one command. */
function commandUsage(name: string, spec: CommandSpec): never {
  const lines = [
    `cuesheet ${name} — ${spec.about}`,
    "",
  ];
  if (spec.usage) {
    lines.push(spec.usage, "");
  }
  if (spec.sub) {
    lines.push("Subcommands:");
    for (const [sub, subSpec] of Object.entries(spec.sub)) {
      lines.push(`  ${(name + " " + sub).padEnd(24)}${subSpec.about}`);
    }
    lines.push("");
  }
  lines.push("Options:", "  -h, --help   show this help", "");
  console.log(lines.join("\n"));
  process.exit(0);
}

function dispatch(argv: string[]): number {
  const wantsHelp = argv.includes("-h") || argv.includes("--help");
  const wantsVersion = argv.includes("-v") || argv.includes("--version");

  if (wantsVersion) {
    console.log(version());
    return 0;
  }

  // A bare `cuesheet` is the surface, not the old chat.
  //
  // The chat printed its own diagnostics on startup: where it was, how many
  // capabilities were registered, how many sessions were on disk, and a notice
  // that goals need a project. All of it true, none of it what a person who
  // typed `cuesheet` asked for. The surface asks one question instead.
  //
  // `cuesheet chat` still reaches the old surface, because the sixteen
  // milestones it implements are still the core's and removing the way to look
  // at them would be throwing away evidence rather than improving a default.
  const [command = "surface", ...rest] = argv;
  const named = COMMANDS[command];
  const firstIsFlag = command.startsWith("-");

  if (wantsHelp && !named) {
    console.log(
      `cuesheet, a session that owns its own state\n\n` +
        `Run \`cuesheet <command> --help\` for one command.\n\n` +
        `Subcommands:\n\n` +
        Object.entries(COMMANDS)
          .map(([n, c]) => `  ${n.padEnd(14)}${c.about}`)
          .join("\n"),
    );
    return 0;
  }
  if (!named && !firstIsFlag && !wantsHelp) {
    console.error(`cuesheet: unknown command "${command}"`);
    console.error(`Run \`cuesheet --help\` for the list.`);
    return 2;
  }
  if (!named && firstIsFlag) {
    console.error(`cuesheet: unknown flag "${command}"`);
    console.error(`Run \`cuesheet --help\` for the list.`);
    return 2;
  }
  if (!named) {
    usage();
  }
  if (wantsHelp) {
    commandUsage(command, named);
  }

  // `version` is implemented here; spawning this file recursively hangs the launcher.
  if (command === "version") {
    if (rest.length > 0) return 2;
    console.log(version());
    return 0;
  }
  const args = named.style === "subcommand" ? [command, ...rest] : rest;
  const result = spawnSync(process.execPath, [join(here, named.file), ...args], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`cuesheet: failed to launch ${named.file}: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`cuesheet: ${command} killed by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(dispatch(process.argv.slice(2)));
}
