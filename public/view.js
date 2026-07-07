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

  function fieldRow(label, value) {
    return `<div class="df-item"><dt>${label}</dt><dd>${value ? escapeHtml(value) : '<span class="df-empty">&mdash;</span>'}</dd></div>`;
  }

  function facilitiesRow(facilities) {
    const tags = (facilities || []).length
      ? facilities.map((f) => `<span class="facility-tag">${escapeHtml(f)}</span>`).join('')
      : '<span class="df-empty">&mdash;</span>';
    return `<div class="df-item df-item-full"><dt>Facilities</dt><dd>${tags}</dd></div>`;
  }

  function renderDetail() {
    const p = findSelected();
    syncMobileView(!!p);
    if (!p) {
      detailPane.innerHTML = `<div id="no-selection" class="empty-state"><p>Select a property to view its details.</p></div>`;
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
        detailItem('Strata Plan No', s.strata_plan_no),
        detailItem('Selling Agent', s.selling_agent),
        detailItem('Aspect', s.aspect),
      ].join('');
      return `
        <div class="sale-card">
          <div class="sale-card-header">
            <div class="sale-card-title">
              <span class="sale-date">${escapeHtml(s.sale_date) || 'No date'}</span>
              <span class="sale-price">${formatMoney(s.sale_price)}</span>
              ${s.is_tenanted ? '<span class="badge badge-tenanted">Tenanted</span>' : ''}
            </div>
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
        </div>

        <dl class="detail-fields">
          ${fieldRow('Address', p.address)}
          ${fieldRow('Suburb', p.suburb)}
          ${fieldRow('Year Built', p.year_built)}
          ${fieldRow('Built By', p.built_by)}
          ${fieldRow('Managed By', p.managed_by)}
          ${fieldRow('Manager', p.manager)}
          ${fieldRow("Manager's Email", p.manager_email)}
          ${fieldRow("Manager's Phone", p.manager_phone)}
          ${fieldRow('Number of Units', p.number_of_units)}
          ${facilitiesRow(p.facilities)}
        </dl>

        <div class="section-title">Sales History</div>
        ${p.sales_history.length ? `<div class="sale-cards">${salesCards}</div>` : `<div class="no-sales">No sales recorded yet.</div>`}
      </div>
    `;

    document.getElementById('back-to-list').addEventListener('click', backToList);
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

  applyRoleBasedNav();
  loadProperties();
})();
