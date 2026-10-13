import { escapeHtml as e, request, action } from './components.mjs';

const params = new URLSearchParams(location.search);
const runId = params.get('runId');
const root = document.querySelector('#app');
const api = (resource) => `/api/runs/${encodeURIComponent(runId)}/${resource}`;
const link = (view, extra = {}) => `/workspace?${new URLSearchParams({ runId, view, ...extra })}`;
const titles = { intake: 'Service intake', inventory: 'Stock allocation', approvals: 'Approval desk', board: 'Dispatch board', frames: 'Embedded routing', tabs: 'Receiving windows', diagnostics: 'Connector incident', journey: 'Order overview' };
const descriptions = {
  intake: 'Register customer requirements and hand a complete request to fulfillment.',
  inventory: 'Find available stock, review movement history and allocate inventory to customers.',
  approvals: 'Review pending expenditure and record a finance decision with its supporting note.',
  board: 'Pack parcels, attach handling documents and release shipments to the demo carrier.',
  frames: 'Maintain depot rules in the embedded routing service. Settings are shared with dispatch.',
  tabs: 'Confirm incoming deliveries in a separate window, then reconcile the order ledger.',
  diagnostics: 'Investigate the local connector, stop unnecessary scans and record a resolution.',
  journey: 'Coordinate the Aster demo order from the service desk through final receiving.',
};
let workspace;
let state;
let view;
let content;
const notify = (message, error = false, target = document.querySelector('#feedback')) => {
  if (!target) return;
  target.className = `notice${error ? ' error' : ''}`;
  target.setAttribute('role', error ? 'alert' : 'status');
  target.textContent = message;
};
async function loadState() { workspace = await request(api('workspace')); state = workspace.state; }
async function busy(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
}
const feedback = '<p id="feedback" class="notice" role="status" aria-live="polite"></p>';
const field = (label, input, extra = '') => `<label class="field ${extra}"><span>${label}</span>${input}</label>`;
const stat = (label, value, detail) => `<div class="stat"><small>${label}</small><strong>${e(value)}</strong><span>${detail}</span></div>`;
const stats = () => `<div class="stats">${stat('Service requests', state.intake.submissions.length, 'Current workspace')}${stat('Ready stock lines', state.inventory.items.filter((item) => item.availability === 'Ready').length, 'Across three demo regions')}${stat('Parcels dispatched', state.board.dispatches.length, 'Documented shipments')}${stat('Orders received', state.tabs.confirmations.length, 'Awaiting reconciliation')}</div>`;
const panel = (title, body, tag = '') => `<section class="panel"><div class="panel-head"><h2>${title}</h2>${tag}</div>${body}</section>`;
const sideNotes = (items) => `<aside>${panel('Desk notes', `<div class="panel-body"><ul class="info-list">${items.map(([title, text]) => `<li><strong>${title}</strong><p>${text}</p></li>`).join('')}</ul></div>`)}${panel('Directory', '<div class="panel-body"><ul class="info-list"><li><strong>Aster Demo Co</strong><p>Priority customer · East region</p></li><li><strong>Birch Demo Labs</strong><p>Standard customer · North region</p></li><li><strong>Cedar Demo Works</strong><p>Returns partner · West region</p></li></ul></div>')}</aside>`;
function heading() {
  return `<div class="heading"><div><div class="eyebrow">Operations / ${e(titles[view])}</div><h1>${e(titles[view])}</h1><p>${e(descriptions[view])}</p></div><span class="pill neutral">Synthetic local workspace</span></div>`;
}
function renderShell() {
  const sections = workspace.scenarioId === 'journey' ? ['journey', 'intake', 'inventory', 'board', 'tabs'] : [workspace.scenarioId];
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div><div class="brand"><span class="brand-mark">M</span> Meridian Demo</div><small>Operations workspace</small></div><nav aria-label="Business sections">${sections.map((section, index) => `<a href="${link(section)}" ${view === section ? 'aria-current="page"' : ''}><span class="nav-index">${String(index + 1).padStart(2, '0')}</span>${titles[section]}</a>`).join('')}</nav><div class="sidebar-foot">Demo environment<br>All people, companies and transactions are fictional.<br><br><a href="/" style="color:#c3e6dd">Workspace launcher</a></div></aside><div class="workspace"><header class="topbar"><div class="topbar-path">Meridian Demo <span aria-hidden="true"> / </span> Operations <span aria-hidden="true"> / </span> ${e(titles[view])}</div><div class="user-badge"><span class="avatar">JD</span><span class="user-name">Jordan Demo<br><span class="muted">Operations coordinator</span></span></div></header><main id="main" class="content" tabindex="-1"></main></div></div>`;
  content = document.querySelector('#main');
}
function renderView() {
  content.innerHTML = heading() + (view === 'board' ? '' : stats()) + '<div id="view-content"></div><footer class="business-footer"><span>Meridian Demo · Local operations</span><span>Fictional data · No external services</span></footer>';
  ({ intake: renderIntake, inventory: renderInventory, approvals: renderApprovals, board: renderBoard, frames: renderFrames, tabs: renderTabs, diagnostics: renderDiagnostics, journey: renderJourney })[view]();
}
const setBody = (html) => { document.querySelector('#view-content').innerHTML = html; };

function renderIntake() {
  const receiptId = params.get('receipt');
  const receipt = state.intake.submissions.find((entry) => entry.id === receiptId);
  if (receipt) {
    setBody(`<section class="receipt" aria-label="Service request receipt"><span class="pill">Submitted</span><h2 style="margin-top:16px">Service request ${e(receipt.id)}</h2><dl>${Object.entries({ Customer: receipt.customer, Contact: receipt.contact, Email: receipt.email, Units: receipt.units, Service: receipt.service, Priority: receipt.priority, 'Delivery date': receipt.deliveryDate, Insurance: receipt.insured ? 'Included' : 'Not included', 'Marketing updates': receipt.marketing ? 'Enabled' : 'Disabled', Notes: receipt.notes }).map(([name, value]) => `<div><dt>${name}</dt><dd>${e(value)}</dd></div>`).join('')}</dl><p role="status">The service request is recorded and ready for stock allocation.</p><a class="button" href="${link(workspace.scenarioId === 'journey' ? 'inventory' : 'intake')}">${workspace.scenarioId === 'journey' ? 'Continue to stock allocation' : 'Return to intake'}</a></section>`);
    return;
  }
  setBody(`<div class="layout"><div>${panel('New service request', `<form id="intake-form"><div class="form-grid">
    ${field('Customer', '<select name="customer" required><option value="">Choose a customer</option><option>Aster Demo Co</option><option>Birch Demo Labs</option></select>')}
    ${field('Contact name', '<input name="contact" autocomplete="off" maxlength="100" required>')}
    ${field('Contact email', '<input name="email" type="email" autocomplete="off" maxlength="180" required>')}
    ${field('Requested units', '<input name="units" type="number" min="1" max="500" required>')}
    ${field('Service level', '<select name="service"><option>Standard</option><option>Express</option></select>')}
    ${field('Delivery date', '<input name="deliveryDate" type="date" required>')}
    <fieldset class="span-2"><legend>Request priority</legend><div class="choice-group"><label class="choice"><input type="radio" name="priority" value="Normal" checked> Normal</label><label class="choice"><input type="radio" name="priority" value="High"> High</label></div></fieldset>
    ${field('Handling notes', '<textarea name="notes" maxlength="1000" required placeholder="Add fulfillment instructions"></textarea>', 'span-2')}
    <label class="choice span-2"><input type="checkbox" name="insured"> Include shipment insurance</label>
    <label class="choice span-2"><input type="checkbox" name="marketing"> Send marketing updates</label>
    <label class="choice span-2"><input type="checkbox" name="terms" required> I accept the service terms</label>
    </div><div class="form-actions"><button class="primary" type="submit">Submit service request</button><span class="muted">A receipt appears after submission.</span></div>${feedback}</form>`, '<span class="pill amber">Draft</span>')}</div>${sideNotes([['Required information', 'All contact and shipping fields are required for allocation.'], ['Insurance', 'Protects the declared demo shipment. Marketing preferences are independent.'], ['Service windows', 'Express requests use the next available demo dispatch slot.']])}</div>`);
  document.querySelector('#intake-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    busy(form.querySelector('button'), async () => {
      notify('Submitting service request…');
      const result = await action(runId, 'intake.submit', { customer: fields.get('customer'), contact: fields.get('contact'), email: fields.get('email'), units: Number(fields.get('units')), service: fields.get('service'), priority: fields.get('priority'), deliveryDate: fields.get('deliveryDate'), notes: fields.get('notes'), insured: fields.has('insured'), marketing: fields.has('marketing'), terms: fields.has('terms') });
      location.assign(link('intake', { receipt: result.id }));
    });
  });
}

function renderInventory() {
  const ledger = state.inventory.items.map((item, index) => `<tr><td>MV-${String(900 + index)}</td><td>${e(item.sku)}</td><td>${e(item.name)}</td><td>${e(item.region)}</td><td>${index % 2 ? 'Cycle count' : 'Depot receipt'}</td><td>${item.available}</td><td>${['Casey Demo', 'Avery Demo', 'Rowan Demo'][index % 3]}</td><td>${e(item.bin)}</td></tr>`).join('');
  setBody(`${panel('Available inventory', `<form id="inventory-filter" class="toolbar">${field('Search stock', '<input name="query" placeholder="SKU or product name">', 'search')}${field('Region', '<select name="region"><option>All</option><option>East</option><option>North</option><option>West</option></select>')}${field('Availability', '<select name="availability"><option>All</option><option>Ready</option><option>Inspection</option></select>')}<button class="primary" type="submit">Apply filters</button><button type="button" id="refresh-stock">Refresh stock</button></form><div class="toolbar">${field('Reserve for customer', '<select id="reservation-customer"><option>Aster Demo Co</option><option>Birch Demo Labs</option></select>')}<span id="stock-revision" class="muted">Stock revision ${state.inventory.revision}</span></div><div id="inventory-results" aria-live="polite"></div><div class="panel-body">${feedback}</div>`)}${panel('Recent inventory movements', `<div class="ledger" tabindex="0" aria-label="Scrollable movement history"><table><caption class="sr-only">Seventy-two synthetic stock movements</caption><thead><tr><th>Movement</th><th>SKU</th><th>Product</th><th>Region</th><th>Activity</th><th>Units</th><th>Coordinator</th><th>Bin</th></tr></thead><tbody>${ledger}</tbody></table></div>`, '<span class="pill neutral">72 records</span>')}`);
  let filters = { query: '', region: 'All', availability: 'All', page: 1 };
  let generation = 0;
  async function loadInventory() {
    const current = ++generation;
    const host = document.querySelector('#inventory-results');
    host.setAttribute('aria-busy', 'true');
    host.innerHTML = '<p class="panel-body" role="status">Loading stock results…</p>';
    try {
      const result = await request(`${api('inventory')}?${new URLSearchParams(filters)}`);
      if (current !== generation) return;
      document.querySelector('#stock-revision').textContent = `Stock revision ${result.revision}`;
      host.innerHTML = `<div class="table-wrap"><table><caption class="sr-only">Available stock</caption><thead><tr><th>SKU / Product</th><th>Region</th><th>Status</th><th>Available</th><th>Bin</th><th>Quantity</th><th>Allocation</th></tr></thead><tbody>${result.items.map((item) => `<tr id="stock-${item.sku}" data-sku="${item.sku}"><td><strong>${e(item.sku)}</strong><small>${e(item.name)}</small></td><td>${e(item.region)}</td><td><span class="pill ${item.availability === 'Ready' ? '' : 'amber'}">${e(item.availability)}</span></td><td>${item.available}</td><td>${e(item.bin)}</td><td><input id="quantity-${item.sku}" aria-label="Quantity for ${item.sku}" type="number" min="1" max="${item.available}" value="1"></td><td><button id="reserve-${item.sku}" data-reserve="${item.sku}" ${item.availability === 'Ready' ? '' : 'disabled'}>Reserve ${item.sku}</button></td></tr>`).join('') || '<tr><td colspan="7">No matching stock. Adjust the filters.</td></tr>'}</tbody></table></div><div class="pagination"><span id="page-status">Page ${result.page} of ${result.totalPages} · ${result.total} matching records</span><div class="buttons"><button id="previous-page" ${result.page === 1 ? 'disabled' : ''}>Previous page</button><button id="next-page" ${result.page === result.totalPages ? 'disabled' : ''}>Next page</button></div></div>`;
      document.querySelector('#previous-page').onclick = () => { filters.page--; loadInventory(); };
      document.querySelector('#next-page').onclick = () => { filters.page++; loadInventory(); };
      host.querySelectorAll('[data-reserve]').forEach((button) => button.addEventListener('click', () => busy(button, async () => {
        const sku = button.dataset.reserve;
        const input = document.querySelector(`#quantity-${sku}`);
        if (!input.reportValidity()) return;
        const customer = document.querySelector('#reservation-customer').value;
        notify(`Reserving stock for ${customer}…`);
        const receipt = await action(runId, 'inventory.reserve', { sku, quantity: Number(input.value), customer });
        await loadInventory();
        notify(`Reservation ${receipt.id}: ${receipt.quantity} units of ${receipt.sku} allocated to ${receipt.customer}.`);
      })));
    } catch (error) { if (current === generation) { host.innerHTML = '<p class="panel-body">Stock could not be loaded. Apply filters to retry.</p>'; notify(error.message, true); } }
    finally { if (current === generation) host.setAttribute('aria-busy', 'false'); }
  }
  document.querySelector('#inventory-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    filters = { query: values.get('query'), region: values.get('region'), availability: values.get('availability'), page: 1 };
    loadInventory();
  });
  document.querySelector('#refresh-stock').onclick = (event) => busy(event.currentTarget, async () => {
    await action(runId, 'inventory.refresh');
    await loadInventory();
    notify('Stock refreshed. Review the current row before reserving.');
  });
  loadInventory();
}

function renderApprovals() {
  setBody(`<div class="layout"><div>${panel('Finance review queue', `<div class="panel-body"><div class="approval-cards">${state.approvals.entries.map((entry) => `<article class="approval-card" data-approval="${entry.id}"><div class="card-head"><div><span class="eyebrow">${entry.id}</span><h3>${e(entry.customer)}</h3><p>${entry.amount.toLocaleString('en-US')} ${entry.currency} · Equipment allocation</p></div><div class="context"><button class="menu-trigger" aria-label="Actions for ${entry.id}" aria-haspopup="menu" aria-expanded="false" data-menu="${entry.id}">Actions ▾</button><div class="menu" role="menu" id="menu-${entry.id}" hidden><button role="menuitem" data-approve="${entry.id}" ${entry.status === 'approved' ? 'disabled' : ''}>Approve request</button></div></div></div><div class="choice-group"><span class="pill ${entry.status === 'pending' ? 'amber' : ''}">${entry.status}</span><span class="hover-note"><button class="review-note" aria-describedby="note-${entry.id}" aria-label="Review note for ${entry.id}">Review note</button><span role="tooltip" id="note-${entry.id}" class="tooltip">Finance reviewed this demo allocation.<br>Review code: <strong>${e(entry.reviewCode)}</strong></span></span></div>${entry.reason ? `<p class="notice">Approval reason: ${e(entry.reason)}</p>` : ''}</article>`).join('')}</div>${feedback}</div>`)} </div>${sideNotes([['Review notes', 'Hover or focus Review note to see the finance reference.'], ['Approval record', 'A cancelled confirmation leaves the request pending. Approval records the reason and amount.']])}</div>`);
  document.querySelectorAll('[data-menu]').forEach((button) => button.onclick = () => {
    const menu = document.querySelector(`#menu-${button.dataset.menu}`);
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.querySelectorAll('[data-approve]').forEach((button) => button.onclick = () => busy(button, async () => {
    const id = button.dataset.approve;
    const entry = state.approvals.entries.find((item) => item.id === id);
    if (!confirm(`Approve ${id} for ${entry.customer}, ${entry.amount} ${entry.currency}?`)) {
      await action(runId, 'approvals.cancel', { id });
      notify(`Approval cancelled. ${id} remains pending.`);
      return;
    }
    const reason = prompt(`Approval reason for ${id} (use the finance review reference):`, '');
    if (reason === null) { await action(runId, 'approvals.cancel', { id }); notify(`Approval cancelled. ${id} remains pending.`); return; }
    await action(runId, 'approvals.approve', { id, reason });
    alert(`${id} approved. The decision has been recorded.`);
    await loadState();
    renderView();
    notify(`${id} approved. One finance decision was recorded.`);
  }));
}

function renderBoard() {
  setBody(`${feedback}<div class="board" aria-label="Parcel workflow">${['Ready', 'Packed', 'Dispatched'].map((lane) => `<section class="lane" data-lane="${lane}" aria-label="${lane} parcels"><h2>${lane}<span class="pill neutral">${state.board.cards.filter((card) => card.lane === lane).length}</span></h2>${state.board.cards.filter((card) => card.lane === lane).map((card) => `<article class="parcel" id="parcel-${card.id}" data-card="${card.id}" draggable="${card.lane !== 'Dispatched'}" tabindex="0" aria-label="${card.id} ${e(card.title)}"><span class="eyebrow">${card.id}</span><h3>${e(card.title)}</h3><p class="meta">${card.pieces} demo packages · ${e(card.customer)}</p><span class="pill ${lane === 'Dispatched' ? '' : 'neutral'}">${lane}</span>${state.board.attachments.filter((file) => file.cardId === card.id).map((file) => `<p class="attachment">Attached: ${e(file.name)} · ${file.size} bytes</p>`).join('')}${lane === 'Packed' ? `<label class="field"><span>Parcel note for ${card.id}</span><input type="file" accept=".txt,text/plain" data-upload="${card.id}" aria-label="Parcel note for ${card.id}"></label>` : ''}${lane !== 'Dispatched' ? `<label class="field"><span>Move ${card.id} to</span><select data-move="${card.id}"><option value="">Choose destination</option>${['Ready', 'Packed', 'Dispatched'].filter((target) => target !== lane).map((target) => `<option>${target}</option>`).join('')}</select></label>` : '<p class="attachment">Dispatch receipt recorded</p>'}</article>`).join('')}</section>`).join('')}</div><div class="notice">Drag a parcel to another column. Keyboard users can use its Move control. Pack and attach a parcel note before dispatch.</div>`);
  async function move(cardId, lane) {
    try {
      notify(`Moving ${cardId} to ${lane}…`);
      await action(runId, 'board.move', { cardId, lane });
      await loadState(); renderView();
      notify(`${cardId} moved to ${lane}.${lane === 'Dispatched' ? ' Dispatch receipt recorded.' : ''}`);
    } catch (error) { notify(error.message, true); }
  }
  document.querySelectorAll('[data-card]').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      if (event.target.closest('input,select,button')) { event.preventDefault(); return; }
      event.dataTransfer.setData('text/plain', card.dataset.card);
      event.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); document.querySelectorAll('.drop-active').forEach((lane) => lane.classList.remove('drop-active')); });
  });
  document.querySelectorAll('[data-lane]').forEach((lane) => {
    lane.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; lane.classList.add('drop-active'); });
    lane.addEventListener('dragleave', (event) => { if (!lane.contains(event.relatedTarget)) lane.classList.remove('drop-active'); });
    lane.addEventListener('drop', (event) => { event.preventDefault(); lane.classList.remove('drop-active'); const cardId = event.dataTransfer.getData('text/plain'); if (cardId) move(cardId, lane.dataset.lane); });
  });
  document.querySelectorAll('[data-move]').forEach((select) => select.onchange = () => { if (select.value) move(select.dataset.move, select.value); });
  document.querySelectorAll('[data-upload]').forEach((input) => input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    input.disabled = true;
    try {
      if (file.size > 16384) throw new Error('Parcel notes must be at most 16 KiB.');
      notify(`Uploading ${file.name}…`);
      await action(runId, 'board.attach', { cardId: input.dataset.upload, name: file.name, mime: file.type, content: await file.text() });
      await loadState(); renderView(); notify(`${file.name} attached to the packed parcel.`);
    } catch (error) { notify(error.message, true); } finally { input.disabled = false; }
  });
}

function renderFrames() {
  setBody(panel('Routing workspace', `<iframe class="embedded" title="Routing workspace" src="/frame?${new URLSearchParams({ runId, level: 'outer' })}"></iframe>`));
}

function renderTabs() {
  if (params.get('orderId')) { renderConfirmation(params.get('orderId')); return; }
  setBody(`${panel('Purchase orders', `<div class="toolbar"><p class="muted" style="margin:0;flex:1">Receiving confirmations open in a separate window.</p><button id="refresh-confirmations">Refresh confirmations</button></div><div class="panel-body"><div class="approval-cards">${state.tabs.orders.map((order) => `<article class="approval-card" data-order="${order.id}"><div class="card-head"><div><span class="eyebrow">${order.id}</span><h3>${e(order.customer)}</h3></div><span class="pill ${order.status === 'awaiting' ? 'amber' : ''}">${order.reconciled ? 'reconciled' : order.status}</span></div><dl class="detail-grid"><div><dt>Expected packages</dt><dd>${order.packages}</dd></div><div><dt>Receiving seal</dt><dd>${e(order.seal)}</dd></div></dl><div class="choice-group"><a class="button" id="open-${order.id}" href="${link('tabs', { orderId: order.id })}" target="_blank">Open confirmation for ${order.id}</a><button data-reconcile="${order.id}" ${order.status === 'received' && !order.reconciled ? '' : 'disabled'}>Reconcile ${order.id}</button></div></article>`).join('')}</div>${feedback}</div>`)}`);
  document.querySelector('#refresh-confirmations').onclick = (event) => busy(event.currentTarget, async () => { await loadState(); renderView(); notify('Receiving status refreshed from the order ledger.'); });
  document.querySelectorAll('[data-reconcile]').forEach((button) => button.onclick = () => busy(button, async () => {
    const orderId = button.dataset.reconcile;
    const result = await action(runId, 'tabs.reconcile', { orderId });
    await loadState(); renderView(); notify(`${orderId} reconciled with confirmation ${result.confirmationId}.`);
  }));
}
function renderConfirmation(orderId) {
  const order = state.tabs.orders.find((entry) => entry.id === orderId);
  if (!order) { setBody('<p role="alert">The selected purchase order does not exist.</p>'); return; }
  const receipt = state.tabs.confirmations.find((entry) => entry.orderId === orderId);
  if (receipt) {
    setBody(`<section class="receipt" aria-label="Receiving receipt"><h2>Receiving confirmation ${receipt.id}</h2><p role="status">${e(orderId)} received by ${e(receipt.receiver)}. Package condition: ${e(receipt.condition)}.</p><p>Return to the original orders page and refresh confirmations to reconcile the ledger.</p><button id="close-confirmation">Close confirmation window</button></section>`);
    document.querySelector('#close-confirmation').onclick = () => window.close();
    return;
  }
  setBody(`<div class="layout"><div>${panel(`Receive ${e(orderId)}`, `<form id="receiving-form"><p>${e(order.customer)} · ${order.packages} expected packages</p><div class="form-grid">${field('Received by', '<input name="receiver" maxlength="100" autocomplete="off" required>')}${field('Receiving seal', '<input name="seal" maxlength="80" autocomplete="off" required>')}${field('Package condition', '<select name="condition"><option>Good</option><option>Damaged</option></select>')}<label class="choice span-2"><input type="checkbox" name="counted" required> All packages were counted</label></div><div class="form-actions"><button class="primary" type="submit">Confirm receiving</button></div>${feedback}</form>`)}</div>${sideNotes([['Seal verification', 'Use the receiving seal in the original purchase order details.'], ['Reconciliation', 'Receiving and ledger reconciliation are separate business steps.']])}</div>`);
  document.querySelector('#receiving-form').onsubmit = (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    busy(event.currentTarget.querySelector('button'), async () => {
      await action(runId, 'tabs.confirm', { orderId, receiver: values.get('receiver'), seal: values.get('seal'), condition: values.get('condition'), counted: values.has('counted') });
      await loadState(); renderView();
    });
  };
}

function renderDiagnostics() {
  setBody(`<div class="connector-grid">${panel('Connector health', `<div class="panel-body"><p>Local fulfillment connector</p><p class="notice warning">The legacy route is being retired. Inspect a failed health request and its console entry before changing the configuration.</p><button id="health-check" class="primary">Run health check</button><p id="health-feedback" role="status" class="notice"></p><form id="connector-form"><div class="form-actions">${field('Connector route', `<select name="connector"><option value="legacy" ${state.diagnostics.connector === 'legacy' ? 'selected' : ''}>Legacy demo route</option><option value="v2" ${state.diagnostics.connector === 'v2' ? 'selected' : ''}>Local v2</option></select>`)}<button type="submit">Save connector</button></div></form></div>`)}${panel('Latency scan', '<div class="panel-body"><p>Run an extended local response-time scan. A scan can be cancelled while it is running.</p><div class="choice-group"><button id="start-scan">Start latency scan</button><button id="cancel-scan" disabled>Cancel scan</button></div><div id="scan-progress" class="progress-track" hidden><div class="progress-fill"></div></div><p id="scan-feedback" class="notice" role="status">No scan is running.</p></div>')}</div>${panel('Incident resolution', `<form id="resolution-form"><div class="form-grid">${field('Original error code', '<input name="errorCode" maxlength="100" required>')}${field('Original trace ID', '<input name="traceId" maxlength="100" required>')}${field('Resolution note', '<textarea name="note" maxlength="1000" required></textarea>', 'span-2')}</div><div class="form-actions"><button class="primary" type="submit">File resolution</button><span class="muted">A successful health check is required.</span></div>${feedback}</form>`)}`);
  document.querySelector('#health-check').onclick = (event) => busy(event.currentTarget, async () => {
    const target = document.querySelector('#health-feedback');
    notify('Checking the connector…', false, target);
    const response = await fetch(api('connector'));
    const result = await response.json();
    if (!response.ok) {
      console.error(`Connector ${result.code}; trace ${result.traceId}: ${result.message}`);
      notify('Health check failed. Review the connector request and console details, then retry after repair.', true, target);
    } else {
      console.info(`Connector ready; trace ${result.traceId}`);
      notify('Connector ready. The local v2 health check succeeded.', false, target);
    }
  });
  document.querySelector('#connector-form').onsubmit = (event) => {
    event.preventDefault();
    const connector = new FormData(event.currentTarget).get('connector');
    busy(event.currentTarget.querySelector('button'), async () => { await action(runId, 'diagnostics.configure', { connector }); notify('Connector configuration saved. Run a health check to verify the route.'); });
  };
  let scanId;
  let controller;
  const startButton = document.querySelector('#start-scan');
  const cancelButton = document.querySelector('#cancel-scan');
  const scanFeedback = document.querySelector('#scan-feedback');
  const progress = document.querySelector('#scan-progress');
  startButton.onclick = () => busy(startButton, async () => {
    const scan = await action(runId, 'diagnostics.scan.start');
    scanId = scan.id;
    controller = new AbortController();
    cancelButton.disabled = false;
    progress.hidden = false;
    notify(`${scanId} running…`, false, scanFeedback);
    try {
      const result = await request(api(`scan/${encodeURIComponent(scanId)}`), { signal: controller.signal });
      notify(`${result.id} ${result.status}.`, false, scanFeedback);
    } catch (error) { if (error.name !== 'AbortError') throw error; }
    finally { progress.hidden = true; cancelButton.disabled = true; }
  });
  cancelButton.onclick = () => busy(cancelButton, async () => {
    const result = await action(runId, 'diagnostics.scan.cancel', { scanId });
    controller.abort();
    notify(`${result.id} cancelled. No scan result was applied.`, false, scanFeedback);
  }).then(() => { cancelButton.disabled = true; });
  document.querySelector('#resolution-form').onsubmit = (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    busy(event.currentTarget.querySelector('button'), async () => {
      const receipt = await action(runId, 'diagnostics.resolve', { errorCode: values.get('errorCode'), traceId: values.get('traceId'), note: values.get('note') });
      notify(`Incident ${receipt.id} resolved. The original failure evidence and repair note were recorded.`);
    });
  };
}

function renderJourney() {
  const complete = { intake: state.intake.submissions.length > 0, inventory: state.inventory.reservations.length > 0, board: state.board.dispatches.some((entry) => entry.cardId === 'PAR-104'), tabs: state.tabs.orders[0].reconciled };
  const receipt = state.journey.orders[0];
  if (receipt) {
    setBody(`<section class="receipt" aria-label="Final order record"><span class="pill">Order completed</span><h2 style="margin-top:16px">${receipt.id} · ${e(receipt.customer)}</h2><dl>${Object.entries({ 'Service request': receipt.requestId, 'Stock reservation': receipt.reservationId, Parcel: receipt.parcelId, 'Purchase order': receipt.purchaseOrderId, 'Receiving confirmation': receipt.confirmationId }).map(([key, value]) => `<div><dt>${key}</dt><dd>${e(value)}</dd></div>`).join('')}</dl><p role="status">The finalized order links every fulfillment record.</p></section>`);
    return;
  }
  setBody(`<div class="steps">${Object.entries(complete).map(([section, done], index) => `<section class="step"><span class="pill ${done ? '' : 'neutral'}">${done ? 'Recorded' : 'Pending'}</span><strong>${index + 1}. ${titles[section]}</strong><p class="muted">${descriptions[section]}</p><a class="button" href="${link(section)}">Open ${titles[section]}</a></section>`).join('')}</div>${panel('Final order record', `<div class="panel-body"><p>Finalize the order after the service request, reservation, dispatch and receiving reconciliation are recorded.</p><button id="finalize-order" class="primary" ${Object.values(complete).every(Boolean) ? '' : 'disabled'}>Finalize order</button>${feedback}</div>`)}`);
  document.querySelector('#finalize-order').onclick = (event) => busy(event.currentTarget, async () => { await action(runId, 'journey.finish'); await loadState(); renderView(); });
}

async function renderFrame() {
  document.body.className = 'frame-body';
  if (params.get('level') === 'outer') {
    root.innerHTML = `<main id="main" class="frame-shell"><div class="panel-head"><div><h2>Routing workspace</h2><small>Depot rules / fulfillment handoff</small></div><button id="reload-routing">Reload routing component</button></div><iframe title="Depot routing component" class="embedded" src="/frame?${new URLSearchParams({ runId, level: 'inner' })}"></iframe><p class="muted">Saved rules remain available after reloading the component.</p></main>`;
    let revision = 0;
    document.querySelector('#reload-routing').onclick = () => { document.querySelector('iframe').src = `/frame?${new URLSearchParams({ runId, level: 'inner', revision: String(++revision) })}`; };
  } else {
    root.innerHTML = `<main id="main"><routing-editor run-id="${e(runId)}"></routing-editor></main>`;
  }
}
async function renderCatalog() {
  const catalog = await request('/api/scenarios');
  root.innerHTML = `<main id="main" class="catalog"><div class="eyebrow">Meridian Demo</div><h1>Operations workspaces</h1><p>Choose a fresh fictional workspace. Each workspace has its own business records and local activity.</p><div class="catalog-grid">${catalog.scenarios.map((scenario) => `<article><span class="pill neutral">Demo workspace</span><h2 style="margin-top:16px">${e(scenario.title)}</h2><p>${e(descriptions[scenario.id])}</p><button class="primary" data-create="${e(scenario.id)}">Open ${e(scenario.title)}</button></article>`).join('')}</div><p class="muted">All data is synthetic. No external services are used.</p>${feedback}</main>`;
  document.querySelectorAll('[data-create]').forEach((button) => button.onclick = () => busy(button, async () => {
    const run = await request('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenarioId: button.dataset.create }) });
    location.assign(run.url);
  }));
}
try {
  if (location.pathname === '/') await renderCatalog();
  else if (location.pathname === '/frame') await renderFrame();
  else {
    await loadState();
    view = params.get('view') ?? workspace.scenarioId;
    const allowed = workspace.scenarioId === 'journey' ? ['journey', 'intake', 'inventory', 'board', 'tabs'] : [workspace.scenarioId];
    if (!allowed.includes(view)) throw new Error('This section is not part of the current workspace.');
    document.title = `${titles[view]} · Meridian Demo`;
    renderShell(); renderView();
  }
} catch (error) { root.innerHTML = `<main id="main" class="catalog"><h1>Workspace unavailable</h1><p role="alert">${e(error.message)}</p><a href="/">Open workspace launcher</a></main>`; }
