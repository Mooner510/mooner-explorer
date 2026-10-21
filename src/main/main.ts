import {app,BrowserWindow,dialog,ipcMain,shell} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {Adb,remotePath,itemName,ROOT} from './adb';
import {Queue} from './queue';
import type {Entry,TransferInput} from '../shared/types';

let win:BrowserWindow|null=null;
let mirror:ChildProcessWithoutNullStreams|null=null;
const adb=new Adb();
let queue:Queue;
const opened:string[]=[];
function emit(channel:string,...args:unknown[]):void {
 if(win&&!win.isDestroyed())win.webContents.send('mooner:'+channel,...args);
}
function bind(name:string,fn:(...args:any[])=>unknown):void {
 ipcMain.handle('mooner:'+name,async(event,...args)=>{
  if(!win||event.sender!==win.webContents)throw Error('허용되지 않은 IPC 호출');
  return fn(...args);
 });
}
async function localList(dir:string):Promise<Entry[]> {
 if(typeof dir!=='string'||!path.isAbsolute(dir))throw Error('절대 경로를 선택하세요');
 const s=await fs.stat(dir);if(!s.isDirectory())throw Error('폴더가 아닙니다');
 const names=await fs.readdir(dir);
 const list=await Promise.all(names.map(async name=>{
  const p=path.join(dir,name);
  try{const st=await fs.lstat(p);return {name,path:p,directory:st.isDirectory(),size:st.size,modified:Math.floor(st.mtimeMs/1000)};}
  catch{return null;}
 }));
 return list.filter((x):x is Entry=>x!==null);
}
async function createWindow():Promise<void>{
 win=new BrowserWindow({
  width:1440,height:900,minWidth:960,minHeight:600,title:'Mooner Explorer',
  backgroundColor:'#f7f9fc',show:false,
  webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}
 });
 win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',event=>event.preventDefault());
 win.once('ready-to-show',()=>win?.show());
 await win.loadFile(path.join(__dirname,'../dist/index.html'));
 emit('queue',queue.snapshot());
}
async function chooseFile(properties:Array<'openDirectory'|'openFile'|'multiSelections'|'createDirectory'>):Promise<string[]>{
 const r=await dialog.showOpenDialog(win||undefined,{properties});return r.canceled?[]:r.filePaths;
}
app.whenReady().then(async()=>{
 queue=new Queue(adb,path.join(app.getPath('userData'),'transfers.json'),
  items=>emit('queue',items),device=>emit('filesChanged',device));
 await queue.init();
 bind('devices',()=>adb.devices());
 bind('information',(d:string)=>adb.information(d));
 bind('list',(d:string,p:string)=>adb.list(d,p));
 bind('search',(d:string,p:string,term:string)=>adb.search(d,p,term));
 bind('mkdir',(d:string,p:string)=>adb.mkdir(d,p));
 bind('rename',(d:string,a:string,b:string)=>adb.rename(d,a,b));
 bind('move',(d:string,a:string,b:string)=>adb.move(d,a,b));
 bind('copy',(d:string,a:string,b:string)=>adb.copy(d,a,b));
 bind('remove',async(d:string,paths:string[])=>{if(!Array.isArray(paths)||paths.length===0||paths.length>1000)throw Error('삭제 항목 오류');await adb.remove(d,paths);emit('filesChanged',d);});
 bind('preview',(d:string,p:string)=>adb.preview(d,p));
 bind('open',async(d:string,p:string)=>{const file=await adb.downloadTemp(d,p);opened.push(file);const error=await shell.openPath(file);if(error)throw Error(error);});
 bind('localList',(p:string)=>localList(p));
 bind('localHome',()=>app.getPath('home'));
 bind('localReveal',async(p:string)=>{if(!path.isAbsolute(p))throw Error('경로 오류');shell.showItemInFolder(p);});
 bind('chooseFiles',()=>chooseFile(['openFile','multiSelections']));
 bind('chooseFolder',async()=>(await chooseFile(['openDirectory']))[0]||null);
 bind('chooseSaveFolder',async()=>(await chooseFile(['openDirectory','createDirectory']))[0]||null);
 bind('chooseApk',async()=>{const r=await dialog.showOpenDialog(win||undefined,{properties:['openFile'],filters:[{name:'Android APK',extensions:['apk']}]});return r.filePaths[0]||null;});
 bind('queueAdd',(items:TransferInput[])=>queue.add(items));
 bind('queueList',()=>queue.snapshot());
 bind('queueSettings',()=>queue.settings());
 bind('queueCancel',(id:string)=>queue.cancel(id));
 bind('queueRetry',(id:string)=>queue.resume(id));
 bind('queuePause',(id:string)=>queue.pause(id));
 bind('queueResume',(id:string)=>queue.resume(id));
 bind('queueGlobalPause',(value:boolean)=>queue.setPaused(value));
 bind('queueClear',()=>queue.clear());
 bind('wifiPair',(e:string,c:string)=>adb.pair(e,c));
 bind('wifiConnect',(e:string)=>adb.connect(e));
 bind('wifiDisconnect',(e:string)=>adb.disconnect(e));
 bind('apps',(d:string,system:boolean)=>adb.apps(d,system));
 bind('install',(d:string,p:string)=>adb.install(d,p));
 bind('uninstall',(d:string,p:string)=>adb.uninstall(d,p));
 bind('launch',(d:string,p:string)=>adb.launch(d,p));
 bind('screenshot',async(d:string)=>{
  const r=await dialog.showSaveDialog(win||undefined,{defaultPath:'android-'+Date.now()+'.png',filters:[{name:'PNG',extensions:['png']}]});
  if(!r.filePath)return false;await adb.screenshot(d,r.filePath);return true;
 });
 bind('mirrorStart',async(d:string)=>{
  adb.args(d,[]);
  if(mirror)throw Error('미러링이 이미 실행 중입니다');
  await new Promise<void>((resolve,reject)=>{
   const cp=spawn(process.env.MOONER_SCRCPY_PATH||'scrcpy',['-s',d],{stdio:'ignore',windowsHide:true});
   cp.once('error',reject);
   cp.once('spawn',()=>{mirror=cp;cp.once('close',()=>{if(mirror===cp)mirror=null;});resolve();});
  });
 });
 bind('mirrorStop',()=>{mirror?.kill();mirror=null;});
 bind('backup',async(d:string,paths:string[])=>{
  if(!Array.isArray(paths)||!paths.length)throw Error('백업할 항목을 선택하세요');
  const folder=(await chooseFile(['openDirectory','createDirectory']))[0];if(!folder)return;
  await queue.add(paths.map(from=>({device:d,direction:'pull',from:remotePath(from),to:path.join(folder,path.posix.basename(from)),policy:'rename'})));
 });
 bind('restore',async(d:string,paths:string[],remoteDir:string)=>{
  if(!Array.isArray(paths)||!paths.length)throw Error('복원할 항목을 선택하세요');
  const target=remotePath(remoteDir);
  await queue.add(paths.map(from=>({device:d,direction:'push',from,to:path.posix.join(target,itemName(path.basename(from))),policy:'rename'})));
 });
 await createWindow();
 app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)void createWindow();});
});
app.on('before-quit',()=>{mirror?.kill();for(const f of opened)void fs.rm(f,{recursive:true,force:true}).catch(()=>{});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
