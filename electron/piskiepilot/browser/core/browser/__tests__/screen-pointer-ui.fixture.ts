// Only the desktop MessagePort handshake is replaced by a local SSE/MessageChannel bridge.
// The feed registry, Worker, OffscreenCanvas, viewport hook and screen components are production code.
export const screenPointerUiSource = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {RendererRuntimeProvider} from './src/renderer-runtime/RendererRuntimeProvider';
import {createScreenFeedRegistry} from './src/domains/screen-feed/screen-feed-registry';
import {BrowserScreenView} from './src/features/console/content/ScreenView';
import {ScreenFullscreen} from './src/features/console/content/ScreenFullscreen';
i18n.use(initReactI18next).init({lng:'en',resources:{en:{translation:{sessionWorkbenchUi:{screen:{
 monitoring:'Monitoring',picture:'Picture',frameRate:'Frame rate',browserWindow:'Browser window',
 close:'Close',showBrowserWindow:'Show browser window',closeFullscreen:'Close fullscreen',
 liveStatus:'Live',escapeHint:'Esc to close',connecting:'Connecting',waitingFirstFrame:'Waiting for frame'
}}}}},interpolation:{escapeValue:false}});
window.sampleState = {messages:[],errors:[]};
const screenFeeds=createScreenFeedRegistry({
 requestPort:async()=>{
  const channel=new MessageChannel();
  const source=new EventSource('/sample-stream');
  source.onmessage=e=>{
   const message=JSON.parse(e.data);
   if(message.type==='frame'){
    const raw=atob(message.data);
    message.data=Uint8Array.from(raw,c=>c.charCodeAt(0));
   }
   window.sampleState.messages.push(message.type==='frame'?{type:'frame',meta:message.meta}:message);
   channel.port1.postMessage(message);
  };
  channel.port1.onmessage=e=>{
   if(e.data.type==='stop'){source.close();channel.port1.close();return;}
   fetch('/sample-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e.data)});
  };
  channel.port1.start();
  return channel.port2;
 },
 createWorker:()=>new Worker('/sample-worker.js',{type:'module'}),
 scheduleFrame:callback=>{const id=requestAnimationFrame(callback);return()=>cancelAnimationFrame(id)},
 scheduleDelay:(callback,delay)=>{const id=setTimeout(callback,delay);return()=>clearTimeout(id)},
});
window.addEventListener('error',event=>window.sampleState.errors.push(event.message));
function App(){
 const [open,setOpen]=useState(false);
 const [hidden,setHidden]=useState(false);
 window.sampleUi={fullscreen:setOpen,hidden:setHidden,close:()=>screenFeeds.close()};
 return <RendererRuntimeProvider runtime={{screenFeeds}}><main>
  <div data-example="inline" style={{width:480,height:360}}><BrowserScreenView subagentId="sample-agent" browserId="sample-browser" browserReady={true}/></div>
  <div data-example="scroll" style={{width:260,height:420}}><BrowserScreenView subagentId="sample-agent" browserId="sample-browser" browserReady={true}/></div>
  <div style={{width:360,height:240}}><div data-example="scaled" style={{width:600,height:400,transform:'scale(.6)',transformOrigin:'0 0'}}><BrowserScreenView subagentId="sample-agent" browserId="sample-browser" browserReady={true} fidelity={hidden?'hidden':'visible'}/></div></div>
  <ScreenFullscreen open={open} onClose={()=>setOpen(false)} subagentId="sample-agent" browserId="sample-browser" title="Example screen"/>
 </main></RendererRuntimeProvider>
}
createRoot(document.getElementById('root')).render(<App/>);
`;

export const screenPointerUiHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/sample-ui.css"><style>
:root{--cyber-primary:#71d6ff;--cyber-bg:#101820;--cyber-surface:#17232e;--cyber-text:#edf4fa;--cyber-muted:#9cb0c0;--cyber-border:#2d4558;--line-1:#263946;color-scheme:dark}
*{box-sizing:border-box}body{margin:20px;background:#101820;color:#edf4fa;font:14px sans-serif}main{display:flex;gap:20px;align-items:flex-start}
</style></head><body><div id="root"></div><script type="module" src="/sample-ui.js"></script></body></html>`;
