CREATE TABLE tandem.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tandem.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 120),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 512),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  leased_by uuid,
  lease_until timestamptz,
  execution_token bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  checkpoint jsonb NOT NULL DEFAULT '{}',
  error_code text,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, dedupe_key),
  CHECK ((status = 'running') = (leased_by IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX jobs_claim ON tandem.jobs (available_at, created_at) WHERE status IN ('queued','running');
CREATE TABLE tandem.worker_heartbeats (
  worker_id uuid PRIMARY KEY,
  seen_at timestamptz NOT NULL
);
ALTER TABLE tandem.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON tandem.workspaces
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY job_scope ON tandem.jobs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- The worker scheduler can lease queue rows across spaces, not domain resources.
-- Queue rows contain references, never credentials or complete tool responses.
CREATE POLICY scheduler_queue ON tandem.jobs TO tandem_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON tandem.workspaces, tandem.jobs TO tandem_app;
GRANT SELECT, UPDATE ON tandem.jobs TO tandem_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON tandem.worker_heartbeats TO tandem_worker;
GRANT SELECT ON tandem.worker_heartbeats TO tandem_app;

