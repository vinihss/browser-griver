import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type Db = DatabaseSync

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recipes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  target      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipes_project ON recipes(project_id);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  recipe_id    TEXT,
  recipe_name  TEXT,
  driver       TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  error        TEXT,
  scope        TEXT,
  log          TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS recordings (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  state       TEXT NOT NULL,
  steps       TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT,
  opencode_session_id TEXT,
  title               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recipe_revisions (
  id          TEXT PRIMARY KEY,
  recipe_id   TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_recipe ON recipe_revisions(recipe_id);

CREATE TABLE IF NOT EXISTS schedules (
  id           TEXT PRIMARY KEY,
  recipe_id    TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cron         TEXT NOT NULL,
  driver       TEXT NOT NULL DEFAULT 'playwright',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_run_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_recipe ON schedules(recipe_id);
`

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  db.exec(SCHEMA)
  return db
}
