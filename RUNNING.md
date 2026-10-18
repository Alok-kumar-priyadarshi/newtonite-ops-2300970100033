# Running Newtonite Ops

| Option | Use it for |
|---|---|
| [1. Docker](#1-docker-recommended) | Reviewing or demoing the app with one command |
| [2. Each part separately](#2-each-part-separately) | Developing or debugging the database, backend or frontend |

## Prerequisites

| Tool | Needed for |
|---|---|
| Docker Desktop (Compose 2.24+) | Option 1, the database in option 2, and tests |
| Node.js 20+ | Option 2 and tests |
| PostgreSQL 13+ | Only if you run the database without Docker |

```bash
git clone https://github.com/Alok-kumar-priyadarshi/newtonite-ops-2300970100033.git
cd newtonite-ops-2300970100033
```

Each part has its own settings file. Create them from the examples (optional for Docker, needed for
option 2; `npm run dev` creates them automatically):

```bash
cp backend/.env.example backend/.env       # PowerShell: Copy-Item backend/.env.example backend/.env
cp frontend/.env.example frontend/.env     # PowerShell: Copy-Item frontend/.env.example frontend/.env
```

## How the parts fit

```
Browser ──► Frontend (React) ──/api──► API (Express, :8080) ──► PostgreSQL (:5433 in Docker)
                                       Worker ─────────────────► (same database)
```

The backend runs as two processes from the same code: the **API** answers requests, and the
**worker** processes background jobs (notifications, statistics, cleanup). In Docker the API also
serves the built frontend on the same port; on Vercel the backend and frontend are separate
projects (see [Deploying](#deploying)).

| Port | Used by |
|---|---|
| 8080 | API and built frontend |
| 5433 | PostgreSQL in Docker (avoids clashing with a local install on 5432) |
| 5173 | Vite dev server |
| 55432 | Throwaway test database |

---

## 1. Docker (recommended)

```bash
docker compose up --build
```

| Container | Role |
|---|---|
| `db` | PostgreSQL 17 |
| `migrate` | Creates the schema and seeds demo data, then exits (expected) |
| `api` | API and frontend on http://localhost:8080 |
| `worker` | Background job processor |

Ready when the log shows `Newtonite Ops API listening on http://localhost:8080` and `outbox worker started`.
Health check: http://localhost:8080/api/health → `{"ok":true,"db":"up"}`.

Docker needs no settings file. If `backend/.env` exists, its values are used (for example
`GROQ_API_KEY` for the Ask assistant), except the database URL, which always points at the `db`
container.

| Task | Command |
|---|---|
| Run in the background | `docker compose up --build -d` |
| Follow logs | `docker compose logs -f api worker` |
| Stop (keep data) | `docker compose down` |
| Reset to fresh demo data | `docker compose down -v` then `docker compose up --build` |

---

## 2. Each part separately

The code is split into `backend/`, `frontend/` and `shared/` (code used by both). Install
dependencies once, from the project root; this installs all three (npm workspaces):

```bash
npm install
```

Shortcut: `npm run dev` starts the database container, migrates, seeds, and runs the API, worker and
frontend with hot reload on http://localhost:5173. Do not run it alongside option 1 (both use 8080).

### 2.1 Database

**Docker:**

```bash
docker compose up -d db     # postgres://nops:nops@localhost:5433/nops (the backend/.env default)
```

**Or your own PostgreSQL:**

```sql
CREATE USER nops WITH PASSWORD 'nops';
CREATE DATABASE nops OWNER nops;
```

and set `DATABASE_URL=postgres://nops:nops@localhost:5432/nops` in `backend/.env`.

Then create the schema and load demo data:

```bash
npm run db:migrate          # safe to re-run
npm run db:seed             # ~20,000 items; skipped if data exists
```

### 2.2 Backend

Requires the database to be running and migrated. Settings are read from `backend/.env`.

```bash
cd backend
npm run dev                 # API on :8080, restarts on change
npm run dev:worker          # worker, in a second terminal
```

Production build:

```bash
cd backend
npm run build               # → backend/dist
node dist/server.js         # API (also serves frontend/dist if it has been built)
node dist/worker.js         # worker
```

Without the worker the app still works, but notifications are not delivered. The endpoints are
documented in [docs/07-api-contracts.md](docs/07-api-contracts.md).

### 2.3 Frontend

Requires the API on :8080.

```bash
cd frontend
npm run dev                 # http://localhost:5173, forwards /api to :8080
npm run build               # → frontend/dist
```

To proxy to another backend, set `API_TARGET` in `frontend/.env` (e.g. `API_TARGET=http://localhost:9090`).

---

## Tests

```bash
npm test
```

Starts the test database on port 55432, runs the backend tests (80) and frontend tests (6). To run one file:
`cd backend && npx vitest run test/concurrency.test.ts`. Stop the test database with
`docker compose -f docker-compose.test.yml down`.

Type checks: `npm run typecheck`.

---

## Deploying

Docker (option 1) runs on any host that runs containers. For Vercel, the backend and frontend
deploy as two projects from this repository (Root Directory `backend` and `frontend`); see
[docs/12-deployment.md §12.4](docs/12-deployment.md).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 8080 or 5433 already in use | Stop the other process or run `docker compose down`. To change the DB port, edit `5433:5432` in `docker-compose.yml` and `DATABASE_URL`. |
| `Invalid environment configuration` | Copy `backend/.env.example` to `backend/.env`. |
| `relation "…" does not exist` | Run `npm run db:migrate`. |
| Sign-in fails in dev mode | Check the API is running: http://localhost:8080/api/health. Password is `Demo@1234`. |
| No notifications | The worker is not running. |
| Ask says the assistant isn't set up | Set `GROQ_API_KEY` in `backend/.env`, then restart the API (Docker: `docker compose up -d`). |
| Compose error about `env_file` / `path` | Docker Compose is older than 2.24; update Docker Desktop. |
| Old UI after code changes | `docker compose up --build`, then hard-refresh the browser. |

---

## Environment variables

### Backend: `backend/.env`

Read by the API, the worker and the `npm run db:*` commands. Docker Compose loads
`backend/.env.example` and then `backend/.env` if it exists, but always uses its own database URL.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://nops:nops@localhost:5433/nops` | Database connection |
| `SESSION_SECRET` | placeholder | Signs session tokens (change for any real deployment) |
| `DEMO_MODE` | `true` | Shows the "Sign in as…" list |
| `APP_ORIGIN` | `http://localhost:8080` | URL users open; `https://` enables secure cookies |
| `PORT` | `8080` | API port |
| `DB_POOL_MAX` | `10` | Connections per process |
| `DB_IDLE_TIMEOUT` | `0` | Seconds before idle connections close (`0` keeps them open) |
| `CRON_SECRET` | placeholder | Protects the job trigger used only on serverless hosting |
| `CORS_ORIGINS` | empty | Frontend URLs on other domains allowed to call the API directly (comma-separated) |
| `GROQ_API_KEY` | empty | Enables the Ask assistant; empty disables it |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Assistant model |

### Frontend: `frontend/.env`

Read by Vite and the frontend's Vercel build. Only `VITE_*` values are built into the app (public).

| Variable | Default | Purpose |
|---|---|---|
| `API_TARGET` | `http://localhost:8080` | Where `/api` is forwarded (dev server; the frontend Vercel project) |
| `VITE_API_URL` | empty | Call the backend directly at this URL instead; needs `CORS_ORIGINS` on the backend |

Tests use their own database: `TEST_DATABASE_URL` (default `…localhost:55432/nops_test`).
