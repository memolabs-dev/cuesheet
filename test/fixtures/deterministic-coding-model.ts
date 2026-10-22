/**
 * Test fixture: a deterministic model adapter.
 *
 * Not a real LLM — no provider key, no network, no credits. It simulates a
 * coding agent that knows exactly one fix: when the goal names a file that has
 * not yet been written, it proposes `write_file` with the corrected contents.
 * Once the file is written, it returns text only.
 *
 * This proves Cuesheet is model-agnostic: the same loop, runner, capture and
 * verifier work with a deterministic adapter as they would with OpenRouter or
 * Anthropic. Only the adapter changes.
 */

import type { ContextFrame, ModelAdapter, ModelResponse } from "../src/core/loop.ts";

export interface DeterministicCodingModelOptions {
  /** The file the model is expected to fix. */
  path: string;
  /** The corrected contents to write. */
  contents: string;
  /** The goal prefix the model responds to. */
  goalContains?: string;
}

/** A model that applies one known fix and nothing else. */
export class DeterministicCodingModel implements ModelAdapter {
  readonly name = "deterministic";
  private readonly path: string;
  private readonly contents: string;
  private readonly goalContains: string;

  constructor(options: DeterministicCodingModelOptions) {
    this.path = options.path;
    this.contents = options.contents;
    this.goalContains = options.goalContains ?? "fix";
  }

  async infer(frame: ContextFrame): Promise<ModelResponse> {
    // Only act if the goal names the file we know how to fix.
    if (!frame.goal.includes(this.goalContains)) {
      return { text: "I do not know how to do that.", toolCalls: [] };
    }

    // Has the file already been written? Look at the action history.
    const alreadyWritten = frame.history.some(
      (e) =>
        e.kind === "action" &&
        e.data.tool === "write_file" &&
        typeof e.data.input === "object" &&
        e.data.input !== null &&
        (e.data.input as Record<string, unknown>).path === this.path,
    );

    if (alreadyWritten) {
      return {
        text: "The fix has been applied. No further action needed.",
        toolCalls: [],
      };
    }

    return {
      text: "",
      toolCalls: [
        { name: "write_file", input: { path: this.path, contents: this.contents } },
      ],
    };
  }
}
