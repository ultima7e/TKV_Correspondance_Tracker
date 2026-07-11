# Correspondence Tracker

A standalone web app for logging and browsing project correspondence, backed by
a single JSON file (`LetterTracker_Data.json`) stored in Nutstore. It reads and
writes that file directly over WebDAV, so there is no manual "connect / upload"
step and every device sees the same live data.

Access is role-based:

- **Admin** — sees every letter, can add/edit/delete, and manages user logins.
- **Department viewer** (e.g. `Contract`, `QA`, `EHS`) — read-only, sees only
  letters whose department matches theirs. A letter tagged `QA/Design` is
  visible to a `QA` viewer or a `Design` viewer.

This is a separate application from the Tamakoshi-V Project Tracker — it shares
no code or deployment with it.

## Architecture

- `api/letters.js` — `GET` loads the letters file from Nutstore and filters it
  server-side to the caller's departments; `POST` (admin only) writes it back.
- `api/login|logout|me|users.js` — session auth + admin-only user CRUD.
- `lib/letters.js` — WebDAV read/write + the department-filter logic.
- `lib/auth.js` — password hashing, signed session tokens, `currentUser()`.
- `lib/store.js` — user store over Upstash/Vercel KV (local JSON fallback).
- `public/index.html` — login page.
- `public/tracker.html` — the tracker UI (loads/saves via `/api/letters`).
- `public/admin.html` — admin user management.

## Local development

```bash
cp .env.example .env      # fill in the values
npm run dev:cloud         # loads .env, serves http://localhost:3000
npm test                  # runs the unit tests
```

Without `NUTSTORE_USER`/`NUTSTORE_PASSWORD`, the app falls back to
`data/sample-letters.json` (and writes go to a local `data/.letters_local.json`)
so you can develop without touching Nutstore.

## Deploy (Vercel)

1. Push this repo to GitHub and import it as a **new** Vercel project.
2. Set env vars (see `.env.example`): `NUTSTORE_USER`, `NUTSTORE_PASSWORD`,
   `AUTH_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD`.
3. Provision a KV store so the users you create persist: Storage → Create →
   Upstash for Redis → Connect to project (auto-adds `KV_REST_API_URL` /
   `KV_REST_API_TOKEN`). Without it, login still works via the bootstrap admin,
   but creating additional users will fail on the read-only serverless FS.
