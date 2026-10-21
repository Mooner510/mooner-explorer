import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {Transfer,TransferInput,Conflict} from '../shared/types';
import {Adb,parseProgress,remotePath,guard,quote,ROOT} from './adb';

const MAX_HISTORY=200;
async function exists(p:string):Promise<boolean> {try{await fs.lstat(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function sizeOf(p:string):Promise<number> {
 const s=await fs.lstat(p);if(s.isSymbolicLink())throw Error('심볼릭 링크 전송은 지원하지 않습니다');
 if(s.isFile())return s.size;
 if(!s.isDirectory())throw Error('지원하지 않는 파일 형식');
 let n=0;for(const f of await fs.readdir(p))n+=await sizeOf(path.join(p,f));return n;
}
function another(p:string,index:number,remote:boolean):string {
 const mod=remote?path.posix:path;
 const ext=mod.extname(p),base=p.slice(0,p.length-ext.length);
 return base+' ('+index+')'+ext;
}
async function replaceLocal(stage:string,target:string,policy:Conflict,id:string):Promise<'done'|'skipped'>{
 if(await exists(target)){
  if(policy==='skip')return 'skipped';
  if(policy==='rename')throw Error('새 이름 중복 감지. 작업을 다시 시도하세요');
  const backup=target+'.mooner-backup-'+id;
  await fs.rename(target,backup);
  try{await fs.rename(stage,target);}catch(e){await fs.rename(backup,target).catch(()=>{});throw e;}
  await fs.rm(backup,{recursive:true,force:true});
 }else await fs.rename(stage,target);
 return 'done';
}
export class Queue {
 private items:Transfer[]=[];
 private processing=false;
 private halted=false;
 private child:ChildProcessWithoutNullStreams|null=null;
 private current:string|null=null;
 private serial:Promise<void>=Promise.resolve();
 constructor(private adb:Adb,private file:string,private notify:(list:Transfer[])=>void,private changed:(device:string)=>void){}
 async init():Promise<void>{
  try{const raw=JSON.parse(await fs.readFile(this.file,'utf8'));this.items=(Array.isArray(raw.items)?raw.items:[]).filter((x:Transfer)=>x&&typeof x.id==='string').map((x:Transfer)=>x.status==='running'?{...x,status:'error',detail:'앱 종료로 전송 중단. 다시 시도하세요'}:x);this.halted=Boolean(raw.paused);}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')this.items=[];}
  this.emit();if(!this.halted)void this.next();
 }
 snapshot(){return this.items.map(x=>({...x}));}
 settings(){return {paused:this.halted,maxHistory:MAX_HISTORY};}
 private persist():void {
  const data=JSON.stringify({version:1,paused:this.halted,items:this.items},null,2);
  this.serial=this.serial.then(async()=>{const tmp=this.file+'.tmp';await fs.writeFile(tmp,data,'utf8');await fs.rename(tmp,this.file);}).catch(()=>{});
 }
 private emit():void {this.notify(this.snapshot());this.persist();}
 async add(inputs:TransferInput[]):Promise<void> {
  if(!Array.isArray(inputs)||inputs.length===0||inputs.length>1000)throw Error('전송 요청 개수 오류');
  const ready:Transfer[]=[];
  for(const x of inputs){
   if(!x||!['push','pull'].includes(x.direction)||!['skip','rename','overwrite'].includes(x.policy))throw Error('잘못된 전송 요청');
   this.adb.args(x.device,[]);
   if(x.direction==='push'){if(!path.isAbsolute(x.from))throw Error('로컬 경로는 절대 경로여야 합니다');remotePath(x.to);await fs.lstat(x.from);}
   else{remotePath(x.from);if(!path.isAbsolute(x.to))throw Error('PC 경로는 절대 경로여야 합니다');}
   ready.push({...x,id:randomUUID(),status:'queued',progress:0,detail:'대기 중',bytes:0,total:0,speed:0,eta:null,attempts:0});
  }
  this.items.push(...ready);
  const finished=this.items.filter(x=>!['running','queued','paused'].includes(x.status));
  if(finished.length>MAX_HISTORY){const remove=new Set(finished.slice(0,finished.length-MAX_HISTORY).map(x=>x.id));this.items=this.items.filter(x=>!remove.has(x.id));}
  this.emit();void this.next();
 }
 cancel(id:string):void {
  const t=this.items.find(x=>x.id===id);if(!t)return;
  if(t.status==='queued'||t.status==='paused'||t.status==='running'){
   t.status='cancelled';t.detail='사용자 취소';t.ended=Date.now();
   if(this.current===id)this.child?.kill();this.emit();
  }
 }
 pause(id:string):void {
  const t=this.items.find(x=>x.id===id);if(!t||!['running','queued'].includes(t.status))return;
  t.status='paused';t.detail='일시정지됨 — 재개하면 파일 처음부터 재전송';
  if(this.current===id)this.child?.kill();this.emit();
 }
 resume(id:string):void {
  const t=this.items.find(x=>x.id===id);if(!t||!['paused','error','cancelled','skipped'].includes(t.status))return;
  if(this.current===id)throw Error('이전 전송 프로세스 종료를 기다리세요');
  t.status='queued';t.progress=0;t.bytes=0;t.detail='대기 중';t.ended=undefined;
  this.emit();void this.next();
 }
 async setPaused(v:boolean):Promise<void>{this.halted=Boolean(v);this.emit();if(!v)void this.next();}
 clear():void {this.items=this.items.filter(x=>x.status==='running'||x.status==='queued'||x.status==='paused');this.emit();}
 private async next():Promise<void>{
  if(this.processing||this.halted)return;
  this.processing=true;
  try{
   while(!this.halted){
    const job=this.items.find(x=>x.status==='queued');if(!job)break;
    await this.transfer(job);
   }
  }finally{this.processing=false;}
 }
 private async resolveTarget(t:Transfer):Promise<boolean>{
  let current=t.to;
  const existsTarget=async(p:string)=>t.direction==='push'?this.adb.exists(t.device,p):exists(p);
  if(!(await existsTarget(current)))return true;
  if(t.policy==='skip')return false;
  if(t.policy==='rename'){
   for(let i=1;i<10000;i++){const p=another(t.to,i,t.direction==='push');if(!(await existsTarget(p))){t.to=p;return true;}}
   throw Error('사용 가능한 새 파일 이름을 찾지 못했습니다');
  }
  return true;
 }
 private async processTransfer(t:Transfer,args:string[]):Promise<void>{
  const cp=this.adb.process(this.adb.args(t.device,args));
  this.child=cp;this.current=t.id;
  let tail='';const started=Date.now();
  await new Promise<void>((resolve,reject)=>{
   let done=false;
   const finish=(err?:Error)=>{if(done)return;done=true;err?reject(err):resolve();};
   const update=(buf:Buffer)=>{
    tail=(tail+buf.toString()).slice(-5000);
    const percent=parseProgress(tail);
    if(percent!==undefined&&t.status==='running'){
     t.progress=percent;t.bytes=t.total*percent/100;
     const seconds=Math.max(0.001,(Date.now()-started)/1000);
     t.speed=t.bytes/seconds;t.eta=t.speed>0?Math.max(0,(t.total-t.bytes)/t.speed):null;
     this.notify(this.snapshot());
    }
   };
   cp.stdout.on('data',update);cp.stderr.on('data',update);
   cp.on('error',finish);cp.on('close',code=>finish(code===0?undefined:Error(tail.trim()||'ADB 종료 코드 '+code)));
  });
 }
 private async finalizeRemote(t:Transfer,stage:string):Promise<void>{
  const dest=remotePath(t.to),backup=remotePath(dest+'.mooner-backup-'+t.id);
  let script=guard(stage)+guard(dest);
  if(t.policy==='overwrite'){
   script+='if [ -e '+quote(dest)+' ] || [ -L '+quote(dest)+' ]; then mv -- '+quote(dest)+' '+quote(backup)+' || exit 9; fi\n';
  }else script+='if [ -e '+quote(dest)+' ] || [ -L '+quote(dest)+' ]; then echo "파일 중복" >&2; exit 8; fi\n';
  script+='mv -- '+quote(stage)+' '+quote(dest)+' || { if [ -e '+quote(backup)+' ]; then mv -- '+quote(backup)+' '+quote(dest)+'; fi; exit 9; }\n';
  if(t.policy==='overwrite')script+='rm -rf -- '+quote(backup)+'\n';
  await this.adb.shell(t.device,script,120000);
 }
 private async transfer(t:Transfer):Promise<void>{
  t.status='running';t.started=Date.now();t.ended=undefined;t.attempts++;t.detail='전송 준비';this.emit();
  let stage='';
  try{
   if(!(await this.resolveTarget(t))){t.status='skipped';t.detail='동일한 이름이 있어 건너뜀';return;}
   if(t.status!=='running')return;
   t.total=t.direction==='push'?await sizeOf(t.from):await this.adb.size(t.device,t.from);
   stage=t.to+'.mooner-'+t.id+'.part';
   if(t.status!=='running')return;
   if(t.direction==='push'){
    remotePath(stage);
    await this.adb.shell(t.device,guard(stage)+'rm -rf -- '+quote(stage)+'\n');
    t.detail='Android로 전송';this.emit();
    await this.processTransfer(t,['push',t.from,stage]);
    if(t.status!=='running')return;
    if((await fs.lstat(t.from)).isFile() && (await this.adb.size(t.device,stage))!==t.total)throw Error('전송한 파일의 크기가 원본과 다릅니다');
    await this.finalizeRemote(t,stage);
   }else{
    await fs.mkdir(path.dirname(t.to),{recursive:true});
    await fs.rm(stage,{recursive:true,force:true});
    t.detail='PC로 전송';this.emit();
    await this.processTransfer(t,['pull',t.from,stage]);
    if(t.status!=='running')return;
    if((await fs.lstat(stage)).isFile() && (await fs.stat(stage)).size!==t.total)throw Error('전송한 파일의 크기가 원본과 다릅니다');
    const result=await replaceLocal(stage,t.to,t.policy,t.id);
    if(result==='skipped'){t.status='skipped';t.detail='전송 중 목적지 파일이 생성되어 건너뜀';return;}
   }
   t.status='done';t.progress=100;t.bytes=t.total;t.eta=0;t.detail='전송 완료';
   this.changed(t.device);
  }catch(e){
   if(t.status==='running'){t.status='error';t.detail=e instanceof Error?e.message:String(e);}
  }finally{
   this.child=null;this.current=null;t.ended=Date.now();
   if(stage){
    if(t.direction==='push')await this.adb.shell(t.device,guard(stage)+'rm -rf -- '+quote(stage)+'\n',30000).catch(()=>{});
    else await fs.rm(stage,{force:true,recursive:true}).catch(()=>{});
   }
   this.emit();
  }
 }
}
