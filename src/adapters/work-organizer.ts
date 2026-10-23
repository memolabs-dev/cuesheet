import type { Event, EventStore } from "../core/store.ts";
import type { ToolRequest, ToolResult } from "../core/loop.ts";
import { MEMORY_SUBJECT, projectMemory, memoryExtractionKey, findMemoryExtraction } from "./work-memory.ts";
import { projectObjectives } from "./objectives.ts";
import { projectWorkPlans, prepareWorkTasks } from "./work-plans.ts";

export const WORK_SUBJECT = "terminal.work";
export const AUTONOMOUS_TOOLS = ["organize_work", "remember", "create_skill", "describe_objective"];
export const AUTONOMOUS_POLICY =
  "You manage the work process automatically. The user supplies intent and corrections, not modes or bookkeeping commands. " +
  "Choose the lightest useful next step from assessment, research, specification, build and review. " +
  "Use organize_work when a durable plan/spec/checklist helps: input {phase,rationale,spec?,tasks?}; phases assess,research,spec,build,review; tasks are strings or {id?,text,expected,dependencies:[]}; reuse supplied IDs for revised tasks. Dependencies refer to retained task IDs. After an objective correction, submit spec and tasks explicitly before admitting the revised plan. " +
  "Revisit plans after observations or corrections. Do not create ceremony for a trivial task. A request for information or a recommendation calls for a concise answer, not for creating or changing work plans, memory or files unless the user requested that work. Read only what is needed to answer; do not repeat an unchanged read or failed call. " +
  "Maintain useful decisions, constraints and open questions from ordinary exchanges using remember: input {operation:'create'|'edit'|'resolve',kind?:'decision'|'constraint'|'question',id?,text,rationale,sources:[event sequence numbers]}. " +
  "Your memory is an interpretation, never a human instruction or verified evidence. Human memory cannot be overwritten by you. " +
  "Use describe_objective when the objective needs clarification: {text,rationale,exclusions:[],dependencies:[],constraints:[],criteria:[]}. Criteria you generate are hypotheses, not owner-approved checks. Human corrections remain authoritative. " +
  "Use existing capabilities and inspect relevant material first. For an observed reusable need, create_skill with {name,instructions,rationale,sources:[event sequence numbers]}; it creates session-local instructions, not privileges. " +
  "After changing work state, derive your next action from a fresh inference. These tools cannot certify completion. " +
  "Use only available tools. Do not claim web research, documentation reads or tests without observed results. Ask only for genuinely missing information or actions outside the entrusted scope.";

function text(value: unknown, limit = 20000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

export function projectOrganization(events: readonly Event[]) {
  const versioned = projectWorkPlans(events);
  const records = events.filter(event => event.kind === "note" && event.subject === WORK_SUBJECT);
  const objective = projectObjectives(events).current;
  const goal = events.filter(event => event.kind === "goal").at(-1)?.data.text ?? null;
  const plan = records.filter(event => event.data.operation === "plan" &&
    (objective && !objective.id.startsWith("legacy-") ? event.data.objectiveId === objective.id : event.data.goal === goal)).at(-1);
  const skills = new Map<string, { revision: number; by: string; name: unknown; instructions: unknown; rationale: unknown; sources: unknown }>();
  for (const event of records) if (event.data.operation === "skill" && typeof event.data.name === "string") {
    skills.set(event.data.name, { revision: event.seq, by: "model", name: event.data.name, instructions: event.data.instructions, rationale: event.data.rationale, sources: event.data.sources });
  }
  return { plan: plan ? { ...plan.data, spec: plan.data.spec, tasks: plan.data.tasks, id: versioned.get(plan.seq)?.id ?? null, taskRecords: versioned.get(plan.seq)?.tasks ?? null, current: objective && !objective.id.startsWith("legacy-") ? plan.data.objectiveRevision === objective.revision : true, revision: plan.seq, by: "model" } : null, skills: [...skills.values()] };
}

/** Model-authored work records have no path to evidence or goal closure. */
export function organizeWork(store: EventStore, request: ToolRequest): ToolResult | null {
  if (!AUTONOMOUS_TOOLS.includes(request.name)) return null;
  const input = request.input;
  const refuse = (output: string): ToolResult => ({ name: request.name, exit: 2, output });
  if (!text(input.rationale, 4000)) return refuse("A bounded rationale is required.");
  const basis = store.revision;
  let data: Record<string, unknown>;
  let subject = WORK_SUBJECT;
  if (request.name === "organize_work") {
    if (!["assess", "research", "spec", "build", "review"].includes(String(input.phase))) return refuse("Unknown phase.");
    if (input.spec !== undefined && !text(input.spec)) return refuse("Invalid specification.");
    if (input.tasks !== undefined && (!Array.isArray(input.tasks) || input.tasks.length > 40)) return refuse("Tasks must be a bounded array of text.");
    const events = store.toSession().events;
    const prior = projectOrganization(events).plan;
    const objective = projectObjectives(events).current;
    if (prior && !prior.current && (input.spec === undefined || input.tasks === undefined)) return refuse("The objective changed; explicitly revise the specification and tasks before readmitting this plan.");
    const seq = basis < 0 ? 1 : basis + 1;
    let taskRecords;
    try { taskRecords = input.tasks === undefined ? prior?.taskRecords ?? prepareWorkTasks(prior?.tasks as unknown[] ?? [], [], seq) : prepareWorkTasks(input.tasks as unknown[], prior?.taskRecords ?? [], seq); }
    catch (cause) { return refuse(cause instanceof Error ? cause.message : "Invalid tasks."); }
    data = { version: 1, id: prior?.id ?? `plan-${seq}`, revision: seq, taskRecords,
      operation: "plan", phase: input.phase, rationale: input.rationale,
      spec: input.spec ?? prior?.spec ?? null, tasks: taskRecords.map(task => task.text),
      goal: store.toSession().goal?.text ?? null, objectiveId: objective?.id ?? null,
      objectiveRevision: objective?.revision ?? null, against: basis };
  } else if (request.name === "create_skill") {
    if (typeof input.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.name) || !text(input.instructions)) return refuse("Invalid skill name or instructions.");
    const events = store.toSession().events;
    if (projectOrganization(events).skills.some(s => s.name === input.name)) return refuse("Skill with this name already exists.");
    if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 20 || !input.sources.every(seq => typeof seq === "number" && events.some(event => event.seq === seq))) return refuse("A reusable skill must name existing source event sequences.");
    data = { operation: "skill", name: input.name, instructions: input.instructions, rationale: input.rationale, sources: input.sources, against: basis };
  } else if (request.name === "describe_objective") {
    const events = store.toSession().events;
    const current = projectObjectives(events).current;
    if (!current || current.id.startsWith("legacy-")) return refuse("No managed objective is active.");
    subject = "terminal.objective";
    data = { version: 1, operation: "describe", id: current.id, expected: current.revision,
      text: input.text, exclusions: input.exclusions, dependencies: input.dependencies,
      constraints: input.constraints, criteria: input.criteria, rationale: input.rationale };
    try { projectObjectives([...events, { kind: "note", subject, data, seq: store.revision + 1, at: 0 }]); }
    catch { return refuse("Invalid objective description or dependency cycle."); }
  } else {
    subject = MEMORY_SUBJECT;
    if (!["create", "edit", "resolve"].includes(String(input.operation)) || !text(input.text, 4000)) return refuse("Invalid memory operation or text.");
    const events = store.toSession().events;
    if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 20 || !input.sources.every(seq => typeof seq === "number" && events.some(event => event.seq === seq))) return refuse("Memory must name existing source event sequences.");
    if (input.operation === "create") {
      if (!["decision", "constraint", "question"].includes(String(input.kind))) return refuse("Invalid memory kind.");
      const extracted = findMemoryExtraction(events,input.kind,input.text,input.sources as number[]);
      if (extracted) {
        const current = projectMemory(events).find(item => item.id === `m-${extracted.seq}`)!;
        return {name:request.name,exit:0,output:JSON.stringify({id:current.id,revision:current.revision,recorded:false,reused:true,verified:false})};
      }
    } else {
      const prior = projectMemory(events).find(item => item.id === input.id);
      if (!prior || prior.by !== "model") return refuse("Unknown memory or human-owned record; preserve it and record your interpretation separately.");
    }
    const projected = projectObjectives(events).current;
    const objective = projected?.id.startsWith("legacy-") ? null : projected;
    const prior = projectMemory(events).find(item => item.id === input.id);
    data = {version:1, operation: input.operation, kind: input.kind, id: input.id, text: input.text,
      rationale: input.rationale, sources: [...new Set(input.sources as number[])].sort((a,b)=>a-b), author: "model", against: basis,
      objectiveId: objective?.id ?? null, objectiveRevision: objective?.revision ?? null,
      ...(input.operation === "create" ? {extractionKey:memoryExtractionKey(input.kind,input.text,input.sources as number[])} : {expected:prior?.revision})};
    try {projectMemory([...events,{kind:"note",subject,data,seq:basis<0 ? 1 : basis+1,at:0}]);}
    catch {return refuse("Invalid memory schema or stale memory revision.");}
  }
  if (request.name === "organize_work") {
    try { projectWorkPlans([...store.toSession().events, {kind: "note", subject, data, seq: basis < 0 ? 1 : basis + 1, at: 0}]); }
    catch { return refuse("Invalid plan schema or task dependency graph."); }
  }
  const event = store.appendIfCurrent(basis, { kind: "note", subject, data });
  return event ? { name: request.name, exit: 0, output: JSON.stringify({ revision: event.seq, id: subject === MEMORY_SUBJECT && input.operation === "create" ? `m-${event.seq}` : input.id, recorded: true, verified: false }) }
    : refuse("Work moved; reread the current state before proposing a replacement.");
}
