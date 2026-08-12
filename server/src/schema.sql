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
  -- Shared Ledger (Window 3) project-level figures — these feed real money math both
  -- parties rely on, so they live here rather than per-browser. Each "direct paid" side
  -- is its own tiny propose/approve pair: the amount only moves once the OTHER party
  -- approves the pending value (mirrors the app's existing bespoke triplet, not the
  -- generic pending_actions table below — see routes/projects.js).
  contractor_profit_percent          NUMERIC NOT NULL DEFAULT 10,
  contractor_direct_paid_amount      NUMERIC NOT NULL DEFAULT 0,
  contractor_direct_paid_status      TEXT NOT NULL DEFAULT 'Approved',
  contractor_direct_paid_pending_val NUMERIC NOT NULL DEFAULT 0,
  owner_direct_paid_amount           NUMERIC NOT NULL DEFAULT 0,
  owner_direct_paid_status           TEXT NOT NULL DEFAULT 'Approved',
  owner_direct_paid_pending_val      NUMERIC NOT NULL DEFAULT 0,
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
  group_name TEXT,
  -- Traced geometry (`geom`) and per-room concrete-mix settings (mixRatio,
  -- mixAssignments, ...) — opaque blob, same precedent as materials.calc.
  extra      JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS mapped_room_materials (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  -- NULL means the frontend's PROJECT_SCOPE_ID sentinel — a "whole project"
  -- mapping (pipe/fitting driver assignment) not tied to any real room.
  room_id     INTEGER REFERENCES blueprint_rooms(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  wastage     NUMERIC,
  manual_qty  NUMERIC,
  surface     TEXT
);

-- Unilateral CRUD (no approval gate) — matches the app's current folder behavior exactly;
-- either party can rename/delete a category without the other's sign-off.
CREATE TABLE IF NOT EXISTS ledger_folders (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL,
  budget     NUMERIC
);

-- The Shared Ledger's mutual-approval expense items. `status`/`pending_action`/`pending_data`/
-- `requester` mirror the app's existing pattern directly on the row (not the generic
-- pending_actions table) since every consumer already expects these exact fields. `requester`,
-- `creator`, `actual_payer`, `payer`, `bought_requested_by`, `bought_by` store the role label
-- ('Contractor'/'Owner') rather than a user id — deliberately the least-disruptive path per the
-- migration research, since the frontend already treats these as role strings everywhere; real
-- enforcement of "who is actually allowed to act as that role" happens in the route handlers via
-- currentUser.id vs. the project's contractor_id/owner_id, not by trusting this string.
CREATE TABLE IF NOT EXISTS ledger_items (
  id                  SERIAL PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  folder_id           TEXT,
  name                TEXT NOT NULL,
  supplier            TEXT,
  price               NUMERIC,
  quantity            NUMERIC,
  unit                TEXT,
  payment_status      TEXT,
  actual_payer        TEXT,
  payer               TEXT,
  due_date            DATE,
  cost_code           TEXT,
  image               TEXT,
  attachments         JSONB NOT NULL DEFAULT '[]',
  linked_from_room    BOOLEAN NOT NULL DEFAULT false,
  creator             TEXT,
  status              TEXT NOT NULL DEFAULT 'Approved',
  pending_action      TEXT,
  pending_data        JSONB,
  requester           TEXT,
  bought_status       TEXT NOT NULL DEFAULT 'Not Bought',
  bought_requested_by TEXT,
  bought_method       TEXT,
  bought_by           TEXT,
  -- Soft delete: an approved deletion sets this instead of removing the row, which is both
  -- the "Recently Deleted" list (deleted_at IS NOT NULL, newest 20) and its restore path.
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
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
