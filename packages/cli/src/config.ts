import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
export type Clone={path:string;repositoryId:number;normalizedRemote:string;name:string;branch?:string;headSha?:string;remoteHeadSha?:string;historyHeads?:string[];repositoryFingerprint?:string};
export type Config={serverUrl:string;userToken?:string;agentToken?:string;agentId?:number;workspaceId?:number;watchedPaths:string[];clones:Clone[];reporter:'codex'|'hermes';pollMs:number};
export type Queued={eventKey:string;repositoryId:number;localKey?:string;identityFingerprint?:string;type:string;occurredAt:string;data:Record<string,unknown>;attempts:number;nextAttempt:number;claimId?:string;claimedAt?:number};
export const stateDir=()=>process.env.TRACEMINI_HOME||path.join(os.homedir(),'.tracemini');
const file=(n:string)=>path.join(stateDir(),n);const defaults=():Config=>({serverUrl:'http://localhost:3000',watchedPaths:[],clones:[],reporter:'codex',pollMs:2000});
function readStored():Partial<Config>{try{return JSON.parse(fs.readFileSync(file('config.json'),'utf8'))}catch{return {}}}
function sameBinding(a:Partial<Config>,b:Partial<Config>){return a.serverUrl===b.serverUrl&&a.agentId===b.agentId&&a.agentToken===b.agentToken&&a.workspaceId===b.workspaceId}
export function isCurrentBinding(c:Config){const current=readStored();return sameBinding(c,current)}
export function loadConfig():Config{fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});const stored=readStored();return {...defaults(),...stored,watchedPaths:stored.watchedPaths||[]}}
const wait=(milliseconds:number)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);
function withConfigLock<T>(operation:()=>T):T{
  const lock=file('config.lock');
  const recovery=file('config.lock.recovery');
  const deadline=Date.now()+5_000;
  const lockIsStale=()=>{
    try{
      const owner=Number(fs.readFileSync(path.join(lock,'owner'),'utf8'));
      if(Number.isInteger(owner)&&owner>0){try{process.kill(owner,0);return false}catch(signal:any){return signal?.code==='ESRCH'}}
      return Date.now()-fs.statSync(lock).mtimeMs>30_000;
    }catch{try{return Date.now()-fs.statSync(lock).mtimeMs>30_000}catch{return false}}
  };
  let acquired=false;
  while(!acquired){
    try{
      fs.mkdirSync(lock,{mode:0o700});
      fs.writeFileSync(path.join(lock,'owner'),String(process.pid),{mode:0o600});
      acquired=true;
    }catch(error:any){
      if(error?.code!=='EEXIST')throw error;
      if(lockIsStale()){
        let recovering=false;
        try{fs.mkdirSync(recovery,{mode:0o700});recovering=true}catch(recoveryError:any){if(recoveryError?.code!=='EEXIST')throw recoveryError}
        if(recovering){
          try{if(lockIsStale())fs.rmSync(lock,{recursive:true,force:true})}finally{fs.rmdirSync(recovery)}
          continue;
        }
      }
      if(Date.now()>=deadline)throw new Error('timed out waiting for TraceMini config lock');
      wait(10);
    }
  }
  try{return operation()}finally{fs.rmSync(lock,{recursive:true,force:true})}
}
function writeConfig(c:Config){
  const target=file('config.json');
  const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(c,null,2),{mode:0o600});
  fs.renameSync(temporary,target);
}
export function mutateCurrentBinding(c:Config, operation:(current:Config)=>void){
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    const stored=readStored();
    if(!sameBinding(c,stored))return false;
    const current={...defaults(),...stored,watchedPaths:stored.watchedPaths||[],clones:stored.clones||[]} as Config;
    operation(current);
    writeConfig(current);
    Object.assign(c,current);
    return true;
  });
}
export function saveConfig(c:Config, options:{preserveCurrentScalars?:boolean;replaceRepositoryState?:boolean;replaceCollections?:boolean;beforeRepositoryStateReplace?:(current:Config)=>void}={}){
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
  // The systemd agent and interactive commands are separate processes. Preserve
  // roots/clones added by `tracemini watch` if an older in-memory agent snapshot
  // is saved at the same time.
  const current=readStored();
  const replaceRepositoryState=options.replaceRepositoryState||options.replaceCollections;
  if(replaceRepositoryState&&options.beforeRepositoryStateReplace){
    options.beforeRepositoryStateReplace({...defaults(),...current,watchedPaths:current.watchedPaths||[],clones:current.clones||[]} as Config);
  }
  const currentHasBinding=current.workspaceId!==undefined||current.agentId!==undefined||current.agentToken!==undefined;
  const sameWorkspace=!currentHasBinding||sameBinding(c,current);
  const sources=replaceRepositoryState?[c]:options.preserveCurrentScalars&&!sameWorkspace?[current]:options.preserveCurrentScalars?[c,current]:[current,c];
  const clones=new Map<string,Clone>();
  if(options.preserveCurrentScalars&&sameWorkspace&&!replaceRepositoryState){
    for(const clone of c.clones)clones.set(clone.path,clone);
    for(const clone of current.clones||[]){
      const background=clones.get(clone.path);
      clones.set(clone.path,background?.repositoryId===clone.repositoryId?{...clone,...background}:clone);
    }
  }else{
    for(const source of sources)for(const clone of source.clones||[])clones.set(clone.path,clone);
  }
  const scalarConfig=options.preserveCurrentScalars?{...defaults(),...current}:c;
  const merged={...scalarConfig,watchedPaths:[...new Set(sources.flatMap(source=>source.watchedPaths||[]))],clones:[...clones.values()]};
  writeConfig(merged);
  });
}
export function loadQueue():Queued[]{try{return JSON.parse(fs.readFileSync(file('queue.json'),'utf8'))}catch{return[]}}
export function saveQueue(q:Queued[], binding?:Config){
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    if(binding&&!sameBinding(binding,readStored()))return false;
    const target=file('queue.json');
    const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(q,null,2),{mode:0o600});
    fs.renameSync(temporary,target);
    return true;
  });
}
export function updateConfig(operation:(current:Config)=>Config|void):Config{
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    const stored=readStored();
    const current={...defaults(),...stored,watchedPaths:stored.watchedPaths||[],clones:stored.clones||[]} as Config;
    const updated=operation(current)||current;
    writeConfig(updated);
    return updated;
  });
}
export function mutateQueue<T>(operation:(queue:Queued[])=>T):T{
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    const queue=loadQueue();
    const result=operation(queue);
    const target=file('queue.json');
    const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(queue,null,2),{mode:0o600});
    fs.renameSync(temporary,target);
    return result;
  });
}
export function enqueue(event:Queued):boolean{
  return mutateQueue(queue=>{
    const stored=readStored();
    if(!event.localKey||!event.identityFingerprint||!(stored.clones||[]).some(clone=>clone.path===event.localKey&&clone.repositoryId===event.repositoryId&&clone.repositoryFingerprint===event.identityFingerprint))return false;
    if(queue.some(current=>current.eventKey===event.eventKey))return true;
    queue.push(event);return true;
  });
}
export const eventKey=(parts:unknown[])=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
