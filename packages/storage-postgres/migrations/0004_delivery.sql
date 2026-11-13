CREATE TABLE tandem.delivery_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 project_id uuid NOT NULL, team_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES tandem.identities(id),
 owner_id uuid NOT NULL REFERENCES tandem.identities(id), session_id uuid NOT NULL REFERENCES tandem.sessions(id),
 request_id uuid NOT NULL, request_hash text NOT NULL, job_id uuid REFERENCES tandem.jobs(id), generation integer NOT NULL DEFAULT 0,
 goal text NOT NULL CHECK(length(goal) BETWEEN 1 AND 6000), acceptance text NOT NULL CHECK(length(acceptance) BETWEEN 1 AND 6000),
 mode text NOT NULL CHECK(mode IN ('demo','deploy')), assigned_role text CHECK(assigned_role IN ('designer','architect','engineer')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','needs_auth','needs_configuration','needs_decision','awaiting_deployment','delivered','failed','cancelled')),
 phase text NOT NULL DEFAULT 'design' CHECK(phase IN ('design','architecture','implementation','test','design_review','technical_review','delivery')),
 revision integer NOT NULL DEFAULT 0, budget_calls integer NOT NULL CHECK(budget_calls BETWEEN 5 AND 100), used_calls integer NOT NULL DEFAULT 0 CHECK(used_calls >= 0),
 budget_tokens integer NOT NULL CHECK(budget_tokens BETWEEN 10000 AND 2000000), used_tokens integer NOT NULL DEFAULT 0 CHECK(used_tokens >= 0),
 max_revisions integer NOT NULL CHECK(max_revisions BETWEEN 0 AND 5), event_sequence integer NOT NULL DEFAULT 0,
 error text, artifact jsonb, deployment jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,project_id) REFERENCES tandem.project_links(workspace_id,id),
 FOREIGN KEY(workspace_id,team_id) REFERENCES tandem.agent_teams(workspace_id,id),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,actor_id,request_id)
);
CREATE INDEX delivery_runs_project ON tandem.delivery_runs(workspace_id,project_id,created_at DESC);
CREATE TABLE tandem.delivery_events (
 workspace_id uuid NOT NULL, run_id uuid NOT NULL, sequence integer NOT NULL,
 kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 80), phase text NOT NULL, role text,
 summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 2000), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,sequence), FOREIGN KEY(workspace_id,run_id) REFERENCES tandem.delivery_runs(workspace_id,id)
);
CREATE TABLE tandem.delivery_documents (
 workspace_id uuid NOT NULL, run_id uuid NOT NULL, kind text NOT NULL, role text NOT NULL,
 version integer NOT NULL, content text NOT NULL CHECK(length(content) BETWEEN 1 AND 200000), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,kind,version), FOREIGN KEY(workspace_id,run_id) REFERENCES tandem.delivery_runs(workspace_id,id)
);
CREATE TABLE tandem.delivery_profiles (
 workspace_id uuid PRIMARY KEY REFERENCES tandem.workspaces(id), profiles jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tandem.delivery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.delivery_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.delivery_events FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.delivery_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.delivery_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.delivery_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.delivery_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_run_internal ON tandem.delivery_runs TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY delivery_event_internal ON tandem.delivery_events TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY delivery_doc_internal ON tandem.delivery_documents TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY delivery_profile_internal ON tandem.delivery_profiles TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY delivery_job_internal ON tandem.jobs TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY delivery_run_read ON tandem.delivery_runs TO tandem_app USING(
 workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.can_access_project(project_id,false));
CREATE POLICY delivery_event_read ON tandem.delivery_events TO tandem_app USING(
 EXISTS(SELECT 1 FROM tandem.delivery_runs r WHERE r.id=run_id AND r.workspace_id=delivery_events.workspace_id));
CREATE POLICY delivery_doc_read ON tandem.delivery_documents TO tandem_app USING(
 EXISTS(SELECT 1 FROM tandem.delivery_runs r WHERE r.id=run_id AND r.workspace_id=delivery_documents.workspace_id));
CREATE POLICY delivery_profile_read ON tandem.delivery_profiles TO tandem_app USING(
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL);
CREATE POLICY delivery_profile_write ON tandem.delivery_profiles FOR ALL TO tandem_app USING(
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IN ('owner','admin')) WITH CHECK(
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IN ('owner','admin'));
GRANT SELECT ON tandem.delivery_runs,tandem.delivery_events,tandem.delivery_documents TO tandem_app;
GRANT SELECT,INSERT,UPDATE ON tandem.delivery_profiles TO tandem_app;

CREATE FUNCTION tandem.start_delivery_run(input jsonb, auth_session uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE space uuid; actor uuid; project uuid; team tandem.agent_teams; previous tandem.delivery_runs; result uuid; queued uuid; digest text;
BEGIN
 space:=nullif(current_setting('app.workspace_id',true),'')::uuid;
 actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
 project:=(input->>'projectId')::uuid;
 IF space IS DISTINCT FROM (input->>'workspaceId')::uuid OR NOT tandem.can_access_project(project,false) THEN
  RAISE EXCEPTION 'Project access forbidden' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM tandem.sessions WHERE id=auth_session AND identity_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Session expired' USING ERRCODE='42501';
 END IF;
 SELECT * INTO team FROM tandem.agent_teams WHERE workspace_id=space AND template_key='default-t';
 IF team.id IS NULL OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=space AND g.project_id=project AND g.identity_id=team.owner_id) THEN
  RAISE EXCEPTION 'Team owner unavailable' USING ERRCODE='42501';
 END IF;
 digest:=md5(input::text);
 PERFORM pg_advisory_xact_lock(hashtextextended(space::text||actor::text||(input->>'requestId'),0));
 SELECT * INTO previous FROM tandem.delivery_runs WHERE workspace_id=space AND actor_id=actor AND request_id=(input->>'requestId')::uuid;
 IF previous.id IS NOT NULL THEN
  IF previous.request_hash<>digest THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='23505'; END IF;
  RETURN previous.id;
 END IF;
 INSERT INTO tandem.delivery_runs(workspace_id,project_id,team_id,actor_id,owner_id,session_id,request_id,request_hash,goal,acceptance,mode,assigned_role,budget_calls,budget_tokens,max_revisions)
 VALUES(space,project,team.id,actor,team.owner_id,auth_session,(input->>'requestId')::uuid,digest,input->>'goal',input->>'acceptance',input->>'mode',input->>'assignedRole',(input->>'budgetCalls')::integer,(input->>'budgetTokens')::integer,(input->>'maxRevisions')::integer) RETURNING id INTO result;
 INSERT INTO tandem.jobs(workspace_id,kind,reference,dedupe_key,max_attempts) VALUES(space,'delivery.run',result::text,'delivery:'||result::text||':0',20) RETURNING id INTO queued;
 UPDATE tandem.delivery_runs SET job_id=queued,event_sequence=1 WHERE id=result;
 INSERT INTO tandem.delivery_events(workspace_id,run_id,sequence,kind,phase,summary) VALUES(space,result,1,'created','design','目标已提交，等待后台执行');
 RETURN result;
END $$;

CREATE FUNCTION tandem.control_delivery_run(target uuid, command text, auth_session uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE run tandem.delivery_runs; actor uuid; next_status text; queued uuid; deployment_state text;
BEGIN
 actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=target AND workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid FOR UPDATE;
 IF run.id IS NULL OR NOT tandem.can_access_project(run.project_id,false) OR actor NOT IN(run.actor_id,run.owner_id) THEN RAISE EXCEPTION 'Run access forbidden' USING ERRCODE='42501'; END IF;
 IF command='resume' THEN
  IF actor<>run.actor_id OR NOT EXISTS(SELECT 1 FROM tandem.sessions WHERE id=auth_session AND identity_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Original actor required' USING ERRCODE='42501'; END IF;
  IF run.status NOT IN('paused','needs_auth','needs_configuration','needs_decision','failed','awaiting_deployment') THEN RAISE EXCEPTION 'Run cannot resume' USING ERRCODE='22023'; END IF;
  IF run.phase='delivery' THEN
   SELECT d.status INTO deployment_state FROM tandem.project_drafts d JOIN tandem.project_draft_versions v ON v.draft_id=d.id AND v.workspace_id=d.workspace_id AND v.version=d.version WHERE d.workspace_id=run.workspace_id AND d.project_id=run.project_id AND v.action->>'kind'='delivery.deploy' AND v.action->>'runId'=run.id::text ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
   IF deployment_state IN('pending','approved','executing','unknown') THEN RAISE EXCEPTION 'Deployment pending or result unknown; reconcile first' USING ERRCODE='23505'; END IF;
  END IF;
  next_status:='queued';
  INSERT INTO tandem.jobs(workspace_id,kind,reference,dedupe_key,max_attempts) VALUES(run.workspace_id,'delivery.run',target::text,'delivery:'||target::text||':'||(run.generation+1)::text,20) RETURNING id INTO queued;
  UPDATE tandem.delivery_runs SET job_id=queued,generation=generation+1,session_id=auth_session WHERE id=target;
 ELSIF command IN('pause','cancel') THEN
  IF run.status IN('delivered','cancelled') THEN RAISE EXCEPTION 'Run is terminal' USING ERRCODE='22023'; END IF;
  next_status:=CASE command WHEN 'pause' THEN 'paused' ELSE 'cancelled' END;
  UPDATE tandem.jobs SET status='completed',leased_by=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=run.job_id AND status IN('queued','running');
 ELSE RAISE EXCEPTION 'Unknown command' USING ERRCODE='22023'; END IF;
 UPDATE tandem.delivery_runs SET status=next_status,error=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE id=target;
 INSERT INTO tandem.delivery_events(workspace_id,run_id,sequence,kind,phase,summary) VALUES(run.workspace_id,target,run.event_sequence+1,command,run.phase,CASE command WHEN 'resume' THEN '按原执行身份继续；累计预算和已有产物保留' WHEN 'pause' THEN '已暂停，停止后续步骤' ELSE '已取消后续执行；已有外部结果不会自动撤销' END);
END $$;

CREATE FUNCTION tandem.extend_delivery_budget(target uuid, calls integer, tokens integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE run tandem.delivery_runs;
BEGIN
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=target AND workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid FOR UPDATE;
 IF run.id IS NULL OR run.actor_id IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')::uuid OR NOT tandem.can_access_project(run.project_id,false) THEN RAISE EXCEPTION 'Run access forbidden' USING ERRCODE='42501'; END IF;
 IF calls < run.budget_calls OR calls > 100 OR tokens < run.budget_tokens OR tokens > 2000000 THEN RAISE EXCEPTION 'Invalid budget' USING ERRCODE='22023'; END IF;
 UPDATE tandem.delivery_runs SET budget_calls=calls,budget_tokens=tokens,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE id=target;
 INSERT INTO tandem.delivery_events(workspace_id,run_id,sequence,kind,phase,summary) VALUES(run.workspace_id,target,run.event_sequence+1,'budget_extended',run.phase,'累计预算已增加；已用预算保留');
END $$;

CREATE FUNCTION tandem.delivery_worker_context(target_job uuid, lease_token bigint, worker uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE run tandem.delivery_runs; actor_session tandem.sessions; owner_session tandem.sessions; actor tandem.identities; owner tandem.identities; profiles jsonb;
BEGIN
 SELECT r.* INTO run FROM tandem.delivery_runs r JOIN tandem.jobs j ON j.id=r.job_id WHERE j.id=target_job AND j.execution_token=lease_token AND j.leased_by=worker AND j.status='running' AND j.lease_until>clock_timestamp() AND j.kind='delivery.run';
 IF run.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO actor_session FROM tandem.sessions WHERE id=run.session_id AND identity_id=run.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp();
 SELECT * INTO owner_session FROM tandem.sessions WHERE identity_id=run.owner_id AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1;
 SELECT * INTO actor FROM tandem.identities WHERE id=run.actor_id;
 SELECT * INTO owner FROM tandem.identities WHERE id=run.owner_id;
 IF actor_session.id IS NULL OR owner_session.id IS NULL OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.actor_id) OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.owner_id) THEN
  UPDATE tandem.delivery_runs SET status='needs_auth',error='发起人或团队挂靠人的登录、成员或项目授权已失效，请恢复授权后继续',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE id=run.id;
  INSERT INTO tandem.delivery_events(workspace_id,run_id,sequence,kind,phase,summary) VALUES(run.workspace_id,run.id,run.event_sequence+1,'authorization_required',run.phase,'发起人或团队挂靠人的登录、成员或项目授权已失效，请恢复授权后继续');
  RETURN NULL;
 END IF;
 SELECT p.profiles INTO profiles FROM tandem.delivery_profiles p WHERE workspace_id=run.workspace_id;
 RETURN jsonb_build_object('run',to_jsonb(run),'profiles',profiles,'project',(SELECT jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'connectionId',p.connection_id,'externalId',p.external_id,'createdBy',p.created_by,'cacheVersion',p.cache_version::text,'createdAt',p.created_at) FROM tandem.project_links p WHERE p.id=run.project_id AND p.workspace_id=run.workspace_id),'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.created_at),'[]'::jsonb) FROM tandem.delivery_documents d WHERE run_id=run.id),'session',jsonb_build_object('id',actor_session.id,'encryptedCredential',actor_session.encrypted_credential,'expiresAt',actor_session.expires_at,'identity',jsonb_build_object('id',actor.id,'providerId',actor.provider_id,'subject',actor.subject,'displayName',actor.display_name,'canCreateWorkspace',actor.can_create_workspace)),
 'ownerSession',jsonb_build_object('id',owner_session.id,'encryptedCredential',owner_session.encrypted_credential,'expiresAt',owner_session.expires_at,'identity',jsonb_build_object('id',owner.id,'providerId',owner.provider_id,'subject',owner.subject,'displayName',owner.display_name,'canCreateWorkspace',owner.can_create_workspace)));
END $$;

CREATE FUNCTION tandem.delivery_worker_update(target_job uuid, lease_token bigint, worker uuid, patch jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE run tandem.delivery_runs; document_version integer;
BEGIN
 SELECT r.* INTO run FROM tandem.delivery_runs r JOIN tandem.jobs j ON j.id=r.job_id WHERE j.id=target_job AND j.execution_token=lease_token AND j.leased_by=worker AND j.status='running' AND j.lease_until>clock_timestamp() AND j.kind='delivery.run' FOR UPDATE OF r;
 IF run.id IS NULL OR run.status IN('paused','cancelled','delivered') THEN RETURN false; END IF;
 IF patch ? 'reserveTokens' THEN
  IF (patch->>'reserveTokens')::integer < 1 OR (patch->>'reserveTokens')::integer > 1000000 THEN RAISE EXCEPTION 'Invalid reservation' USING ERRCODE='22023'; END IF;
  IF run.used_calls>=run.budget_calls OR run.used_tokens+(patch->>'reserveTokens')::integer>run.budget_tokens THEN RETURN false; END IF;
  UPDATE tandem.delivery_runs SET used_calls=used_calls+1,used_tokens=used_tokens+(patch->>'reserveTokens')::integer,updated_at=clock_timestamp() WHERE id=run.id;
  RETURN true;
 END IF;
 IF patch ? 'tokenDelta' THEN
  IF abs((patch->>'tokenDelta')::integer)>1000000 THEN RAISE EXCEPTION 'Invalid settlement' USING ERRCODE='22023'; END IF;
  UPDATE tandem.delivery_runs SET used_tokens=greatest(0,used_tokens+(patch->>'tokenDelta')::integer),updated_at=clock_timestamp() WHERE id=run.id;
  RETURN true;
 END IF;
 IF NOT(patch ? 'event') THEN RAISE EXCEPTION 'Event required' USING ERRCODE='22023'; END IF;
 UPDATE tandem.delivery_runs SET status=coalesce(patch->>'status',status),phase=coalesce(patch->>'phase',phase),revision=coalesce((patch->>'revision')::integer,revision),
 error=CASE WHEN patch ? 'error' THEN patch->>'error' ELSE error END,
 artifact=CASE WHEN patch ? 'artifact' THEN patch->'artifact' ELSE artifact END,
 deployment=CASE WHEN patch ? 'deployment' THEN patch->'deployment' ELSE deployment END,
 event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE id=run.id;
 INSERT INTO tandem.delivery_events(workspace_id,run_id,sequence,kind,phase,role,summary) VALUES(run.workspace_id,run.id,run.event_sequence+1,patch->'event'->>'kind',coalesce(patch->>'phase',run.phase),patch->'event'->>'role',patch->'event'->>'summary');
 IF patch ? 'document' THEN
  SELECT coalesce(max(version),0)+1 INTO document_version FROM tandem.delivery_documents WHERE run_id=run.id AND kind=patch->'document'->>'kind';
  INSERT INTO tandem.delivery_documents(workspace_id,run_id,kind,role,version,content) VALUES(run.workspace_id,run.id,patch->'document'->>'kind',patch->'document'->>'role',document_version,patch->'document'->>'content');
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION tandem.start_delivery_run(jsonb,uuid),tandem.control_delivery_run(uuid,text,uuid),tandem.extend_delivery_budget(uuid,integer,integer),tandem.delivery_worker_context(uuid,bigint,uuid),tandem.delivery_worker_update(uuid,bigint,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.start_delivery_run(jsonb,uuid),tandem.control_delivery_run(uuid,text,uuid),tandem.extend_delivery_budget(uuid,integer,integer) TO tandem_app;
GRANT EXECUTE ON FUNCTION tandem.delivery_worker_context(uuid,bigint,uuid),tandem.delivery_worker_update(uuid,bigint,uuid,jsonb) TO tandem_worker;

CREATE FUNCTION tandem.delivery_worker_create_draft(queue_id uuid, lease_token bigint, worker uuid, heading text, content jsonb, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ctx jsonb; run tandem.delivery_runs; result uuid;
BEGIN
 ctx:=tandem.delivery_worker_context(queue_id,lease_token,worker);
 IF ctx IS NULL THEN RAISE EXCEPTION 'Run lease or authorization expired' USING ERRCODE='42501'; END IF;
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=(ctx->'run'->>'id')::uuid;
 IF content->>'kind'='delivery.deploy' THEN
  IF run.phase<>'delivery' OR run.status NOT IN('running','awaiting_deployment') OR content->>'runId' IS DISTINCT FROM run.id::text OR content->>'artifactRef' IS DISTINCT FROM run.artifact->>'artifactRef' OR content->>'contentHash' IS DISTINCT FROM run.artifact->>'contentHash' OR (content->>'version')::integer IS DISTINCT FROM run.revision OR coalesce((run.artifact->>'passed')::boolean,false)=false THEN RAISE EXCEPTION 'Artifact version invalid' USING ERRCODE='22023'; END IF;
 ELSIF content->>'kind'='mcp.call' THEN
  IF content->>'projectId' IS DISTINCT FROM run.project_id::text OR content->>'teamId' IS DISTINCT FROM run.team_id::text OR content->>'agentRole' NOT IN('designer','architect','engineer') THEN RAISE EXCEPTION 'Tool binding invalid' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'Unsupported worker draft' USING ERRCODE='22023'; END IF;
 PERFORM set_config('app.workspace_id',run.workspace_id::text,true),set_config('app.actor_id',run.actor_id::text,true);
 result:=tandem.save_project_draft(run.project_id,run.session_id,heading,content,request_key);
 RETURN tandem.project_draft_json(result);
END $$;
REVOKE ALL ON FUNCTION tandem.delivery_worker_create_draft(uuid,bigint,uuid,text,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.delivery_worker_create_draft(uuid,bigint,uuid,text,jsonb,uuid) TO tandem_worker;

-- Deployment access is derived only from an approved immutable draft and its current queue lease.
CREATE FUNCTION tandem.deployment_worker_context(queue_id uuid, lease_token bigint, worker uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE d tandem.project_drafts; action jsonb; run tandem.delivery_runs; s tandem.sessions; os tandem.sessions; i tandem.identities; oi tandem.identities;
BEGIN
 SELECT draft.* INTO d FROM tandem.project_drafts draft JOIN tandem.jobs j ON j.id=draft.job_id WHERE j.id=queue_id AND j.kind='draft.execute' AND j.execution_token=lease_token AND j.leased_by=worker AND j.status='running' AND j.lease_until>clock_timestamp();
 IF d.id IS NULL OR d.status NOT IN('approved','executing') THEN RETURN NULL; END IF;
 SELECT v.action INTO action FROM tandem.project_draft_versions v WHERE v.draft_id=d.id AND v.workspace_id=d.workspace_id AND v.version=d.version;
 IF action->>'kind' NOT IN('delivery.deploy','delivery.rollback') THEN RETURN NULL; END IF;
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=(action->>'runId')::uuid AND workspace_id=d.workspace_id AND project_id=d.project_id AND actor_id=d.actor_id AND session_id=d.session_id;
 IF run.id IS NULL OR run.status NOT IN('awaiting_deployment','delivered') OR run.revision<>(action->>'version')::integer OR coalesce((run.artifact->>'passed')::boolean,false)=false THEN RETURN NULL; END IF;
 IF action->>'kind'='delivery.deploy' AND (run.artifact->>'artifactRef' IS DISTINCT FROM action->>'artifactRef' OR run.artifact->>'contentHash' IS DISTINCT FROM action->>'contentHash') THEN RETURN NULL; END IF;
 IF action->>'kind'='delivery.rollback' AND (run.deployment->>'id' IS DISTINCT FROM action->>'deploymentId' OR run.deployment->>'contentHash' IS DISTINCT FROM action->>'contentHash' OR run.deployment->>'previousDeploymentId' IS NULL) THEN RETURN NULL; END IF;
 SELECT * INTO s FROM tandem.sessions WHERE id=run.session_id AND identity_id=run.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp();
 SELECT * INTO os FROM tandem.sessions WHERE identity_id=run.owner_id AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1;
 IF s.id IS NULL OR os.id IS NULL OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.actor_id AND g.role='editor') OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.owner_id) THEN RETURN NULL; END IF;
 SELECT * INTO i FROM tandem.identities WHERE id=run.actor_id; SELECT * INTO oi FROM tandem.identities WHERE id=run.owner_id;
 RETURN jsonb_build_object('run',to_jsonb(run),'profiles',(SELECT profiles FROM tandem.delivery_profiles WHERE workspace_id=run.workspace_id),'project',(SELECT jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'connectionId',p.connection_id,'externalId',p.external_id,'createdBy',p.created_by,'cacheVersion',p.cache_version::text,'createdAt',p.created_at) FROM tandem.project_links p WHERE p.id=run.project_id AND p.workspace_id=run.workspace_id),'documents','[]'::jsonb,
 'session',jsonb_build_object('id',s.id,'encryptedCredential',s.encrypted_credential,'expiresAt',s.expires_at,'identity',jsonb_build_object('id',i.id,'providerId',i.provider_id,'subject',i.subject,'displayName',i.display_name,'canCreateWorkspace',i.can_create_workspace)),
 'ownerSession',jsonb_build_object('id',os.id,'encryptedCredential',os.encrypted_credential,'expiresAt',os.expires_at,'identity',jsonb_build_object('id',oi.id,'providerId',oi.provider_id,'subject',oi.subject,'displayName',oi.display_name,'canCreateWorkspace',oi.can_create_workspace)));
END $$;
CREATE FUNCTION tandem.record_delivery_deployment(queue_id uuid, lease_token bigint, worker uuid, target_run uuid, receipt jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ctx jsonb; run tandem.delivery_runs; d tandem.project_drafts; action jsonb;
BEGIN
 ctx:=tandem.deployment_worker_context(queue_id,lease_token,worker);
 IF ctx IS NULL OR ctx->'run'->>'id' IS DISTINCT FROM target_run::text THEN RETURN false; END IF;
 SELECT * INTO d FROM tandem.project_drafts WHERE job_id=queue_id;
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=target_run FOR UPDATE;
 SELECT v.action INTO action FROM tandem.project_draft_versions v WHERE v.draft_id=d.id AND v.workspace_id=d.workspace_id AND v.version=d.version;
 IF d.status<>'executing' OR receipt->>'id' IS DISTINCT FROM d.id::text OR receipt->>'environment'<>'local-demo' OR receipt->>'status' NOT IN('healthy','failed','rolled_back') OR length(receipt::text)>10000 THEN RETURN false; END IF;
 IF action->>'kind'='delivery.deploy' AND (receipt->>'artifactRef' IS DISTINCT FROM action->>'artifactRef' OR receipt->>'contentHash' IS DISTINCT FROM action->>'contentHash' OR (receipt->>'version')::integer IS DISTINCT FROM (action->>'version')::integer) THEN RETURN false; END IF;
 UPDATE tandem.delivery_runs SET deployment=receipt,status=CASE WHEN receipt->>'status' IN('healthy','rolled_back') THEN 'delivered' ELSE 'needs_decision' END,error=CASE WHEN receipt->>'status'='failed' THEN '部署健康检查失败，保留前一版本' ELSE NULL END,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE id=target_run;
 INSERT INTO tandem.delivery_events(workspace_id,run_id,sequence,kind,phase,role,summary) VALUES(run.workspace_id,run.id,run.event_sequence+1,CASE WHEN action->>'kind'='delivery.rollback' THEN 'rollback_completed' ELSE 'deployment_completed' END,'delivery','engineer',CASE receipt->>'status' WHEN 'healthy' THEN '获批本地演示部署通过HTTP健康检查' WHEN 'rolled_back' THEN '已按获批草案回滚并通过HTTP健康检查' ELSE '本地演示部署健康检查失败，保留前一版本' END);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION tandem.deployment_worker_context(uuid,bigint,uuid),tandem.record_delivery_deployment(uuid,bigint,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.deployment_worker_context(uuid,bigint,uuid),tandem.record_delivery_deployment(uuid,bigint,uuid,uuid,jsonb) TO tandem_worker;
