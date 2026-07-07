(() => {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');
  const versionEl = document.getElementById('login-version');

  api('/api/version')
    .then((res) => { if (versionEl) versionEl.textContent = `v${res.version}`; })
    .catch(() => { /* version display is non-essential */ });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const fd = new FormData(form);
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: fd.get('username')?.trim(), password: fd.get('password') }),
      });
      window.location.href = 'index.html';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
})();
