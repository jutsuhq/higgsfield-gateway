-- Higgsfield Gateway schema. See docs/architecture.md for how each table is used.

CREATE TABLE clients (
  id              TEXT PRIMARY KEY,     -- e.g. bot, web; "_global" is reserved
  daily_cap_cents INTEGER NOT NULL,
  max_job_cents   INTEGER NOT NULL,
  models          TEXT NOT NULL,        -- JSON: {"<model>": ["480p", "720p"], …}
  max_parallel    INTEGER NOT NULL      -- share of the Higgsfield concurrency tier
);

-- One row per client per UTC day, plus a "_global" row per day for the global cap.
CREATE TABLE spend (
  client_id      TEXT NOT NULL,
  day            TEXT NOT NULL,         -- UTC date
  cap_cents      INTEGER NOT NULL,      -- copied from config on every reservation
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, day)
);

-- Fires only when a reservation grows, so settling a job that cost more
-- than its estimate never fails.
CREATE TRIGGER spend_cap BEFORE UPDATE OF reserved_cents ON spend
WHEN NEW.reserved_cents > OLD.reserved_cents
 AND NEW.spent_cents + NEW.reserved_cents > NEW.cap_cents
BEGIN
  SELECT RAISE(ABORT, 'budget_exceeded');
END;

CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,      -- Workflow instance id and Idempotency-Key
  client_id      TEXT NOT NULL,
  client_job_id  TEXT NOT NULL,
  model          TEXT NOT NULL,
  resolution     TEXT NOT NULL,
  spec           TEXT NOT NULL,         -- JSON: inputs and options as createJob received them
  est_cents      INTEGER NOT NULL,      -- list price, then the exact /estimate
  max_cents      INTEGER NOT NULL,      -- the client's maxUsd
  spent_cents    INTEGER,               -- set when the job is closed
  spend_day      TEXT NOT NULL,         -- UTC day the reservation was made; settle uses it
  hf_request     TEXT UNIQUE,
  hf_correlation TEXT,                  -- X-Correlation-ID of the submit, for support
  hook_token     TEXT NOT NULL,         -- random, part of the webhook path
  status         TEXT NOT NULL,         -- reserved|submitted|completed|failed|nsfw|canceled|timeout
  error          TEXT,
  result_key     TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at    TEXT,
  UNIQUE (client_id, client_job_id)
);
CREATE INDEX jobs_status ON jobs (status, client_id);

CREATE TABLE inputs (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- image | video
  seconds    REAL,                      -- video only
  width      INTEGER,                   -- as displayed: a video's rotation is applied
  height     INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trends (
  id      TEXT PRIMARY KEY,
  r2_key  TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK (seconds BETWEEN 4 AND 15),
  width   INTEGER NOT NULL,
  height  INTEGER NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE webhook_events (
  id          TEXT PRIMARY KEY,         -- webhook-id header
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
