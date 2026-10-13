// Isolated renderer: desktop IPC is bridged to a real ScreenStreamHub over SSE.
// The monitor, leases, Worker, OffscreenCanvas and remote input are production code.
export const browserMonitorUiSource = `
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import en from './src/i18n/locales/en-US';
import {RendererRuntimeProvider} from './src/renderer-runtime/RendererRuntimeProvider';
import {createScreenFeedRegistry} from './src/domains/screen-feed/screen-feed-registry';
import {BrowserMonitorPanel,FloatingBrowserMonitors} from './src/features/console/modes/thread/BrowserMonitor';
import {useBrowserMonitor} from './src/features/console/modes/thread/useBrowserMonitor';
import {BrowserScreenView} from './src/features/console/content/ScreenView';
import {ScreenFullscreen} from './src/features/console/content/ScreenFullscreen';
import {WorkerCreationRow} from './src/features/console/content/WorkerCreationRow';
import {projectConversationNodes} from './src/domains/transcript/project-entry';
import layout from './src/features/console/modes/thread/threadview.module.css';
i18n.use(initReactI18next).init({lng:'en-US',resources:{'en-US':{translation:en}},interpolation:{escapeValue:false}});
window.sampleState={ports:{},errors:[],inputs:[]};
window.sampleActivities={};
const screenFeeds=createScreenFeedRegistry({
 requestPort:async(options)=>{
  const id=options.browserId;
  window.sampleState.ports[id]=(window.sampleState.ports[id]||0)+1;
  const channel=new MessageChannel();
  const source=new EventSource('/sample-stream?id='+encodeURIComponent(id));
  source.onmessage=e=>{
   const message=JSON.parse(e.data);
   if(message.type==='frame') message.data=Uint8Array.from(atob(message.data),c=>c.charCodeAt(0));
   channel.port1.postMessage(message);
  };
  channel.port1.onmessage=e=>{
   if(e.data.type==='stop'){source.close();channel.port1.close();return;}
   if(e.data.type==='input')window.sampleState.inputs.push(e.data);
   fetch('/sample-control?id='+encodeURIComponent(id),{method:'POST',body:JSON.stringify(e.data)});
  };
  channel.port1.start();return channel.port2;
 },
 createWorker:()=>new Worker('/sample-worker.js',{type:'module'}),
});
window.addEventListener('error',event=>window.sampleState.errors.push(event.message));
const first={id:'sample-worker-a',subject:'Sample task A',type:'browser-worker',status:'running',browserId:'sample-browser-a',browserReady:true};
const second={...first,id:'sample-worker-b',subject:'Sample task B',browserId:'sample-browser-b'};
const pending={...first,id:'sample-worker-c',subject:'Sample task C',browserId:'sample-browser-c',browserReady:false};
const empty=[];
const workerRow=projectConversationNodes([
 {t:'msg',ts:1,id:'sample-row',role:'assistant',content:[{type:'tool_use',id:'sample-create',name:'subagent',input:{type:'browser-worker',subject:'Inspect a generic sample page with a long task title. '.repeat(5),prompt:'Inspect the sample.'}}]},
 {t:'tool',ts:2,toolUseId:'sample-create',ok:true,result:[{type:'text',text:'subagentId: sample-worker-a'}]},
])[0];
function App(){
 const [scope,setScope]=useState('sample-main');
 const [workers,setWorkers]=useState([first,second,pending]);
 const [panel,setPanel]=useState(true);
 const [panelWidth,setPanelWidth]=useState('38%');
 const [gate,setGate]=useState(false);
 const [interactive,setInteractive]=useState(false);
 const [full,setFull]=useState(null);
 const reading=useRef(null);
 const controller=useBrowserMonitor(scope,scope==='sample-main'?workers:empty);
 window.sampleUi={scope:setScope,panel:setPanel,panelWidth:value=>setPanelWidth(value+'px'),gate:setGate,interactive:setInteractive,
  resources:count=>setWorkers(Array.from({length:count},(_,index)=>index<2?[first,second][index]:index===2?pending:
   {...pending,id:'sample-worker-'+index,browserId:'sample-browser-'+index,subject:'Sample pending task '+index})),
  closeResource:id=>setWorkers(items=>items.filter(item=>item.id!==id)),
  taskState:(id,type)=>{
   window.sampleActivities[id]={text:type==='completed'?'Completed':type==='need_user_action'?'Waiting for user action':'Executing',unfinished:type!=='completed'};
   setWorkers(items=>items.map(item=>item.id===id?{...item,taskState:{inputAt:Date.now(),...(type&&{notification:{type,at:Date.now()}})}}:item));
  },
  snapshot:()=>({windows:controller.windows,tasks:controller.tasks,feeds:screenFeeds.activeFeedCount()}),
  close:()=>screenFeeds.close(),
 };
 const target=controller.tasks.find(task=>task.key===full);
 return <RendererRuntimeProvider runtime={{screenFeeds}}>
  <main className={layout.threadview} style={{'--col-panel':panelWidth}} data-threads-collapsed="true" data-panel-hidden={panel?undefined:'true'}>
   <nav className={layout.threads}>Sample</nav>
   <div className={layout.center}><header style={{height:40,flexShrink:0}}>Sample conversation</header>
    <div className={layout.column}>
     <div ref={reading} data-reading="true" style={{flex:1,minHeight:0,overflow:'auto'}}>Sample reading area
      <div data-worker-line="true" style={{width:360}}><WorkerCreationRow cell={workerRow} mainAgentId={scope} status="running" onActivate={()=>{}}/></div>
     </div>
     <div data-tasks="true" style={{height:35}}>Sample task list</div>
     <div data-input="true" style={{height:gate?220:100,flexShrink:0}}>{gate?<button>Approve sample</button>:<textarea aria-label="Sample input"/>}</div>
     <FloatingBrowserMonitors agentId={scope} controller={controller} readingRef={reading} hidden={false} onFullscreen={setFull}
      onReturnToMonitor={key=>{controller.close(key);if(controller.tasks.length>0)setPanel(true)}}/>
    </div>
   </div>
   <aside className={layout.panel} style={{paddingTop:40}} data-collapsed={panel?undefined:'true'}>
    <button data-manual="true" onClick={()=>window.sampleState.manualClicked=true}>Sample manual browser control</button>
    <div style={{height:'calc(100% - 30px)'}}><BrowserMonitorPanel key={scope} agentId={scope} tasks={controller.tasks} windows={controller.windows} hidden={!panel}
     onOpen={key=>{const rect=reading.current.getBoundingClientRect();controller.open(key,rect)}} trackFrame={controller.trackFrame}/></div>
   </aside>
  </main>
  {interactive&&<div data-interactive-test="true" style={{position:'fixed',left:20,top:20,width:640,height:400,zIndex:30}}>
   <BrowserScreenView subagentId={first.id} browserId={first.browserId} browserReady={true} interactive fit="full"/>
  </div>}
  {target&&<ScreenFullscreen open subagentId={target.workerId} browserId={target.browserId} title={target.title} browserReady={target.ready} resourceClosed={target.closed} onClose={()=>setFull(null)}/>}
 </RendererRuntimeProvider>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

export const browserMonitorUiHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/sample-ui.css"><style>
:root{--cyber-primary:#71d6ff;--cyber-bg:#101820;--cyber-surface:#17232e;--cyber-text:#edf4fa;--cyber-text-muted:#9cb0c0;--surface-1:#17232e;--surface-2:#243747;--surface-3:#31485b;--line-1:#263946;--line-2:#355062;--line-3:#406078;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:#101820;color:#edf4fa;font:14px sans-serif}#root{height:100dvh}
</style></head><body><div id="root"></div><script type="module" src="/sample-ui.js"></script></body></html>`;
