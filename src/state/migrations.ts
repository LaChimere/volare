import type { Database } from 'bun:sqlite';

export const CURRENT_SCHEMA_VERSION = 1;

const MIGRATION_1 = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS backend_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  backend_session_id TEXT,
  process_id TEXT,
  process_started_at INTEGER,
  process_identity_hash TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (thread_id) REFERENCES threads(id)
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  parent_turn_id TEXT,
  bridge_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (bridge_session_id) REFERENCES backend_sessions(id)
);

CREATE TABLE IF NOT EXISTS client_turn_refs (
  protocol TEXT NOT NULL,
  external_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  parent_protocol TEXT,
  parent_external_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (protocol, external_id),
  FOREIGN KEY (turn_id) REFERENCES turns(id),
  FOREIGN KEY (thread_id) REFERENCES threads(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  redacted_raw_json TEXT,
  canonical_json TEXT,
  encoded_json TEXT,
  redaction_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(turn_id, seq),
  FOREIGN KEY (turn_id) REFERENCES turns(id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  bridge_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  redacted_request_json TEXT NOT NULL,
  decision_json TEXT,
  timeout_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  FOREIGN KEY (turn_id) REFERENCES turns(id),
  FOREIGN KEY (bridge_session_id) REFERENCES backend_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_turns_thread_id ON turns(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_turn_id_seq ON events(turn_id, seq);
CREATE INDEX IF NOT EXISTS idx_backend_sessions_thread_id ON backend_sessions(thread_id);
CREATE INDEX IF NOT EXISTS idx_backend_sessions_workspace_status ON backend_sessions(workspace_id, status);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

export function migrate(database: Database): void {
  database.run('PRAGMA foreign_keys = ON');
  database.transaction(() => {
    database.exec(MIGRATION_1);
    database
      .query('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(CURRENT_SCHEMA_VERSION, Date.now());
  })();
}
