import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
export type Clone={path:string;repositoryId:number;normalizedRemote:string;name:string;branch?:string;headSha?:string;remoteHeadSha?:string};
export type Config={serverUrl:string;userToken?:string;agentToken?:string;agentId?:number;workspaceId?:number;watchedPaths:string[];clones:Clone[];reporter:'codex'|'hermes';pollMs:number};
export type Queued={eventKey:string;repositoryId:number;type:string;occurredAt:string;data:Record<string,unknown>;attempts:number;nextAttempt:number};
export const stateDir=()=>process.env.TRACEMINI_HOME||path.join(os.homedir(),'.tracemini');
const file=(n:string)=>path.join(stateDir(),n);const defaults:Config={serverUrl:'http://localhost:3000',watchedPaths:[],clones:[],reporter:'codex',pollMs:2000};
export function loadConfig():Config{fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});try{return {...defaults,...JSON.parse(fs.readFileSync(file('config.json'),'utf8'))}}catch{return {...defaults}}}
export function saveConfig(c:Config){fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});fs.writeFileSync(file('config.json'),JSON.stringify(c,null,2),{mode:0o600})}
export function loadQueue():Queued[]{try{return JSON.parse(fs.readFileSync(file('queue.json'),'utf8'))}catch{return[]}}
export function saveQueue(q:Queued[]){fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});fs.writeFileSync(file('queue.json'),JSON.stringify(q,null,2),{mode:0o600})}
export const eventKey=(parts:unknown[])=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
