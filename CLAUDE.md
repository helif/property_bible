# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install: `npm install`
- Run: `node server.js` (or `npm start`). Listens on `PORT` env var, default `3000`.
- No build step, no bundler, no test suite, and no linter configured. Verify changes by running the server and exercising the app in a browser at `http://localhost:3000`.
- On first run against an empty database, two accounts (`admin`, `cathy`) are auto-created with generated passwords printed once to the console — check the terminal output after a fresh `node server.js` if login is needed.

## Architecture

Single Express server (`server.js`) + vanilla JS frontend (`public/`), no framework, no build step. SQLite via Node's built-in `node:sqlite` (requires Node 22.5+), file at `data/properties.db` (git-ignored).

### Schema evolution via runtime migrations

There are no migration files — `server.js` runs `CREATE TABLE IF NOT EXISTS` followed by a sequence of guarded `ALTER TABLE` blocks at startup, each checking `PRAGMA table_info(...)` for a column's presence before adding it (and backfilling from old locations when a field moved tables). This means the current schema can only be understood by reading through the full migration sequence top to bottom, not just the `CREATE TABLE` statement — e.g. `unit_number`, `layout`, `aspect`, and `strata_plan_no` were moved from `sales_history` to `properties` because they describe the unit itself and don't change between re-sales, and `manager`/`manager_email`/`manager_phone` (strata manager) are distinct from `building_manager`/`building_manager_email`/`building_manager_phone` (building manager) — two separate contacts. When adding a new property/sales field, follow this same pattern: an `IF NOT EXISTS`-guarded `ALTER TABLE` block, not a schema rewrite.

### Three frontend pages, one shared session model

- `index.html`/`view.js` — read-only browse + search (any logged-in user).
- `manage.html`/`manage.js` — create/edit/delete properties and sales (requires `role: admin`; viewers are redirected client-side after `/api/me` resolves, and server-side by `requireAdmin` on mutating routes).
- `admin.html`/`admin.js` — user management (requires `canManageUsers`, which is independent of `role`; an account can be `role: admin` for properties without admin-module access, or vice versa).

All three follow the same master-detail UI pattern (list on the left via a `<template>` clone, detail pane on the right, mobile view toggled via `syncMobileView`) and the same page bootstrap idiom: call `applyRoleBasedNav()` from `common.js` first (hides nav links and wires logout based on `/api/me`), then load data. `manage.js` and `view.js` are near-duplicates of each other (list rendering, detail rendering, search) — `manage.js` adds the create/edit/delete forms and sale management on top. When changing shared display logic (e.g. how a property card or detail pane renders), update both.

### Auth

Session-based, not JWT: `/api/login` creates a random 256-bit token stored server-side in the `sessions` table and set as an `HttpOnly`/`SameSite=Lax` cookie. `sessionAuth` middleware runs on every request except `PUBLIC_PATHS`; it attaches `req.username`/`req.userRole`/`req.canManageUsers` from the session row. `requireAdmin` and `requireUserAdmin` are separate middleware for the two independent permission axes described above — don't conflate them.

### Shared constants duplicated between server and client

`PROPERTY_TYPES`, `FACILITY_OPTIONS`, and `LAYOUT_OPTIONS` are defined independently in both `server.js` (for validation) and `public/common.js` (for form rendering). There's no shared module between them since this is a no-build-step app — when adding/renaming an option, update both places, or validation will reject values the UI happily submits.

### Strata-specific fields

`showsStrataFields(type)` (in `common.js`, mirrored conceptually in the detail/form rendering of `view.js`/`manage.js`) gates a large group of fields (unit number, strata plan no, strata manager/building manager contacts, facilities, etc.) to only `Apartment` and `Townhouse/Villa` property types. These fields still exist in the DB and API for all types; the gating is purely presentational, applied per-field in both the read-only detail view and the edit form.
