export type Device = {id:string;state:string;model:string;product:string;transport:string};
export type Entry = {name:string;path:string;directory:boolean;size:number;modified:number};
export type LocalEntry = Entry;
export type Conflict = 'skip'|'rename'|'overwrite';
export type TransferStatus = 'queued'|'running'|'paused'|'done'|'error'|'cancelled'|'skipped';
export type Transfer = {id:string;device:string;direction:'push'|'pull';from:string;to:string;policy:Conflict;status:TransferStatus;progress:number;detail:string;bytes:number;total:number;speed:number;eta:number|null;started?:number;ended?:number;attempts:number};
export type TransferInput = Pick<Transfer,'device'|'direction'|'from'|'to'|'policy'>;
export type DeviceInfo = {model:string;manufacturer:string;android:string;sdk:string;serial:string;battery:string;storage:string};
export type AppInfo = {packageName:string;system:boolean};
export type Preview = {name:string;mime:string;data:string;size:number};
export type QueueSettings = {paused:boolean;maxHistory:number};
export interface NativeAPI {
  platform:string;
  getFilePath(file:File):string;
  devices():Promise<Device[]>; information(device:string):Promise<DeviceInfo>;
  list(device:string,dir:string):Promise<Entry[]>; search(device:string,dir:string,term:string):Promise<Entry[]>;
  mkdir(device:string,p:string):Promise<void>; rename(device:string,a:string,b:string):Promise<void>;
  remove(device:string,paths:string[]):Promise<void>; move(device:string,from:string,to:string):Promise<void>;
  copy(device:string,from:string,to:string):Promise<void>;
  preview(device:string,p:string):Promise<Preview>; open(device:string,p:string):Promise<void>;
  chooseFiles():Promise<string[]>; chooseFolder():Promise<string|null>; chooseSaveFolder():Promise<string|null>;
  localList(p:string):Promise<LocalEntry[]>; localHome():Promise<string>; localReveal(p:string):Promise<void>;
  queueAdd(items:TransferInput[]):Promise<void>; queueList():Promise<Transfer[]>; queueCancel(id:string):Promise<void>;
  queueRetry(id:string):Promise<void>; queuePause(id:string):Promise<void>; queueResume(id:string):Promise<void>;
  queueGlobalPause(value:boolean):Promise<void>; queueClear():Promise<void>; queueSettings():Promise<QueueSettings>;
  wifiPair(endpoint:string,code:string):Promise<string>; wifiConnect(endpoint:string):Promise<string>; wifiDisconnect(endpoint:string):Promise<string>;
  apps(device:string,system:boolean):Promise<AppInfo[]>; install(device:string,p:string):Promise<string>;
  uninstall(device:string,pkg:string):Promise<string>; launch(device:string,pkg:string):Promise<string>;
  chooseApk():Promise<string|null>; screenshot(device:string):Promise<boolean>;
  mirrorStart(device:string):Promise<void>; mirrorStop():Promise<void>;
  backup(device:string,remotePaths:string[]):Promise<void>; restore(device:string,localPaths:string[],remoteDir:string):Promise<void>;
  onQueue(callback:(items:Transfer[])=>void):()=>void; onFilesChanged(callback:(device:string)=>void):()=>void;
}
declare global {interface Window {mooner:NativeAPI}}
