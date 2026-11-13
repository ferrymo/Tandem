-- Capability assets are Tandem-owned, immutable resources. Tool responses are never copied here.
CREATE TABLE tandem.skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  enabled boolean NOT NULL DEFAULT true, removed boolean NOT NULL DEFAULT false,
  active_version_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, name)
);
CREATE TABLE tandem.skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  skill_id uuid NOT NULL, version text NOT NULL CHECK (length(version) BETWEEN 1 AND 80),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  bundle jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object' AND octet_length(bundle::text) <= 3200000),
  installed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, skill_id) REFERENCES tandem.skills(workspace_id, id),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, skill_id, id), UNIQUE (workspace_id, skill_id, version)
);
ALTER TABLE tandem.skills ADD CONSTRAINT skill_active_version FOREIGN KEY (workspace_id, id, active_version_id)
  REFERENCES tandem.skill_versions(workspace_id, skill_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE tandem.skill_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  project_id uuid NOT NULL, team_id uuid NOT NULL, agent_role text NOT NULL DEFAULT '*'
    CHECK (agent_role IN ('*','designer','architect','engineer')),
  skill_id uuid NOT NULL, version_id uuid NOT NULL,
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'), enabled boolean NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES tandem.project_links(workspace_id, id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES tandem.agent_teams(workspace_id, id),
  FOREIGN KEY (workspace_id, skill_id, version_id) REFERENCES tandem.skill_versions(workspace_id, skill_id, id),
  UNIQUE (workspace_id, project_id, team_id, agent_role, skill_id)
);
CREATE TABLE tandem.mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120), connection jsonb NOT NULL CHECK (jsonb_typeof(connection) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), enabled boolean NOT NULL DEFAULT true, removed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','ready','unavailable','changed')),
  checked_at timestamptz, tools jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tools) = 'array' AND octet_length(tools::text) <= 2000000),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (workspace_id, id)
);
CREATE TABLE tandem.mcp_credentials (
  workspace_id uuid NOT NULL, server_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES tandem.identities(id),
  server_revision integer NOT NULL, ciphertext text NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 32768),
  FOREIGN KEY (workspace_id, server_id) REFERENCES tandem.mcp_servers(workspace_id, id),
  PRIMARY KEY (workspace_id, server_id, actor_id)
);
CREATE TABLE tandem.mcp_tool_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  project_id uuid NOT NULL, team_id uuid NOT NULL, agent_role text NOT NULL DEFAULT '*'
    CHECK (agent_role IN ('*','designer','architect','engineer')),
  server_id uuid NOT NULL, tool_name text NOT NULL, schema_hash text NOT NULL CHECK (schema_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision > 0), effect text NOT NULL CHECK (effect IN ('read','write','unknown')), enabled boolean NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES tandem.project_links(workspace_id, id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES tandem.agent_teams(workspace_id, id),
  FOREIGN KEY (workspace_id, server_id) REFERENCES tandem.mcp_servers(workspace_id, id),
  UNIQUE (workspace_id, project_id, team_id, agent_role, server_id, tool_name)
);
CREATE TABLE tandem.capability_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES tandem.identities(id), kind text NOT NULL CHECK (kind IN ('skill','mcp')),
  resource_id uuid NOT NULL, version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('succeeded','failed','unknown')),
  summary text NOT NULL CHECK (length(summary) <= 256), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES tandem.project_links(workspace_id, id)
);
CREATE INDEX capability_usage_project ON tandem.capability_usage (workspace_id, project_id, created_at DESC);
GRANT EXECUTE ON FUNCTION tandem.current_member_role(uuid) TO tandem_worker;

-- Worker scope is derived from a live queue lease, never from actor/workspace settings alone.
CREATE FUNCTION tandem.capability_worker_scope(target_workspace uuid, target_project uuid DEFAULT NULL, target_team uuid DEFAULT NULL, target_server uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE job tandem.jobs; run tandem.delivery_runs; draft tandem.project_drafts; action jsonb; project uuid; team uuid; owner uuid; actor uuid; auth_session uuid;
BEGIN
  SELECT * INTO job FROM tandem.jobs WHERE id=nullif(current_setting('app.job_id',true),'')::uuid
    AND execution_token=nullif(current_setting('app.job_token',true),'')::bigint
    AND leased_by=nullif(current_setting('app.worker_id',true),'')::uuid AND status='running' AND lease_until>clock_timestamp();
  IF job.id IS NULL OR job.workspace_id IS DISTINCT FROM target_workspace OR target_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')::uuid THEN RETURN false; END IF;
  IF job.kind='delivery.run' THEN
    SELECT * INTO run FROM tandem.delivery_runs WHERE id::text=job.reference AND job_id=job.id AND workspace_id=job.workspace_id AND status IN ('queued','running');
    IF run.id IS NULL THEN RETURN false; END IF;
    project:=run.project_id; team:=run.team_id; actor:=run.actor_id; owner:=run.owner_id; auth_session:=run.session_id;
  ELSIF job.kind='draft.execute' THEN
    SELECT * INTO draft FROM tandem.project_drafts WHERE id::text=job.reference AND job_id=job.id AND workspace_id=job.workspace_id AND status IN ('approved','executing');
    IF draft.id IS NULL THEN RETURN false; END IF;
    SELECT v.action INTO action FROM tandem.project_draft_versions v WHERE v.draft_id=draft.id AND v.version=draft.version;
    IF action->>'kind' IS DISTINCT FROM 'mcp.call' OR (target_server IS NOT NULL AND target_server IS DISTINCT FROM (action->>'serverId')::uuid) THEN RETURN false; END IF;
    project:=draft.project_id; team:=(action->>'teamId')::uuid; actor:=draft.actor_id; auth_session:=draft.session_id;
    SELECT owner_id INTO owner FROM tandem.agent_teams WHERE id=team AND workspace_id=target_workspace;
  ELSE RETURN false;
  END IF;
  IF actor IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')::uuid OR (target_project IS NOT NULL AND target_project IS DISTINCT FROM project) OR (target_team IS NOT NULL AND target_team IS DISTINCT FROM team) OR owner IS NULL THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM tandem.sessions WHERE id=auth_session AND identity_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp())
    AND EXISTS(SELECT 1 FROM tandem.sessions WHERE identity_id=owner AND revoked_at IS NULL AND expires_at>clock_timestamp())
    AND EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=target_workspace AND g.project_id=project AND g.identity_id=actor)
    AND EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=target_workspace AND g.project_id=project AND g.identity_id=owner);
END $$;
REVOKE ALL ON FUNCTION tandem.capability_worker_scope(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.capability_worker_scope(uuid,uuid,uuid,uuid) TO tandem_worker;

-- The credential is a server-only authorization input; no product response exposes this function's result.
CREATE FUNCTION tandem.capability_owner_session(target_project uuid, target_team uuid, write_required boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE space uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid; owner uuid; auth_session tandem.sessions; person tandem.identities;
BEGIN
  IF NOT tandem.can_access_project(target_project,write_required) THEN RETURN NULL; END IF;
  IF session_user='tandem_worker' AND NOT tandem.capability_worker_scope(space,target_project,target_team) THEN RETURN NULL; END IF;
  SELECT t.owner_id INTO owner FROM tandem.agent_teams t JOIN tandem.workspace_members m ON m.workspace_id=t.workspace_id AND m.identity_id=t.owner_id
    JOIN tandem.project_grants g ON g.workspace_id=t.workspace_id AND g.identity_id=t.owner_id AND g.project_id=target_project AND (NOT write_required OR g.role='editor')
    WHERE t.workspace_id=space AND t.id=target_team;
  IF owner IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO auth_session FROM tandem.sessions WHERE identity_id=owner AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 1;
  IF auth_session.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO person FROM tandem.identities WHERE id=owner;
  RETURN jsonb_build_object('id',auth_session.id,'encryptedCredential',auth_session.encrypted_credential,'expiresAt',auth_session.expires_at,'identity',jsonb_build_object('id',person.id,'providerId',person.provider_id,'subject',person.subject,'displayName',person.display_name,'canCreateWorkspace',person.can_create_workspace));
END $$;
REVOKE ALL ON FUNCTION tandem.capability_owner_session(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.capability_owner_session(uuid,uuid,boolean) TO tandem_app,tandem_worker;

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['skills','skill_versions','skill_bindings','mcp_servers','mcp_credentials','mcp_tool_grants','capability_usage'] LOOP
    EXECUTE format('ALTER TABLE tandem.%I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE tandem.%I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY capability_internal ON tandem.%I TO tandem_migrator USING (true) WITH CHECK (true)', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['skills','skill_versions','mcp_servers'] LOOP
    EXECUTE format('CREATE POLICY capability_read ON tandem.%I FOR SELECT TO tandem_app USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL)', target);
    EXECUTE format('CREATE POLICY capability_insert ON tandem.%I FOR INSERT TO tandem_app WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin''))', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['skills','mcp_servers'] LOOP
    EXECUTE format('CREATE POLICY capability_update ON tandem.%I FOR UPDATE TO tandem_app USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin'')) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin''))', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['skill_bindings','mcp_tool_grants'] LOOP
    EXECUTE format('CREATE POLICY capability_binding_read ON tandem.%I FOR SELECT TO tandem_app USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.can_access_project(project_id,false))', target);
    EXECUTE format('CREATE POLICY capability_binding_insert ON tandem.%I FOR INSERT TO tandem_app WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin'') AND tandem.can_access_project(project_id,true))', target);
    EXECUTE format('CREATE POLICY capability_binding_update ON tandem.%I FOR UPDATE TO tandem_app USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin'') AND tandem.can_access_project(project_id,true)) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin'') AND tandem.can_access_project(project_id,true))', target);
  END LOOP;
END $$;
CREATE POLICY credential_actor ON tandem.mcp_credentials TO tandem_app
 USING (workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid AND actor_id = nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid AND actor_id = nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL);
CREATE POLICY credential_worker ON tandem.mcp_credentials FOR SELECT TO tandem_worker
 USING (actor_id = nullif(current_setting('app.actor_id',true),'')::uuid AND EXISTS(SELECT 1 FROM tandem.mcp_tool_grants g WHERE g.workspace_id=mcp_credentials.workspace_id AND g.server_id=mcp_credentials.server_id AND g.enabled AND tandem.capability_worker_scope(g.workspace_id,g.project_id,g.team_id,g.server_id)));
CREATE POLICY usage_read ON tandem.capability_usage FOR SELECT TO tandem_app
 USING (workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.can_access_project(project_id,false));
CREATE POLICY usage_insert ON tandem.capability_usage FOR INSERT TO tandem_app
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid AND actor_id = nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.can_access_project(project_id,false));
CREATE POLICY worker_skill_binding ON tandem.skill_bindings FOR SELECT TO tandem_worker USING (tandem.capability_worker_scope(workspace_id,project_id,team_id));
CREATE POLICY worker_tool_grant ON tandem.mcp_tool_grants FOR SELECT TO tandem_worker USING (tandem.capability_worker_scope(workspace_id,project_id,team_id,server_id));
CREATE POLICY worker_skill ON tandem.skills FOR SELECT TO tandem_worker USING (EXISTS(SELECT 1 FROM tandem.skill_bindings b WHERE b.workspace_id=skills.workspace_id AND b.skill_id=skills.id AND b.enabled));
CREATE POLICY worker_skill_version ON tandem.skill_versions FOR SELECT TO tandem_worker USING (EXISTS(SELECT 1 FROM tandem.skill_bindings b WHERE b.workspace_id=skill_versions.workspace_id AND b.skill_id=skill_versions.skill_id AND b.version_id=skill_versions.id AND b.enabled));
CREATE POLICY worker_mcp_server ON tandem.mcp_servers FOR SELECT TO tandem_worker USING (EXISTS(SELECT 1 FROM tandem.mcp_tool_grants g WHERE g.workspace_id=mcp_servers.workspace_id AND g.server_id=mcp_servers.id AND g.enabled));
CREATE POLICY worker_usage ON tandem.capability_usage FOR SELECT TO tandem_worker USING (tandem.capability_worker_scope(workspace_id,project_id));
CREATE POLICY worker_usage_insert ON tandem.capability_usage FOR INSERT TO tandem_worker WITH CHECK (actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.capability_worker_scope(workspace_id,project_id));
GRANT SELECT, INSERT, UPDATE ON tandem.skills,tandem.mcp_servers,tandem.skill_bindings,tandem.mcp_tool_grants TO tandem_app;
GRANT SELECT, INSERT ON tandem.skill_versions TO tandem_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tandem.mcp_credentials TO tandem_app;
GRANT SELECT, INSERT ON tandem.capability_usage TO tandem_app,tandem_worker;
GRANT SELECT ON tandem.skills,tandem.skill_versions,tandem.mcp_servers,tandem.skill_bindings,tandem.mcp_tool_grants,tandem.mcp_credentials TO tandem_worker;
