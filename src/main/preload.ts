import {contextBridge,ipcRenderer,webUtils} from 'electron';
const call=(name:string,...args:unknown[])=>ipcRenderer.invoke('mooner:'+name,...args);
function subscribe(name:string,fn:(...args:any[])=>void):()=>void {
 const listener=(_event:Electron.IpcRendererEvent,...args:any[])=>fn(...args);
 ipcRenderer.on('mooner:'+name,listener);
 return ()=>ipcRenderer.removeListener('mooner:'+name,listener);
}
contextBridge.exposeInMainWorld('mooner',{
 platform:process.platform,
 getFilePath:(file:File)=>webUtils.getPathForFile(file),
 devices:()=>call('devices'),information:(d:string)=>call('information',d),
 list:(d:string,p:string)=>call('list',d,p),search:(d:string,p:string,q:string)=>call('search',d,p,q),
 mkdir:(d:string,p:string)=>call('mkdir',d,p),rename:(d:string,a:string,b:string)=>call('rename',d,a,b),
 remove:(d:string,paths:string[])=>call('remove',d,paths),move:(d:string,a:string,b:string)=>call('move',d,a,b),
 copy:(d:string,a:string,b:string)=>call('copy',d,a,b),
 preview:(d:string,p:string)=>call('preview',d,p),open:(d:string,p:string)=>call('open',d,p),
 chooseFiles:()=>call('chooseFiles'),chooseFolder:()=>call('chooseFolder'),chooseSaveFolder:()=>call('chooseSaveFolder'),
 localList:(p:string)=>call('localList',p),localHome:()=>call('localHome'),localReveal:(p:string)=>call('localReveal',p),
 queueAdd:(items:unknown[])=>call('queueAdd',items),queueList:()=>call('queueList'),
 queueCancel:(id:string)=>call('queueCancel',id),queueRetry:(id:string)=>call('queueRetry',id),
 queuePause:(id:string)=>call('queuePause',id),queueResume:(id:string)=>call('queueResume',id),
 queueGlobalPause:(v:boolean)=>call('queueGlobalPause',v),queueClear:()=>call('queueClear'),queueSettings:()=>call('queueSettings'),
 wifiPair:(e:string,c:string)=>call('wifiPair',e,c),wifiConnect:(e:string)=>call('wifiConnect',e),wifiDisconnect:(e:string)=>call('wifiDisconnect',e),
 apps:(d:string,s:boolean)=>call('apps',d,s),install:(d:string,p:string)=>call('install',d,p),
 uninstall:(d:string,p:string)=>call('uninstall',d,p),launch:(d:string,p:string)=>call('launch',d,p),
 chooseApk:()=>call('chooseApk'),screenshot:(d:string)=>call('screenshot',d),
 mirrorStart:(d:string)=>call('mirrorStart',d),mirrorStop:()=>call('mirrorStop'),
 backup:(d:string,paths:string[])=>call('backup',d,paths),
 restore:(d:string,paths:string[],r:string)=>call('restore',d,paths,r),
 onQueue:(cb:(items:unknown[])=>void)=>subscribe('queue',cb),
 onFilesChanged:(cb:(device:string)=>void)=>subscribe('filesChanged',cb)
});
