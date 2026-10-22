/**
 * Projection: worker responsibilities and cumulative consumption.
 *
 * H06.5. From the event log alone — never from private messages — this
 * projects, for each worker subject:
 *
 * - responsibilities: the effects/tasks the worker has been asked to carry,
 *   with the phase each is in (requested / settled / unobserved);
 * * useful state: whether the worker currently has an unobserved effect
 *   (mid-flight), or is idle;
 * - cumulative consumption: input/output tokens summed across the model
 *   usage receipts recorded against that worker.
 *
 * Everything is a pure fold over the event list. No clock, no filesystem,
 * no network, no private channel. Two readings of the same log agree.
 */

import type { Event } from "../core/store.ts";
import { effectStatuses, type EffectStatus } from "../effects.ts";

/** A minimal usage receipt extracted from a model.usage note, no seq constraint. */
interface SimpleUsage {
  readonly requestId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly status: "pending" | "observed";
}

/** Extract model.usage notes from the event log, attributing each to its requestId. */
function extractUsage(events: readonly Event[]): SimpleUsage[] {
  const byRequest = new Map<string, SimpleUsage>();
  for (const event of events) {
    if (event.kind !== "note" || event.subject !== "model.usage") continue;
    const d = event.data as Record<string, unknown>;
    const requestId = typeof d.requestId === "string" ? d.requestId : null;
    if (!requestId) continue;
    let entry = byRequest.get(requestId);
    if (!entry) {
      entry = { requestId, inputTokens: null, outputTokens: null, status: "pending" };
      byRequest.set(requestId, entry);
    }
    const phase = d.phase;
    if (phase === "observed") {
      entry.status = "observed";
      entry.inputTokens = typeof d.inputTokens === "number" ? d.inputTokens : null;
      entry.outputTokens = typeof d.outputTokens === "number" ? d.outputTokens : null;
    }
  }
  return [...byRequest.values()];
}

/** The phase of one responsibility carried by a worker. */
export type ResponsibilityPhase = "requested" | "settled";

/** One thing a worker is responsible for, as the log records it. */
export interface WorkerResponsibility {
  /** The effect id this responsibility is about. */
  readonly effectId: string;
  /** What the worker was asked to do. */
  readonly subject: string;
  /** The affordance that permitted the request. */
  readonly affordance: string;
  /** The revision the request was judged against. */
  readonly revision: number | null;
  /** Whether an observation has answered the request. */
  readonly phase: ResponsibilityPhase;
  /** The sequence at which the request was recorded. */
  readonly at: number;
}

/** The cumulative consumption recorded for one worker. */
export interface WorkerConsumption {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requestCount: number;
  readonly pendingCount: number;
}

/** Everything the shared state can say about one worker. */
export interface WorkerView {
  readonly subject: string;
  readonly responsibilities: readonly WorkerResponsibility[];
  readonly consumption: WorkerConsumption;
  /** True when the worker has at least one unobserved (mid-flight) effect. */
  readonly busy: boolean;
}

/** The complete projection: every worker the log mentions. */
export interface WorkerResponsibilities {
  readonly workers: readonly WorkerView[];
  /** Total input tokens across all workers. */
  readonly totalInputTokens: number;
  /** Total output tokens across all workers. */
  readonly totalOutputTokens: number;
}

/** Where model usage receipts are recorded in the journal. */
const MODEL_USAGE_SUBJECT = "model.usage";

/**
 * Project worker responsibilities and consumption from the event log.
 *
 * Pure: the same events always give the same projection. A worker becomes
 * visible the first time an effect is requested in its name, or the first
 * time a model usage receipt is recorded for it.
 */
export function projectWorkerResponsibilities(events: readonly Event[]): WorkerResponsibilities {
  const statuses = effectStatuses([...events]);
  const usage = extractUsage(events);

  // Responsibilities: one entry per effect request, keyed by effect id.
  const byEffect = new Map<string, WorkerResponsibility>();
  // Consumption per worker subject.
  const consumptionByWorker = new Map<string, { inputTokens: number; outputTokens: number; requestCount: number; pendingCount: number }>();
  // All worker subjects seen, in first-appearance order.
  const workers: string[] = [];
  const workerSet = new Set<string>();

  for (const event of events) {
    if (event.kind === "effect_requested") {
      const d = event.data as Record<string, unknown>;
      const effectId = typeof d.effectId === "string" ? d.effectId : null;
      const subject = typeof event.subject === "string" ? event.subject : "";
      const affordance = typeof d.affordance === "string" ? d.affordance : "";
      const revision = typeof d.revision === "number" ? d.revision : null;
      if (!effectId || !subject) continue;
      if (!workerSet.has(subject)) { workerSet.add(subject); workers.push(subject); }
      const status = statuses.get(effectId);
      const phase = status && status.status === "requested" ? "requested" : "settled";
      byEffect.set(effectId, {
        effectId,
        subject: typeof d.subject === "string" ? d.subject : subject,
        affordance,
        revision,
        phase,
        at: event.seq,
      });
    }
    if (event.kind === "note" && event.subject === MODEL_USAGE_SUBJECT) {
      const d = event.data as Record<string, unknown>;
      // Model usage notes don't name a worker directly; attribute by the
      // request's owner when the log records it, otherwise leave unattributed.
      // (The caller can join usage to workers via effect id when needed.)
      const requestId = typeof d.requestId === "string" ? d.requestId : null;
      if (!requestId) continue;
      // We cannot reliably attribute a usage receipt to a worker from this
      // event alone; the worker attribution is done at call time via
      // attributeUsageToWorkers. Here we just count globally.
      // Nothing to do in this pass; consumption is attributed below.
    }
  }

  // Attribute consumption to workers: a usage receipt's requestId matches an
  // effect id, and that effect's subject is the worker.
  const usageByEffect = new Map<string, UsageRequest[]>();
  for (const u of usage) {
    const list = usageByEffect.get(u.requestId) ?? [];
    list.push(u);
    usageByEffect.set(u.requestId, list);
  }

  for (const [effectId, responsibility] of byEffect) {
    const list = usageByEffect.get(effectId) ?? [];
    let entry = consumptionByWorker.get(responsibility.subject);
    if (!entry) {
      entry = { inputTokens: 0, outputTokens: 0, requestCount: 0, pendingCount: 0 };
      consumptionByWorker.set(responsibility.subject, entry);
    }
    for (const u of list) {
      entry.requestCount += 1;
      if (u.status === "pending") entry.pendingCount += 1;
      entry.inputTokens += u.inputTokens ?? 0;
      entry.outputTokens += u.outputTokens ?? 0;
    }
  }

  const workerViews: WorkerView[] = [];
  for (const subject of workers) {
    const responsibilities: WorkerResponsibility[] = [];
    for (const r of byEffect.values()) {
      if (r.subject === subject) responsibilities.push(r);
    }
    const entry = consumptionByWorker.get(subject) ?? {
      inputTokens: 0, outputTokens: 0, requestCount: 0, pendingCount: 0,
    };
    const busy = responsibilities.some((r) => r.phase === "requested");
    workerViews.push({ subject, responsibilities, consumption: entry, busy });
  }

  let totalInput = 0;
  let totalOutput = 0;
  for (const w of workerViews) {
    totalInput += w.consumption.inputTokens;
    totalOutput += w.consumption.outputTokens;
  }

  return {
    workers: workerViews,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
  };
}

/** A one-line summary for a surface, never a verdict. */
export function describeWorkerView(worker: WorkerView): string {
  const phases: Record<ResponsibilityPhase, number> = { requested: 0, settled: 0 };
  for (const r of worker.responsibilities) phases[r.phase] += 1;
  const c = worker.consumption;
  return `${worker.subject}: ${phases.requested} mid-flight, ${phases.settled} settled, ` +
    `in ${c.inputTokens} / out ${c.outputTokens} tokens (${c.requestCount} requests, ${c.pendingCount} pending)`;
}
