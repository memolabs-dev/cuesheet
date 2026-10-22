import {Work} from '../overlays/Work.tsx';
import {Changes} from '../overlays/Changes.tsx';
import {MotionContext} from "../theme/motion.tsx";
import {findCommand} from "./commands.ts";
import {AgentModels} from '../overlays/AgentModels.tsx';
/**
 * The shell: header, timeline, composer, status bar.
 *
 * Layout, and the reason for it:
 *
 * ```text
 *   cuesheet                          cuesheet              ◇ ready
 *   ────────────────────────────────────────────────────────────────────
 *
 *   ( conversation, scrolling, the only part that grows )
 *
 *   ────────────────────────────────────────────────────────────────────
 *   › _
 *   ────────────────────────────────────────────────────────────────────
 *   3 files · 0 modified                                       ⌘K palette
 * ```
 *
 * Two rules that decided the shape:
 *
 * 1. The composer is permanent and always at the bottom. An interface that hides
 *    the place you type in, or that puts it at the top of a growing log, is a log
 *    with a text field in it.
 *
 * 2. One frame. Not a dashboard of panels: a column, with two hairlines and a
 *    status line. The temptation in a terminal is always to fill the space, and
 *    filling the space is how this becomes fifteen boxes.
 *
 * ## What changed in V2
 *
 * The state moved out of `useState` and into a store the producer owns
 * (`app/store.ts`), read here through `useSyncExternalStore`. The reason is
 * mechanical: the loop's `onEvent` fires from a promise continuation outside
 * React, so a reducer driven by a keypress callback cannot represent a streaming
 * run.
 *
 * And `submit` no longer carries a `TurnIntent`. It carries the sentence. There
 * is no classifier between the composer and the producer, so there is no phrase
 * that can produce "name a project", and no branch that can answer a sentence
 * before anybody has tried to do the work.
 *
 * Every component below receives state and emits a control. None of them decides
 * anything, and none of them reads the filesystem.
 */

import React, { useCallback, useMemo, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, useStdin } from "ink";
import { useSurface } from "./store.ts";
import type { Control, SurfaceState, WorkReference } from "./state.ts";
import { theme, glyph, inkColor } from "../theme/tokens.ts";
import { Header } from "../components/Header.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { Composer } from "../components/Composer.tsx";
import { Activity } from "../components/Activity.tsx";
import {contextLines} from '../components/WorkContext.tsx';
import { StatusBar } from "../components/StatusBar.tsx";
import { Projects } from "../overlays/Projects.tsx";
import { Inspect } from "../overlays/Inspect.tsx";
import { Palette } from "../overlays/Palette.tsx";
import { Help } from "../overlays/Help.tsx";
import { createStore, type Store } from "./store.ts";
import { Models } from "../overlays/Models.tsx";
import { listModels } from "../../../../src/adapters/model-catalog.ts";
import type { ModelBinding } from "../../../../src/adapters/model-binding.ts";
import { Sessions } from "../overlays/Sessions.tsx";
import { listTerminalSessions, type TerminalSession } from "../../../../src/adapters/terminal-session.ts";
import { createLiveProducer, createTerminalRuntime } from "../producer/runtime.ts";
import type { Producer } from "../producer/index.ts";
import type { Option } from "./state.ts";
import { windowTitle, oscTitle } from "./window-title.ts";

/**
 * The window title names the work, so a shell full of terminals says which one
 * is busy. Only a real terminal receives the escape sequence: a pipe, a file or
 * a test stream is not a title surface, and writing control bytes into it would
 * pollute the captured frame instead of decorating a titlebar.
 *
 * The title is set and then left alone. Handing it back on exit would be a
 * write during Ink's own teardown, where the renderer drops it; most shells set
 * their own title in the prompt anyway, and an empty payload would leave a
 * blank titlebar where a shell does not.
 */
function useTerminalTitle(stdout:{isTTY?:boolean;write?:(chunk:string)=>unknown}|undefined,title:string):void {
  const written=useRef<string|null>(null);
  useEffect(()=>{
    if(!stdout?.isTTY||typeof stdout.write!=="function")return;
    if(written.current===title)return;
    written.current=title;
    stdout.write(oscTitle(title));
  },[stdout,title]);
}

export interface AppProps {
  /**
   * Injected so a test can drive the whole shell headlessly.
   *
   * Omitted in production, where the real adapters are built and, when there is
   * no provider key, the reason is shown in the timeline instead of a run that
   * cannot finish.
   */
  readonly store?: Store;
  readonly producer?: Producer;
  /** Overrides the working directory. A test never reads the real machine. */
  readonly cwd?: string;
}

export function App(props: AppProps): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const {stdin}=useStdin();
  const [, resized] = useState(0);
  useEffect(() => {
    const resize = () => resized((n) => n + 1);
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);

  // The store and the producer exist once, for the life of the process. They are
  // built outside the render body on purpose: a producer is not a value, and
  // rebuilding one per frame would mint a new session per keystroke.
  const initial = useMemo(() => wire(props), [props.store, props.producer, props.cwd]);
  const [replacement,setReplacement]=useState<ReturnType<typeof wire> | null>(null);
  const wired=replacement ?? initial;
  useEffect(()=>()=>wired.session?.close(),[wired]);
  const { store, producer, binding } = wired;
  const [motion,setMotion]=useState(process.env.CUESHEET_REDUCE_MOTION!=="1");
  const [paletteAction,setPaletteAction]=useState<string|undefined>();
  const [agentModelsMode,setAgentModelsMode]=useState(false);
  const [returnToWork,setReturnToWork]=useState(false);
  const [reference,setReference]=useState<{value:WorkReference;title:string}|null>(null);
  const [, changedModel] = useState(0);
  const missing = binding ? binding.missing : wired.missing;
  const modelName = binding ? binding.label : wired.modelName;
  const state = useSurface(store);

  /** The only path from a component to a decision. */
  const send = useCallback((control: Control) => {
    if(control.type==='close'&&returnToWork){setReturnToWork(false);store.send({type:'open',overlay:'work'});return;}
    store.send(control);
  }, [store,returnToWork]);
  const submit = useCallback((text: string) => {
    const said=text.trim();
    if(reference){
      const result=producer?.steerAt?.(reference.value,said)??{error:'Targeted correction unavailable. Esc detaches the target; your draft is preserved.'};
      if('error' in result){store.send({type:'noted',entry:{kind:'failure',text:result.error}});return;}
      setReference(null);store.send({type:'compose',text:''});return;
    }
    if(said.startsWith('/')&&!said.split(/\s/)[0]!.slice(1).includes('/')){
      const [token,...parts]=said.slice(1).split(/\s+/);const command=findCommand(token??'');const args=parts.join(' ');
      const refuse=(message:string)=>store.send({type:'noted',entry:{kind:'failure',text:message}});
      if(!command){refuse(`Unknown command /${token}. Use /help or /commands.`);return;}
      if(command.action==='native'||(command.name==='context'&&args)||(command.name==='check'&&args)){
        if(!producer){refuse('Runtime unavailable. Choose a model first.');return;}store.send({type:'compose',text:''});producer.say(said);return;
      }
      if(command.action==='steer'){
        if(!args){refuse('Usage: /steer TEXT');return;}
        if(!producer?.steer?.(args)){refuse('No current objective could be corrected. Your instruction is preserved.');return;}store.send({type:'compose',text:''});return;
      }
      if(command.action==='motion'){
        if(args&&!['on','off'].includes(args)){refuse('Usage: /motion on|off');return;}
        if(args)setMotion(args==='on');store.send({type:'compose',text:''});store.send({type:'noted',entry:{kind:'status',label:'motion',value:args|| (motion?'on':'off'),certainty:'confirmed'}});return;
      }
      if(args){refuse(`/${command.name} does not accept arguments. Use /help.`);return;}
      const action=command.action;
      if(action==='quit'){if(store.get().busy){refuse('Work is running. Use /stop before /quit.');return;}exit();return;}
      store.send({type:'compose',text:''});
      if(action==='stop'){producer?.cancel?.();return;}
      if(action==='resume'){producer?.resume?.();return;}
      if(action==='new'){loadSession();return;}
      if(action==='agent-models'){setAgentModelsMode(true);send({type:'open',overlay:'models'});return;}
      setAgentModelsMode(false);
      if(['help','models','sessions','inspect','changes','work'].includes(action)){send({type:'open',overlay:action as 'help'|'models'|'sessions'|'inspect'|'changes'|'work'});return;}
      setPaletteAction(action==='palette'?undefined:action);send({type:'open',overlay:'palette'});return;
    }
    if (missing) { store.send({ type: "submit", text }); return; }
    producer?.say(text);
  }, [producer, missing, store,motion,reference]);
  const catalog = useCallback((choice: Parameters<typeof listModels>[0], signal: AbortSignal) => listModels(choice, { signal }), []);

  const sessionChoices=useCallback(()=>listTerminalSessions(),[]);
  const loadSession=(id?:string)=>{
    setReturnToWork(false);
    if(store.get().busy) {store.send({type:"noted",entry:{kind:"failure",text:"Work is running. Stop it before loading another history."}});store.send({type:"close"});return;}
    if(id===wired.session?.metadata.id) {store.send({type:"close"});return;}
    const next=wire({...props,cwd:wired.session?.metadata.cwd ?? props.cwd,store:undefined,producer:undefined},id ?? null);
    if(next.missing && !next.producer) {store.send({type:"noted",entry:{kind:"failure",text:next.missing}});store.send({type:"close"});return;}
    setReference(null);
    setReplacement(next);
  };

  // Enter submits the composer as a turn. This is the whole input contract, and
  // it is here rather than in a component so that a component never sees a turn
  // at all.
  useInput((input, key) => {
    if((stdin as {pasteText?:string|null}).pasteText!=null)return;
    if(key.escape&&state.overlay==='none'&&reference){setReference(null);return;}
    if (key.escape) return send({ type: "close" });
    if (input === "?" && state.composer === "" && state.overlay === "none") return send({ type: "open", overlay: "help" });
  });

  // One width, computed once and passed down. Three components each deciding
  // their own rule width is how a header ends up wider than the status bar, which
  // is the most visible way a terminal layout looks unfinished.
  const terminalWidth = SHELL_RULE_WIDTH(stdout.columns);
  const gutter = terminalWidth >= 100 ? 4 : terminalWidth >= 40 ? 2 : 0;
  const column = Math.max(1, Math.min(96, terminalWidth - gutter * 2));
  const terminalRows = Math.max(8, stdout.rows ?? 24);
  const rows = terminalRows;
  const contentRows = Math.max(1, rows - 8);
  const workSurface=producer?.workSurface?.();
  const context=contextLines(workSurface,Math.min(8,Math.max(2,Math.floor(contentRows/3))));
  useTerminalTitle(stdout,windowTitle({intent:workSurface?.intent,project:state.project}));

  return (
    <MotionContext.Provider value={motion}>
    <Box width={terminalWidth} height={rows - 1} paddingX={gutter} alignItems="center" flexDirection="column" overflow="hidden">
    <Box flexDirection="column" width={column} height={rows - 1} overflow="hidden">
      <Header
        width={column}
        project={state.project}
        busy={state.busy}
        model={producer ? modelName : "no model"}
      />

      <Box flexDirection="column" flexGrow={1} flexShrink={0} height={contentRows + 1} overflow="hidden" paddingTop={1}>
        {state.overlay === "changes" ? (
          <Changes width={column} rows={contentRows} busy={state.busy} load={()=>producer?.changes?.()??Promise.resolve(null)} decide={(token,digest,decision)=>producer?.decideChanges?.(token,digest,decision)??Promise.reject(Error("Review decision unavailable."))}/>
        ) : state.overlay === "models" && agentModelsMode && producer ? (
          <AgentModels width={column} rows={contentRows} busy={state.busy} targets={()=>producer.agentModelTargets?.()??[]} apply={(role,choice)=>producer.selectAgentModel?.(role,choice)??{error:"Selection unavailable."}} list={catalog} onClose={()=>send({type:"close"})}/>
        ) : state.overlay === "models" && binding ? (
          <Models width={column} selection={binding.selection} rows={contentRows} busy={state.busy} list={catalog}
            apply={(choice, save) => {
              const result = binding.select(choice, { save, busy: store.get().busy, beforeCommit:selection=>producer?.modelSelected?.(selection) });
              if ("ok" in result) {
                changedModel(value => value + 1);
                store.send({ type: "noted", entry: { kind: "status", label: "model", value: `${binding.label}${store.get().busy ? " · next request" : ""}${save && !result.warning ? " · default saved" : " · this session"}`, certainty: "confirmed" } });
                if(result.warning)store.send({type:"noted",entry:{kind:"status",label:"preference",value:result.warning,certainty:"unknown"}});
                store.send({ type: "logged", line: `[model-selected] ${JSON.stringify(binding.selection)} saved=${save}` });
              }
              return result;
            }} onClose={() => send({ type: "close" })} />
        ) : state.overlay === "palette" ? (
          <Palette onAction={action=>{
            if(action==='stop')producer?.cancel?.();
            if(action==='motion')setMotion(value=>!value);
            if(action==='steer')store.send({type:'compose',text:'/steer '+store.get().composer});
            if(action==='native')producer?.say('/memory');
            if(action==='quit'){if(store.get().busy){store.send({type:'noted',entry:{kind:'failure',text:'Work is running. Use /stop before /quit.'}});}else exit();}
            send({type:'close'});
          }} initialAction={paletteAction} width={column} rows={contentRows} onOpen={(overlay) => {setAgentModelsMode(false);send({ type: "open", overlay });}}
            onSkills={()=>producer?.skillPage?.()??{digest:"",offset:0,nextOffset:null,lines:["Skills unavailable."]}}
            onWorkspaces={()=>producer?.workspacePage?.()??{digest:"",offset:0,nextOffset:null,lines:["Workspace inspection unavailable."]}}
            onNotifications={()=>producer?.notificationPage?.()??{digest:"",offset:0,nextOffset:null,lines:["Notifications unavailable."]}}
            onReadNotifications={digest=>producer?.readNotifications?.(digest)??{digest:"",offset:0,nextOffset:null,lines:["Notifications unavailable."]}}
            onSituation={()=>producer?.situationPage?.()??{digest:"",offset:0,nextOffset:null,lines:["Situation unavailable."]}}
            onAgentModels={()=>{setAgentModelsMode(true);send({type:"open",overlay:"models"});}}
            onAgents={offset=>producer?.agentPage?.(offset) ?? {digest:"",offset:0,nextOffset:null,lines:["No agents available."]}}
            onContext={(offset,digest)=>producer?.sharedContextPage?.(offset,digest) ?? {digest:"",offset:0,nextOffset:null,lines:["No shared context configured."]}}
            onCheck={()=>producer?.checkConfirmation?.() ?? null} onConfirmCheck={approval=>{send({type:"close"});producer?.say(`/check confirm ${approval.id} ${approval.revision} ${approval.digest}`);}}
            onNew={()=>loadSession()} onResume={()=>{send({type:"close"});if(!missing) producer?.resume?.();}} />
        ) : state.overlay === "sessions" ? (
          <Sessions width={column} rows={contentRows} current={wired.session?.metadata.id} list={sessionChoices} onChoose={loadSession} />
        ) : missing ? (
          <Notice text={missing} />
        ) : state.overlay === "projects" ? (
          <Projects rows={contentRows} width={column}
            choices={state.choices}
            onChoose={(option) => producer?.choose(option)}
            onDismiss={() => send({ type: "close" })}
          />
        ) : state.overlay === "inspect" ? (
          <Inspect lines={state.log} width={column} maxLines={Math.max(1, contentRows - 4)} />
        ) : state.overlay === "help" ? (
          <Help rows={contentRows} onClose={() => send({ type: "close" })} />
        ) : null}
        <Box display={state.overlay === "work" ? "flex" : "none"}>
          <Work key={wired.session?.metadata.id??'session'} active={state.overlay==='work'} entries={state.entries} surface={workSurface} width={column} rows={contentRows}
            onReference={(value,title)=>{setReference({value,title});setReturnToWork(false);store.send({type:'close'});}}
            onRedirect={()=>{setReturnToWork(false);store.send({type:'close'});}}
            onOpen={target=>{setReturnToWork(true);setAgentModelsMode(false);if(target==='context'){setPaletteAction('context');store.send({type:'open',overlay:'palette'});}else store.send({type:'open',overlay:target});}}/>
        </Box>
        <Box display={state.overlay === "none" && !missing ? "flex" : "none"}>
          <Timeline intent={workSurface?.intent??undefined} active={state.overlay === "none" && !missing} busy={state.busy} progressKind={state.progressKind} reasoning={state.progressKind === "text" ? state.reasoning : ""} width={column} entries={state.entries} context={context.slice(1)} visible={contentRows} rows={contentRows} />
        </Box>
      </Box>

      {reference?<Box width={column} height={1} flexShrink={0}><Text wrap="truncate-end" color={inkColor(theme.active)}>↳ Target: {reference.title} · Esc detach</Text></Box>:<Activity progressKind={state.reasoning?state.progressKind:undefined} busy={state.busy} entries={state.entries} width={column} />}
      <Composer
        width={column}
        placeholder={state.entries.length === 0 ? undefined : " "}
        value={state.composer}
        onChange={(text) => send({ type: "compose", text })}
        onSubmit={submit}
        preserveOnEscape={!!reference}
        onQuit={() => state.busy ? producer?.cancel?.() : exit()}
        onModels={() => {setAgentModelsMode(false);send({type:"open",overlay:"models"});}}
        onPalette={() => {setPaletteAction(undefined);send({ type: "open", overlay: "palette" });}}
        onHelp={() => send({ type: "open", overlay: "help" })}
        onInspect={() => send({ type: "open", overlay: "work" })}
        active={state.overlay === "none"}
        disabled={!producer || !!missing}
        history={state.entries.flatMap((entry) => entry.kind === "you" ? [entry.text] : [])}
      />

      <StatusBar
        overlay={state.overlay}
        targeted={!!reference}
        notifications={producer?.notificationCount?.()??0}
        consumption={state.consumption}
        width={column}
        entries={state.entries}
        busy={state.busy}
        onHelp={() => send({ type: "open", overlay: "help" })}
      />
    </Box>
    </Box>
    </MotionContext.Provider>
  );
}

/**
 * Build the store, the producer, or the reason there is no producer.
 *
 * A missing provider is reported once, in the timeline, in the surface's own
 * words. It is not an error banner and it is not an exit code: the surface still
 * runs, still resolves the portfolio, and still explains itself, because a person
 * who typed `cuesheet` did not ask for a stack trace about a missing variable.
 */
function wire(props: AppProps, sessionId?:string | null): {
  store: Store;
  producer: Producer | null;
  missing: string | null;
  /**
   * What the header calls the model.
   *
   * Resolved where the producer is built rather than in the render body, so the
   * header and the producer cannot name two different models. A header reading
   * one transport while the loop runs another is a lie a person cannot detect
   * from the screen, and this surface is the one place that claim is made.
   */
  modelName: string;
  binding?: ModelBinding;
  session?: TerminalSession;
} {
  const store = props.store ?? createStore();
  // A test that supplies its own producer is not running a model at all, so it
  // has no model to name. "test" is honest where a provider id would be a guess.
  if (props.producer) return { store, producer: props.producer, missing: null, modelName: "test" };
  const cwd = props.cwd ?? process.cwd();
  if (!props.store) {
    const live=createTerminalRuntime(cwd,sessionId === null ? undefined : sessionId ?? process.env.CUESHEET_SESSION);
    if("missing" in live) return {store,producer:null,missing:live.missing,modelName:"no model"};
    return {store:live.store,producer:live.producer,binding:live.binding,session:live.session,missing:null,modelName:live.binding.label};
  }
  const live = createLiveProducer(store, cwd);
  if ("missing" in live) {
    return {
      store,
      producer: null,
      missing: live.missing,
      modelName: "no model",
    };
  }
  return { store, producer: live.producer, binding: live.binding, missing: null, modelName: live.binding.label };
}

/** The one line that replaces the timeline when there is nothing to run with. */
function Notice({ text }: { text: string }): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={inkColor(theme.failed)}>  {glyph.failed} </Text>
      <Text>{text}</Text>
    </Box>
  );
}

/** Exported so a test can check the shell without a terminal. */
export const SHELL_RULE_WIDTH = (columns: number | undefined): number =>
  Math.max(1, columns ?? 100);

export type { SurfaceState, Option };
