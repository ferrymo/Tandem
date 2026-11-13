ALTER TABLE tandem.project_drafts ADD COLUMN originating_run_id uuid;
ALTER TABLE tandem.project_drafts ADD COLUMN originating_generation integer;
ALTER TABLE tandem.project_drafts ADD CONSTRAINT draft_origin_run FOREIGN KEY(workspace_id,originating_run_id) REFERENCES tandem.delivery_runs(workspace_id,id);
ALTER TABLE tandem.project_drafts ADD CONSTRAINT draft_origin_generation CHECK((originating_run_id IS NULL AND originating_generation IS NULL) OR (originating_run_id IS NOT NULL AND originating_generation>=0));

CREATE FUNCTION tandem.draft_origin_active(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
 SELECT EXISTS(SELECT 1 FROM tandem.project_drafts d WHERE d.id=target AND (d.originating_run_id IS NULL OR EXISTS(
  SELECT 1 FROM tandem.delivery_runs r WHERE r.id=d.originating_run_id AND r.workspace_id=d.workspace_id AND r.project_id=d.project_id AND r.actor_id=d.actor_id
   AND r.generation>=d.originating_generation AND r.status IN('queued','running','needs_decision','awaiting_deployment'))))
$$;
REVOKE ALL ON FUNCTION tandem.draft_origin_active(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION tandem.delivery_worker_create_draft(queue_id uuid, lease_token bigint, worker uuid, heading text, content jsonb, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ctx jsonb; run tandem.delivery_runs; result uuid; previous tandem.project_drafts;
BEGIN
 ctx:=tandem.delivery_worker_context(queue_id,lease_token,worker);
 IF ctx IS NULL THEN RAISE EXCEPTION 'Run lease or authorization expired' USING ERRCODE='42501'; END IF;
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=(ctx->'run'->>'id')::uuid;
 IF run.status NOT IN('queued','running') THEN RAISE EXCEPTION 'Run is not executing' USING ERRCODE='42501'; END IF;
 IF content->>'kind'='delivery.deploy' THEN
  IF run.phase<>'delivery' OR content->>'runId' IS DISTINCT FROM run.id::text OR content->>'artifactRef' IS DISTINCT FROM run.artifact->>'artifactRef' OR content->>'contentHash' IS DISTINCT FROM run.artifact->>'contentHash' OR (content->>'version')::integer IS DISTINCT FROM run.revision OR coalesce((run.artifact->>'passed')::boolean,false)=false THEN RAISE EXCEPTION 'Artifact version invalid' USING ERRCODE='22023'; END IF;
 ELSIF content->>'kind'='mcp.call' THEN
  IF content->>'projectId' IS DISTINCT FROM run.project_id::text OR content->>'teamId' IS DISTINCT FROM run.team_id::text OR content->>'agentRole' NOT IN('designer','architect','engineer') THEN RAISE EXCEPTION 'Tool binding invalid' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'Unsupported worker draft' USING ERRCODE='22023'; END IF;
 PERFORM set_config('app.workspace_id',run.workspace_id::text,true),set_config('app.actor_id',run.actor_id::text,true);
 result:=tandem.save_project_draft(run.project_id,run.session_id,heading,content,request_key);
 SELECT * INTO previous FROM tandem.project_drafts WHERE id=result FOR UPDATE;
 IF previous.originating_run_id IS NOT NULL AND previous.originating_run_id<>run.id THEN RAISE EXCEPTION 'Draft belongs to another run' USING ERRCODE='23505'; END IF;
 UPDATE tandem.project_drafts SET originating_run_id=run.id,originating_generation=coalesce(originating_generation,run.generation) WHERE id=result;
 RETURN tandem.project_draft_json(result);
END $$;

CREATE FUNCTION tandem.cancel_origin_drafts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
BEGIN
 IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
  UPDATE tandem.jobs SET status='completed',leased_by=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id IN(SELECT job_id FROM tandem.project_drafts WHERE originating_run_id=NEW.id AND workspace_id=NEW.workspace_id AND status IN('pending','approved')) AND status IN('queued','running');
  UPDATE tandem.project_drafts SET status='failed',error='ORIGIN_RUN_CANCELLED',updated_at=clock_timestamp() WHERE originating_run_id=NEW.id AND workspace_id=NEW.workspace_id AND status IN('pending','approved');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tandem.cancel_origin_drafts() FROM PUBLIC;
CREATE TRIGGER cancel_run_drafts AFTER UPDATE OF status ON tandem.delivery_runs FOR EACH ROW EXECUTE FUNCTION tandem.cancel_origin_drafts();

CREATE OR REPLACE FUNCTION tandem.begin_draft_action(queue_id uuid, lease_token bigint, worker uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE d tandem.project_drafts;
BEGIN
 PERFORM 1 FROM tandem.jobs WHERE id=queue_id AND kind='draft.execute' AND execution_token=lease_token AND leased_by=worker AND status='running' AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO d FROM tandem.project_drafts WHERE job_id=queue_id FOR UPDATE;
 IF d.id IS NULL OR d.status<>'approved' OR NOT tandem.draft_origin_active(d.id) OR NOT EXISTS(SELECT 1 FROM tandem.sessions WHERE id=d.session_id AND identity_id=d.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp()) OR
 NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m ON m.workspace_id=g.workspace_id AND m.identity_id=g.identity_id WHERE g.workspace_id=d.workspace_id AND g.project_id=d.project_id AND g.identity_id=d.actor_id AND g.role='editor') THEN RETURN false; END IF;
 UPDATE tandem.project_drafts SET status='executing',updated_at=clock_timestamp() WHERE id=d.id;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION tandem.capability_worker_scope(target_workspace uuid, target_project uuid DEFAULT NULL, target_team uuid DEFAULT NULL, target_server uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE job tandem.jobs; run tandem.delivery_runs; draft tandem.project_drafts; action jsonb; project uuid; team uuid; owner uuid; actor uuid; auth_session uuid;
BEGIN
 SELECT * INTO job FROM tandem.jobs WHERE id=nullif(current_setting('app.job_id',true),'')::uuid AND execution_token=nullif(current_setting('app.job_token',true),'')::bigint AND leased_by=nullif(current_setting('app.worker_id',true),'')::uuid AND status='running' AND lease_until>clock_timestamp();
 IF job.id IS NULL OR job.workspace_id IS DISTINCT FROM target_workspace OR target_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')::uuid THEN RETURN false; END IF;
 IF job.kind='delivery.run' THEN
  SELECT * INTO run FROM tandem.delivery_runs WHERE id::text=job.reference AND job_id=job.id AND workspace_id=job.workspace_id AND status IN('queued','running');
  IF run.id IS NULL THEN RETURN false; END IF;
  project:=run.project_id;team:=run.team_id;actor:=run.actor_id;owner:=run.owner_id;auth_session:=run.session_id;
 ELSIF job.kind='draft.execute' THEN
  SELECT * INTO draft FROM tandem.project_drafts WHERE id::text=job.reference AND job_id=job.id AND workspace_id=job.workspace_id AND status IN('approved','executing');
  IF draft.id IS NULL OR NOT tandem.draft_origin_active(draft.id) THEN RETURN false; END IF;
  SELECT v.action INTO action FROM tandem.project_draft_versions v WHERE v.draft_id=draft.id AND v.version=draft.version;
  IF action->>'kind' IS DISTINCT FROM 'mcp.call' OR (target_server IS NOT NULL AND target_server IS DISTINCT FROM (action->>'serverId')::uuid) THEN RETURN false; END IF;
  project:=draft.project_id;team:=(action->>'teamId')::uuid;actor:=draft.actor_id;auth_session:=draft.session_id;
  SELECT owner_id INTO owner FROM tandem.agent_teams WHERE id=team AND workspace_id=target_workspace;
 ELSE RETURN false;END IF;
 IF actor IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')::uuid OR (target_project IS NOT NULL AND target_project IS DISTINCT FROM project) OR (target_team IS NOT NULL AND target_team IS DISTINCT FROM team) OR owner IS NULL THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM tandem.sessions WHERE id=auth_session AND identity_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp())
 AND EXISTS(SELECT 1 FROM tandem.sessions WHERE identity_id=owner AND revoked_at IS NULL AND expires_at>clock_timestamp())
 AND EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=target_workspace AND g.project_id=project AND g.identity_id=actor)
 AND EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=target_workspace AND g.project_id=project AND g.identity_id=owner);
END $$;
