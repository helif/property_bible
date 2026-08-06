# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install: `npm install`
- Run: `node server.js` (or `npm start`). Listens on `PORT` env var, default `3000`.
- No build step, no bundler, no test suite, and no linter configured. Verify changes by running the server and exercising the app in a browser at `http://localhost:3000`.
- On first run against an empty database, two accounts (`admin`, `cathy`) are auto-created with generated passwords printed once to the console — check the terminal output after a fresh `node server.js` if login is needed.

## Architecture

Single Express server (`server.js`) + vanilla JS frontend (`public/`), no framework, no build step. SQLite via Node's built-in `node:sqlite` (requires Node 22.5+), file at `data/properties.db` (git-ignored).

### DB schema (high level)

- **`properties`** — one row per unit/listing: `id`, `address` (required), `suburb`, `type` (`Apartment`/`House`/`Townhouse/Villa`/`Commercial`/`Vacant Land`/`Other`), `year_built`, `built_by`, `unit_number`, `layout`, `aspect`, `building_id` (nullable FK → `buildings`), `created_at`/`updated_at`.
- **`buildings`** — one row per physical building, only ever linked from `Apartment`/`Townhouse/Villa` properties: `id`, `name`, `address`, `suburb`, `strata_plan_no`, `number_of_units` (strata lot count), `managed_by`/`manager`/`manager_email`/`manager_phone` (strata manager), `building_manager`/`building_manager_email`/`building_manager_phone` (building manager — a distinct contact), `facilities` (JSON array), `created_at`/`updated_at`. Unique on `(address, suburb, strata_plan_no)` (case-insensitive, only when `strata_plan_no` is non-blank — see below).
- **`sales_history`** — one row per sale event, FK `property_id` → `properties` (`ON DELETE CASCADE`): `sale_date`, `sale_price`, `buyer`, `seller`, `strata_levy`, `water`, `council_fees`, `is_tenanted`, `selling_agent`, `notes`.
- **`users`** — `username`, `salt`/`password_hash` (scrypt), `role` (`admin`/`viewer`), `can_manage_users` (independent admin-module flag).
- **`sessions`** — `token` (256-bit, primary key), FK `user_id` → `users` (`ON DELETE CASCADE`), `expires_at`.

`GET /api/properties`/`/api/properties/:id` nest the linked building as `property.building` (`null` for non-strata types) rather than flattening its fields onto the property — see "Building/Property split" below for why and how that link is resolved on every save.

### Schema evolution via runtime migrations

There are no migration files — `server.js` runs `CREATE TABLE IF NOT EXISTS` followed by a sequence of guarded `ALTER TABLE` blocks at startup, each checking `PRAGMA table_info(...)` for a column's presence before adding it (and backfilling from old locations when a field moved tables). This means the current schema can only be understood by reading through the full migration sequence top to bottom, not just the `CREATE TABLE` statement — e.g. `unit_number`, `layout`, `aspect`, and `strata_plan_no` were moved from `sales_history` to `properties` (and `strata_plan_no` later on to `buildings`) because they describe the unit/building, not the sale event, and `manager`/`manager_email`/`manager_phone` (strata manager) are distinct from `building_manager`/`building_manager_email`/`building_manager_phone` (building manager) — two separate contacts. When adding a new property/building/sales field, follow this same pattern: an `IF NOT EXISTS`-guarded `ALTER TABLE` block, not a schema rewrite.

**Gotcha**: several older guards use a column's presence as a stand-in for "has this migration already run" (e.g. `if (!columns.includes('name'))`). The Building-split migration *drops* some of those very columns (`name`, `manager_email`, `strata_plan_no`, `building_manager`, ...) off `properties` once it moves them to `buildings` — which would otherwise make those older guards misfire on every subsequent restart and crash on `duplicate column name`. Every such guard is therefore also gated on `!columns.includes('building_id')`, since `building_id` is only ever added after all of them have already run. If you drop or rename a column that an earlier guard checks for, you must add the same `building_id`-style escape hatch, or the migration chain stops being idempotent across restarts.

### Three frontend pages, one shared session model

- `index.html`/`view.js` — read-only browse + search (any logged-in user).
- `manage.html`/`manage.js` — create/edit/delete properties and sales (requires `role: admin`; viewers are redirected client-side after `/api/me` resolves, and server-side by `requireAdmin` on mutating routes).
- `admin.html`/`admin.js` — user management (requires `canManageUsers`, which is independent of `role`; an account can be `role: admin` for properties without admin-module access, or vice versa).

All three follow the same master-detail UI pattern (list on the left via a `<template>` clone, detail pane on the right, mobile view toggled via `syncMobileView`) and the same page bootstrap idiom: call `applyRoleBasedNav()` from `common.js` first (hides nav links and wires logout based on `/api/me`), then load data. `manage.js` and `view.js` are near-duplicates of each other (list rendering, detail rendering, search) — `manage.js` adds the create/edit/delete forms and sale management on top. When changing shared display logic (e.g. how a property card or detail pane renders), update both.

### Auth

Session-based, not JWT: `/api/login` creates a random 256-bit token stored server-side in the `sessions` table and set as an `HttpOnly`/`SameSite=Lax` cookie. `sessionAuth` middleware runs on every request except `PUBLIC_PATHS`; it attaches `req.username`/`req.userRole`/`req.canManageUsers` from the session row. `requireAdmin` and `requireUserAdmin` are separate middleware for the two independent permission axes described above — don't conflate them.

### Shared constants duplicated between server and client

`PROPERTY_TYPES`, `FACILITY_OPTIONS`, `LAYOUT_OPTIONS`, and `STRATA_FIELD_TYPES` are defined independently in both `server.js` (for validation/building-eligibility checks) and `public/common.js` (for form rendering and `showsStrataFields`). There's no shared module between them since this is a no-build-step app — when adding/renaming an option or changing which types have a Building, update both places, or validation will reject values the UI happily submits.

### Strata-specific fields live on Building, not Property

`showsStrataFields(type)` (in `common.js`) gates the strata-only UI (unit number, and the whole Building fields block) to only `Apartment` and `Townhouse/Villa` property types. Unit number stays on `properties`; everything else in that gated group — name, strata plan no, number of strata lots, strata manager contact, building manager contact, facilities — lives on the linked `buildings` row (`property.building.*`), not on the property itself. Non-strata types always have `building: null`.

### Building/Property split and save-time resolution

A Building is a separate entity from a Property (unit) so that multiple units in the same building can share one building record instead of duplicating (and drifting on) its strata/manager/facilities data. The tricky part is entirely in `server.js`:

- **`findBuildingByKey(address, suburb, strataPlanNo)`** matches an existing building by `(address, suburb, strata_plan_no)`, case-insensitive/trimmed. It only matches when `strata_plan_no` is non-blank — that's the one field that reliably identifies a specific building, so a blank one is never used to merge buildings together.
- **`resolveBuildingLink(type, address, suburb, values, currentBuildingId)`** is called on every `POST`/`PUT /api/properties` and is the single source of truth for the link — it never trusts a client-supplied `building_id`. It: returns `null` immediately for non-strata types (detaching without deleting the building row, since other units may still use it); reuses/merge-updates the existing building when the key matches one (a **blank submitted field never overwrites the shared building's existing value**, so one unit's edit can't wipe data other units rely on); and for a blank `strata_plan_no`, reuses the property's own previous private building row across edits instead of creating a new orphaned one every save (private, blank-key buildings are never matched/shared by `findBuildingByKey`).
- **`GET /api/buildings/lookup?address=&suburb=&strata_plan_no=`** is a read-only convenience for the client — it does not affect what gets persisted; that's always re-derived by `resolveBuildingLink` at save time regardless of what the client did with the lookup result.
- **Client side** (`manage.js`): `wireBuildingLookup` debounces on the address/suburb/strata-plan-no inputs (and the type dropdown) and shows a confirm/dismiss banner only when all three fields are filled *and* the lookup returns a different building than the one currently linked (the banner's visibility must be driven entirely by JS — see the `:not([hidden])` note in `style.css`, since an unconditional `display` on the same selector silently defeats the `hidden` attribute). Confirming fills the building fields from the match and locks `address`/`suburb`/`strata_plan_no` read-only via `lockBuildingKeyFields` so the confirmed key can't drift. The same lock is applied unconditionally when opening the edit form for a property whose building already has `unit_count > 1` (computed server-side in `getBuilding()`, not by scanning the client's possibly search-filtered property list) — editing the key of an already-shared building's unit is where corruption risk is highest.
