const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const DB_PATH = path.join(__dirname, 'data', 'properties.db');
require('node:fs').mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const PROPERTY_TYPES = ['Apartment Complex', 'House and Land', 'Townhouse/Villa', 'Commercial', 'Vacant'];
const LAYOUT_OPTIONS = ['1-1-0', '1-1-1', '2-1-0', '2-2-0', '2-2-1', '2-2-2', '3-1-1', '3-2-1', '3-2-2', '3-3-2', 'Other'];

db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    suburb TEXT,
    type TEXT,
    address TEXT NOT NULL,
    year_built TEXT,
    built_by TEXT,
    managed_by TEXT,
    manager TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sales_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    sale_date TEXT,
    sale_price REAL,
    unit_number TEXT,
    layout TEXT,
    buyer TEXT,
    seller TEXT,
    strata_levy REAL,
    water REAL,
    council_fees REAL,
    is_tenanted INTEGER NOT NULL DEFAULT 0,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sales_property ON sales_history(property_id);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    can_manage_users INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
`);

// Migrate older users table (add role column, defaulting existing accounts to admin)
const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userColumns.includes('role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
}
// Migrate in admin-module access (initially granted only to the 'admin' account)
if (!userColumns.includes('can_manage_users')) {
  db.exec("ALTER TABLE users ADD COLUMN can_manage_users INTEGER NOT NULL DEFAULT 0");
  db.prepare("UPDATE users SET can_manage_users = 1 WHERE username = 'admin'").run();
}

// Migrate older schemas (owner/tenant/building_manager/notes -> name/suburb/type/year_built/built_by/managed_by/manager)
const columns = db.prepare("PRAGMA table_info(properties)").all().map((c) => c.name);
if (!columns.includes('name')) {
  db.exec(`
    ALTER TABLE properties ADD COLUMN name TEXT;
    ALTER TABLE properties ADD COLUMN suburb TEXT;
    ALTER TABLE properties ADD COLUMN type TEXT;
    ALTER TABLE properties ADD COLUMN year_built TEXT;
    ALTER TABLE properties ADD COLUMN built_by TEXT;
    ALTER TABLE properties ADD COLUMN managed_by TEXT;
  `);
  if (columns.includes('building_manager')) {
    db.exec(`
      ALTER TABLE properties ADD COLUMN manager TEXT;
      UPDATE properties SET manager = building_manager;
    `);
    db.exec('ALTER TABLE properties DROP COLUMN building_manager');
  } else {
    db.exec('ALTER TABLE properties ADD COLUMN manager TEXT');
  }
  for (const col of ['owner', 'tenant', 'notes']) {
    if (columns.includes(col)) db.exec(`ALTER TABLE properties DROP COLUMN ${col}`);
  }
}

// Migrate older sales_history schemas (add unit_number/layout/strata_levy/water/council_fees/is_tenanted)
const salesColumns = db.prepare("PRAGMA table_info(sales_history)").all().map((c) => c.name);
if (!salesColumns.includes('layout')) {
  db.exec(`
    ALTER TABLE sales_history ADD COLUMN unit_number TEXT;
    ALTER TABLE sales_history ADD COLUMN layout TEXT;
    ALTER TABLE sales_history ADD COLUMN strata_levy REAL;
    ALTER TABLE sales_history ADD COLUMN water REAL;
    ALTER TABLE sales_history ADD COLUMN council_fees REAL;
    ALTER TABLE sales_history ADD COLUMN is_tenanted INTEGER NOT NULL DEFAULT 0;
  `);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createUser(username, password, role = 'admin', canManageUsers = false) {
  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = hashPassword(password, salt);
  db.prepare('INSERT INTO users (username, salt, password_hash, role, can_manage_users) VALUES (?, ?, ?, ?, ?)')
    .run(username, salt, password_hash, role, canManageUsers ? 1 : 0);
}

function generatePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const adminPassword = generatePassword();
  const cathyPassword = generatePassword();
  createUser('admin', adminPassword, 'admin', true);
  createUser('cathy', cathyPassword, 'admin', false);
  console.log('='.repeat(64));
  console.log('Created initial user accounts (passwords shown once):');
  console.log(`  admin : ${adminPassword}`);
  console.log(`  cathy : ${cathyPassword}`);
  console.log('Store these somewhere safe now. They are hashed in storage and cannot be retrieved again.');
  console.log('='.repeat(64));
}

function verifyCredentials(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  const candidate = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.password_hash, 'hex');
  if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) return null;
  return user;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

function getValidSession(token) {
  const row = db.prepare(`
    SELECT u.username, u.role, u.can_manage_users, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/common.js', '/style.css', '/api/login', '/api/logout', '/api/version']);

function sessionAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const token = getCookie(req, 'session');
  const session = token ? getValidSession(token) : null;
  if (session) {
    req.username = session.username;
    req.userRole = session.role;
    req.canManageUsers = !!session.can_manage_users;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'View-only account: editing is not permitted' });
  }
  next();
}

function requireUserAdmin(req, res, next) {
  if (!req.canManageUsers) {
    return res.status(403).json({ error: 'This account does not have admin module access' });
  }
  next();
}

const app = express();
app.use(express.json());
app.use(sessionAuth);

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username && password ? verifyCredentials(username, password) : null;
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const token = createSession(user.id);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ username: user.username, role: user.role, canManageUsers: !!user.can_manage_users });
});

app.post('/api/logout', (req, res) => {
  const token = getCookie(req, 'session');
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ username: req.username, role: req.userRole, canManageUsers: req.canManageUsers });
});

app.get('/api/version', (req, res) => {
  res.json({ version: require('./package.json').version });
});

app.use(express.static(path.join(__dirname, 'public')));

function getSalesFor(propertyId) {
  return db.prepare(
    'SELECT * FROM sales_history WHERE property_id = ? ORDER BY sale_date DESC, id DESC'
  ).all(propertyId);
}

function getPropertyWithSales(id) {
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!property) return null;
  return { ...property, sales_history: getSalesFor(id) };
}

// List all properties (with sales history)
app.get('/api/properties', (req, res) => {
  const properties = db.prepare('SELECT * FROM properties ORDER BY updated_at DESC').all();
  const withSales = properties.map((p) => ({ ...p, sales_history: getSalesFor(p.id) }));
  res.json(withSales);
});

// Keyword search across name, suburb, type, address, built by, managed by, manager, and sales parties
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    const properties = db.prepare('SELECT * FROM properties ORDER BY updated_at DESC').all();
    return res.json(properties.map((p) => ({ ...p, sales_history: getSalesFor(p.id) })));
  }
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT DISTINCT p.* FROM properties p
    LEFT JOIN sales_history s ON s.property_id = p.id
    WHERE p.name LIKE ? OR p.suburb LIKE ? OR p.type LIKE ? OR p.address LIKE ?
       OR p.year_built LIKE ? OR p.built_by LIKE ? OR p.managed_by LIKE ? OR p.manager LIKE ?
       OR s.buyer LIKE ? OR s.seller LIKE ? OR s.unit_number LIKE ?
    ORDER BY p.updated_at DESC
  `).all(like, like, like, like, like, like, like, like, like, like, like);
  res.json(rows.map((p) => ({ ...p, sales_history: getSalesFor(p.id) })));
});

// Get single property
app.get('/api/properties/:id', (req, res) => {
  const property = getPropertyWithSales(req.params.id);
  if (!property) return res.status(404).json({ error: 'Not found' });
  res.json(property);
});

function validatePropertyBody(body) {
  const { name, suburb, type, address, year_built, built_by, managed_by, manager } = body;
  if (!address || !address.trim()) {
    return { error: 'Address is required' };
  }
  if (type && !PROPERTY_TYPES.includes(type)) {
    return { error: `Type must be one of: ${PROPERTY_TYPES.join(', ')}` };
  }
  return {
    values: {
      name: name?.trim() || null,
      suburb: suburb?.trim() || null,
      type: type || null,
      address: address.trim(),
      year_built: year_built?.toString().trim() || null,
      built_by: built_by?.trim() || null,
      managed_by: managed_by?.trim() || null,
      manager: manager?.trim() || null,
    },
  };
}

// Create property
app.post('/api/properties', requireAdmin, (req, res) => {
  const { error, values } = validatePropertyBody(req.body);
  if (error) return res.status(400).json({ error });
  const result = db.prepare(`
    INSERT INTO properties (name, suburb, type, address, year_built, built_by, managed_by, manager)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(values.name, values.suburb, values.type, values.address, values.year_built, values.built_by, values.managed_by, values.manager);
  res.status(201).json(getPropertyWithSales(result.lastInsertRowid));
});

// Update property
app.put('/api/properties/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM properties WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { error, values } = validatePropertyBody(req.body);
  if (error) return res.status(400).json({ error });
  db.prepare(`
    UPDATE properties
    SET name = ?, suburb = ?, type = ?, address = ?, year_built = ?, built_by = ?, managed_by = ?, manager = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(values.name, values.suburb, values.type, values.address, values.year_built, values.built_by, values.managed_by, values.manager, req.params.id);
  res.json(getPropertyWithSales(req.params.id));
});

// Delete property
app.delete('/api/properties/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM properties WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// Add sale record
app.post('/api/properties/:id/sales', requireAdmin, (req, res) => {
  const property = db.prepare('SELECT id FROM properties WHERE id = ?').get(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const {
    sale_date, sale_price, unit_number, layout, buyer, seller,
    strata_levy, water, council_fees, is_tenanted, notes,
  } = req.body;
  if (layout && !LAYOUT_OPTIONS.includes(layout)) {
    return res.status(400).json({ error: `Layout must be one of: ${LAYOUT_OPTIONS.join(', ')}` });
  }
  const result = db.prepare(`
    INSERT INTO sales_history (
      property_id, sale_date, sale_price, unit_number, layout, buyer, seller,
      strata_levy, water, council_fees, is_tenanted, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id, sale_date || null, sale_price || null, unit_number || null, layout || null,
    buyer || null, seller || null, strata_levy || null, water || null, council_fees || null,
    is_tenanted ? 1 : 0, notes || null
  );
  db.prepare(`UPDATE properties SET updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.status(201).json(getPropertyWithSales(req.params.id));
});

// Delete sale record
app.delete('/api/sales/:saleId', requireAdmin, (req, res) => {
  const sale = db.prepare('SELECT property_id FROM sales_history WHERE id = ?').get(req.params.saleId);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sales_history WHERE id = ?').run(req.params.saleId);
  res.json(getPropertyWithSales(sale.property_id));
});

// List users (no password data)
app.get('/api/users', requireUserAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, can_manage_users FROM users ORDER BY username').all();
  res.json(users.map((u) => ({ ...u, can_manage_users: !!u.can_manage_users })));
});

const MIN_PASSWORD_LENGTH = 8;

function resolvePassword(requestedPassword) {
  const trimmed = (requestedPassword || '').trim();
  if (!trimmed) return { password: generatePassword() };
  if (trimmed.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  return { password: trimmed };
}

// Create user
app.post('/api/users', requireUserAdmin, (req, res) => {
  const username = (req.body.username || '').trim();
  const role = req.body.role;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: "Role must be 'admin' or 'viewer'" });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'That username is already taken' });

  const { password, error } = resolvePassword(req.body.password);
  if (error) return res.status(400).json({ error });
  createUser(username, password, role, false);
  const user = db.prepare('SELECT id, username, role, can_manage_users FROM users WHERE username = ?').get(username);
  res.status(201).json({ ...user, can_manage_users: !!user.can_manage_users, password });
});

// Update an existing user's role / admin module access
app.put('/api/users/:id', requireUserAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const role = req.body.role;
  const canManageUsers = !!req.body.can_manage_users;
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: "Role must be 'admin' or 'viewer'" });
  if (user.username === req.username && !canManageUsers) {
    return res.status(400).json({ error: 'You cannot revoke your own admin module access' });
  }
  db.prepare('UPDATE users SET role = ?, can_manage_users = ? WHERE id = ?').run(role, canManageUsers ? 1 : 0, req.params.id);
  const updated = db.prepare('SELECT id, username, role, can_manage_users FROM users WHERE id = ?').get(req.params.id);
  res.json({ ...updated, can_manage_users: !!updated.can_manage_users });
});

// Reset (or manually set) a user's password
app.post('/api/users/:id/reset-password', requireUserAdmin, (req, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { password, error } = resolvePassword(req.body?.password);
  if (error) return res.status(400).json({ error });
  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = hashPassword(password, salt);
  db.prepare('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?').run(salt, password_hash, req.params.id);
  res.json({ password });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Property manager running at http://localhost:${PORT}`);
});
