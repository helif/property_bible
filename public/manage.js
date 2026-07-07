(() => {
  const state = {
    properties: [],
    selectedId: null,
    query: '',
  };

  const listEl = document.getElementById('property-list');
  const emptyListEl = document.getElementById('empty-list');
  const resultCountEl = document.getElementById('result-count');
  const detailPane = document.getElementById('detail-pane');
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search');
  const newPropertyBtn = document.getElementById('new-property-btn');
  const cardTemplate = document.getElementById('property-card-template');

  async function loadProperties(query = '') {
    const url = query ? `/api/search?q=${encodeURIComponent(query)}` : '/api/properties';
    state.properties = await api(url);
    renderList();
  }

  function renderList() {
    listEl.innerHTML = '';
    const items = state.properties;
    resultCountEl.textContent = state.query
      ? `${items.length} result${items.length === 1 ? '' : 's'} for "${state.query}"`
      : `${items.length} propert${items.length === 1 ? 'y' : 'ies'}`;
    emptyListEl.hidden = items.length !== 0;

    for (const p of items) {
      const node = cardTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.type = typeSlug(p.type);
      node.querySelector('.pc-address').textContent = p.name || p.address;
      node.querySelector('.pc-suburb').textContent = p.suburb || '';
      node.querySelector('.pc-type').textContent = p.type || '';
      node.classList.toggle('active', p.id === state.selectedId);
      node.addEventListener('click', () => selectProperty(p.id));
      listEl.appendChild(node);
    }
  }

  function selectProperty(id) {
    state.selectedId = id;
    renderList();
    renderDetail();
  }

  function backToList() {
    state.selectedId = null;
    renderList();
    renderDetail();
  }

  function findSelected() {
    return state.properties.find((p) => p.id === state.selectedId) || null;
  }

  function renderNewForm() {
    detailPane.innerHTML = `
      <div class="detail-card">
        <div class="detail-header">
          <button type="button" class="mobile-back-btn" id="back-to-list" aria-label="Back to list">&larr;</button>
          <h2>New Property</h2>
        </div>
        <form id="property-form">
          ${propertyFieldsHtml({})}
          <div class="card-footer">
            <button type="button" class="btn btn-secondary" id="cancel-new">Cancel</button>
            <button type="submit" class="btn btn-primary">Create Property</button>
          </div>
        </form>
      </div>
    `;
    document.getElementById('back-to-list').addEventListener('click', backToList);
    document.getElementById('cancel-new').addEventListener('click', () => {
      state.selectedId = null;
      renderDetail();
    });
    document.getElementById('property-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = readPropertyForm(e.target);
      try {
        const created = await api('/api/properties', { method: 'POST', body: JSON.stringify(data) });
        await loadProperties(state.query);
        selectProperty(created.id);
        showToast('Property created');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }

  function propertyFieldsHtml(p) {
    const typeOptions = PROPERTY_TYPES.map((t) =>
      `<option value="${t}" ${p.type === t ? 'selected' : ''}>${t}</option>`
    ).join('');
    return `
      <div class="form-grid">
        <div class="field">
          <label for="f-name">Name</label>
          <input id="f-name" name="name" value="${escapeHtml(p.name)}" placeholder="Property name">
        </div>
        <div class="field">
          <label for="f-type">Type</label>
          <select id="f-type" name="type">
            <option value="">Select type...</option>
            ${typeOptions}
          </select>
        </div>
        <div class="field">
          <label for="f-address">Address</label>
          <input id="f-address" name="address" required value="${escapeHtml(p.address)}" placeholder="123 Main St, Springfield">
        </div>
        <div class="field">
          <label for="f-suburb">Suburb</label>
          <input id="f-suburb" name="suburb" value="${escapeHtml(p.suburb)}" placeholder="Suburb">
        </div>
        <div class="field">
          <label for="f-year-built">Year Built</label>
          <input id="f-year-built" name="year_built" value="${escapeHtml(p.year_built)}" placeholder="e.g. 1998">
        </div>
        <div class="field">
          <label for="f-built-by">Built By</label>
          <input id="f-built-by" name="built_by" value="${escapeHtml(p.built_by)}" placeholder="Builder/developer">
        </div>
        <div class="field">
          <label for="f-managed-by">Managed By</label>
          <input id="f-managed-by" name="managed_by" value="${escapeHtml(p.managed_by)}" placeholder="Managing company">
        </div>
        <div class="field">
          <label for="f-manager">Manager</label>
          <input id="f-manager" name="manager" value="${escapeHtml(p.manager)}" placeholder="Manager contact name">
        </div>
      </div>
    `;
  }

  function readPropertyForm(form) {
    const fd = new FormData(form);
    return {
      name: fd.get('name')?.trim() || '',
      suburb: fd.get('suburb')?.trim() || '',
      type: fd.get('type') || '',
      address: fd.get('address')?.trim() || '',
      year_built: fd.get('year_built')?.trim() || '',
      built_by: fd.get('built_by')?.trim() || '',
      managed_by: fd.get('managed_by')?.trim() || '',
      manager: fd.get('manager')?.trim() || '',
    };
  }

  function renderDetail() {
    const p = findSelected();
    syncMobileView(!!p || state.selectedId === 'new');
    if (!p) {
      if (state.selectedId === 'new') { renderNewForm(); return; }
      detailPane.innerHTML = `<div id="no-selection" class="empty-state"><p>Select a property, or create a new one, to edit details.</p></div>`;
      return;
    }

    const salesCards = p.sales_history.map((s) => {
      const detailItem = (label, value) => value
        ? `<div class="sc-item"><span class="sc-label">${label}</span><span class="sc-value">${escapeHtml(value)}</span></div>`
        : '';
      const details = [
        detailItem('Unit', s.unit_number),
        detailItem('Layout', s.layout),
        detailItem('Buyer', s.buyer),
        detailItem('Seller', s.seller),
        detailItem('Strata Levy', formatMoney(s.strata_levy)),
        detailItem('Water', formatMoney(s.water)),
        detailItem('Council Fees', formatMoney(s.council_fees)),
      ].join('');
      return `
        <div class="sale-card" data-sale-id="${s.id}">
          <div class="sale-card-header">
            <div class="sale-card-title">
              <span class="sale-date">${escapeHtml(s.sale_date) || 'No date'}</span>
              <span class="sale-price">${formatMoney(s.sale_price)}</span>
              ${s.is_tenanted ? '<span class="badge badge-tenanted">Tenanted</span>' : ''}
            </div>
            <button class="del-sale" title="Remove sale record">&times;</button>
          </div>
          ${details ? `<div class="sale-card-grid">${details}</div>` : ''}
          ${s.notes ? `<div class="sale-card-notes">${escapeHtml(s.notes)}</div>` : ''}
        </div>
      `;
    }).join('');

    detailPane.innerHTML = `
      <div class="detail-card">
        <div class="detail-header">
          <button type="button" class="mobile-back-btn" id="back-to-list" aria-label="Back to list">&larr;</button>
          <div class="detail-title-group">
            <h2>${escapeHtml(p.name || p.address)}</h2>
            ${p.type ? `<span class="type-badge" data-type="${typeSlug(p.type)}">${escapeHtml(p.type)}</span>` : ''}
          </div>
          <div class="detail-actions">
            <button class="btn btn-danger" id="delete-property">Delete</button>
          </div>
        </div>
        <form id="property-form">
          ${propertyFieldsHtml(p)}
          <div class="card-footer">
            <button type="submit" class="btn btn-primary">Save Changes</button>
          </div>
        </form>

        <div class="section-title">Sales History</div>
        ${p.sales_history.length ? `<div class="sale-cards">${salesCards}</div>` : `<div class="no-sales">No sales recorded yet.</div>`}

        <form id="add-sale-form" class="add-sale-form">
          <div class="form-grid">
            <div class="field"><label>Unit Number</label><input type="text" name="unit_number" placeholder="e.g. 12"></div>
            <div class="field">
              <label>Layout</label>
              <select name="layout">
                <option value="">Select layout...</option>
                ${LAYOUT_OPTIONS.map((l) => `<option value="${l}">${l}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Sale Date</label><input type="date" name="sale_date"></div>
            <div class="field"><label>Sale Price</label><input type="number" name="sale_price" step="0.01" placeholder="0.00"></div>
            <div class="field"><label>Buyer</label><input type="text" name="buyer"></div>
            <div class="field"><label>Seller</label><input type="text" name="seller"></div>
            <div class="field"><label>Strata Levy</label><input type="number" name="strata_levy" step="0.01" placeholder="0.00"></div>
            <div class="field"><label>Water</label><input type="number" name="water" step="0.01" placeholder="0.00"></div>
            <div class="field"><label>Council Fees</label><input type="number" name="council_fees" step="0.01" placeholder="0.00"></div>
            <div class="field full"><label>Notes</label><input type="text" name="notes"></div>
            <div class="field full checkbox-field">
              <label><input type="checkbox" name="is_tenanted"> Is Tenanted</label>
            </div>
          </div>
          <div class="card-footer">
            <button type="submit" class="btn btn-secondary">Add Sale</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById('back-to-list').addEventListener('click', backToList);

    document.getElementById('property-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = readPropertyForm(e.target);
      try {
        await api(`/api/properties/${p.id}`, { method: 'PUT', body: JSON.stringify(data) });
        await loadProperties(state.query);
        showToast('Saved');
      } catch (err) {
        showToast(err.message, true);
      }
    });

    document.getElementById('delete-property').addEventListener('click', async () => {
      if (!confirm(`Delete "${p.address}"? This cannot be undone.`)) return;
      try {
        await api(`/api/properties/${p.id}`, { method: 'DELETE' });
        state.selectedId = null;
        await loadProperties(state.query);
        renderDetail();
        showToast('Property deleted');
      } catch (err) {
        showToast(err.message, true);
      }
    });

    document.getElementById('add-sale-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        sale_date: fd.get('sale_date') || null,
        sale_price: fd.get('sale_price') ? Number(fd.get('sale_price')) : null,
        unit_number: fd.get('unit_number')?.trim() || null,
        layout: fd.get('layout') || null,
        buyer: fd.get('buyer')?.trim() || null,
        seller: fd.get('seller')?.trim() || null,
        strata_levy: fd.get('strata_levy') ? Number(fd.get('strata_levy')) : null,
        water: fd.get('water') ? Number(fd.get('water')) : null,
        council_fees: fd.get('council_fees') ? Number(fd.get('council_fees')) : null,
        is_tenanted: fd.get('is_tenanted') === 'on',
        notes: fd.get('notes')?.trim() || null,
      };
      try {
        await api(`/api/properties/${p.id}/sales`, { method: 'POST', body: JSON.stringify(payload) });
        await loadProperties(state.query);
        renderDetail();
        showToast('Sale record added');
      } catch (err) {
        showToast(err.message, true);
      }
    });

    detailPane.querySelectorAll('.del-sale').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const saleId = btn.closest('.sale-card').dataset.saleId;
        try {
          await api(`/api/sales/${saleId}`, { method: 'DELETE' });
          await loadProperties(state.query);
          renderDetail();
          showToast('Sale record removed');
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  }

  const runSearch = debounce(async (q) => {
    state.query = q;
    await loadProperties(q);
  }, 200);

  searchInput.addEventListener('input', (e) => {
    const q = e.target.value;
    clearSearchBtn.hidden = !q;
    runSearch(q);
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.hidden = true;
    state.query = '';
    loadProperties('');
    searchInput.focus();
  });

  newPropertyBtn.addEventListener('click', () => {
    state.selectedId = 'new';
    renderList();
    renderDetail();
  });

  applyRoleBasedNav().then((me) => {
    if (me && me.role !== 'admin') {
      showToast('View-only account — redirecting to View', true);
      setTimeout(() => { window.location.href = 'index.html'; }, 700);
    }
  });
  loadProperties();
})();
