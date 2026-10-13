import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createState } from './model.mjs';

const parcelBytes = readFileSync(new URL('./data/parcel-note.txt', import.meta.url));
const parcelDigest = createHash('sha256').update(parcelBytes).digest('hex');
const intakeFields = {
  customer: 'Aster Demo Co', contact: 'Riley Demo', email: 'riley@example.invalid', units: 12,
  service: 'Express', priority: 'High', deliveryDate: '2030-06-18', notes: 'Demo launch allocation',
  insured: true, terms: true, marketing: false,
};
const routingFields = { routeId: 'ROUTE-7', depot: 'harbor', reorder: 24, label: 'Demo coastal lane', coldChain: true };
const project = (entry, expected) => entry ? Object.fromEntries(Object.keys(expected).map((key) => [key, entry[key]])) : null;

export function evaluateBusinessRun(run) {
  const checks = [];
  const state = run.state;
  const initial = createState(run.seed);
  const check = (id, expected, actual) => checks.push({ id, passed: isDeepStrictEqual(actual, expected), expected, actual: actual ?? null });
  const modules = {
    intake() {
      check('intake.single-submission', 1, state.intake.submissions.length);
      check('intake.fields', intakeFields, project(state.intake.submissions[0], intakeFields));
      check('intake.submitted', 'submitted', state.intake.submissions[0]?.status);
    },
    inventory() {
      const reservation = state.inventory.reservations[0];
      check('inventory.single-reservation', 1, state.inventory.reservations.length);
      const expected = { sku: 'DEMO-042', quantity: 7, customer: 'Aster Demo Co' };
      check('inventory.reservation-fields', expected, project(reservation, expected));
      check('inventory.refreshed-before-reserving', true, Boolean(reservation && reservation.revision > 0));
      const reserveIndex = run.events.findIndex((entry) => entry.type === 'inventory.reserve');
      check('inventory.filtered-target-view', true, run.events.slice(0, Math.max(0, reserveIndex)).some((entry) => entry.type === 'inventory.view' && entry.data.region === 'East' && entry.data.availability === 'Ready' && entry.data.skus.includes('DEMO-042')));
      const target = state.inventory.items.find((entry) => entry.sku === 'DEMO-042');
      const original = initial.inventory.items.find((entry) => entry.sku === 'DEMO-042');
      check('inventory.target-stock', { available: original.available - 7, reserved: 7 }, { available: target.available, reserved: target.reserved });
      check('inventory.other-stock-unchanged', initial.inventory.items.filter((entry) => entry.sku !== 'DEMO-042'), state.inventory.items.filter((entry) => entry.sku !== 'DEMO-042'));
    },
    approvals() {
      check('approvals.single-decision', 1, state.approvals.decisions.length);
      check('approvals.reason', { id: 'APR-204', reason: 'FIN-DEMO-7' }, state.approvals.decisions[0]);
      check('approvals.target-approved', 'approved', state.approvals.entries.find((entry) => entry.id === 'APR-204')?.status);
      check('approvals.cancel-recorded', true, state.approvals.cancellations.some((entry) => entry.id === 'APR-204'));
      check('approvals.other-request-unchanged', initial.approvals.entries[1], state.approvals.entries[1]);
    },
    board() {
      check('board.target-dispatched', 'Dispatched', state.board.cards.find((entry) => entry.id === 'PAR-104')?.lane);
      check('board.single-dispatch', 1, state.board.dispatches.length);
      check('board.packed-before-dispatch', true, state.board.moves.some((entry) => entry.cardId === 'PAR-104' && entry.from === 'Ready' && entry.to === 'Packed'));
      check('board.single-attachment', 1, state.board.attachments.length);
      const attachmentFields = { cardId: 'PAR-104', name: 'parcel-note.txt', mime: 'text/plain', size: parcelBytes.length, sha256: parcelDigest };
      check('board.attachment-content', attachmentFields, project(state.board.attachments[0], attachmentFields));
      check('board.dispatch-includes-attachment', true, Boolean(state.board.attachments[0] && state.board.dispatches[0]?.cardId === 'PAR-104' && state.board.dispatches[0]?.attachmentIds.includes(state.board.attachments[0].id)));
      check('board.other-parcels-unchanged', initial.board.cards.filter((entry) => entry.id !== 'PAR-104'), state.board.cards.filter((entry) => entry.id !== 'PAR-104'));
      check('board.other-parcels-not-moved', [], state.board.moves.filter((entry) => entry.cardId !== 'PAR-104'));
    },
    frames() {
      check('frames.saved-fields', routingFields, state.frames.routes.find((entry) => entry.routeId === 'ROUTE-7'));
      check('frames.saved-through-editor', true, state.frames.saves.some((entry) => isDeepStrictEqual(entry, routingFields)));
      check('frames.persisted-on-reload', routingFields, state.frames.reads.at(-1)?.find((entry) => entry.routeId === 'ROUTE-7'));
      check('frames.other-route-unchanged', initial.frames.routes[1], state.frames.routes[1]);
      check('frames.other-route-not-edited', [], state.frames.saves.filter((entry) => entry.routeId !== 'ROUTE-7'));
    },
    tabs() {
      check('tabs.single-confirmation', 1, state.tabs.confirmations.length);
      const expected = { orderId: 'PO-731', receiver: 'Morgan Demo', seal: 'DEMO-SEAL-731', condition: 'Good', counted: true };
      check('tabs.receiving-fields', expected, project(state.tabs.confirmations[0], expected));
      check('tabs.target-order', { status: 'received', reconciled: true }, project(state.tabs.orders[0], { status: '', reconciled: false }));
      check('tabs.single-reconciliation', [{ orderId: 'PO-731', confirmationId: state.tabs.confirmations[0]?.id ?? null }], state.tabs.reconciliations);
      check('tabs.other-order-unchanged', initial.tabs.orders[1], state.tabs.orders[1]);
    },
    diagnostics() {
      const failedProbe = state.diagnostics.probes.find((entry) => entry.status === 503);
      check('diagnostics.failure-observed', true, Boolean(failedProbe));
      check('diagnostics.scan-cancelled', true, state.diagnostics.scans.some((entry) => entry.status === 'cancelled'));
      check('diagnostics.no-running-scan', false, state.diagnostics.scans.some((entry) => entry.status === 'running'));
      check('diagnostics.connector-repaired', 'v2', state.diagnostics.connector);
      check('diagnostics.retry-ready', 200, state.diagnostics.probes.at(-1)?.status);
      check('diagnostics.single-resolution', 1, state.diagnostics.resolutions.length);
      const expected = { errorCode: 'DEMO_ROUTE_RETIRED', traceId: `DEMO-TRACE-${String(run.seed).padStart(6, '0')}`, note: 'Demo connector migrated', status: 'resolved' };
      check('diagnostics.evidence', expected, project(state.diagnostics.resolutions[0], expected));
    },
  };
  if (run.scenarioId === 'journey') {
    for (const section of ['intake', 'inventory', 'board', 'tabs']) modules[section]();
    check('journey.single-final-order', 1, state.journey.orders.length);
    check('journey.linked-records', {
      id: 'ORDER-001', customer: 'Aster Demo Co', requestId: state.intake.submissions[0]?.id ?? null,
      reservationId: state.inventory.reservations[0]?.id ?? null, parcelId: 'PAR-104', purchaseOrderId: 'PO-731',
      confirmationId: state.tabs.confirmations[0]?.id ?? null, status: 'completed',
    }, state.journey.orders[0]);
    const orderedTypes = ['intake.submit', 'inventory.reserve', 'board.move', 'tabs.confirm', 'tabs.reconcile', 'journey.finish'];
    const positions = orderedTypes.map((type) => run.events.findIndex((entry) => entry.type === type));
    check('journey.business-sequence', true, positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  } else {
    modules[run.scenarioId]();
  }
  return { status: checks.every((entry) => entry.passed) ? 'passed' : 'failed', checks, completedAt: new Date().toISOString() };
}
