const PROPERTY_TYPES = ['Apartment Complex', 'House and Land', 'Townhouse/Villa', 'Commercial', 'Vacant'];
const LAYOUT_OPTIONS = ['1-1-0', '1-1-1', '2-1-0', '2-2-0', '2-2-1', '2-2-2', '3-1-1', '3-2-1', '3-2-2', '3-3-2', 'Other'];
const TYPE_SLUGS = {
  'Apartment Complex': 'apartment',
  'House and Land': 'house',
  'Townhouse/Villa': 'townhouse',
  'Commercial': 'commercial',
  'Vacant': 'vacant',
};
function typeSlug(type) {
  return TYPE_SLUGS[type] || 'none';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { const body = await res.json(); if (body.error) message = body.error; } catch {}
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function suggestPassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function formatMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  const num = Number(n);
  if (Number.isNaN(num)) return '';
  return num.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

let _toastTimer = null;
function showToast(message, isError = false) {
  const toastEl = document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2500);
}

function syncMobileView(hasSelection) {
  const appEl = document.querySelector('.app');
  if (appEl) appEl.classList.toggle('showing-detail', !!hasSelection);
}

async function getCurrentUser() {
  try { return await api('/api/me'); } catch { return null; }
}

async function applyRoleBasedNav() {
  const me = await getCurrentUser();
  if (me) {
    if (me.role !== 'admin') {
      document.querySelectorAll('.nav-link[href="manage.html"]').forEach((el) => el.remove());
    }
    if (!me.canManageUsers) {
      document.querySelectorAll('.nav-link[href="admin.html"]').forEach((el) => el.remove());
    }
    const nameEl = document.getElementById('current-username');
    if (nameEl) nameEl.textContent = me.username;
  }
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  return me;
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (e) { /* ignore — clearing the cookie client-side isn't possible for httpOnly cookies anyway */ }
  window.location.href = 'login.html';
}
