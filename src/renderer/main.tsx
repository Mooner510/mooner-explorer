import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {
 Smartphone,Monitor,Folder,File,Upload,Download,RefreshCw,Plus,Trash2,Pencil,
 ChevronRight,ArrowLeft,HardDrive,Camera,Package,Search,X,AlertCircle,
 ArrowUpDown,RotateCcw,Square,FolderOpen,Wifi,Copy,MoveRight,Eye,
 ExternalLink,Play,Pause,Settings,CheckSquare,Clipboard,ShieldAlert
} from 'lucide-react';
import type {AppInfo,Conflict,Device,DeviceInfo,Entry,Preview,Transfer,TransferInput} from '../shared/types';
import './style.css';

const api=window.mooner;
type Page='files'|'transfers'|'apps'|'device';
type Modal={title:string;description?:string;initial?:string;placeholder?:string;danger?:boolean;onSubmit:(value:string)=>Promise<void>};
const ROOT='/sdcard';
const remoteJoin=(p:string,n:string)=>p.replace(/\/$/,'')+'/'+n;
const remoteParent=(p:string)=>p===ROOT?ROOT:p.slice(0,p.lastIndexOf('/'))||ROOT;
const base=(p:string)=>p.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||p;
const localJoin=(p:string,n:string)=>p.replace(/[\\/]+$/,'')+(api.platform==='win32'?'\\':'/')+n;
const localParent=(p:string)=>{const n=p.replace(/[\\/]+$/,'');const i=Math.max(n.lastIndexOf('/'),n.lastIndexOf('\\'));if(/^[A-Za-z]:/.test(n)&&i<=2)return n.slice(0,2)+'\\';return i<=0?p:n.slice(0,i);};
const niceSize=(value:number)=>{if(value<1024)return String(value)+' B';const u=['KB','MB','GB','TB'];let n=value/1024,i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return n.toFixed(1)+' '+u[i];};
const favorite=[['내부 저장소',ROOT],['다운로드',ROOT+'/Download'],['카메라',ROOT+'/DCIM'],['사진',ROOT+'/Pictures'],['문서',ROOT+'/Documents'],['음악',ROOT+'/Music'],['동영상',ROOT+'/Movies']];
const statusText:Record<Transfer['status'],string>={queued:'대기',running:'전송 중',paused:'일시정지',done:'완료',error:'실패',cancelled:'취소',skipped:'건너뜀'};
const fmtTime=(s:number|null)=>s===null?'계산 중':s>=3600?Math.ceil(s/3600)+'시간':s>=60?Math.ceil(s/60)+'분':Math.ceil(s)+'초';
function App(){
 const [page,setPage]=useState<Page>('files');
 const [devices,setDevices]=useState<Device[]>([]),[device,setDevice]=useState('');
 const [dir,setDir]=useState(ROOT),[remote,setRemote]=useState<Entry[]>([]);
 const [localDir,setLocalDir]=useState(''),[local,setLocal]=useState<Entry[]>([]);
 const [rSelected,setRSelected]=useState<string[]>([]),[lSelected,setLSelected]=useState<string[]>([]);
 const [focusPane,setFocusPane]=useState<'remote'|'local'>('remote');
 const [sort,setSort]=useState<'name'|'size'|'modified'>('name'),[descending,setDescending]=useState(false);
 const [query,setQuery]=useState(''),[deep,setDeep]=useState(false),[policy,setPolicy]=useState<Conflict>('skip');
 const [queue,setQueue]=useState<Transfer[]>([]),[paused,setPaused]=useState(false);
 const [apps,setApps]=useState<AppInfo[]>([]),[systemApps,setSystemApps]=useState(false),[appQuery,setAppQuery]=useState('');
 const [info,setInfo]=useState<DeviceInfo|null>(null),[notice,setNotice]=useState(''),[loading,setLoading]=useState(false);
 const [modal,setModal]=useState<Modal|null>(null),[modalInput,setModalInput]=useState(''),[modalBusy,setModalBusy]=useState(false);
 const [preview,setPreview]=useState<Preview|null>(null),[previewPath,setPreviewPath]=useState(''),[drag,setDrag]=useState(false);
 const [endpoint,setEndpoint]=useState(''),[pairCode,setPairCode]=useState('');
 const anchor=useRef<Record<string,number>>({remote:-1,local:-1});
 const active=devices.find(d=>d.id===device&&d.state==='device');
 const error=(e:unknown)=>setNotice(e instanceof Error?e.message:String(e));
 const run=async(action:()=>Promise<unknown>,success?:string)=>{
  try{await action();if(success)setNotice(success);}catch(e){error(e);}
 };
 const scan=useCallback(async()=>{
  try{
   const next=await api.devices();setDevices(next);
   setDevice(prev=>next.some(d=>d.id===prev&&d.state==='device')?prev:next.find(d=>d.state==='device')?.id||'');
  }catch(e){error(e);}
 },[]);
 const reloadRemote=useCallback(async()=>{
  if(!device)return;setLoading(true);
  try{
   const result=deep&&query.trim()?await api.search(device,dir,query):await api.list(device,dir);
   setRemote(result);setRSelected([]);
  }catch(e){setRemote([]);error(e);}
  finally{setLoading(false);}
 },[device,dir,deep,query]);
 const reloadLocal=useCallback(async()=>{
  if(!localDir)return;
  try{setLocal(await api.localList(localDir));setLSelected([]);}catch(e){setLocal([]);error(e);}
 },[localDir]);
 const reloadApps=useCallback(async()=>{
  if(!device)return;
  try{setApps(await api.apps(device,systemApps));}catch(e){error(e);}
 },[device,systemApps]);
 useEffect(()=>{void scan();const id=setInterval(()=>void scan(),5000);return()=>clearInterval(id);},[scan]);
 useEffect(()=>{void api.localHome().then(setLocalDir).catch(error);void api.queueList().then(setQueue).catch(error);void api.queueSettings().then(x=>setPaused(x.paused)).catch(error);},[]);
 useEffect(()=>{if(active)void reloadRemote();else{setRemote([]);setRSelected([]);}},[active?.id,reloadRemote]);
 useEffect(()=>{void reloadLocal();},[reloadLocal]);
 useEffect(()=>{if(page==='apps'&&active)void reloadApps();},[page,active?.id,reloadApps]);
 useEffect(()=>{if(page==='device'&&active)void api.information(device).then(x=>setInfo(x as DeviceInfo)).catch(error);},[page,device,active?.id]);
 useEffect(()=>api.onQueue(setQueue),[]);
 useEffect(()=>api.onFilesChanged(d=>{if(d===device){void reloadRemote();void reloadLocal();}}),[device,reloadRemote,reloadLocal]);
 useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(''),7000);return()=>clearTimeout(t);},[notice]);
 const sorted=(data:Entry[])=>[...data].sort((a,b)=>{
  if(a.directory!==b.directory)return a.directory?-1:1;
  const n=sort==='name'?a.name.localeCompare(b.name,'ko',{numeric:true}):a[sort]-b[sort];
  return descending?-n:n;
 });
 const rShown=useMemo(()=>sorted(remote.filter(e=>deep||e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))),[remote,deep,query,sort,descending]);
 const lShown=useMemo(()=>sorted(local),[local,sort,descending]);
 const pick=(pane:'remote'|'local',index:number,items:Entry[],event:React.MouseEvent|React.KeyboardEvent)=>{
  setFocusPane(pane);const selected=pane==='remote'?rSelected:lSelected;const set=pane==='remote'?setRSelected:setLSelected;
  const key=items[index].path;
  if(event.shiftKey&&anchor.current[pane]>=0){
   const a=Math.min(anchor.current[pane],index),b=Math.max(anchor.current[pane],index);
   set([...new Set([...selected,...items.slice(a,b+1).map(x=>x.path)])]);return;
  }
  anchor.current[pane]=index;
  if(event.metaKey||event.ctrlKey)set(selected.includes(key)?selected.filter(x=>x!==key):[...selected,key]);
  else set([key]);
 };
 const goRemote=(p:string)=>{if(p!==ROOT&&!p.startsWith(ROOT+'/'))return;setDir(p);setQuery('');setRSelected([]);};
 const goLocal=(p:string)=>{setLocalDir(p);setLSelected([]);};
 const enqueue=async(items:TransferInput[])=>{if(!items.length)return;await run(async()=>{await api.queueAdd(items);setPage('transfers');},'전송 대기열에 추가했습니다');};
 const upload=async(p?:string[])=>{
  if(!active)return;const files=p|| (lSelected.length?lSelected:await api.chooseFiles());if(!files.length)return;
  await enqueue(files.map(from=>({device,direction:'push',from,to:remoteJoin(dir,base(from)),policy})));
 };
 const download=async()=>{
  if(!active||!rSelected.length)return;const folder=await api.chooseSaveFolder();if(!folder)return;
  await enqueue(rSelected.map(from=>({device,direction:'pull',from,to:localJoin(folder,base(from)),policy})));
 };
 const openModal=(m:Modal)=>{setModalInput(m.initial||'');setModal(m);};
 const submitModal=async()=>{if(!modal||modalBusy)return;setModalBusy(true);
  try{await modal.onSubmit(modalInput);setModal(null);}catch(e){error(e);}finally{setModalBusy(false);}
 };
 const askName=(title:string,initial:string,callback:(value:string)=>Promise<void>)=>openModal({
  title,initial,description:'같은 위치에 기존 항목이 있으면 변경하지 않습니다.',
  onSubmit:async value=>{
   if(!value||value==='.'||value==='..'||/[\\/\x00-\x1f]/.test(value))throw Error('올바른 이름을 입력하세요');
   await callback(value);await reloadRemote();
  }
 });
 const createFolder=()=>askName('새 폴더 만들기','',name=>api.mkdir(device,remoteJoin(dir,name)));
 const renameItem=()=>{if(rSelected.length!==1)return;const source=rSelected[0];askName('이름 변경',base(source),name=>api.rename(device,source,remoteJoin(dir,name)));};
 const copyOrMove=(move:boolean)=>{
  if(!rSelected.length)return;
  openModal({title:move?'다른 폴더로 이동':'다른 폴더로 복사',initial:dir,description:'Android 공유 저장소 내부의 대상 폴더 경로를 입력하세요.',
   onSubmit:async destination=>{
    if(destination!==ROOT&&!destination.startsWith(ROOT+'/'))throw Error('공유 저장소 내부 경로만 허용됩니다');
    for(const from of rSelected){const to=remoteJoin(destination,base(from));if(move)await api.move(device,from,to);else await api.copy(device,from,to);}
    await reloadRemote();setNotice('작업 완료');
   }});
 };
 const removeSelected=()=>{if(!rSelected.length)return;const files=[...rSelected];
  openModal({title:files.length+'개 항목 영구 삭제',description:'Android에서 삭제한 항목은 복구되지 않을 수 있습니다. 삭제하려면 "삭제"를 입력하세요.',danger:true,
   onSubmit:async value=>{if(value!=='삭제')throw Error('삭제를 정확하게 입력하세요');await api.remove(device,files);await reloadRemote();setNotice('삭제 완료');}});
 };
 const openPreview=async(entry:Entry)=>{
  if(entry.directory){goRemote(entry.path);return;}
  await run(async()=>{setPreviewPath(entry.path);setPreview(await api.preview(device,entry.path));});
 };
 const chooseLocal=async()=>{const next=await api.chooseFolder();if(next)goLocal(next);};
 const installApk=async()=>{if(!active)return;const file=await api.chooseApk();if(!file)return;await run(async()=>{await api.install(device,file);await reloadApps();},'APK 설치 요청 완료');};
 const confirmUninstall=(name:string)=>openModal({
  title:'앱 제거',description:name+' 앱을 제거합니다. 진행하려면 "제거"를 입력하세요.',danger:true,
  onSubmit:async value=>{if(value!=='제거')throw Error('제거를 정확히 입력하세요');await api.uninstall(device,name);await reloadApps();setNotice('앱 제거 완료');}
 });
 const keyboard=(event:React.KeyboardEvent)=>{
  if(modal||preview)return;
  const t=event.target as HTMLElement;
  if(t.matches('input, textarea, select, button'))return;
  const shown=focusPane==='remote'?rShown:lShown,chosen=focusPane==='remote'?rSelected:lSelected;
  const set=focusPane==='remote'?setRSelected:setLSelected;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();set(shown.map(x=>x.path));return;}
  if(event.key==='Backspace'){event.preventDefault();if(focusPane==='remote')goRemote(remoteParent(dir));else goLocal(localParent(localDir));}
  if(event.key==='Delete'&&focusPane==='remote'){event.preventDefault();removeSelected();}
  if(event.key==='F2'&&focusPane==='remote'){event.preventDefault();renameItem();}
  if(event.key==='Enter'&&chosen.length===1){
   const entry=shown.find(x=>x.path===chosen[0]);if(!entry)return;
   if(focusPane==='remote')void openPreview(entry);else if(entry.directory)goLocal(entry.path);
  }
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();const last=shown.findIndex(x=>x.path===chosen.at(-1));
   const index=Math.max(0,Math.min(shown.length-1,last+(event.key==='ArrowDown'?1:-1)));
   if(shown[index])set([shown[index].path]);
  }
 };
 const transferCount=queue.filter(x=>x.status==='running'||x.status==='queued').length;
 const dropped=async(e:React.DragEvent)=>{
  e.preventDefault();setDrag(false);
  const files=[...e.dataTransfer.files].map(file=>api.getFilePath(file)).filter(Boolean);
  await upload(files);
 };
 const sidebar=(name:string,target:Page,Icon:typeof FolderOpen)=>(
  <button className={'nav-button '+(page===target?'active':'')} onClick={()=>setPage(target)}><Icon size={18}/><span>{name}</span>{target==='transfers'&&transferCount>0&&<small>{transferCount}</small>}</button>
 );
 return <div className="app" onKeyDown={keyboard}>
  <header className="topbar"><div className="identity"><span className="brand-symbol"><ArrowUpDown size={19}/></span><div><strong>Mooner Explorer</strong><small>Android 기기 관리자</small></div></div>
   <div className="device-picker"><Smartphone size={17}/><select aria-label="연결 기기" value={device} onChange={e=>{setDevice(e.target.value);goRemote(ROOT);}}><option value="">기기 연결 필요</option>{devices.map(x=><option key={x.id} value={x.id} disabled={x.state!=='device'}>{x.model} — {x.state==='device'?x.id:x.state}</option>)}</select><button aria-label="기기 새로고침" onClick={()=>void scan()}><RefreshCw size={16}/></button></div>
  </header>
  <div className="workspace"><aside className="sidebar">
   <div className="nav-caption">관리</div>
   {sidebar('파일 탐색기','files',FolderOpen)}
   {sidebar('전송 관리','transfers',ArrowUpDown)}
   {sidebar('앱 관리','apps',Package)}
   {sidebar('연결 및 기기 정보','device',Settings)}
   <div className="nav-caption spacer-caption">빠른 경로</div>
   {favorite.map(([name,p])=><button key={p} className="favorite" onClick={()=>{goRemote(p);setPage('files');}}><Folder size={15}/>{name}</button>)}
   <div className="side-foot"><span className={'light '+(active?'connected':'')}/>{active?'ADB 연결됨':devices.some(x=>x.state==='unauthorized')?'휴대폰에서 USB 디버깅 승인 필요':'연결된 기기가 없습니다'}</div>
  </aside>
  <main className="content">
   {page==='files'&&<>
    <div className="page-title"><div><h1>파일 탐색기</h1><p>PC와 Android 사이의 파일과 폴더를 관리합니다.</p></div><div className="inline-controls"><span>중복 파일</span><select aria-label="충돌 처리" value={policy} onChange={e=>setPolicy(e.target.value as Conflict)}><option value="skip">건너뛰기</option><option value="rename">새 이름</option><option value="overwrite">덮어쓰기</option></select></div></div>
    <div className="actions">
     <button onClick={()=>void upload()} disabled={!active}><Upload size={16}/>업로드</button>
     <button onClick={()=>void download()} disabled={!active||!rSelected.length}><Download size={16}/>다운로드</button>
     <button onClick={createFolder} disabled={!active}><Plus size={16}/>폴더</button>
     <button onClick={renameItem} disabled={rSelected.length!==1}><Pencil size={16}/>이름 변경</button>
     <button onClick={()=>copyOrMove(false)} disabled={!rSelected.length}><Copy size={16}/>복사</button>
     <button onClick={()=>copyOrMove(true)} disabled={!rSelected.length}><MoveRight size={16}/>이동</button>
     <button className="danger-link" onClick={removeSelected} disabled={!rSelected.length}><Trash2 size={16}/>삭제</button>
     <div className="push-right"/>
     <button onClick={()=>void api.backup(device,rSelected).then(()=>setPage('transfers')).catch(error)} disabled={!active||!rSelected.length}><HardDrive size={16}/>백업</button>
     <button onClick={()=>void api.restore(device,lSelected,dir).then(()=>setPage('transfers')).catch(error)} disabled={!active||!lSelected.length}><RotateCcw size={16}/>복원</button>
    </div>
    <div className="panes">
     <section className={'pane '+(focusPane==='remote'?'pane-focused':'')} onFocus={()=>setFocusPane('remote')}>
      <div className="pane-heading"><div><Smartphone size={17}/><strong>Android</strong><span>{active?.model||'연결 안 됨'}</span></div><button title="새로고침" onClick={()=>void reloadRemote()} disabled={!active}><RefreshCw size={15}/></button></div>
      <div className="pathline"><button aria-label="상위 폴더" disabled={dir===ROOT} onClick={()=>goRemote(remoteParent(dir))}><ArrowLeft size={15}/></button><span title={dir}>{dir}</span></div>
      <div className="pane-filter"><Search size={15}/><input placeholder="파일 검색" value={query} onChange={e=>setQuery(e.target.value)}/><label title="하위 폴더까지 검색"><input type="checkbox" checked={deep} onChange={e=>setDeep(e.target.checked)}/>하위 포함</label></div>
      <div className={'file-scroll '+(drag?'dragged':'')} onDragOver={e=>e.preventDefault()} onDragEnter={e=>{e.preventDefault();setDrag(true);}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDrag(false);}} onDrop={e=>void dropped(e)}>
       <FileHeader sort={sort} setSort={setSort} descending={descending} setDescending={setDescending}/>
       {!active?<div className="empty"><Smartphone size={34}/><strong>Android를 연결하세요</strong><p>USB 디버깅을 허용하거나 무선 ADB에 연결하세요.</p><button onClick={()=>setPage('device')}>연결 설정</button></div>:loading?<div className="empty">목록을 불러오는 중입니다.</div>:rShown.length===0?<div className="empty">표시할 항목이 없습니다.</div>:
       rShown.map((entry,i)=><FileRow key={entry.path} entry={entry} selected={rSelected.includes(entry.path)} onClick={e=>pick('remote',i,rShown,e)} onOpen={()=>void openPreview(entry)}/>)}
       {drag&&<div className="drop-zone"><Upload size={28}/>여기에 놓아 Android로 전송</div>}
      </div><div className="pane-status">{rShown.length}개 항목 · {rSelected.length}개 선택</div>
     </section>
     <section className={'pane '+(focusPane==='local'?'pane-focused':'')} onFocus={()=>setFocusPane('local')}>
      <div className="pane-heading"><div><Monitor size={17}/><strong>내 PC</strong></div><div><button title="폴더 선택" onClick={()=>void chooseLocal()}><FolderOpen size={15}/></button><button title="새로고침" onClick={()=>void reloadLocal()}><RefreshCw size={15}/></button></div></div>
      <div className="pathline"><button aria-label="PC 상위 폴더" onClick={()=>goLocal(localParent(localDir))}><ArrowLeft size={15}/></button><span title={localDir}>{localDir||'PC 폴더 선택 필요'}</span></div>
      <div className="pane-filter"><button onClick={()=>void chooseLocal()}><FolderOpen size={15}/> 다른 폴더 열기</button><button onClick={()=>void upload(lSelected)} disabled={!active||!lSelected.length}><Upload size={15}/>선택 업로드</button></div>
      <div className="file-scroll"><FileHeader sort={sort} setSort={setSort} descending={descending} setDescending={setDescending}/>
       {lShown.length===0?<div className="empty">폴더가 비어 있거나 접근할 수 없습니다.</div>:lShown.map((entry,i)=><FileRow key={entry.path} entry={entry} selected={lSelected.includes(entry.path)} onClick={e=>pick('local',i,lShown,e)} onOpen={()=>entry.directory?goLocal(entry.path):void run(()=>api.localReveal(entry.path))}/>)}
      </div><div className="pane-status">{lShown.length}개 항목 · {lSelected.length}개 선택</div>
     </section>
    </div>
    <p className="footnote">파일 드래그 앤 드롭은 PC → Android 방향을 지원합니다. Android → PC는 다운로드를 사용하세요. 중단된 파일은 처음부터 다시 전송합니다.</p>
   </>}
   {page==='transfers'&&<>
    <div className="page-title"><div><h1>전송 관리</h1><p>작업 기록은 이 PC에 저장되며 다시 실행할 수 있습니다.</p></div><div className="page-buttons"><button onClick={()=>void api.queueGlobalPause(!paused).then(()=>setPaused(!paused)).catch(error)}>{paused?<Play size={16}/>:<Pause size={16}/>} {paused?'대기열 재개':'대기열 일시정지'}</button><button onClick={()=>void api.queueClear().catch(error)}>완료 내역 정리</button></div></div>
    <section className="transfer-list">{queue.length===0?<div className="empty">전송한 파일이 없습니다.</div>:queue.slice().reverse().map(t=><div className="transfer" key={t.id}>
     <span className="transfer-icon">{t.direction==='push'?<Upload size={18}/>:<Download size={18}/>}</span><div className="transfer-main">
      <div className="transfer-head"><strong title={t.from}>{base(t.from)}</strong><span className={'state '+t.status}>{statusText[t.status]}</span></div>
      <p title={t.to}>{t.direction==='push'?'PC → Android':'Android → PC'} · {t.to}</p>
      <div className="progress"><div style={{width:t.progress+'%'}}/></div>
      <div className="metrics"><span>{t.detail}</span><span>{t.progress.toFixed(0)}% {t.total?('· '+niceSize(t.bytes)+' / '+niceSize(t.total)):''} {t.speed>0?('· '+niceSize(t.speed)+'/s'):''} {t.status==='running'?'· '+fmtTime(t.eta)+' 남음':''}</span></div>
     </div><div className="transfer-buttons">
      {t.status==='running'||t.status==='queued'?<button title="일시정지" onClick={()=>void api.queuePause(t.id).catch(error)}><Pause size={16}/></button>:null}
      {['paused','cancelled','error','skipped'].includes(t.status)&&<button title="처음부터 다시 전송" onClick={()=>void api.queueResume(t.id).catch(error)}><RotateCcw size={16}/></button>}
      {['running','queued','paused'].includes(t.status)&&<button title="취소" onClick={()=>void api.queueCancel(t.id).catch(error)}><Square size={16}/></button>}
     </div>
    </div>)}</section>
   </>}
   {page==='apps'&&<>
    <div className="page-title"><div><h1>앱 관리</h1><p>설치된 패키지를 조회하고 실행하거나 삭제할 수 있습니다.</p></div><div className="page-buttons"><button disabled={!active} onClick={()=>void installApk()}><Plus size={16}/>APK 설치</button><button disabled={!active} onClick={()=>void reloadApps()}><RefreshCw size={16}/>새로고침</button></div></div>
    <div className="apps-toolbar"><label><input type="checkbox" checked={systemApps} onChange={e=>setSystemApps(e.target.checked)}/> 시스템 앱만 보기</label><div className="searchbox"><Search size={16}/><input placeholder="패키지 이름 검색" value={appQuery} onChange={e=>setAppQuery(e.target.value)}/></div></div>
    <section className="app-list">{!active?<div className="empty">기기를 선택하세요.</div>:apps.filter(a=>a.packageName.toLowerCase().includes(appQuery.toLowerCase())).map(x=><div className="app-item" key={x.packageName}><Package size={18}/><span>{x.packageName}</span><button onClick={()=>void run(()=>api.launch(device,x.packageName),'실행 요청 완료')}><Play size={15}/>실행</button><button className="danger-link" onClick={()=>confirmUninstall(x.packageName)}><Trash2 size={15}/>제거</button></div>)}</section>
   </>}
   {page==='device'&&<>
    <div className="page-title"><div><h1>연결 및 기기 정보</h1><p>USB 디버깅, Android 무선 디버깅과 기기 유틸리티를 관리합니다.</p></div><button onClick={()=>void scan()}><RefreshCw size={16}/>검색</button></div>
    <div className="settings-grid">
     <section className="settings-section"><h2>무선 ADB</h2><p>Android 개발자 옵션의 무선 디버깅에서 표시되는 IP와 포트를 입력하세요. 페어링 포트와 연결 포트는 다를 수 있습니다.</p><label>IP:포트</label><input placeholder="192.168.1.12:37123" value={endpoint} onChange={e=>setEndpoint(e.target.value)}/><label>6자리 페어링 코드</label><input placeholder="123456" inputMode="numeric" maxLength={6} value={pairCode} onChange={e=>setPairCode(e.target.value)}/><div className="settings-actions"><button onClick={()=>void run(async()=>{setNotice(await api.wifiPair(endpoint,pairCode));setPairCode('');})}><Wifi size={16}/>페어링</button><button onClick={()=>void run(async()=>{setNotice(await api.wifiConnect(endpoint));await scan();})}>연결</button><button onClick={()=>void run(async()=>{setNotice(await api.wifiDisconnect(endpoint));await scan();})}>연결 해제</button></div></section>
     <section className="settings-section"><h2>기기 도구</h2><p>스크린샷은 PC에 PNG로 저장합니다. 화면 미러링에는 별도로 설치된 scrcpy가 필요합니다.</p><div className="settings-actions column"><button disabled={!active} onClick={()=>void run(async()=>{const saved=await api.screenshot(device);if(saved)setNotice('스크린샷을 저장했습니다');})}><Camera size={16}/>스크린샷 저장</button><button disabled={!active} onClick={()=>void run(()=>api.mirrorStart(device),'scrcpy를 실행했습니다')}><Eye size={16}/>화면 미러링 시작</button><button onClick={()=>void run(()=>api.mirrorStop(),'미러링 종료 요청')}><Square size={16}/>화면 미러링 종료</button></div></section>
     <section className="settings-section device-details"><h2>기기 상세 정보</h2>{!active?<p>연결된 기기가 없습니다.</p>:info?<dl>{Object.entries(info).map(([k,v])=><React.Fragment key={k}><dt>{({model:'모델',manufacturer:'제조사',android:'Android 버전',sdk:'API 레벨',serial:'시리얼',battery:'배터리',storage:'저장 공간'} as Record<string,string>)[k]||k}</dt><dd>{v||'정보 없음'}</dd></React.Fragment>)}</dl>:<p>기기 정보를 불러오는 중입니다.</p>}</section>
     <section className="settings-section"><h2>보안 및 저장 범위</h2><p>공유 저장소(/sdcard) 내부 파일만 변경할 수 있습니다. 보호된 앱 데이터나 시스템 영역에는 접근하지 않습니다.</p><p>대화 내용, 파일 목록, 기기 식별자를 서버에 전송하지 않습니다. 전송 기록은 PC 사용자 데이터 폴더에 저장됩니다.</p></section>
    </div>
   </>}
  </main></div>
  {notice&&<div className="toast" role="status"><AlertCircle size={17}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="닫기"><X size={15}/></button></div>}
  {modal&&<div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget&&!modalBusy)setModal(null);}}><div className="modal" role="dialog" aria-modal="true" aria-label={modal.title}><h2>{modal.danger&&<ShieldAlert size={20}/>} {modal.title}</h2>{modal.description&&<p>{modal.description}</p>}<input autoFocus value={modalInput} placeholder={modal.placeholder} onKeyDown={e=>{if(e.key==='Enter')void submitModal();}} onChange={e=>setModalInput(e.target.value)}/><div className="modal-buttons"><button onClick={()=>setModal(null)} disabled={modalBusy}>취소</button><button className={modal.danger?'destructive':'primary'} disabled={modalBusy} onClick={()=>void submitModal()}>{modalBusy?'처리 중':modal.danger?'확인':'적용'}</button></div></div></div>}
  {preview&&<div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setPreview(null);}}><div className="preview" role="dialog" aria-modal="true" aria-label="파일 미리보기"><div className="preview-head"><strong>{preview.name}</strong><button onClick={()=>setPreview(null)}><X size={19}/></button></div>{preview.mime.startsWith('image/')?<img alt={preview.name} src={'data:'+preview.mime+';base64,'+preview.data}/>:preview.mime.startsWith('audio/')?<audio controls src={'data:'+preview.mime+';base64,'+preview.data}/>:preview.mime.startsWith('video/')?<video controls src={'data:'+preview.mime+';base64,'+preview.data}/>:<pre>{new TextDecoder().decode(Uint8Array.from(atob(preview.data),c=>c.charCodeAt(0)))}</pre>}<div className="preview-foot"><span>{niceSize(preview.size)}</span><button onClick={()=>{if(previewPath)void run(()=>api.open(device,previewPath));}}><ExternalLink size={16}/>외부 앱으로 열기</button></div></div></div>}
 </div>;
}
function FileHeader({sort,setSort,descending,setDescending}:{sort:'name'|'size'|'modified';setSort:(v:'name'|'size'|'modified')=>void;descending:boolean;setDescending:(v:boolean)=>void}){
 return <div className="file-header">{(['name','size','modified'] as const).map((key)=><button key={key} onClick={()=>{if(sort===key)setDescending(!descending);else{setSort(key);setDescending(false);}}}>{({name:'이름',size:'크기',modified:'수정'} as const)[key]} {sort===key?(descending?'↓':'↑'):''}</button>)}</div>;
}
function FileRow({entry,selected,onClick,onOpen}:{entry:Entry;selected:boolean;onClick:(e:React.MouseEvent)=>void;onOpen:()=>void}){
 return <button className={'file-row '+(selected?'selected':'')} onClick={onClick} onDoubleClick={onOpen} title={entry.path}>
  <span className="file-name">{entry.directory?<Folder size={17} className="folder-icon"/>:<File size={17}/>}<span>{entry.name}</span></span>
  <span className="file-size">{entry.directory?'폴더':niceSize(entry.size)}</span>
  <span className="file-date">{entry.modified?new Date(entry.modified*1000).toLocaleDateString('ko-KR'):'—'}</span>
 </button>;
}
createRoot(document.getElementById('root')!).render(<App/>);
