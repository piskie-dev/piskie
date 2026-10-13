export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? body.message ?? `Request failed (${response.status}).`);
  return body;
}
export const action = async (runId, type, fields = {}) => (await request(`/api/runs/${encodeURIComponent(runId)}/actions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...fields }),
})).result;

class RoutingEditor extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.load();
  }
  async load() {
    this.shadowRoot.innerHTML = '<p role="status">Loading depot routing settings…</p>';
    try {
      this.routes = (await request(`/api/runs/${encodeURIComponent(this.getAttribute('run-id'))}/routes`)).routes;
      this.selected = this.routes[0].routeId;
      this.render();
    } catch (error) {
      this.shadowRoot.innerHTML = `<p role="alert">${escapeHtml(error.message)}</p>`;
    }
  }
  render() {
    const route = this.routes.find((entry) => entry.routeId === this.selected);
    const e = escapeHtml;
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="/assets/styles.css">
      <style>:host{display:block}.panel{margin:0}.form-grid{gap:12px}.form-actions{margin-top:14px;padding-top:12px}</style>
      <section class="panel" aria-label="Route configuration">
        <div class="panel-head"><h3>Depot routing editor</h3><span class="pill neutral">Embedded service</span></div>
        <form id="routing-form">
          <div class="form-grid">
            <label class="field"><span>Route</span><select id="route-id" name="routeId">${this.routes.map((entry) => `<option value="${e(entry.routeId)}" ${entry.routeId === this.selected ? 'selected' : ''}>${e(entry.routeId)}</option>`).join('')}</select></label>
            <label class="field"><span>Depot</span><select id="depot" name="depot"><option value="central" ${route.depot === 'central' ? 'selected' : ''}>Central demo depot</option><option value="harbor" ${route.depot === 'harbor' ? 'selected' : ''}>Harbor demo depot</option><option value="upland" ${route.depot === 'upland' ? 'selected' : ''}>Upland demo depot</option></select></label>
            <label class="field"><span>Reorder point</span><input id="reorder" name="reorder" type="number" min="1" max="250" value="${route.reorder}" required></label>
            <label class="field"><span>Lane label</span><input id="lane-label" name="label" maxlength="100" value="${e(route.label)}" required></label>
            <label class="choice span-2"><input id="cold-chain" name="coldChain" type="checkbox" ${route.coldChain ? 'checked' : ''}> Temperature-controlled handling</label>
          </div>
          <div class="form-actions"><button class="primary" type="submit">Save routing settings</button><span class="muted">Changes apply to the selected route.</span></div>
          <p id="routing-feedback" class="notice" role="status" aria-live="polite"></p>
        </form>
      </section>`;
    this.shadowRoot.querySelector('#route-id').addEventListener('change', (event) => { this.selected = event.target.value; this.render(); });
    this.shadowRoot.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      const feedback = this.shadowRoot.querySelector('#routing-feedback');
      const fields = new FormData(form);
      button.disabled = true;
      feedback.textContent = 'Saving routing settings…';
      try {
        const saved = await action(this.getAttribute('run-id'), 'frames.save', {
          routeId: fields.get('routeId'), depot: fields.get('depot'), reorder: Number(fields.get('reorder')),
          label: fields.get('label'), coldChain: fields.has('coldChain'),
        });
        this.routes = this.routes.map((entry) => entry.routeId === saved.routeId ? saved : entry);
        feedback.className = 'notice';
        feedback.textContent = `Routing settings saved for ${saved.routeId}.`;
      } catch (error) {
        feedback.className = 'notice error';
        feedback.textContent = error.message;
      } finally { button.disabled = false; }
    });
  }
}
customElements.define('routing-editor', RoutingEditor);
