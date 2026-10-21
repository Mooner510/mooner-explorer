import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import type {Device, DeviceInfo, Entry, AppInfo, Preview} from '../shared/types';

export const ROOT='/sdcard';
export function remotePath(v:string):string {
 if(typeof v!=='string'||!v.startsWith('/')||/[\x00-\x1f\x7f]/.test(v))throw Error('Android 경로가 올바르지 않습니다');
 const n=path.posix.normalize(v);if(n!==ROOT&&!n.startsWith(ROOT+'/'))throw Error('/sdcard 외부 접근 차단');return n;
}
export function itemName(v:string):string {
 if(!v||v==='.'||v==='..'||v.includes('/')||v.includes('\\')||/[\x00-\x1f\x7f]/.test(v))throw Error('유효하지 않은 이름');return v;
}
export const quote=(v:string)=>"'"+v.replace(/'/g,"'\\''")+"'";
export function guard(v:string):string {
 const p=remotePath(v);
 return 'base=$(readlink -f /sdcard) || exit 77\nprobe='+quote(p)+'\n'+
 'while [ ! -e "$probe" ] && [ ! -L "$probe" ]; do probe=$(dirname "$probe"); [ -n "$probe" ] || exit 77; done\n'+
 'actual=$(readlink -f "$probe") || exit 77\n'+
 'case "$actual" in "$base"|"$base"/*) ;; *) echo "공유 저장소 외부 심볼릭 링크" >&2; exit 77;; esac\n';
}
export function parseDevices(s:string):Device[] {
 return s.split(/\r?\n/).slice(1).map(x=>x.trim()).filter(Boolean).map(line=>{
  const [id,state,...parts]=line.split(/\s+/);
  const fields=Object.fromEntries(parts.filter(x=>x.includes(':')).map(x=>{const i=x.indexOf(':');return [x.slice(0,i),x.slice(i+1)];}));
  return {id,state,model:(fields.model||id).replace(/_/g,' '),product:fields.product||'',transport:fields.transport_id||''};
 });
}
export function parseProgress(s:string):number|undefined {
 const list=[...s.matchAll(/(?:^|[\s\[])(\d{1,3})%/g)];
 return list.length?Math.max(0,Math.min(100,Number(list[list.length-1][1]))):undefined;
}
export class Adb {
 readonly binary=process.env.MOONER_ADB_PATH||'adb';
 args(device:string,args:string[]):string[] {
  if(!device||device.startsWith('-')||/[\x00-\x20]/.test(device))throw Error('기기 선택 필요');
  return ['-s',device,...args];
 }
 process(args:string[],stdin=false):ChildProcessWithoutNullStreams {
  return spawn(this.binary,args,{windowsHide:true,stdio:[stdin?'pipe':'ignore','pipe','pipe']});
 }
 run(args:string[],timeout=30000):Promise<string> {
  return new Promise((resolve,reject)=>{
   const cp=this.process(args);let output='';let error='';let expired=false;let done=false;
   const timer=setTimeout(()=>{expired=true;cp.kill();},timeout);
   const finish=(err?:Error)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(output);};
   cp.stdout.on('data',(b:Buffer)=>{output+=b.toString();if(output.length>32_000_000)cp.kill();});
   cp.stderr.on('data',(b:Buffer)=>{error+=b.toString();if(error.length>1_000_000)cp.kill();});
   cp.on('error',finish);
   cp.on('close',code=>finish(code===0&&!expired?undefined:Error(expired?'ADB 시간 초과':(error||output||'ADB 종료 '+code).trim())));
  });
 }
 shell(device:string,script:string,timeout=30000):Promise<string> {
  // stdin avoids double shell-quoting of spaces, Unicode and special characters.
  return new Promise((resolve,reject)=>{
   const cp=this.process(this.args(device,['shell','-T','sh']),true);
   let output='';let error='';let expired=false;let done=false;
   const timer=setTimeout(()=>{expired=true;cp.kill();},timeout);
   const finish=(err?:Error)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(output);};
   cp.stdout.on('data',(b:Buffer)=>{output+=b.toString();if(output.length>32_000_000)cp.kill();});
   cp.stderr.on('data',(b:Buffer)=>{error+=b.toString();if(error.length>1_000_000)cp.kill();});
   cp.on('error',finish);
   cp.on('close',code=>finish(code===0&&!expired?undefined:Error(expired?'Android 명령 시간 초과':(error||output||'Android 종료 '+code).trim())));
   cp.stdin.on('error',()=>{});cp.stdin.end(script+'\n');
  });
 }
 devices():Promise<Device[]> {return this.run(['devices','-l']).then(parseDevices);}
 async list(device:string,dir:string):Promise<Entry[]> {
  const d=remotePath(dir);
  const script=guard(d)+'cd '+quote(d)+' || exit 2\n'+
   'for f in ./* ./.[!.]* ./..?*; do\n'+
   ' [ -e "$f" ] || [ -L "$f" ] || continue\n'+
   ' if [ -d "$f" ]; then kind=d; else kind=f; fi\n'+
   ' size=$(stat -c %s "$f" 2>/dev/null || echo 0)\n'+
   ' stamp=$(stat -c %Y "$f" 2>/dev/null || echo 0)\n'+
   ' name=$(basename "$f")\n'+
   " printf '%s\\0%s\\0%s\\0%s\\0' \"$kind\" \"$size\" \"$stamp\" \"$name\"\n"+
   'done\n';
  const parts=(await this.shell(device,script,60000)).split('\0'),result:Entry[]=[];
  for(let i=0;i+3<parts.length;i+=4){
   const [k,s,m,n]=parts.slice(i,i+4);if(!n||n==='.'||n==='..')continue;
   result.push({name:n,path:path.posix.join(d,n),directory:k==='d',size:Number(s)||0,modified:Number(m)||0});
  }
  return result;
 }
 async search(device:string,dir:string,term:string):Promise<Entry[]> {
  const d=remotePath(dir);if(!term.trim())return this.list(device,d);
  const script=guard(d)+'find '+quote(d)+' -mindepth 1 -print0 | head -c 4000000\n';
  const paths=(await this.shell(device,script,90000)).split('\0').filter(Boolean);
  return paths.filter(p=>path.posix.basename(p).toLocaleLowerCase().includes(term.toLocaleLowerCase())).slice(0,500).map(p=>({name:path.posix.basename(p),path:p,directory:false,size:0,modified:0}));
 }
 async exists(device:string,p:string):Promise<boolean> {
  const v=remotePath(p);
  return (await this.shell(device,guard(v)+'if [ -e '+quote(v)+' ] || [ -L '+quote(v)+' ]; then echo 1; else echo 0; fi\n')).trim()==='1';
 }
 async mkdir(device:string,p:string):Promise<void> {
  const v=remotePath(p);if(v===ROOT||await this.exists(device,v))throw Error('생성할 수 없거나 이미 존재하는 경로');
  await this.shell(device,guard(v)+'mkdir -p -- '+quote(v)+'\n');
 }
 async move(device:string,a:string,b:string):Promise<void> {
  a=remotePath(a);b=remotePath(b);
  if(a===ROOT||b===ROOT||b.startsWith(a+'/')||await this.exists(device,b))throw Error('이동할 수 없거나 목적지가 존재합니다');
  await this.shell(device,guard(a)+guard(b)+'mv -- '+quote(a)+' '+quote(b)+'\n');
 }
 rename(device:string,a:string,b:string):Promise<void>{return this.move(device,a,b);}
 async copy(device:string,a:string,b:string):Promise<void> {
  a=remotePath(a);b=remotePath(b);
  if(a===ROOT||b===ROOT||b.startsWith(a+'/')||await this.exists(device,b))throw Error('복사할 수 없거나 목적지가 존재합니다');
  await this.shell(device,guard(a)+guard(b)+'cp -R -- '+quote(a)+' '+quote(b)+'\n',180000);
 }
 async remove(device:string,paths:string[]):Promise<void> {
  for(const p of paths){const v=remotePath(p);if(v===ROOT)throw Error('루트 삭제 불가');await this.shell(device,guard(v)+'rm -rf -- '+quote(v)+'\n',120000);}
 }
 async size(device:string,p:string):Promise<number> {
  const v=remotePath(p);
  const s=await this.shell(device,guard(v)+'if [ -d '+quote(v)+' ]; then du -sk '+quote(v)+" | awk '{print $1*1024}'; else stat -c %s "+quote(v)+'; fi\n');
  return Number(s.trim())||0;
 }
 async information(device:string):Promise<DeviceInfo> {
  const prop=async(p:string)=>(await this.shell(device,'getprop '+quote(p)+'\n')).trim();
  const [model,manufacturer,android,sdk,serial,battery,storage]=await Promise.all([
   prop('ro.product.model'),prop('ro.product.manufacturer'),prop('ro.build.version.release'),prop('ro.build.version.sdk'),
   prop('ro.serialno'),this.shell(device,'dumpsys battery\n').then(s=>s.trim()),
   this.shell(device,'df -h /sdcard\n').then(s=>s.trim())]);
  return {model,manufacturer,android,sdk,serial,battery,storage};
 }
 async apps(device:string,system:boolean):Promise<AppInfo[]> {
  const out=await this.run(this.args(device,['shell','pm','list','packages',system?'-s':'-3']),60000);
  return out.split(/\r?\n/).filter(x=>x.startsWith('package:')).map(x=>({packageName:x.slice(8).trim(),system}));
 }
 async install(device:string,apk:string):Promise<string> {
  if(path.extname(apk).toLowerCase()!=='.apk'||!(await fs.stat(apk)).isFile())throw Error('APK 선택 필요');
  return this.run(this.args(device,['install','-r',apk]),300000);
 }
 async uninstall(device:string,pkg:string):Promise<string> {
  validatePackage(pkg);return this.run(this.args(device,['uninstall',pkg]),90000);
 }
 async launch(device:string,pkg:string):Promise<string> {
  validatePackage(pkg);return this.run(this.args(device,['shell','monkey','-p',pkg,'-c','android.intent.category.LAUNCHER','1']),30000);
 }
 async screenshot(device:string,target:string):Promise<void> {
  const cp=this.process(this.args(device,['exec-out','screencap','-p']));
  const chunks:Buffer[]=[];let err='';
  await new Promise<void>((resolve,reject)=>{cp.stdout.on('data',(b:Buffer)=>chunks.push(b));cp.stderr.on('data',(b:Buffer)=>err+=b.toString());cp.on('error',reject);cp.on('close',code=>code===0?resolve():reject(Error(err||'스크린샷 실패')));});
  await fs.writeFile(target,Buffer.concat(chunks),{flag:'wx'});
 }
 async downloadTemp(device:string,p:string):Promise<string> {
  const src=remotePath(p),dst=path.join(os.tmpdir(),'mooner-explorer-'+randomUUID()+'-'+path.posix.basename(src));
  try{await this.run(this.args(device,['pull',src,dst]),300000);return dst;}
  catch(e){await fs.rm(dst,{force:true,recursive:true}).catch(()=>{});throw e;}
 }
 async preview(device:string,p:string):Promise<Preview> {
  const src=remotePath(p),size=await this.size(device,src);
  if(size>8*1024*1024)throw Error('8MB 초과 파일은 외부 앱으로 열어주세요');
  const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.txt':'text/plain','.md':'text/plain','.json':'application/json','.csv':'text/plain','.xml':'text/xml','.mp3':'audio/mpeg','.wav':'audio/wav','.mp4':'video/mp4','.webm':'video/webm'};
  const type=mime[path.posix.extname(src).toLowerCase()];
  if(!type)throw Error('이 형식은 외부 앱으로 열어주세요');
  const temp=await this.downloadTemp(device,src);
  try{const data=await fs.readFile(temp);return {name:path.posix.basename(src),mime:type,data:data.toString('base64'),size:data.length};}
  finally{await fs.rm(temp,{force:true}).catch(()=>{});}
 }
 pair(endpoint:string,code:string):Promise<string> {
  validateEndpoint(endpoint);if(!/^\d{6}$/.test(code))throw Error('6자리 페어링 코드를 입력하세요');return this.run(['pair',endpoint,code]);
 }
 connect(endpoint:string):Promise<string>{validateEndpoint(endpoint);return this.run(['connect',endpoint]);}
 disconnect(endpoint:string):Promise<string>{validateEndpoint(endpoint);return this.run(['disconnect',endpoint]);}
}
function validatePackage(p:string):void {if(!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(p))throw Error('패키지 이름이 올바르지 않습니다');}
export function validateEndpoint(e:string):void {
 if(typeof e!=='string'||e.length>255||!/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5}$/.test(e))throw Error('IP:포트 형식으로 입력하세요');
 const port=Number(e.slice(e.lastIndexOf(':')+1));if(port<1||port>65535)throw Error('포트 범위 오류');
}
