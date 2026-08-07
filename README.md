# CT Property Bible

A self-hosted property management web app: track addresses, owners, tenants, building managers, and sales history, with full-text search and role-based access control. Built as a small Node.js/Express server with SQLite storage and a vanilla JS frontend — no build step, no external services.

## Features

- **Property records**: name, suburb, type (Apartment, House, Townhouse/Villa, Commercial, Vacant Land), address, year built, built by, managed by, and manager.
- **Sales history** per property: date, price, unit number, layout, buyer, seller, strata levy, water, council fees, and tenanted status.
- **Keyword search** across every property and sale field, with instant results as you type.
- **Three pages, separated by purpose**:
  - **View** (`index.html`) — read-only browse and search.
  - **Manage** (`manage.html`) — create, edit, and delete properties and sales.
  - **Admin** (`admin.html`) — create users, set/reset passwords, and grant or revoke access.
- **Role-based access**: each account has a `role` (`admin` can edit properties, `viewer` is read-only) and, independently, `admin module access` (who can manage other users).
- **Session-based login**: a proper sign-in page backed by server-side sessions (HTTP-only cookie), not a browser Basic Auth popup.
- **Persistent storage**: SQLite via Node's built-in `node:sqlite` module — no native build step, no separate database server.

## Requirements

- Node.js 22.5+ (uses the built-in `node:sqlite` module)

## Getting started

```bash
npm install
node server.js
```

Then open **http://localhost:3000** in a browser.

### First run

On first launch, two accounts are created automatically — `admin` (full access, including the Admin module) and `cathy` (can manage properties, no Admin module access). Their generated passwords are printed **once** to the console:

```
================================================================
Created initial user accounts (passwords shown once):
  admin : <generated>
  cathy : <generated>
================================================================
```

Save these immediately — passwords are hashed (scrypt, salted) in storage and cannot be recovered afterward. Use the Admin page to create additional users, reset passwords, or change access levels once logged in as `admin`.

### Configuration

- `PORT` — port to listen on (default `3000`).

## Project structure

```
server.js          Express server: auth, sessions, and all API routes
data/               SQLite database file (created on first run, git-ignored)
public/
  login.html/js     Sign-in page
  index.html/view.js        View page (read-only)
  manage.html/manage.js     Manage page (create/edit/delete)
  admin.html/admin.js       Admin page (user management)
  common.js         Shared helpers (API client, formatting, nav/session UI)
  style.css         Shared styling
```

## Security notes

- Passwords are hashed with `scrypt` and a random per-user salt; plaintext is never stored.
- Sessions are random 256-bit tokens stored server-side, set as an `HttpOnly`, `SameSite=Lax` cookie (30-day expiry).
- This app has no HTTPS of its own — if exposing it beyond localhost/LAN, put it behind a reverse proxy that terminates TLS.
- The bundled SQLite database (`data/properties.db`) contains real property data and password hashes; it's git-ignored on purpose and should never be committed.

## License

Not yet licensed for public distribution — add a `LICENSE` file if you plan to share or reuse this code.
