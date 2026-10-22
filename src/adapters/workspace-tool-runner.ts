/**
 * Adapter: a tool runner that operates inside one workspace, with no shell.
 *
 * Honours the verbs the LLM producer exposes (`list_files`, `read_file`,
 * `write_file`) and nothing else. Every path is resolved against the declared
 * workspace and refused if it escapes, so a model cannot reach outside its
 * admitted scope. This is the boundary `runAgentLoop` needs to act on the
 * world: a tool request becomes a filesystem operation, and nothing more.
 *
 * No credentials are ever passed to a command — there is no command at all.
 * Operations read and write bytes directly, so output is deterministic and a
 * test can assert on exact bytes rather than on shell formatting.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { ToolRequest, ToolResult } from "../core/loop.ts";
import { placeInWorkspace } from "./llm-producer.ts";

/** Where a tool may run. One root, never widened by a request. */
export interface WorkspaceToolRunnerOptions {
  /** The directory tools may read and write. */
  workspace: string;
  /** Bytes of output kept per call. */
  outputBytes?: number;
}

/** The default set of verbs a worker is offered. Nothing else exists. */
export const WORKSPACE_VERBS = ["list_files", "read_file", "write_file"] as const;
export type WorkspaceVerb = (typeof WORKSPACE_VERBS)[number];

export class WorkspaceToolRunner implements ToolRunner {
  private readonly workspace: string;
  private readonly outputBytes: number;

  constructor(options: WorkspaceToolRunnerOptions) {
    this.workspace = resolve(options.workspace);
    this.outputBytes = options.outputBytes ?? 8_000;
  }

  async run(request: ToolRequest): Promise<ToolResult> {
    const { name, input } = request;

    switch (name) {
      case "list_files": {
        const files = listWorkspace(this.workspace);
        return { name, exit: 0, output: files.join("\n") || "(empty)" };
      }
      case "read_file": {
        const path = typeof input?.path === "string" ? input.path : "";
        if (!path) {
          return { name, exit: 1, output: "read_file requires a path" };
        }
        const placement = placeInWorkspace(this.workspace, path);
        if (!placement.ok) {
          return { name, exit: 1, output: placement.why };
        }
        try {
          const contents = readFileSync(placement.absolute, "utf8");
          return { name, exit: 0, output: truncate(contents) };
        } catch (cause) {
          return { name, exit: 1, output: String(cause instanceof Error ? cause.message : cause) };
        }
      }
      case "write_file": {
        const path = typeof input?.path === "string" ? input.path : "";
        const contents = typeof input?.contents === "string" ? input.contents : undefined;
        if (!path || contents === undefined) {
          return { name, exit: 1, output: "write_file requires path and contents" };
        }
        const placement = placeInWorkspace(this.workspace, path);
        if (!placement.ok) {
          return { name, exit: 1, output: placement.why };
        }
        try {
          mkdirSync(resolve(placement.absolute, ".."), { recursive: true });
          writeFileSync(placement.absolute, contents, "utf8");
          return { name, exit: 0, output: `wrote ${path}` };
        } catch (cause) {
          return { name, exit: 1, output: String(cause instanceof Error ? cause.message : cause) };
        }
      }
      default:
        return { name, exit: 127, output: `tool "${name}" is not admitted: ${WORKSPACE_VERBS.join(", ")}` };
    }
  }
}

/** Every file under a directory, relative and sorted. */
function listWorkspace(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(d, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

function truncate(value: string): string {
  if (value.length <= 8_000) return value;
  return value.slice(0, 8_000) + "\n... (output truncated)";
}
