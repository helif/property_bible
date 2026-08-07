const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

// DATA_DIR lets a persistent disk (e.g. a Render Disk mounted outside the
// ephemeral build directory) be used in production; defaults to a local
// folder for development, where __dirname is stable across runs.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'properties.db');
require('node:fs').mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

// Kept in sync with public/common.js — server validates against these, common.js renders <option>s from them.
const PROPERTY_TYPES = ['Apartment', 'House', 'Townhouse/Villa', 'Commercial', 'Vacant Land', 'Other'];
const FACILITY_OPTIONS = ['Indoor Pool', 'Spa', 'BBQ Area', 'Gym', 'Sauna', 'Gardens', 'Picnic Area', 'Outdoor Pool/Spa', 'Reception', 'Terrace', 'Lounge', 'Function Room', 'Other'];
const LAYOUT_OPTIONS = ['1-1-0', '1-1-1', '2-1-0', '2-2-0', '2-2-1', '2-2-2', '3-1-1', '3-2-1', '3-2-2', '3-3-2', 'Other'];
// Also kept in sync with public/common.js's STRATA_FIELD_TYPES/showsStrataFields — property types that have a Building.
const STRATA_FIELD_TYPES = ['Apartment', 'Townhouse/Villa'];

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
    manager_email TEXT,
    manager_phone TEXT,
    number_of_units INTEGER,
    unit_number TEXT,
    layout TEXT,
    aspect TEXT,
    strata_plan_no TEXT,
    facilities TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sales_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    sale_date TEXT,
    sale_price REAL,
    buyer TEXT,
    seller TEXT,
    strata_levy REAL,
    water REAL,
    council_fees REAL,
    is_tenanted INTEGER NOT NULL DEFAULT 0,
    selling_agent TEXT,
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

  CREATE TABLE IF NOT EXISTS buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    address TEXT NOT NULL,
    suburb TEXT,
    strata_plan_no TEXT,
    number_of_units INTEGER,
    managed_by TEXT,
    manager TEXT,
    manager_email TEXT,
    manager_phone TEXT,
    building_manager TEXT,
    building_manager_email TEXT,
    building_manager_phone TEXT,
    facilities TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  DROP INDEX IF EXISTS idx_buildings_key;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_buildings_spn
    ON buildings(strata_plan_no COLLATE NOCASE)
    WHERE strata_plan_no IS NOT NULL AND strata_plan_no <> '';
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
// Note: 'name' (and several other columns checked below) were later moved off properties entirely by
// the Building split further down — every such guard is also gated on `!columns.includes('building_id')`
// so it can never fire again once that split has happened, even though its own sentinel column is gone.
const columns = db.prepare("PRAGMA table_info(properties)").all().map((c) => c.name);
if (!columns.includes('name') && !columns.includes('building_id')) {
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

// Migrate in manager contact details, unit count, and facilities
if (!columns.includes('manager_email') && !columns.includes('building_id')) {
  db.exec(`
    ALTER TABLE properties ADD COLUMN manager_email TEXT;
    ALTER TABLE properties ADD COLUMN manager_phone TEXT;
    ALTER TABLE properties ADD COLUMN number_of_units INTEGER;
    ALTER TABLE properties ADD COLUMN facilities TEXT;
  `);
}

// Migrate older sales_history schemas (add strata_levy/water/council_fees/is_tenanted)
const salesColumns = db.prepare("PRAGMA table_info(sales_history)").all().map((c) => c.name);
if (!salesColumns.includes('strata_levy')) {
  db.exec(`
    ALTER TABLE sales_history ADD COLUMN strata_levy REAL;
    ALTER TABLE sales_history ADD COLUMN water REAL;
    ALTER TABLE sales_history ADD COLUMN council_fees REAL;
    ALTER TABLE sales_history ADD COLUMN is_tenanted INTEGER NOT NULL DEFAULT 0;
  `);
}
// Migrate in selling agent
if (!salesColumns.includes('selling_agent')) {
  db.exec('ALTER TABLE sales_history ADD COLUMN selling_agent TEXT');
}

// Move unit number, layout, and aspect from sales_history to properties — these describe
// the unit itself and don't change between re-sales of the same unit.
if (!columns.includes('unit_number')) {
  db.exec(`
    ALTER TABLE properties ADD COLUMN unit_number TEXT;
    ALTER TABLE properties ADD COLUMN layout TEXT;
    ALTER TABLE properties ADD COLUMN aspect TEXT;
  `);
  if (salesColumns.includes('unit_number')) {
    db.exec(`
      UPDATE properties SET
        unit_number = (SELECT unit_number FROM sales_history WHERE property_id = properties.id AND unit_number IS NOT NULL ORDER BY sale_date DESC, id DESC LIMIT 1),
        layout = (SELECT layout FROM sales_history WHERE property_id = properties.id AND layout IS NOT NULL ORDER BY sale_date DESC, id DESC LIMIT 1),
        aspect = (SELECT aspect FROM sales_history WHERE property_id = properties.id AND aspect IS NOT NULL ORDER BY sale_date DESC, id DESC LIMIT 1)
    `);
  }
}

// Move strata plan number from sales_history to properties — the strata plan doesn't
// change between re-sales of the same unit.
if (!columns.includes('strata_plan_no') && !columns.includes('building_id')) {
  db.exec('ALTER TABLE properties ADD COLUMN strata_plan_no TEXT');
  if (salesColumns.includes('strata_plan_no')) {
    db.exec(`
      UPDATE properties SET
        strata_plan_no = (SELECT strata_plan_no FROM sales_history WHERE property_id = properties.id AND strata_plan_no IS NOT NULL ORDER BY sale_date DESC, id DESC LIMIT 1)
    `);
  }
}

// Add building manager contact fields — distinct from the strata manager fields above
if (!columns.includes('building_manager') && !columns.includes('building_id')) {
  db.exec(`
    ALTER TABLE properties ADD COLUMN building_manager TEXT;
    ALTER TABLE properties ADD COLUMN building_manager_email TEXT;
    ALTER TABLE properties ADD COLUMN building_manager_phone TEXT;
  `);
}

// Split out a Building entity (Apartment/Townhouse-only) from Property — the building name, strata
// plan no, strata lot count, strata/building manager contacts, and facilities describe the shared
// building, not an individual unit, and previously duplicated (and could drift) across every unit's row.
if (!columns.includes('building_id')) {
  db.exec('ALTER TABLE properties ADD COLUMN building_id INTEGER REFERENCES buildings(id) ON DELETE SET NULL');

  // Dedupe: group existing strata-type rows by matching (address, suburb, strata_plan_no) — including a
  // blank strata_plan_no as a matching value, since this is a one-time backfill of presumed-real data.
  // (Ongoing saves are stricter — see resolveBuildingLink below — and never auto-merge on a blank key.)
  const candidates = db.prepare(
    `SELECT * FROM properties WHERE type IN (${STRATA_FIELD_TYPES.map(() => '?').join(',')})`
  ).all(...STRATA_FIELD_TYPES);
  const groups = new Map();
  for (const row of candidates) {
    const key = [row.address, row.suburb, row.strata_plan_no].map((v) => (v || '').trim().toLowerCase()).join('');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const firstNonBlank = (rows, col) => {
    for (const r of rows) if (r[col] !== null && String(r[col]).trim() !== '') return r[col];
    return null;
  };
  const insertBuilding = db.prepare(`
    INSERT INTO buildings (
      name, address, suburb, strata_plan_no, number_of_units, managed_by, manager,
      manager_email, manager_phone, building_manager, building_manager_email, building_manager_phone, facilities
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const linkProperty = db.prepare('UPDATE properties SET building_id = ? WHERE id = ?');

  for (const rows of groups.values()) {
    const first = rows[0];
    const unitsRow = rows.find((r) => r.number_of_units !== null);
    const facilitySet = new Set();
    for (const r of rows) for (const f of parseFacilities(r.facilities)) facilitySet.add(f);
    const result = insertBuilding.run(
      firstNonBlank(rows, 'name'), first.address, firstNonBlank(rows, 'suburb'), firstNonBlank(rows, 'strata_plan_no'),
      unitsRow ? unitsRow.number_of_units : null,
      firstNonBlank(rows, 'managed_by'), firstNonBlank(rows, 'manager'),
      firstNonBlank(rows, 'manager_email'), firstNonBlank(rows, 'manager_phone'),
      firstNonBlank(rows, 'building_manager'), firstNonBlank(rows, 'building_manager_email'), firstNonBlank(rows, 'building_manager_phone'),
      facilitySet.size ? JSON.stringify([...facilitySet]) : null
    );
    for (const r of rows) linkProperty.run(result.lastInsertRowid, r.id);
  }

  // Non-strata-type rows get no building row — any stray values in these columns (the UI has always
  // gated them to strata types) are discarded here along with the columns themselves.
  for (const col of ['name', 'managed_by', 'manager', 'manager_email', 'manager_phone', 'number_of_units',
    'strata_plan_no', 'facilities', 'building_manager', 'building_manager_email', 'building_manager_phone']) {
    db.exec(`ALTER TABLE properties DROP COLUMN ${col}`);
  }
}

const salesColumnsNow = db.prepare("PRAGMA table_info(sales_history)").all().map((c) => c.name);
if (salesColumnsNow.includes('unit_number')) {
  db.exec(`
    ALTER TABLE sales_history DROP COLUMN unit_number;
    ALTER TABLE sales_history DROP COLUMN layout;
    ALTER TABLE sales_history DROP COLUMN aspect;
  `);
}
if (salesColumnsNow.includes('strata_plan_no')) {
  db.exec('ALTER TABLE sales_history DROP COLUMN strata_plan_no');
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

const DEFAULT_SEED_PASSWORD = 'password';

const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  createUser('admin', DEFAULT_SEED_PASSWORD, 'admin', true);
  createUser('cathy', DEFAULT_SEED_PASSWORD, 'admin', false);
  console.log('='.repeat(64));
  console.log('Created initial user accounts with the default password:');
  console.log(`  admin : ${DEFAULT_SEED_PASSWORD}`);
  console.log(`  cathy : ${DEFAULT_SEED_PASSWORD}`);
  console.log('SECURITY WARNING: this is a well-known fixed password. Change it via');
  console.log('the Admin module immediately, especially on any public deployment.');
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

function parseFacilities(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getBuilding(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM buildings WHERE id = ?').get(id);
  if (!row) return null;
  // unit_count tells the client whether this building is shared by more than one property — if so,
  // the property form should lock the address/suburb/strata plan fields so editing one unit can't
  // silently detach it from (or corrupt the key of) the building its siblings still rely on.
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM properties WHERE building_id = ?').get(id);
  return { ...row, facilities: parseFacilities(row.facilities), unit_count: count };
}

function normKey(s) {
  return (s || '').toString().trim().toLowerCase();
}

// Buildings are matched by two independent, alternative keys, tried in this precedence:
//   1. strata_plan_no alone, when supplied — it reliably identifies a specific building regardless of
//      how its address/suburb happen to be typed, so when present it is used on its own (address/suburb
//      are NOT also checked).
//   2. address + suburb together, when strata_plan_no is blank — both must be non-blank to attempt a
//      match. Not enforced as a DB-level unique key (a single address can legitimately hold multiple
//      strata plans/buildings), so this is a best-effort application-level lookup only.
function findBuildingByKey(address, suburb, strataPlanNo) {
  const spn = normKey(strataPlanNo);
  if (spn) {
    return db.prepare(`
      SELECT * FROM buildings WHERE strata_plan_no COLLATE NOCASE = ?
    `).get((strataPlanNo || '').trim()) || null;
  }
  if (!normKey(address) || !normKey(suburb)) return null;
  return db.prepare(`
    SELECT * FROM buildings
    WHERE address COLLATE NOCASE = ? AND COALESCE(suburb, '') COLLATE NOCASE = ?
  `).get((address || '').trim(), (suburb || '').trim()) || null;
}

// Resolves (creates/reuses/updates) the building a property should link to. The server never trusts a
// client-supplied building_id — this always re-derives the link via findBuildingByKey's SPN-else-
// address+suburb precedence, so the result is consistent regardless of what the client's lookup/confirm
// UX did or didn't do.
// currentBuildingId is the property's building_id before this save (null for a new property, or one that
// never had a building) — passing it lets an edit that doesn't match any existing building keep updating
// its own previous building row instead of creating a new orphaned one on every save.
//
// Known accepted risk: strata_plan_no is not locked read-only on the client even when a property's
// building is shared (see lockBuildingKeyFields in manage.js), so editing it here on a shared building's
// property updates that same shared row in place (via the no-match branch below) — silently renaming the
// shared building's SPN for every sibling property too. This is intentional, not a bug to guard against.
function resolveBuildingLink(type, address, suburb, values, currentBuildingId) {
  if (!STRATA_FIELD_TYPES.includes(type)) return null;

  const insertNew = () => db.prepare(`
    INSERT INTO buildings (
      name, address, suburb, strata_plan_no, number_of_units, managed_by, manager,
      manager_email, manager_phone, building_manager, building_manager_email, building_manager_phone, facilities
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.name, address, suburb, values.strata_plan_no, values.number_of_units, values.managed_by,
    values.manager, values.manager_email, values.manager_phone, values.building_manager,
    values.building_manager_email, values.building_manager_phone, values.facilities
  ).lastInsertRowid;

  const existing = findBuildingByKey(address, suburb, values.strata_plan_no);

  if (!existing) {
    // No match under either key — keep updating this property's own previous building row across edits
    // instead of orphaning a new one every save. Applies whenever there's no match at all (blank SPN,
    // blank address/suburb, or a non-blank key that simply doesn't match anything yet).
    if (currentBuildingId) {
      db.prepare(`
        UPDATE buildings SET name = ?, address = ?, suburb = ?, strata_plan_no = ?, number_of_units = ?,
          managed_by = ?, manager = ?, manager_email = ?, manager_phone = ?, building_manager = ?,
          building_manager_email = ?, building_manager_phone = ?, facilities = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        values.name, address, suburb, values.strata_plan_no, values.number_of_units, values.managed_by,
        values.manager, values.manager_email, values.manager_phone, values.building_manager,
        values.building_manager_email, values.building_manager_phone, values.facilities, currentBuildingId
      );
      return currentBuildingId;
    }
    return insertNew();
  }

  // Shared building found by key (SPN, or address+suburb) — merge-update. A blank submitted field never
  // overwrites the shared building's existing value, so one unit's edit can't wipe data still relevant to
  // sibling units. address/suburb/strata_plan_no are identity fields and are always written directly from
  // the submitted values (not merge-guarded).
  const merged = {
    name: values.name ?? existing.name,
    number_of_units: values.number_of_units !== null ? values.number_of_units : existing.number_of_units,
    managed_by: values.managed_by ?? existing.managed_by,
    manager: values.manager ?? existing.manager,
    manager_email: values.manager_email ?? existing.manager_email,
    manager_phone: values.manager_phone ?? existing.manager_phone,
    building_manager: values.building_manager ?? existing.building_manager,
    building_manager_email: values.building_manager_email ?? existing.building_manager_email,
    building_manager_phone: values.building_manager_phone ?? existing.building_manager_phone,
    facilities: values.facilities ?? existing.facilities,
  };
  db.prepare(`
    UPDATE buildings SET name = ?, address = ?, suburb = ?, strata_plan_no = ?, number_of_units = ?,
      managed_by = ?, manager = ?, manager_email = ?, manager_phone = ?, building_manager = ?,
      building_manager_email = ?, building_manager_phone = ?, facilities = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    merged.name, address, suburb, values.strata_plan_no, merged.number_of_units, merged.managed_by,
    merged.manager, merged.manager_email, merged.manager_phone, merged.building_manager,
    merged.building_manager_email, merged.building_manager_phone, merged.facilities, existing.id
  );
  return existing.id;
}

function serializeProperty(row) {
  return { ...row, building: getBuilding(row.building_id), sales_history: getSalesFor(row.id) };
}

function getPropertyWithSales(id) {
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!property) return null;
  return serializeProperty(property);
}

// List all properties (with sales history)
app.get('/api/properties', (req, res) => {
  const properties = db.prepare('SELECT * FROM properties ORDER BY updated_at DESC').all();
  res.json(properties.map(serializeProperty));
});

// Look up an existing building for the "this building already exists — use its details?" prompt on the
// property form. Mirrors findBuildingByKey's precedence: strata_plan_no alone is sufficient when
// present; otherwise both address and suburb are required.
app.get('/api/buildings/lookup', (req, res) => {
  const { address, suburb, strata_plan_no } = req.query;
  const hasSpn = !!normKey(strata_plan_no);
  const hasAddressSuburb = !!normKey(address) && !!normKey(suburb);
  if (!hasSpn && !hasAddressSuburb) {
    return res.status(404).json({ error: 'No matching building found' });
  }
  const building = findBuildingByKey(address, suburb, strata_plan_no);
  if (!building) return res.status(404).json({ error: 'No matching building found' });
  res.json({ ...building, facilities: parseFacilities(building.facilities) });
});

// Keyword search across property fields (suburb, type, address, unit/layout/aspect, built by/year),
// the linked building's fields (name, strata plan, manager/building-manager contacts, facilities), and
// sales parties
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    const properties = db.prepare('SELECT * FROM properties ORDER BY updated_at DESC').all();
    return res.json(properties.map(serializeProperty));
  }
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT DISTINCT p.* FROM properties p
    LEFT JOIN sales_history s ON s.property_id = p.id
    LEFT JOIN buildings b ON b.id = p.building_id
    WHERE p.type LIKE ? OR p.address LIKE ? OR p.suburb LIKE ?
       OR p.year_built LIKE ? OR p.built_by LIKE ? OR p.unit_number LIKE ? OR p.layout LIKE ? OR p.aspect LIKE ?
       OR b.name LIKE ? OR b.strata_plan_no LIKE ? OR b.managed_by LIKE ? OR b.manager LIKE ?
       OR b.manager_email LIKE ? OR b.manager_phone LIKE ? OR b.building_manager LIKE ?
       OR b.building_manager_email LIKE ? OR b.building_manager_phone LIKE ? OR b.facilities LIKE ?
       OR s.buyer LIKE ? OR s.seller LIKE ? OR s.selling_agent LIKE ?
    ORDER BY p.updated_at DESC
  `).all(like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like);
  res.json(rows.map(serializeProperty));
});

// Get single property
app.get('/api/properties/:id', (req, res) => {
  const property = getPropertyWithSales(req.params.id);
  if (!property) return res.status(404).json({ error: 'Not found' });
  res.json(property);
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validatePropertyBody(body) {
  const { suburb, type, address, year_built, built_by, unit_number, layout, aspect } = body;
  if (!address || !address.trim()) {
    return { error: 'Address is required' };
  }
  if (type && !PROPERTY_TYPES.includes(type)) {
    return { error: `Type must be one of: ${PROPERTY_TYPES.join(', ')}` };
  }
  if (layout && !LAYOUT_OPTIONS.includes(layout)) {
    return { error: `Layout must be one of: ${LAYOUT_OPTIONS.join(', ')}` };
  }
  return {
    values: {
      suburb: suburb?.trim() || null,
      type: type || null,
      address: address.trim(),
      year_built: year_built?.toString().trim() || null,
      built_by: built_by?.trim() || null,
      unit_number: unit_number?.trim() || null,
      layout: layout || null,
      aspect: aspect?.trim() || null,
    },
  };
}

// Validates the building sub-object of a property request — only required/read when the property's
// type is strata-eligible (Apartment/Townhouse). Same conventions/error messages as property validation.
function validateBuildingFields(body) {
  const {
    name, managed_by, manager, manager_email, manager_phone, number_of_units, strata_plan_no, facilities,
    building_manager, building_manager_email, building_manager_phone,
  } = body || {};
  if (manager_email && manager_email.trim() && !EMAIL_PATTERN.test(manager_email.trim())) {
    return { error: 'Manager email is not a valid email address' };
  }
  if (building_manager_email && building_manager_email.trim() && !EMAIL_PATTERN.test(building_manager_email.trim())) {
    return { error: 'Building manager email is not a valid email address' };
  }
  let unitsValue = null;
  if (number_of_units !== undefined && number_of_units !== null && number_of_units !== '') {
    const parsed = Number(number_of_units);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { error: 'Number of units must be a non-negative whole number' };
    }
    unitsValue = parsed;
  }
  const facilitiesList = Array.isArray(facilities) ? facilities : [];
  for (const f of facilitiesList) {
    if (!FACILITY_OPTIONS.includes(f)) {
      return { error: `Facilities must be one of: ${FACILITY_OPTIONS.join(', ')}` };
    }
  }
  return {
    values: {
      name: name?.trim() || null,
      managed_by: managed_by?.trim() || null,
      manager: manager?.trim() || null,
      manager_email: manager_email?.trim() || null,
      manager_phone: manager_phone?.trim() || null,
      number_of_units: unitsValue,
      strata_plan_no: strata_plan_no?.trim() || null,
      facilities: facilitiesList.length ? JSON.stringify(facilitiesList) : null,
      building_manager: building_manager?.trim() || null,
      building_manager_email: building_manager_email?.trim() || null,
      building_manager_phone: building_manager_phone?.trim() || null,
    },
  };
}

// Create property
app.post('/api/properties', requireAdmin, (req, res) => {
  const { error, values } = validatePropertyBody(req.body);
  if (error) return res.status(400).json({ error });
  let buildingValues = null;
  if (STRATA_FIELD_TYPES.includes(values.type)) {
    const bv = validateBuildingFields(req.body.building);
    if (bv.error) return res.status(400).json({ error: bv.error });
    buildingValues = bv.values;
  }
  const buildingId = resolveBuildingLink(values.type, values.address, values.suburb, buildingValues, null);
  const result = db.prepare(`
    INSERT INTO properties (suburb, type, address, year_built, built_by, unit_number, layout, aspect, building_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.suburb, values.type, values.address, values.year_built, values.built_by,
    values.unit_number, values.layout, values.aspect, buildingId
  );
  res.status(201).json(getPropertyWithSales(result.lastInsertRowid));
});

// Update property
app.put('/api/properties/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id, building_id FROM properties WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { error, values } = validatePropertyBody(req.body);
  if (error) return res.status(400).json({ error });
  let buildingValues = null;
  if (STRATA_FIELD_TYPES.includes(values.type)) {
    const bv = validateBuildingFields(req.body.building);
    if (bv.error) return res.status(400).json({ error: bv.error });
    buildingValues = bv.values;
  }
  const buildingId = resolveBuildingLink(values.type, values.address, values.suburb, buildingValues, existing.building_id);
  db.prepare(`
    UPDATE properties
    SET suburb = ?, type = ?, address = ?, year_built = ?, built_by = ?, unit_number = ?, layout = ?, aspect = ?,
        building_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    values.suburb, values.type, values.address, values.year_built, values.built_by,
    values.unit_number, values.layout, values.aspect, buildingId, req.params.id
  );
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
    sale_date, sale_price, buyer, seller,
    strata_levy, water, council_fees, is_tenanted,
    selling_agent, notes,
  } = req.body;
  const result = db.prepare(`
    INSERT INTO sales_history (
      property_id, sale_date, sale_price, buyer, seller,
      strata_levy, water, council_fees, is_tenanted, selling_agent, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id, sale_date || null, sale_price || null,
    buyer || null, seller || null, strata_levy || null, water || null, council_fees || null,
    is_tenanted ? 1 : 0, selling_agent || null, notes || null
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
