(() => {
  const state = {
    users: [],
    selectedId: null,
    currentUsername: null,
    revealPassword: null, // { userId, password } shown once after create/reset
  };

  const listEl = document.getElementById('user-list');
  const resultCountEl = document.getElementById('result-count');
  const detailPane = document.getElementById('detail-pane');
  const newUserBtn = document.getElementById('new-user-btn');
  const cardTemplate = document.getElementById('user-card-template');

  async function loadUsers() {
    state.users = await api('/api/users');
    renderList();
  }

  function renderList() {
    listEl.innerHTML = '';
    const items = state.users;
    resultCountEl.textContent = `${items.length} user${items.length === 1 ? '' : 's'}`;

    for (const u of items) {
      const node = cardTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.role = u.role;
      node.querySelector('.pc-address').textContent = u.username;
      node.querySelector('.pc-suburb').textContent = u.role === 'admin' ? 'Admin' : 'Viewer';
      node.querySelector('.pc-type').textContent = u.can_manage_users ? 'Admin module access' : '';
      node.classList.toggle('active', u.id === state.selectedId);
      node.addEventListener('click', () => selectUser(u.id));
      listEl.appendChild(node);
    }
  }

  function selectUser(id) {
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
    return state.users.find((u) => u.id === state.selectedId) || null;
  }

  function credentialRevealHtml(userId) {
    if (!state.revealPassword || state.revealPassword.userId !== userId) return '';
    const password = state.revealPassword.password;
    state.revealPassword = null;
    return `
      <div class="credential-box">
        <div class="credential-label">New password (shown once &mdash; save it now)</div>
        <div class="credential-row">
          <code id="credential-password">${escapeHtml(password)}</code>
          <button type="button" class="btn btn-secondary" id="copy-credential">Copy</button>
        </div>
      </div>
    `;
  }

  function wireCredentialReveal() {
    const copyBtn = document.getElementById('copy-credential');
    if (!copyBtn) return;
    copyBtn.addEventListener('click', async () => {
      const text = document.getElementById('credential-password').textContent;
      try {
        await navigator.clipboard.writeText(text);
        showToast('Password copied');
      } catch {
        showToast('Copy failed — select and copy manually', true);
      }
    });
  }

  function renderNewUserForm() {
    syncMobileView(true);
    detailPane.innerHTML = `
      <div class="detail-card">
        <div class="detail-header">
          <button type="button" class="mobile-back-btn" id="back-to-list" aria-label="Back to list">&larr;</button>
          <h2>New User</h2>
        </div>
        <form id="new-user-form">
          <div class="form-grid">
            <div class="field">
              <label for="f-username">Username</label>
              <input id="f-username" name="username" required placeholder="e.g. jordan">
            </div>
            <div class="field">
              <label for="f-role">Role</label>
              <select id="f-role" name="role">
                <option value="viewer">Viewer (read-only)</option>
                <option value="admin">Admin (can manage properties)</option>
              </select>
            </div>
            <div class="field full">
              <label for="f-password">Password <span class="df-empty">(optional &mdash; leave blank to auto-generate)</span></label>
              <div class="password-row">
                <input id="f-password" name="password" type="text" placeholder="Leave blank to auto-generate" autocomplete="off">
                <button type="button" class="btn btn-secondary" id="suggest-password">Suggest</button>
              </div>
            </div>
          </div>
          <div class="card-footer">
            <button type="button" class="btn btn-secondary" id="cancel-new">Cancel</button>
            <button type="submit" class="btn btn-primary">Create User</button>
          </div>
        </form>
      </div>
    `;
    document.getElementById('back-to-list').addEventListener('click', backToList);
    document.getElementById('cancel-new').addEventListener('click', () => {
      state.selectedId = null;
      renderDetail();
    });
    document.getElementById('suggest-password').addEventListener('click', () => {
      document.getElementById('f-password').value = suggestPassword();
    });
    document.getElementById('new-user-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = { username: fd.get('username')?.trim(), role: fd.get('role'), password: fd.get('password')?.trim() };
      try {
        const created = await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
        state.revealPassword = { userId: created.id, password: created.password };
        await loadUsers();
        selectUser(created.id);
        showToast('User created');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }

  function renderDetail() {
    const u = findSelected();
    syncMobileView(!!u || state.selectedId === 'new');
    if (!u) {
      if (state.selectedId === 'new') { renderNewUserForm(); return; }
      detailPane.innerHTML = `<div id="no-selection" class="empty-state"><p>Select a user, or create a new one, to manage access.</p></div>`;
      return;
    }

    const isSelf = u.username === state.currentUsername;

    detailPane.innerHTML = `
      <div class="detail-card">
        <div class="detail-header">
          <button type="button" class="mobile-back-btn" id="back-to-list" aria-label="Back to list">&larr;</button>
          <div class="detail-title-group">
            <h2>${escapeHtml(u.username)}</h2>
            <span class="type-badge" data-role="${u.role}">${u.role === 'admin' ? 'Admin' : 'Viewer'}</span>
            ${u.can_manage_users ? '<span class="badge badge-tenanted">Admin module access</span>' : ''}
          </div>
        </div>

        <form id="access-form">
          <div class="form-grid">
            <div class="field">
              <label>Role</label>
              <select name="role">
                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin (can manage properties)</option>
                <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Viewer (read-only)</option>
              </select>
            </div>
            <div class="field checkbox-field full">
              <label>
                <input type="checkbox" name="can_manage_users" ${u.can_manage_users ? 'checked' : ''} ${isSelf ? 'disabled' : ''}>
                Admin module access (can manage users)
              </label>
              ${isSelf ? '<div class="df-empty" style="margin-top:4px;">You cannot revoke your own admin module access.</div>' : ''}
            </div>
          </div>
          <div class="card-footer">
            <button type="submit" class="btn btn-primary">Save Access</button>
          </div>
        </form>

        <div class="section-title">Password</div>
        <p class="no-sales">Passwords are hashed and cannot be viewed. Set one manually below, or leave it blank to auto-generate.</p>
        <form id="reset-password-form">
          <div class="password-row">
            <input id="f-reset-password" name="password" type="text" placeholder="Leave blank to auto-generate" autocomplete="off">
            <button type="button" class="btn btn-secondary" id="suggest-reset-password">Suggest</button>
          </div>
          <div class="card-footer">
            <button type="submit" class="btn btn-primary">Set Password</button>
          </div>
        </form>

        ${credentialRevealHtml(u.id)}
      </div>
    `;

    wireCredentialReveal();
    document.getElementById('back-to-list').addEventListener('click', backToList);

    document.getElementById('access-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        role: fd.get('role'),
        can_manage_users: fd.get('can_manage_users') === 'on',
      };
      try {
        await api(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        await loadUsers();
        showToast('Access updated');
      } catch (err) {
        showToast(err.message, true);
      }
    });

    document.getElementById('suggest-reset-password').addEventListener('click', () => {
      document.getElementById('f-reset-password').value = suggestPassword();
    });

    document.getElementById('reset-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('f-reset-password').value.trim();
      if (!confirm(`Set a new password for "${u.username}"? Their current password will stop working immediately.`)) return;
      try {
        const result = await api(`/api/users/${u.id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
        state.revealPassword = { userId: u.id, password: result.password };
        renderDetail();
        showToast('Password updated');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }

  newUserBtn.addEventListener('click', () => {
    state.selectedId = 'new';
    renderList();
    renderDetail();
  });

  (async () => {
    const me = await applyRoleBasedNav();
    if (!me || !me.canManageUsers) {
      showToast('Access restricted — redirecting', true);
      setTimeout(() => { window.location.href = 'index.html'; }, 700);
      return;
    }
    state.currentUsername = me.username;
    loadUsers();
  })();
})();
