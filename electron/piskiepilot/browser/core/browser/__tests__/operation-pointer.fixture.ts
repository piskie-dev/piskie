export const operationPointerEventRecorder = `<script>
window.sampleEvents=[];
for(const type of ['pointermove','pointerdown','pointerup','click','input','change','focusin','keydown'])
 document.addEventListener(type,e=>sampleEvents.push({type,id:e.target.id,x:e.clientX,y:e.clientY,buttons:e.buttons,key:e.key,trusted:e.isTrusted}),true);
</script>`;

export const operationPointerHtml = `<!doctype html><title>Example operations</title><style>
body{margin:0;height:1900px;background:#eef5fa;font:16px sans-serif;color:#14212b}
input,textarea,select,[contenteditable],button{position:absolute;box-sizing:border-box;font:16px sans-serif;padding:6px;border:2px solid #5a849d;background:white}
#sample-input{left:80px;top:60px;width:240px;height:40px}#sample-area{left:80px;top:160px;width:240px;height:80px}
#sample-editable{left:380px;top:60px;width:240px;height:70px}#sample-select{left:380px;top:170px;width:180px;height:40px}
#sample-toggle{left:90px;top:300px;width:26px;height:26px}#sample-file{left:380px;top:300px;width:230px;height:40px}
#sample-chooser{left:380px;top:360px;width:220px;height:40px}#sample-far{left:80px;top:1400px;width:240px;height:40px}
iframe{position:absolute;left:80px;top:410px;width:300px;height:120px;border:4px solid #52677a}
#sample-shadow{position:absolute;left:450px;top:450px;width:230px;height:80px}
#sample-scrollport{position:absolute;left:50px;top:700px;width:300px;height:150px;overflow:auto;background:#dae8f0}
#sample-nested{position:relative;margin:300px 20px 50px;width:220px;height:40px}
</style>
<input id="sample-input" aria-label="Example input"><textarea id="sample-area" aria-label="Example textarea"></textarea>
<div id="sample-editable" contenteditable="true" role="textbox" aria-label="Example editable"></div>
<select id="sample-select" aria-label="Example select"><option value="one">Example one</option><option value="two">Example two</option></select>
<input id="sample-toggle" type="checkbox" aria-label="Example toggle">
<input id="sample-file" type="file" aria-label="Example file"><input id="sample-hidden-file" type="file" hidden>
<button id="sample-chooser" onclick="document.querySelector('#sample-hidden-file').click()">Example chooser</button>
<input id="sample-far" aria-label="Example far input"><iframe src="/sample-input-frame" title="Example input frame"></iframe>
<div id="sample-shadow"></div><div id="sample-scrollport"><input id="sample-nested" aria-label="Example nested input"></div>
<script>document.querySelector('#sample-shadow').attachShadow({mode:'open'}).innerHTML='<input id="sample-shadow-input" aria-label="Example shadow input" style="width:200px;height:40px;margin:10px">';</script>
${operationPointerEventRecorder}`;

export const operationPointerFrameHtml = `<!doctype html><style>body{margin:0;background:#dde9f0}input{position:absolute;left:20px;top:20px;width:180px;height:40px;box-sizing:border-box}</style><input id="sample-frame-input" aria-label="Example frame input">${operationPointerEventRecorder}`;
