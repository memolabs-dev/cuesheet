import {createSituation} from '../../../../src/adapters/situation.ts';
/**
 * The real adapters, in one place.
 *
 * Separated from `producer/index.ts` so the producer's own logic can be driven by
 * fakes with no provider key and no shell, and so the list of things this surface
 * is allowed to touch the world with is a single readable block rather than a
 * detail spread across the producer.
 *
 * ## On credentials
 *
 * The launcher (`src/surface-cli.ts`) used to pass only `PATH`, `HOME` and `TERM`,
 * and the comment claimed the surface "starts no model and touches no network".
 * That was true of V1 and is false now: the producer runs the real loop, and the
 * loop needs a model.
 *
 * What changed is which model. The surface used to refuse to build a producer
 * without `OPENROUTER_API_KEY` and say so, which made a live run impossible on a
 * machine with no OpenRouter account. It now resolves a model the same way every
 * other surface does, which on a machine with the local binary installed is that
 * binary, using its configured account. `OPENROUTER_API_KEY` is still forwarded, and a
 * person chooses a transport with `--provider` or `CUESHEET_PROVIDER`.
 *
 * The binary proposes and this surface's own tool runner acts. That is the whole
 * safety argument, and it is measured rather than assumed: see
 * `docs/MB-01-local-binary-transport.md`.
 *
 * ## On the tool allowlist
 *
 * Seven commands, the same seven `src/chat.ts:213` uses. Not a sandbox: a
 * constraint. The runner refuses a path outside the roots, and the producer roots
 * the run at the directory the person is standing in, so a sentence cannot widen
 * its own scope by naming a directory.
 */

import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { TerminalSession, terminalSessionRoot } from "../../../../src/adapters/terminal-session.ts";
import { persistentView } from "./session-view.ts";
import type { CompletionCheck } from "../../../../src/adapters/surface-verification.ts";
import { homedir } from "node:os";
import { join, delimiter, resolve, isAbsolute } from "node:path";
import { createCompletionCheck } from "../../../../src/adapters/surface-verification.ts";
import { createModelBinding, type ModelBinding } from "../../../../src/adapters/model-binding.ts";
import { resolveModel } from "../../../../src/adapters/default-model.ts";
import { ShellToolRunner } from "../../../../src/adapters/shell.ts";
import { SessionContainers } from "../../../../src/adapters/container-receipts.ts";
import { invocationKey } from "../../../../src/adapters/tool-receipts.ts";
import { createToolRouteSelector,DEFAULT_CONTAINER_TOOLS } from "../../../../src/adapters/tool-route.ts";
import { ContainerToolRunner } from "../../../../src/adapters/container-tools.ts";
import { ResearchTools } from "../../../../src/adapters/research-tools.ts";
import { SessionUsage, type UsageReceipt } from "../../../../src/adapters/model-usage.ts";
import { ProjectVaultPublisher } from "../../../../src/adapters/vault-publisher.ts";
import { VaultRetrieval } from "../../../../src/adapters/vault.ts";
import { SharedContexts,sharedScope } from "../../../../src/adapters/shared-memory.ts";
import { SkillTools } from "../../../../src/adapters/skill-tools.ts";
import type { ModelAdapter, ToolRunner } from "../../../../src/core/loop.ts";
import { createProducer, type Producer, type ProducerOptions } from "./index.ts";
import type { Store } from "../app/store.ts";

/** The commands the surface may run, rooted at the resolved directory. */
export const ALLOWED = ["node", "git", "rg", "ls", "cat", "npm", "npx", "cargo"];

/**
 * The model a run uses, and the sentence that says why.
 *
 * Exported because a surface that cannot name its own model cannot have its log
 * read back honestly. The value is resolved per run rather than fixed here: the
 * old hardcoded id named a provider this machine does not use, and a constant is
 * not a fact about a machine.
 */
export function modelFor(cwd: string): { name: string; model: string | null; why: string } {
  const resolved = resolveModel({ project: cwd });
  if ("missing" in resolved) return { name: "none", model: null, why: resolved.missing };
  return { name: resolved.name, model: resolved.model, why: resolved.why };
}

/**
 * Build one producer with a switchable model binding.
 *
 * A missing model remains selectable in the UI without replacing this producer.
 * App gates task submission on binding.missing. A broken owner check still
 * refuses construction, because model selection cannot repair that check.
 */
export function createLiveProducer(store: Store, cwd: string, settings: { journal?: TerminalSession; verification?: CompletionCheck; binding?: ModelBinding; identities?:ProducerOptions['identities']; onUsage?:(receipt:UsageReceipt)=>void } = {}): { producer: Producer; binding: ModelBinding } | { missing: string } {
  const projectsRoot=process.env.CUESHEET_PROJECTS_ROOT;
  if(projectsRoot!==undefined&&(!isAbsolute(projectsRoot)||/[\0\r\n]/.test(projectsRoot)))return {missing:"CUESHEET_PROJECTS_ROOT must be an absolute directory path."};
  let situation;try{situation=createSituation();}catch{return {missing:"Contexte de situation invalide : vérifier fuseau, langue et labels configurés."};}
  const contextBudgetChars=process.env.CUESHEET_CONTEXT_CHARS===undefined ? undefined : Number(process.env.CUESHEET_CONTEXT_CHARS);
  if(contextBudgetChars!==undefined && (!Number.isSafeInteger(contextBudgetChars) || contextBudgetChars<4000))return {missing:"CUESHEET_CONTEXT_CHARS must be an integer of at least 4000."};
  const maxSlices=process.env.CUESHEET_MAX_SLICES===undefined ? 4 : Number(process.env.CUESHEET_MAX_SLICES);
  if(!Number.isSafeInteger(maxSlices) || maxSlices<1 || maxSlices>16)return {missing:"CUESHEET_MAX_SLICES must be an integer from 1 to 16."};
  const usage=settings.journal ? new SessionUsage({root:settings.journal.root,sessionId:settings.journal.metadata.id,assertWritable:()=>settings.journal!.assertWritable()}) : undefined;
  const onUsage=(receipt:UsageReceipt)=>{usage?.record(receipt);settings.onUsage?.(receipt);};
  const binding = settings.binding ?? createModelBinding({ project: cwd,onUsage });
  const model: ModelAdapter = binding.adapter;
  const selectRoute=createToolRouteSelector({home:homedir(),enterprise:!!process.env.CUESHEET_CONTEXT_ROOTS?.split(delimiter).filter(Boolean).length,mode:process.env.CUESHEET_TOOL_MODE,image:process.env.CUESHEET_TOOL_IMAGE,socket:process.env.CUESHEET_TOOL_SOCKET});
  let verification;
  try {
    const script = process.env.CUESHEET_VERIFY_SCRIPT;
    verification = settings.verification ?? (script ? createCompletionCheck({ script, root: join(homedir(), ".local", "state", "cuesheet", "verification"),containerSocket:(()=>{const route=selectRoute();return route.kind==="container"?route.socket:undefined;})() }) : undefined);
  } catch (error) {
    return { missing: `The declared check could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  const toolsForScope=(scope:string,resourceJournal=settings.journal):ToolRunner=>createScopedToolRunner({scope,journal:resourceJournal,route:selectRoute(),protectedPaths:verification?.pinned?[verification.pinned.script]:[]});
  let tools:ToolRunner;
  try {tools=toolsForScope(cwd);} catch {return {missing:"Tool route is invalid or its resource journal is damaged; verify mode, local Unix socket, immutable image and session resources."};}
  const researchForScope=(scope:string)=>new ResearchTools({root:scope,provider:process.env.CUESHEET_SEARCH_PROVIDER,apiKey:process.env.BRAVE_SEARCH_API_KEY});
  const research=researchForScope(cwd);
  const configuredSkillRoots=process.env.CUESHEET_SKILL_ROOTS?.split(delimiter).filter(Boolean);
  const skillsForScope=(scope:string)=>new SkillTools({roots:configuredSkillRoots ?? [join(scope,".cuesheet","skills")]});
  const skills=skillsForScope(cwd);
  const sharedContexts=new SharedContexts({cwd,organizations:process.env.CUESHEET_CONTEXT_ROOTS?.split(delimiter).filter(Boolean)});
  const organizationRoots=process.env.CUESHEET_CONTEXT_ROOTS?.split(delimiter).filter(Boolean)??[];
  const vaultForScope=(scope:string)=>new VaultRetrieval({principal:"local-owner",scopes:[{kind:"project",id:sharedScope("project",scope).id,root:join(scope,".cuesheet","vault")},...organizationRoots.map(root=>({kind:"enterprise" as const,id:sharedScope("organization",root).id,root:join(resolve(root),"vault")}))],authorize:()=>true});
  const vaultPublisherForScope=settings.journal ? (scope:string)=>new ProjectVaultPublisher({root:join(scope,".cuesheet","vault"),scope,sessionId:settings.journal!.metadata.id,assertWritable:()=>settings.journal!.assertWritable()}) : undefined;
  const agentCredentials={...process.env};for(const key of ['CUESHEET_PROVIDER','CUESHEET_MODEL','CUESHEET_BASE_URL','CUESHEET_MAX_TOKENS'])delete agentCredentials[key];
  const agentModel=(selection:import('../../../../src/adapters/model-preferences.ts').ModelPreferences,scope:string)=>{const resolved=resolveModel({project:scope,preferences:{},env:agentCredentials,provider:selection.provider,model:selection.model??null,baseUrl:selection.baseUrl,maxTokens:selection.maxTokens,onUsage:usage?.record});if('missing' in resolved)throw Error(resolved.missing);return {adapter:resolved.adapter,label:`${resolved.name} · ${resolved.model??"modèle configuré"}`};};
  const toolsForWorker=(scope:string,journal:TerminalSession,signal:AbortSignal):ToolRunner=>{const runner=toolsForScope(scope,journal);return Object.assign({run:(request:Parameters<ToolRunner["run"]>[0])=>(runner as ToolRunner&{run(request:Parameters<ToolRunner["run"]>[0],signal?:AbortSignal):ReturnType<ToolRunner["run"]>}).run(request,signal)},{names:(runner as ToolRunner&{names?:readonly string[]}).names??[]});};
  const workerModel=(scope:string)=>agentModel(binding.selection,scope);
  const options: ProducerOptions = {identities:settings.identities,onUsage,projectsRoot,toolsForWorker,workerModel,worktreeRoot:settings.journal?join(settings.journal.root,"workspaces",settings.journal.metadata.id):undefined,situation,agentModel,modelLabel:()=>binding.label,vaultPublisherForScope,vaultForScope,toolsForScope,researchForScope,skillsForScope,sharedContexts, store, journal: settings.journal, model, tools, cwd, toolNames: ALLOWED, verification, contextBudgetChars, research, skills, maxSlices };
  return { producer: createProducer(options), binding };
}
/** Acquire storage before building any live adapter. Loading never starts work. */
export function createTerminalRuntime(cwd: string, id?: string): { store: Store; producer: Producer; binding: ModelBinding; session: TerminalSession } | { missing: string } {
  let session: TerminalSession | undefined;
  try {
    const root = terminalSessionRoot();
    const proofRoot = join(homedir(), ".local", "state", "cuesheet", "verification");
    const declared = process.env.CUESHEET_VERIFY_SCRIPT;
    const checkRoute=createToolRouteSelector({home:homedir(),enterprise:!!process.env.CUESHEET_CONTEXT_ROOTS?.split(delimiter).filter(Boolean).length,mode:process.env.CUESHEET_TOOL_MODE,image:process.env.CUESHEET_TOOL_IMAGE,socket:process.env.CUESHEET_TOOL_SOCKET})();
    const containerSocket=checkRoute.kind==="container"?checkRoute.socket:undefined;
    let verification = declared ? createCompletionCheck({script:declared,root:proofRoot,containerSocket}) : undefined;
    session = new TerminalSession({root,cwd,id,check:verification?.pinned});
    if (session.metadata.check) {
      const check = session.metadata.check;
      if(createHash("sha256").update(readFileSync(check.script)).digest("hex")!==check.digest) throw new Error("Le critère sauvegardé ne correspond plus à son empreinte. Reprise refusée.");
      verification = createCompletionCheck({script:check.script,root:proofRoot,containerSocket});
    }
    const store = persistentView(session);
    const usage=new SessionUsage({root:session.root,sessionId:session.metadata.id,assertWritable:()=>session!.assertWritable()});
    const notifySurface = (): void => {
      const requests=usage.read();
      let inputTokens=0,outputTokens=0,observed=0;
      for(const r of requests){if(r.status!=="observed")continue;observed+=1;inputTokens+=r.inputTokens??0;outputTokens+=r.outputTokens??0;}
      const costCents=Math.round((inputTokens*0.3+outputTokens*1.5)/1000);
      store.send({type:"consumed",inputTokens,outputTokens,requests:observed,costCents});
    };
    const onUsage=(receipt:UsageReceipt)=>{usage.record(receipt);notifySurface();};
    const binding = createModelBinding({project:session.metadata.cwd,preferences:session.lastModel,onUsage});
    const live = createLiveProducer(store,session.metadata.cwd,{journal:session,verification,binding,onUsage});
    if("missing" in live) throw new Error(live.missing);
    if(!binding.missing) live.producer.modelSelected?.(binding.selection);
    store.send({type:"logged",line:`[session] ${session.metadata.id} ${session.metadata.cwd}`});
    return {store,producer:live.producer,binding,session};
  } catch(error) {session?.close();return {missing:error instanceof Error ? error.message : String(error)};}
}

/** Same scoped admission factory for controller and private worker journals. */
export function createScopedToolRunner(options:{scope:string;journal?:TerminalSession;route:import("../../../../src/adapters/tool-route.ts").ToolRoute;protectedPaths?:string[]}):ToolRunner{
  const {scope,journal:resourceJournal,route}=options;const protectedPaths=options.protectedPaths??[];
    const containers=resourceJournal ? new SessionContainers({root:resourceJournal.root,sessionId:resourceJournal.metadata.id,assertWritable:()=>resourceJournal.assertWritable()}) : undefined;
    if(route.kind==="unavailable")return {names:[],policy:route.reason,async run(request){return {name:request.name,exit:126,output:route.reason};}} as ToolRunner;
    if(route.kind==="local")return Object.assign(new ShellToolRunner({allow:ALLOWED,roots:[scope],defaultCwd:scope}),{policy:route.reason,names:Object.freeze(ALLOWED.slice())});
    try{containers?.read();}catch{throw new Error("Container resource journal is damaged; inspect it before starting tools.");}
    const image=route.image;
    // Linked worktree metadata lives outside the one mounted scope. Advertising
    // git here sends the model into an inspection loop it cannot resolve.
    let linkedWorktree=false;
    try { linkedWorktree=lstatSync(join(scope,".git")).isFile(); } catch {}
    const allow=(route.defaultImage ? [...DEFAULT_CONTAINER_TOOLS] : [...ALLOWED]).filter(name=>!linkedWorktree||name!=="git");
    const runner=new ContainerToolRunner({allow,roots:[scope],defaultCwd:scope,image,socket:route.socket,
      onAdmission:(name,request)=>{
        if(!containers||!resourceJournal)throw new Error("Container execution requires a durable terminal session.");
        const digest=invocationKey(request.name,request.input);
        const intent=resourceJournal.core.toSession().events.filter(e=>e.kind==="action"&&e.subject==="terminal.intent"&&e.data.tool===request.name&&e.data.scopeCwd===scope&&invocationKey(request.name,e.data.input as Record<string,unknown>)===digest).at(-1);
        if(!intent)throw new Error("Container execution lacks an admitted intent.");
        containers.record({phase:"admitted",name,image,scope,intentSeq:intent.seq,inputDigest:digest});
      },onCleanup:(name,removed)=>containers!.record({phase:"cleanup",name,removed}),
      protectedPaths:[...(resourceJournal?[resourceJournal.root]:[]),...protectedPaths]});
    if(linkedWorktree)Object.assign(runner,{policy:runner.policy+" Git non disponible dans ce worktree conteneur : métadonnées hors périmètre monté. Le contrôleur garde la préparation et l’intégration vérifiée."});
    return Object.assign(runner,{requiresIsolatedWorkspace:true});
}
