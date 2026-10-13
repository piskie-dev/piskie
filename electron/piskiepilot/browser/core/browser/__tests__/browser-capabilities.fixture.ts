export function sampleCapabilitiesHtml(baseUrl: string, label = 'Sample page') {
  const crossUrl = baseUrl.replace('127.0.0.1', 'localhost');
  const fields = Array.from({ length: 10 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return `<label>Sample field ${number}<input id="sample-field-${number}" name="field-${number}"></label>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${label}</title>
<style>body{margin:0;padding:20px;background:#e6f0f8;color:#123;font:16px sans-serif}h1{margin:0 0 12px}button,input,select{font:inherit;padding:6px}#sample-form{display:grid;grid-template-columns:240px 240px;gap:8px}label input{display:block;width:205px}#sample-form button{grid-column:1 / 3}section{margin:10px 0}iframe{width:280px;height:105px;border:3px solid #467}#sample-drag{display:inline-block;width:100px;height:40px;background:#8ac;margin:10px}#sample-drop{display:inline-block;width:130px;height:40px;background:#ca8;margin:10px}#sample-late{min-height:20px}</style>
<h1>${label}</h1><form id="sample-form">${fields}<button id="sample-submit">Sample submit</button></form>
<output id="sample-form-result">Sample form pending</output>
<section><button id="sample-click">Sample click</button><button id="sample-hover">Sample hover</button><button id="sample-menu">Sample menu</button><span id="sample-options"></span><button id="sample-stable">Sample stable</button><output id="sample-action-result">Sample action pending</output></section>
<section><select id="sample-select" aria-label="Sample select"><option value="one">Sample one</option><option value="two">Sample two</option></select><label><input type="checkbox" id="sample-toggle">Sample toggle</label></section>
<form id="sample-type-form"><input id="sample-type" aria-label="Sample typing"><button>Sample typing submit</button><output id="sample-type-result">Sample typing pending</output></form>
<section><span id="sample-drag" role="button" tabindex="0">Sample drag</span><span id="sample-drop" role="button" tabindex="0">Sample drop</span><output id="sample-drag-result">Sample drag pending</output><input type="file" multiple id="sample-upload" aria-label="Sample upload"></section>
<section><input id="sample-dialog-first" aria-label="Sample dialog first"><input id="sample-dialog-second" aria-label="Sample dialog second"><input id="sample-dialog-third" aria-label="Sample dialog third"><button id="sample-prompt">Sample prompt</button></section>
<section><iframe name="sample-same" src="/sample-frame" title="Sample same frame"></iframe><iframe name="sample-srcdoc" title="Sample srcdoc frame" srcdoc="${sampleFrameHtml('Sample srcdoc').replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe><iframe name="sample-cross" src="${crossUrl}/sample-frame?cross" title="Sample cross frame"></iframe></section>
<output id="sample-late"></output><script src="/sample-mapped.js"></script><script>
window.sampleState={clicks:0,hovers:0,stable:0,submitted:[],submits:0,typed:[],drop:0,keys:[],fieldOrder:[],dialogShown:false};
const byId=id=>document.getElementById(id);
byId('sample-form').onsubmit=e=>{e.preventDefault();sampleState.submits++;sampleState.submitted=[...new FormData(e.target).values()];byId('sample-form-result').textContent='Sample form complete';};
for(const input of document.querySelectorAll('#sample-form input'))input.addEventListener('input',()=>sampleState.fieldOrder.push(input.name));
byId('sample-click').onclick=()=>{sampleState.clicks++;byId('sample-action-result').textContent='Sample click complete';};
byId('sample-hover').onmouseenter=()=>{sampleState.hovers++;byId('sample-action-result').textContent='Sample hover complete';};
byId('sample-stable').onclick=()=>sampleState.stable++;
byId('sample-menu').onclick=()=>{byId('sample-options').innerHTML='<button id="sample-option">Sample generated option</button>';byId('sample-option').onclick=()=>{sampleState.option='chosen';byId('sample-action-result').textContent='Sample option chosen';};};
byId('sample-type-form').onsubmit=e=>{e.preventDefault();sampleState.typed.push(byId('sample-type').value);byId('sample-type-result').textContent='Sample typing complete';};
document.addEventListener('keydown',e=>sampleState.keys.push({key:e.key,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey}));
let dragging=false;byId('sample-drag').onmousedown=()=>dragging=true;byId('sample-drop').onmouseup=()=>{if(dragging){sampleState.drop++;byId('sample-drag-result').textContent='Sample drop complete';}dragging=false;};
byId('sample-dialog-second').oninput=()=>{if(!sampleState.dialogShown){sampleState.dialogShown=true;alert('Sample form interruption');}};
byId('sample-prompt').onclick=()=>{sampleState.prompt=prompt('Sample fictional prompt','Sample default');};
</script></html>`;
}

export function sampleFrameHtml(label = 'Sample iframe') {
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:10px;background:#f5e9cf;font:14px sans-serif}button,input{font:inherit;padding:5px}</style><button id="sample-frame-click">${label} button</button><input id="sample-frame-input" aria-label="${label} input"><script>window.sampleFrameClicks=0;document.querySelector('button').onclick=()=>{sampleFrameClicks++;document.querySelector('button').textContent='${label} complete'};</script>`;
}

export const sampleMappedScript = `function sampleMappedFailure(){console.error(new Error('Sample mapped failure'));}window.sampleMappedFailure=sampleMappedFailure;\n//# sourceMappingURL=sample-mapped.js.map\n`;
export const sampleMappedSourceMap = JSON.stringify({ version: 3, file: 'sample-mapped.js', sources: ['sample-original.js'], sourcesContent: ["export function sampleMappedFailure() { console.error(new Error('Sample mapped failure')); }"], names: ['sampleMappedFailure'], mappings: 'AAAA' });
