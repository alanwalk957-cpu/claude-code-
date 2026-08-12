-- Material Matrix Pro — backend schema
-- Run against a Postgres database, e.g.: psql "$DATABASE_URL" -f src/schema.sql

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('supplier', 'engineer', 'contractor', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL,
  company_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One Contractor + one Owner per project (Engineer optional, may be attached later).
CREATE TABLE IF NOT EXISTS projects (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  contractor_id  INTEGER REFERENCES users(id),
  owner_id       INTEGER REFERENCES users(id),
  engineer_id    INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS material_folders (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL,
  is_fixed BOOLEAN NOT NULL DEFAULT false
);

-- Global catalog — NOT project-scoped. Any authenticated account can read;
-- only suppliers can create/edit/delete (enforced in routes/materials.js).
CREATE TABLE IF NOT EXISTS materials (
  id             SERIAL PRIMARY KEY,
  -- Plain text, not a FK: the frontend's fixed trade folders ("Piping", "Concrete", ...)
  -- are hardcoded client-side string ids (not rows in material_folders), and materials
  -- can live in either a fixed folder or a custom one — so this column has to accept both.
  folder_id      TEXT,
  name           TEXT NOT NULL,
  code           TEXT,
  price          NUMERIC,
  unit_type      TEXT,
  dim_unit       TEXT,
  per_unit       TEXT,
  length         NUMERIC,
  width          NUMERIC,
  height         NUMERIC,
  weight         NUMERIC,
  measure_by     TEXT,
  bulk_density   NUMERIC,
  concrete_role  TEXT,
  description    TEXT,
  images         JSONB NOT NULL DEFAULT '[]',
  -- Quantity-calculation settings (purpose/method/params) used by Window 2's takeoff
  -- engine — opaque to the backend, just carried through as JSON.
  calc           JSONB,
  creator_id     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blueprint_rooms (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL,
  length     NUMERIC,
  width      NUMERIC,
  height     NUMERIC,
  group_name TEXT
);

CREATE TABLE IF NOT EXISTS mapped_room_materials (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  room_id     INTEGER NOT NULL REFERENCES blueprint_rooms(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  wastage     NUMERIC,
  manual_qty  NUMERIC
);

CREATE TABLE IF NOT EXISTS ledger_items (
  id             SERIAL PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  folder_id      TEXT,
  name           TEXT NOT NULL,
  supplier       TEXT,
  price          NUMERIC,
  quantity       NUMERIC,
  unit           TEXT,
  payment_status TEXT,
  actual_payer   TEXT,
  payer          TEXT,
  due_date       DATE,
  cost_code      TEXT,
  creator_id     INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'Approved',
  bought_status  TEXT NOT NULL DEFAULT 'Not Bought',
  bought_by      INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generalized version of the app's existing "one party proposes, the other
-- approves" pattern (today duplicated per-feature as ad hoc pendingAction
-- fields). entity_type + entity_id point at the row being changed;
-- payload holds the staged new values for an edit/move.
CREATE TABLE IF NOT EXISTS pending_actions (
  id           SERIAL PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    INTEGER NOT NULL,
  action       TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  proposer_id  INTEGER NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS work_plan_steps (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  name         TEXT NOT NULL,
  area         TEXT,
  planned_days NUMERIC NOT NULL DEFAULT 0,
  budget       NUMERIC NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'not',
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_plan_materials (
  id             SERIAL PRIMARY KEY,
  step_id        INTEGER NOT NULL REFERENCES work_plan_steps(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  cost           NUMERIC NOT NULL DEFAULT 0,
  unit           TEXT,
  qty            NUMERIC NOT NULL DEFAULT 0,
  bought         BOOLEAN NOT NULL DEFAULT false,
  source         TEXT,
  material_id    INTEGER REFERENCES materials(id),
  room_id        INTEGER REFERENCES blueprint_rooms(id),
  mapping_id     INTEGER REFERENCES mapped_room_materials(id),
  ledger_item_id INTEGER REFERENCES ledger_items(id)
);

CREATE TABLE IF NOT EXISTS work_plan_labor (
  id          SERIAL PRIMARY KEY,
  step_id     INTEGER NOT NULL REFERENCES work_plan_steps(id) ON DELETE CASCADE,
  description TEXT,
  amount      NUMERIC NOT NULL DEFAULT 0
);

-- Unifies the app's two parallel client-side logs (w3ActivityLog, w4HistoryLog)
-- into one table, distinguished by `window`.
CREATE TABLE IF NOT EXISTS activity_log (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  window_name TEXT NOT NULL,
  actor_id   INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
