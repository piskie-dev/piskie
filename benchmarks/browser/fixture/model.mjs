import { createHash } from 'node:crypto';
import { getScenario } from './scenarios.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new HttpError(status, message); };
const text = (max = 160) => (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (min, max) => (value) => Number.isInteger(value) && value >= min && value <= max;
const oneOf = (...values) => (value) => values.includes(value);
const boolean = (value) => typeof value === 'boolean';
const email = (value) => text(180)(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function validateObject(value, fields, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object.');
  for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) fail(`Unknown field: ${key}.`);
  for (const [key, validate] of Object.entries(fields)) {
    if (optional.includes(key) && !Object.hasOwn(value, key)) continue;
    if (!validate(value[key])) fail(`Invalid field: ${key}.`);
  }
  return value;
}

export function validateRunInput(input) {
  validateObject(input, { scenarioId: (id) => typeof id === 'string' && Boolean(getScenario(id)), seed: integer(0, 0xffffffff) }, ['seed']);
  return { scenarioId: input.scenarioId, seed: input.seed ?? 1 };
}

function randomForSeed(seed) {
  let current = seed >>> 0;
  return () => { current = (Math.imul(current, 1664525) + 1013904223) >>> 0; return current / 0x100000000; };
}

export function createState(seed) {
  const random = randomForSeed(seed);
  const items = Array.from({ length: 72 }, (_, index) => {
    const number = index + 1;
    return {
      sku: `DEMO-${String(number).padStart(3, '0')}`,
      name: number === 42 ? 'Prism field kit' : `${['Atlas', 'Prism', 'Orbit', 'Lumen'][index % 4]} demo kit ${number}`,
      region: number % 2 === 0 ? 'East' : number % 3 === 0 ? 'North' : 'West',
      availability: number === 42 || number % 3 !== 0 ? 'Ready' : 'Inspection',
      available: 30 + Math.floor(random() * 150), reserved: 0,
      bin: `D-${String(1 + Math.floor(random() * 24)).padStart(2, '0')}`,
    };
  });
  return {
    intake: { submissions: [] },
    inventory: { items, revision: 0, reservations: [] },
    approvals: {
      entries: [
        { id: 'APR-204', customer: 'Aster Demo Co', amount: 2840, currency: 'USD', status: 'pending', reviewCode: 'FIN-DEMO-7', reason: '' },
        { id: 'APR-205', customer: 'Birch Demo Labs', amount: 1920, currency: 'USD', status: 'pending', reviewCode: 'FIN-DEMO-8', reason: '' },
      ], decisions: [], cancellations: [],
    },
    board: {
      cards: [
        { id: 'PAR-104', title: 'Aster demo shipment', customer: 'Aster Demo Co', lane: 'Ready', pieces: 12 },
        { id: 'PAR-105', title: 'Birch demo replenishment', customer: 'Birch Demo Labs', lane: 'Ready', pieces: 8 },
        { id: 'PAR-106', title: 'Cedar demo returns', customer: 'Cedar Demo Works', lane: 'Packed', pieces: 3 },
      ], attachments: [], moves: [], dispatches: [],
    },
    frames: {
      routes: [
        { routeId: 'ROUTE-7', depot: 'central', reorder: 10, label: 'Demo inland lane', coldChain: false },
        { routeId: 'ROUTE-8', depot: 'central', reorder: 16, label: 'Demo city lane', coldChain: false },
      ], saves: [], reads: [],
    },
    tabs: {
      orders: [
        { id: 'PO-731', customer: 'Aster Demo Co', seal: 'DEMO-SEAL-731', packages: 12, status: 'awaiting', reconciled: false },
        { id: 'PO-732', customer: 'Birch Demo Labs', seal: 'DEMO-SEAL-732', packages: 8, status: 'awaiting', reconciled: false },
      ], confirmations: [], reconciliations: [],
    },
    diagnostics: { connector: 'legacy', probes: [], scans: [], resolutions: [], configurationChanges: [] },
    journey: { orders: [] },
  };
}

const schemas = {
  'intake.submit': { customer: oneOf('Aster Demo Co', 'Birch Demo Labs'), contact: text(100), email, units: integer(1, 500), service: oneOf('Standard', 'Express'), priority: oneOf('Normal', 'High'), deliveryDate: date, notes: text(1000), insured: boolean, terms: (value) => value === true, marketing: boolean },
  'inventory.refresh': {},
  'inventory.reserve': { sku: text(40), quantity: integer(1, 500), customer: oneOf('Aster Demo Co', 'Birch Demo Labs') },
  'approvals.cancel': { id: text(40) },
  'approvals.approve': { id: text(40), reason: text(300) },
  'board.move': { cardId: text(40), lane: oneOf('Ready', 'Packed', 'Dispatched') },
  'board.attach': { cardId: text(40), name: (value) => text(100)(value) && !/[\\\0]/.test(value) && !value.includes('/') && value.endsWith('.txt'), mime: oneOf('text/plain', ''), content: text(16384) },
  'frames.save': { routeId: text(40), depot: oneOf('central', 'harbor', 'upland'), reorder: integer(1, 250), label: text(100), coldChain: boolean },
  'tabs.confirm': { orderId: text(40), receiver: text(100), seal: text(80), condition: oneOf('Good', 'Damaged'), counted: (value) => value === true },
  'tabs.reconcile': { orderId: text(40) },
  'diagnostics.scan.start': {},
  'diagnostics.scan.cancel': { scanId: text(40) },
  'diagnostics.configure': { connector: oneOf('legacy', 'v2') },
  'diagnostics.resolve': { errorCode: text(100), traceId: text(100), note: text(1000) },
  'journey.finish': {},
};
const journeyDomains = ['intake', 'inventory', 'board', 'tabs', 'journey'];
export function allowDomain(run, domain) {
  if (run.scenarioId !== domain && !(run.scenarioId === 'journey' && journeyDomains.includes(domain))) fail('This workspace does not contain that business section.', 403);
}
function entity(list, key, id) {
  const item = list.find((entry) => entry[key] === id);
  if (!item) fail(`No record exists for ${id}.`, 404);
  return item;
}
function requireBusiness(condition, message) { if (!condition) fail(message, 409); }
export function recordEvent(run, type, data = {}) {
  run.updatedAt = new Date().toISOString();
  run.events.push({ sequence: run.events.length + 1, type, at: run.updatedAt, data: structuredClone(data) });
}

export function applyAction(run, input) {
  const schema = input && typeof input.type === 'string' && Object.hasOwn(schemas, input.type) ? schemas[input.type] : undefined;
  if (!schema) fail('Unknown business action.');
  validateObject(input, { type: (value) => value === input.type, ...schema });
  const domain = input.type.split('.')[0];
  allowDomain(run, domain);
  const { type, ...data } = input;
  const state = run.state;
  let result;
  switch (type) {
    case 'intake.submit': {
      result = { id: `REQ-${String(state.intake.submissions.length + 1).padStart(3, '0')}`, ...data, status: 'submitted' };
      state.intake.submissions.push(result);
      break;
    }
    case 'inventory.refresh': {
      state.inventory.revision++;
      result = { revision: state.inventory.revision };
      break;
    }
    case 'inventory.reserve': {
      const item = entity(state.inventory.items, 'sku', data.sku);
      requireBusiness(item.availability === 'Ready', 'This stock is still under inspection.');
      requireBusiness(data.quantity <= item.available, 'The requested quantity exceeds available stock.');
      if (run.scenarioId === 'journey') requireBusiness(state.intake.submissions.some((entry) => entry.customer === data.customer), 'Submit the customer service request before reserving stock.');
      result = { id: `RSV-${String(state.inventory.reservations.length + 1).padStart(3, '0')}`, ...data, revision: state.inventory.revision };
      item.available -= data.quantity;
      item.reserved += data.quantity;
      state.inventory.reservations.push(result);
      break;
    }
    case 'approvals.cancel': {
      const entry = entity(state.approvals.entries, 'id', data.id);
      requireBusiness(entry.status === 'pending', 'This request has already been approved.');
      state.approvals.cancellations.push(data);
      result = { status: 'cancelled', id: data.id };
      break;
    }
    case 'approvals.approve': {
      const entry = entity(state.approvals.entries, 'id', data.id);
      requireBusiness(entry.status === 'pending', 'This request has already been approved.');
      entry.status = 'approved';
      entry.reason = data.reason;
      state.approvals.decisions.push(data);
      result = entry;
      break;
    }
    case 'board.move': {
      const card = entity(state.board.cards, 'id', data.cardId);
      requireBusiness(card.lane !== data.lane, 'The parcel is already in that column.');
      requireBusiness(card.lane !== 'Dispatched', 'A dispatched parcel cannot be moved back.');
      if (data.lane === 'Dispatched') {
        requireBusiness(card.lane === 'Packed', 'Pack the parcel before dispatch.');
        requireBusiness(state.board.attachments.some((entry) => entry.cardId === data.cardId), 'Attach a parcel note before dispatch.');
        if (run.scenarioId === 'journey') requireBusiness(state.inventory.reservations.some((entry) => entry.customer === card.customer), 'Reserve the customer stock before dispatch.');
      }
      const move = { cardId: card.id, from: card.lane, to: data.lane };
      card.lane = data.lane;
      state.board.moves.push(move);
      if (data.lane === 'Dispatched') state.board.dispatches.push({ cardId: card.id, attachmentIds: state.board.attachments.filter((entry) => entry.cardId === card.id).map((entry) => entry.id) });
      result = move;
      break;
    }
    case 'board.attach': {
      const card = entity(state.board.cards, 'id', data.cardId);
      requireBusiness(card.lane === 'Packed', 'Parcel notes can be attached to packed parcels.');
      const bytes = Buffer.from(data.content, 'utf8');
      if (bytes.length > 16384) fail('Parcel notes must be at most 16 KiB.', 413);
      result = { id: `ATT-${String(state.board.attachments.length + 1).padStart(3, '0')}`, cardId: data.cardId, name: data.name, mime: data.mime || 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      state.board.attachments.push(result);
      break;
    }
    case 'frames.save': {
      const route = entity(state.frames.routes, 'routeId', data.routeId);
      Object.assign(route, data);
      state.frames.saves.push({ ...data });
      result = route;
      break;
    }
    case 'tabs.confirm': {
      const order = entity(state.tabs.orders, 'id', data.orderId);
      requireBusiness(order.status === 'awaiting', 'This purchase order already has a receiving confirmation.');
      requireBusiness(order.seal === data.seal, 'The seal does not match this purchase order.');
      if (run.scenarioId === 'journey') requireBusiness(state.board.cards.some((card) => card.customer === order.customer && card.lane === 'Dispatched'), 'Dispatch the customer parcel before recording receipt.');
      result = { id: `RCV-${String(state.tabs.confirmations.length + 1).padStart(3, '0')}`, ...data };
      order.status = 'received';
      state.tabs.confirmations.push(result);
      break;
    }
    case 'tabs.reconcile': {
      const order = entity(state.tabs.orders, 'id', data.orderId);
      requireBusiness(order.status === 'received', 'Receive the order before reconciliation.');
      requireBusiness(!order.reconciled, 'This purchase order is already reconciled.');
      order.reconciled = true;
      result = { orderId: data.orderId, confirmationId: state.tabs.confirmations.find((entry) => entry.orderId === data.orderId).id };
      state.tabs.reconciliations.push(result);
      break;
    }
    case 'diagnostics.scan.start': {
      requireBusiness(!state.diagnostics.scans.some((scan) => scan.status === 'running'), 'A latency scan is already running.');
      result = { id: `SCAN-${state.diagnostics.scans.length + 1}`, status: 'running' };
      state.diagnostics.scans.push(result);
      break;
    }
    case 'diagnostics.scan.cancel': {
      const scan = entity(state.diagnostics.scans, 'id', data.scanId);
      requireBusiness(scan.status === 'running', 'This scan is no longer running.');
      scan.status = 'cancelled';
      result = scan;
      break;
    }
    case 'diagnostics.configure': {
      state.diagnostics.connector = data.connector;
      state.diagnostics.configurationChanges.push(data);
      result = data;
      break;
    }
    case 'diagnostics.resolve': {
      requireBusiness(state.diagnostics.connector === 'v2' && state.diagnostics.probes.at(-1)?.status === 200, 'A successful health check is required before resolving the incident.');
      result = { id: `INC-${String(state.diagnostics.resolutions.length + 1).padStart(3, '0')}`, ...data, status: 'resolved' };
      state.diagnostics.resolutions.push(result);
      break;
    }
    case 'journey.finish': {
      requireBusiness(state.journey.orders.length === 0, 'This order is already finalized.');
      const request = state.intake.submissions.find((entry) => entry.customer === 'Aster Demo Co');
      const reservation = state.inventory.reservations.find((entry) => entry.customer === 'Aster Demo Co');
      const dispatch = state.board.dispatches.find((entry) => entry.cardId === 'PAR-104');
      const receiving = state.tabs.reconciliations.find((entry) => entry.orderId === 'PO-731');
      requireBusiness(request && reservation && dispatch && receiving, 'Finish intake, reservation, dispatch and receiving before finalizing this order.');
      result = { id: 'ORDER-001', customer: 'Aster Demo Co', requestId: request.id, reservationId: reservation.id, parcelId: dispatch.cardId, purchaseOrderId: receiving.orderId, confirmationId: receiving.confirmationId, status: 'completed' };
      state.journey.orders.push(result);
      break;
    }
  }
  // Upload evidence contains a digest, not a second copy of the supplied document.
  recordEvent(run, type, type === 'board.attach' ? result : data);
  return structuredClone(result);
}

export function listInventory(run, parameters) {
  allowDomain(run, 'inventory');
  validateObject(parameters, {
    query: (value) => typeof value === 'string' && value.length <= 100,
    region: oneOf('All', 'East', 'North', 'West'), availability: oneOf('All', 'Ready', 'Inspection'), page: integer(1, 100),
  });
  let items = run.state.inventory.items.filter((item) => (parameters.region === 'All' || item.region === parameters.region) && (parameters.availability === 'All' || item.availability === parameters.availability) && `${item.sku} ${item.name}`.toLowerCase().includes(parameters.query.toLowerCase()));
  if (run.state.inventory.revision % 2) items = items.flatMap((_, index, all) => index % 2 === 0 ? all.slice(index, index + 2).reverse() : []);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  if (parameters.page > totalPages) fail('This result page does not exist.');
  const result = { items: items.slice((parameters.page - 1) * pageSize, parameters.page * pageSize), page: parameters.page, totalPages, total: items.length, revision: run.state.inventory.revision };
  recordEvent(run, 'inventory.view', { ...parameters, revision: result.revision, skus: result.items.map((item) => item.sku) });
  return structuredClone(result);
}

export function readRoutes(run) {
  allowDomain(run, 'frames');
  const data = structuredClone(run.state.frames.routes);
  run.state.frames.reads.push(data);
  recordEvent(run, 'frames.read');
  return data;
}

export function probeConnector(run) {
  allowDomain(run, 'diagnostics');
  const working = run.state.diagnostics.connector === 'v2';
  const result = {
    status: working ? 200 : 503, code: working ? 'DEMO_CONNECTOR_READY' : 'DEMO_ROUTE_RETIRED',
    traceId: `DEMO-TRACE-${String(run.seed).padStart(6, '0')}`,
    message: working ? 'Local v2 connector is ready.' : 'The legacy demo route is retired. Select Local v2 and retry.',
    connector: run.state.diagnostics.connector,
  };
  run.state.diagnostics.probes.push(result);
  recordEvent(run, 'diagnostics.probe', result);
  return structuredClone(result);
}

export function completeScan(run, scanId) {
  allowDomain(run, 'diagnostics');
  const scan = entity(run.state.diagnostics.scans, 'id', scanId);
  if (scan.status === 'running') { scan.status = 'completed'; recordEvent(run, 'diagnostics.scan.completed', { scanId }); }
  return structuredClone(scan);
}
