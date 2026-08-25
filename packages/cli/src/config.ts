import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
export type Clone={path:string;repositoryId:number;normalizedRemote:string;name:string;branch?:string;headSha?:string;remoteHeadSha?:string;historyHeads?:string[]};
export type Config={serverUrl:string;userToken?:string;agentToken?:string;agentId?:number;workspaceId?:number;watchedPaths:string[];clones:Clone[];reporter:'codex'|'hermes';pollMs:number};
export type Queued={eventKey:string;repositoryId:number;type:string;occurredAt:string;data:Record<string,unknown>;attempts:number;nextAttempt:number};
export const stateDir=()=>process.env.TRACEMINI_HOME||path.join(os.homedir(),'.tracemini');
const file=(n:string)=>path.join(stateDir(),n);const defaults=():Config=>({serverUrl:'http://localhost:3000',watchedPaths:[os.homedir()],clones:[],reporter:'codex',pollMs:2000});
function readStored():Partial<Config>{try{return JSON.parse(fs.readFileSync(file('config.json'),'utf8'))}catch{return {}}}
export function loadConfig():Config{fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});const stored=readStored();return {...defaults(),...stored,watchedPaths:stored.watchedPaths?.length?stored.watchedPaths:[os.homedir()]}}
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
export function saveConfig(c:Config, options:{preserveCurrentScalars?:boolean;replaceCollections?:boolean}={}){
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
  // The systemd agent and interactive commands are separate processes. Preserve
  // roots/clones added by `tracemini watch` if an older in-memory agent snapshot
  // is saved at the same time.
  const current=readStored();
  const sources=options.replaceCollections?[c]:options.preserveCurrentScalars?[c,current]:[current,c];
  const clones=new Map<string,Clone>();
  if(options.preserveCurrentScalars){
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
  const target=file('config.json');
  const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(merged,null,2),{mode:0o600});
  fs.renameSync(temporary,target);
  });
}
export function loadQueue():Queued[]{try{return JSON.parse(fs.readFileSync(file('queue.json'),'utf8'))}catch{return[]}}
export function saveQueue(q:Queued[]){fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});fs.writeFileSync(file('queue.json'),JSON.stringify(q,null,2),{mode:0o600})}
export const eventKey=(parts:unknown[])=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
