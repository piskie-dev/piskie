export const SUITE_ID = 'browser-operations';
export const SUITE_VERSION = '1';

const intakeTask = 'Create one service request for Aster Demo Co: contact Riley Demo, email riley@example.invalid, 12 units, service Express, priority High, delivery date 2030-06-18, notes "Demo launch allocation". Enable shipment insurance and accept the service terms; leave marketing updates disabled. Submit the request and check its receipt.';
const inventoryTask = 'Filter stock to region East and availability Ready. Find SKU DEMO-042 (Prism field kit), including further result pages as needed. Refresh stock, then reserve 7 units of that SKU for Aster Demo Co. Check the reservation receipt. Do not reserve or change another SKU.';
const boardTask = 'Drag parcel PAR-104 (Aster demo shipment) from Ready to Packed. Attach the supplied parcel-note.txt file to that parcel, then drag it to Dispatched. Check the attachment and dispatch receipt; leave the other parcels unchanged. The attachment is at {{attachmentPath}} on the browser tool host; use that local file with the upload control.';
const tabsTask = 'Open the receiving confirmation for purchase order PO-731 in its new window. Use the seal printed in the order details, receiver Morgan Demo, condition Good, and confirm that all packages were counted. Submit one receiving confirmation, close its window, return to the original orders page, refresh confirmations, and reconcile PO-731. Leave PO-732 unchanged.';

export const scenarios = [
  {
    id: 'intake', title: 'Service intake',
    description: 'A dense service request with text, number, date, select, radio and checkbox fields, validation and a delayed receipt.',
    capabilities: ['snapshot', 'stable-uid', 'fill_form', 'checkbox', 'select', 'radio', 'dynamic-wait', 'navigation'],
    task: 'Open {{url}}. ' + intakeTask,
  },
  {
    id: 'inventory', title: 'Stock allocation',
    description: 'Filter and paginate a seeded stock table, replace its DOM on refresh, then reserve the correct item. Includes a long movement ledger.',
    capabilities: ['snapshot', 'long-snapshot', 'stable-uid', 'rerender', 'fill_form', 'select', 'pagination', 'dynamic-wait'],
    task: 'Open {{url}}. ' + inventoryTask,
  },
  {
    id: 'approvals', title: 'Approval desk',
    description: 'Discover a hover review note, use a contextual menu and handle native confirm, prompt and alert dialogs.',
    capabilities: ['hover', 'menu', 'native-dialog', 'cancel', 'feedback'],
    task: 'Open {{url}}. Review approval APR-204 for Aster Demo Co. Hover its Review note to read the finance review code. Open its Actions menu and begin approval, but cancel the first confirmation while checking the amount. Then approve APR-204 using the review code as the approval reason and dismiss the final notification. Leave APR-205 pending. Check that APR-204 is approved only once.',
  },
  {
    id: 'board', title: 'Dispatch board',
    description: 'Move a real parcel between workflow columns and upload a permanent text attachment before dispatch.',
    capabilities: ['drag', 'upload', 'dynamic-wait', 'feedback'],
    task: 'Open {{url}}. ' + boardTask,
  },
  {
    id: 'frames', title: 'Embedded routing',
    description: 'Edit an open shadow component inside two same-origin iframes and verify its saved settings after remount.',
    capabilities: ['iframe', 'nested-frame', 'open-shadow', 'fill_form', 'checkbox', 'select', 'rerender'],
    task: 'Open {{url}}. In the embedded Routing workspace, edit route ROUTE-7: depot Harbor demo depot, reorder point 24, lane label "Demo coastal lane", and temperature-controlled handling enabled. Save the routing settings, reload the routing component, and check the saved values. Leave ROUTE-8 unchanged.',
  },
  {
    id: 'tabs', title: 'Receiving windows',
    description: 'Confirm a purchase order in a separate window and reconcile it from the original page.',
    capabilities: ['new-page', 'popup', 'page-selection', 'fill_form', 'checkbox', 'navigation', 'dynamic-wait'],
    task: 'Open {{url}}. ' + tabsTask,
  },
  {
    id: 'diagnostics', title: 'Connector incident',
    description: 'Observe a real HTTP failure and console error, cancel a slow scan, repair a local connector and file evidence.',
    capabilities: ['network', 'console', 'cancel', 'retry', 'dynamic-wait', 'fill_form', 'feedback'],
    task: 'Open {{url}}. Run a connector health check and use browser network and console observations to identify its error code and trace ID. Start the latency scan, then cancel it while it is running. Switch the connector to Local v2 and save the configuration, then retry the health check until it is ready. File one resolution using the original failed check’s error code and trace ID, with the note "Demo connector migrated". All requests stay on this local site.',
  },
  {
    id: 'journey', title: 'Order to dispatch',
    description: 'An independent end-to-end run linking intake, stock allocation, parcel dispatch and receiving into one order record.',
    capabilities: ['multi-step', 'navigation', 'fill_form', 'stable-uid', 'rerender', 'drag', 'upload', 'new-page', 'dynamic-wait'],
    task: 'Open {{url}}. Complete the Aster demo order using the workspace sections in order. 1. ' + intakeTask + ' 2. ' + inventoryTask + ' 3. ' + boardTask + ' 4. ' + tabsTask + ' Finally return to Order overview and finalize the order. Check the final order record links the service request, reservation, dispatched parcel and receiving confirmation. This is a separate order run; carry out every step here.',
  },
];

export function getScenario(id) {
  return scenarios.find((scenario) => scenario.id === id);
}
