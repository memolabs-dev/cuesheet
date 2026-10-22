/**
 * Delegation contract: what a delegator promises before a worker spawns.
 *
 * Built on the two primitives that already exist:
 * - `src/core/delegation.ts` — `preflightDelegation`, the preflight gate that
 *   resolves requirements against a capability snapshot and returns spawnable
 *   or a refusal.
 * - `src/work-state.ts` — `SharedWorkState` and `Task`, the projection a worker
 *   reads instead of a transcript.
 *
 * Nothing here touches the world. A contract is data: worker identity,
 * objective, revision, unit of work, expected result, read/write scope,
 * capabilities, budget. Admission checks the capabilities exist before a
 * worker is asked to do anything. Role choice is automatic: the scheduler
 * derives the role from what the work needs, never from a title handed in.
 */

import type { Capability } from "./core/capability.ts";
import type { Requirement } from "./core/capability.ts";
import { preflightDelegation } from "./core/delegation.ts";

/** The four roles a worker can hold, chosen by the scheduler, never by hand. */
export type DelegationRole = "research" | "build" | "review" | "control";

/** A unit of work inside a delegation, with the honest state a fold can report. */
export interface DelegationTask {
  readonly id: string;
  readonly subject: string;
  readonly state: "asked" | "running" | "settled";
}

/** The spend a delegation is allowed: tokens and money, both optional. */
export interface DelegationBudget {
  readonly maxTokens?: number;
  readonly maxCostCents?: number;
}

/** The scope a worker may read or write, as file paths. Empty means none. */
export interface DelegationScope {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/**
 * One delegation: the contract between a brief and a worker before spawn.
 *
 * `revision` is the revision the contract was judged against; admission is
 * conditional on it (`appendIfCurrent` semantics further up the stack).
 * `capabilities` are what the work needs; `admitDelegation` resolves them
 * against a snapshot and refuses when any is missing.
 */
export interface DelegationContract {
  readonly id: string;
  readonly workerId: string;
  readonly objective: string;
  readonly revision: number;
  readonly task: DelegationTask;
  readonly expectedResult: string;
  readonly capabilities: readonly Requirement[];
  readonly budget: DelegationBudget;
  readonly scope: DelegationScope;
  /** The role the scheduler assigned, or null when it has not decided yet. */
  readonly role: DelegationRole | null;
}

/** Build a contract with the role left unset; `chooseRole` fills it later. */
export function contract(
  id: string,
  workerId: string,
  objective: string,
  revision: number,
  task: DelegationTask,
  expectedResult: string,
  capabilities: readonly Requirement[],
  budget: DelegationBudget,
  scope: DelegationScope,
): DelegationContract {
  return {
    id,
    workerId,
    objective,
    revision,
    task,
    expectedResult,
    capabilities,
    budget,
    scope,
    role: null,
  };
}

/**
 * Choose a role automatically from the requirements a piece of work needs.
 *
 * The mapping is deliberately narrow: a skill means someone must find out
 * something (research), a tool means someone must make something (build),
 * and anything else leaves the role unspecified so the scheduler can assign
 * it explicitly rather than guess.
 *
 * Returns null when no rule applies; the caller then assigns a role by hand
 * or leaves the delegation without one.
 */
export function roleFromRequirements(
  requirements: readonly Requirement[],
): DelegationRole | null {
  let role: DelegationRole | null = null;
  for (const requirement of requirements) {
    switch (requirement.kind) {
      case "skill":
        role = "research";
        break;
      case "tool":
        role = "build";
        break;
      case "mcp":
        role = role === null ? "control" : role;
        break;
      default:
        // Unknown kind: no automatic role. Keep whatever we have.
        break;
    }
  }
  return role;
}

/** Alias kept for callers that name the choice `chooseRole`. */
export const chooseRole = roleFromRequirements;

/** Assign a role to a contract when none is set, from its capabilities. */
export function assignRole(
  contract: DelegationContract,
): DelegationContract {
  if (contract.role !== null) return contract;
  const role = roleFromRequirements(contract.capabilities);
  return { ...contract, role };
}

/**
 * Admit a delegation: resolve its capabilities against a snapshot and refuse
 * when any is missing. The refusal text comes from `preflightDelegation`, so
 * a caller that refuses does not have to reconstruct why.
 *
 * `options.now` is injected so this is testable without a real clock.
 */
export function admitDelegation(
  contract: DelegationContract,
  available: readonly Capability[],
  options: { now: number; registryUnverified?: boolean } = { now: Date.now() },
): { admitted: boolean; refusal?: string } {
  const preflight = preflightDelegation(
    [...contract.capabilities],
    available as Capability[],
    options,
  );
  if (!preflight.spawnable) {
    return { admitted: false, refusal: preflight.refusal };
  }
  return { admitted: true };
}
