import {ProviderProposalRefused} from './opencode-stream.ts';
import {randomUUID, createHash} from 'node:crypto';
import type {ContextFrame, ModelAdapter, ToolRunner, ToolResult, ModelProgress} from '../core/loop.ts';
import type {Event, NewEvent} from '../core/store.ts';
import type {PreparedCodeWorker} from './code-worker-workspaces.ts';

export type CodeWorkerResult = {phase:'proposal'|'exhausted'|'stale'|'cancelled'|'failed'|'uncertain'; text:string; steps:number};
const forbidden = new Set(['git','finish','prepare_workspace','integrate_workspace','reconcile_effect','consult_agents',
  'organize_work','remember','create_skill','describe_objective']);
/** Owner-supplied append is a private durable journal; tools are already scoped. */
export async function runCodeWorker(options: {
  worker: PreparedCodeWorker; tools: ToolRunner; allow: readonly string[]; maxSteps: number;
  frame(step: number): ContextFrame; signal: AbortSignal; current(): boolean;
  maxFrameChars?: number;
  inferenceTimeoutMs?: number;
  /** Parent-owned, bounded help. It carries no file or delegation authority. */
  consult?(input:Record<string,unknown>):Promise<ToolResult>;
  /** Controller compiles shared context after every child-specific field exists. */
  finalizeFrame?(frame:ContextFrame):ContextFrame;
  /** Controller observation, never a model claim. False redirects within the same budget. */
  hasContribution?(): Promise<boolean>;
  /** Optional current owner criterion for a single-worker candidate, not goal closure. */
  contributionReady?(): Promise<boolean>;
  append(event: NewEvent): Event;
}): Promise<CodeWorkerResult> {
  let steps=0, effectPending=false, consecutiveFailures=0;
  const allowed=new Set(options.allow.filter(name=>!forbidden.has(name)));
  if(options.consult)allowed.add('consult_agents');
  const current=()=>!options.signal.aborted&&options.current();
  const outcome=(phase:CodeWorkerResult['phase'],text=''):CodeWorkerResult=>({phase,text,steps});
  const stale=()=>outcome(options.signal.aborted?'cancelled':'stale');
  if(!Number.isSafeInteger(options.maxSteps)||options.maxSteps<1||options.maxSteps>8) return outcome('failed');
  const maxFrameChars=options.maxFrameChars??48000;
  if(!Number.isSafeInteger(maxFrameChars)||maxFrameChars<4000)return outcome('failed');
  const inferenceTimeoutMs=options.inferenceTimeoutMs??60000;
  if(!Number.isSafeInteger(inferenceTimeoutMs)||inferenceTimeoutMs<1||inferenceTimeoutMs>300000)return outcome('failed','Invalid worker inference timeout.');
  let timedOut=false;
  try {
    while(steps<options.maxSteps){
      if(!current())return stale();
      const source=options.frame(++steps);
      const childFrame:ContextFrame={...source, goal:options.worker.packet.task, capabilities:source.capabilities.filter(capability=>allowed.has(capability.name)),
        directives:[...source.directives.filter(d=>!/^tools:/.test(d.text)),
          {seq:Number.MAX_SAFE_INTEGER-2,at:Date.now(),target:'builder',applied:false,text:`Parent objective (context only): ${source.goal}. The controller owns delegation, supervision, integration and independent verification. Execute only your admitted code-worker packet; do not try to delegate a worker or invoke integration tools.`},
          {seq:Number.MAX_SAFE_INTEGER,at:Date.now(),target:'builder',applied:false,text:`tools: ${[...allowed].join(', ')}`},
          {seq:Number.MAX_SAFE_INTEGER-1,at:Date.now(),target:'builder',applied:false,
            text:`Code worker ${options.worker.packet.role}: ${options.worker.packet.task}\nResponsibilities: ${options.worker.packet.files.join(', ')}\nController-selected workspace: ${options.worker.path}. Your output is an unverified contribution. The controller owns delegation, supervision, integration and verification. Propose allowed file-editing tools for your packet only; do not wait for controller tools. No goal closure or integration authority.\nInference budget: ${steps}/${options.maxSteps}. Inspect only the admitted files and necessary dependencies; avoid broad directory inventories. For a new file, create its parent directory if needed using an allowed editing tool rather than probing missing directories. Reserve budget for writing and checking. ${options.consult?'You may request bounded advice with consult_agents {tasks:[{role:slug,task:question}]}; the controller selects helpers and records unverified advice. Help adds no file permissions.':''} ${allowed.has('check_types')?'Static verification: check_types {project:relative tsconfig path}, no installation or project scripts.':''}`}]};
      const frame=options.finalizeFrame?options.finalizeFrame(childFrame):childFrame;
      if(frame.goal!==options.worker.packet.task || JSON.stringify(frame).length>maxFrameChars)return outcome('failed','Worker context exceeds the owner frame ceiling; no inference was sent and no instruction was silently dropped.');
      let stop=()=>{};
      const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(options.signal.reason);options.signal.addEventListener('abort',stop,{once:true});if(options.signal.aborted)stop();});
      let response;
      const deadline=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;deadline.abort(new Error('Worker inference deadline reached.'));reject(new Error('Worker inference deadline reached.'));},inferenceTimeoutMs);});
      try {response=await Promise.race([(options.worker.adapter as ModelAdapter & {infer(frame:ContextFrame,signal?:AbortSignal,onProgress?:(progress:ModelProgress)=>void):ReturnType<ModelAdapter['infer']>}).infer(frame,AbortSignal.any([options.signal,deadline.signal]),()=>{}),aborted,timeout]);}
      finally {if(timer)clearTimeout(timer);options.signal.removeEventListener('abort',stop);}
      if(!current())return stale();
      // Validate the entire response before executing even its first call.
      if(!Array.isArray(response.toolCalls)||response.toolCalls.length>8||response.toolCalls.some(call=>
        !call||!allowed.has(call.name)||!call.input||typeof call.input!=='object'||Array.isArray(call.input))){
        const diagnostic=`The worker proposed an invalid or unavailable tool batch. No call from this inference was executed. Allowed tools: ${[...allowed].join(', ')}. Return toolCalls as an array of {name,input}; input must be an object. Command tools require input.argv starting with the tool name. Correct only your admitted packet; do not delegate or integrate.`;
        options.append({kind:'observation',subject:'terminal.code-worker-supervision',data:{exit:126,output:diagnostic}});
        if(steps===options.maxSteps)return outcome('failed',diagnostic);
        continue;
      }
      // 90% budget warning: notify the controller before the last tool-capable call
      if(steps >= Math.ceil(0.9 * options.maxSteps)){
        options.append({kind:'observation',subject:'terminal.supervision',data:{type:'budgetWarning',message:'90% of inference budget reached'}});
      }
      if(response.toolCalls.length===0){
        if(options.contributionReady){
          let ready:boolean;try{ready=await options.contributionReady();}catch{return outcome('uncertain','Candidate inspection is unconfirmed.');}
          if(!current())return stale();
          if(ready)return outcome('proposal','Controller candidate criteria passed; integration and source verification remain pending.');
        }
        if(options.hasContribution){
          let changed:boolean;
          try{changed=await options.hasContribution();}catch{return outcome('uncertain','Controller could not inspect the code contribution.');}
          if(!current())return stale();
          if(!changed){
            options.append({kind:'observation',subject:'terminal.code-worker-supervision',data:{
              exit:126,output:'No code change was observed. Your text is not a contribution. Inspect the declared files and propose the next allowed tool call to perform the requested change; do not return a prose-only completion.',
              proposal:typeof response.text==='string'?response.text.slice(0,8000):''}});
            continue;
          }
        }
        return outcome('proposal',typeof response.text==='string'?response.text.slice(0,8000):'');
      }
      for(const request of response.toolCalls){
        if(!current())return stale();
        const effectId=`${options.worker.id}:${randomUUID()}`;
        const intent=options.append({kind:'action',subject:'terminal.intent',data:{version:1,phase:'requested',tool:request.name,input:request.input,effectId,scopeCwd:options.worker.path}});
        effectPending=true;
        // Append callbacks may themselves observe a new human revision.
        if(!current())return outcome('uncertain','An admitted effect has no confirmed completion receipt. Inspect the preserved private journal before retrying.');
        const result=request.name==='consult_agents'
          ? await options.consult!(request.input)
          : await options.tools.run(request);
        if(result.exit===null||!Number.isInteger(result.exit))return outcome('uncertain','An admitted effect has no confirmed completion receipt. Inspect the preserved private journal before retrying.');
        options.append({kind:'note',subject:'terminal.receipt',data:{version:1,operation:'completed',intentSeq:intent.seq,tool:request.name,exit:result.exit,digest:createHash('sha256').update(result.output).digest('hex')}});
        effectPending=false;
        options.append({kind:'observation',subject:'builder',data:{tool:request.name,exit:result.exit,output:result.output.slice(0,16000)}});
        if(!current())return stale();
        if(result.exit!==0&&request.name!=='consult_agents')return outcome('failed',`${request.name} failed with exit ${result.exit}: ${result.output.slice(0,1600)}`);
      }
      if(options.contributionReady){
        let ready:boolean;try{ready=await options.contributionReady();}catch{return outcome('uncertain','Candidate inspection is unconfirmed.');}
        if(!current())return stale();
        if(ready)return outcome('proposal','Controller candidate criteria passed; integration and source verification remain pending.');
      }
      // Heartbeat: signal worker is still alive and making progress
      options.append({kind:'note',subject:'terminal.work.heartbeat',data:{step:steps, maxSteps:options.maxSteps, task: options.worker.packet.task}});
    }
    return outcome('exhausted',`The ${options.maxSteps}-inference budget was exhausted; inspect the preserved workspace and receipts. No completion was established.`);
  }catch(error){return effectPending?outcome('uncertain','An admitted effect or its receipt is unconfirmed. Inspect the private journal before retrying.'):!current()?stale():outcome('failed',error instanceof ProviderProposalRefused?error.message:timedOut?`The provider did not answer within ${inferenceTimeoutMs}ms. The inference was cancelled; completed effects and the private workspace remain preserved.`:'Worker inference or journal publication failed. Earlier completed effects remain preserved in the private journal; inspect them before retrying. No completion was established.');}
}
