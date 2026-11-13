-- Business facts remain upstream. These are references and Tandem collaboration assets.
-- Restricted owner functions enqueue and fence jobs; FORCE RLS still applies to the owner.
CREATE POLICY job_internal ON tandem.jobs TO tandem_migrator USING(true) WITH CHECK(true);
CREATE TABLE tandem.project_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
  connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 200),
  external_id text NOT NULL CHECK (external_id ~ '^[1-9][0-9]{0,19}$'),
  created_by uuid NOT NULL REFERENCES tandem.identities(id),
  cache_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id), UNIQUE (workspace_id,connection_id,external_id)
);
CREATE TABLE tandem.project_grants (
  workspace_id uuid NOT NULL, project_id uuid NOT NULL, identity_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer','editor')),
  PRIMARY KEY (workspace_id,project_id,identity_id),
  FOREIGN KEY (workspace_id,project_id) REFERENCES tandem.project_links(workspace_id,id),
  FOREIGN KEY (workspace_id,identity_id) REFERENCES tandem.workspace_members(workspace_id,identity_id) ON DELETE CASCADE
);
CREATE TABLE tandem.task_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  task_id text NOT NULL CHECK (task_id ~ '^[1-9][0-9]{0,19}$'), actor_id uuid NOT NULL REFERENCES tandem.identities(id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,project_id) REFERENCES tandem.project_links(workspace_id,id)
);
CREATE INDEX task_messages_thread ON tandem.task_messages(workspace_id,project_id,task_id,created_at,id);
CREATE TABLE tandem.project_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES tandem.identities(id), session_id uuid NOT NULL REFERENCES tandem.sessions(id),
  request_id uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK (version>0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executing','succeeded','failed','unknown')),
  reviewer_id uuid REFERENCES tandem.identities(id), reviewed_at timestamptz, job_id uuid,
  receipt jsonb, error text CHECK (length(error)<=200), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,project_id) REFERENCES tandem.project_links(workspace_id,id),
  FOREIGN KEY (workspace_id,job_id) REFERENCES tandem.jobs(workspace_id,id),
  UNIQUE (workspace_id,id), UNIQUE (workspace_id,actor_id,request_id),
  CHECK (receipt IS NULL OR octet_length(receipt::text)<=4096)
);
CREATE TABLE tandem.project_draft_versions (
  workspace_id uuid NOT NULL, project_id uuid NOT NULL, draft_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  action jsonb NOT NULL CHECK (jsonb_typeof(action)='object' AND action ? 'kind' AND octet_length(action::text)<=65536 AND action->>'kind' IN ('task.create','task.update','task.status','task.effort','delivery.deploy','delivery.rollback','mcp.call')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id,draft_id,version),
  FOREIGN KEY(workspace_id,draft_id) REFERENCES tandem.project_drafts(workspace_id,id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES tandem.project_links(workspace_id,id)
);
CREATE INDEX project_drafts_latest ON tandem.project_drafts(workspace_id,project_id,created_at DESC,id);

ALTER TABLE tandem.project_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.project_links FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.project_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.project_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.task_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.task_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.project_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.project_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.project_draft_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.project_draft_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY project_internal ON tandem.project_links TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY project_grant_internal ON tandem.project_grants TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY task_message_internal ON tandem.task_messages TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY draft_internal ON tandem.project_drafts TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY draft_version_internal ON tandem.project_draft_versions TO tandem_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION tandem.can_access_project(target_project uuid, write_required boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
  SELECT EXISTS (SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m
    ON m.workspace_id=g.workspace_id AND m.identity_id=g.identity_id
    WHERE g.project_id=target_project AND g.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
      AND g.identity_id=nullif(current_setting('app.actor_id',true),'')::uuid AND (NOT write_required OR g.role='editor'))
$$;
REVOKE ALL ON FUNCTION tandem.can_access_project(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.can_access_project(uuid,boolean) TO tandem_app,tandem_worker;
CREATE POLICY project_scope ON tandem.project_links TO tandem_app USING(tandem.can_access_project(id));
CREATE POLICY project_grant_scope ON tandem.project_grants TO tandem_app USING(tandem.can_access_project(project_id));
CREATE POLICY task_message_scope ON tandem.task_messages TO tandem_app USING(tandem.can_access_project(project_id));
CREATE POLICY draft_scope ON tandem.project_drafts TO tandem_app USING(tandem.can_access_project(project_id));
CREATE POLICY draft_version_scope ON tandem.project_draft_versions TO tandem_app USING(tandem.can_access_project(project_id));
GRANT SELECT ON tandem.project_links,tandem.project_grants,tandem.task_messages,tandem.project_drafts,tandem.project_draft_versions TO tandem_app;

CREATE FUNCTION tandem.bind_project(connection text, external_project text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; project uuid;
BEGIN
  PERFORM 1 FROM tandem.workspaces WHERE id=ws FOR UPDATE;
  IF tandem.current_member_role(ws) NOT IN ('owner','admin') OR tandem.current_member_role(ws) IS NULL OR
    NOT EXISTS(SELECT 1 FROM tandem.identities WHERE id=actor AND provider_id=connection) THEN
    RAISE EXCEPTION 'Project binding forbidden' USING ERRCODE='42501';
  END IF;
  INSERT INTO tandem.project_links(workspace_id,connection_id,external_id,created_by) VALUES(ws,connection,external_project,actor)
    ON CONFLICT(workspace_id,connection_id,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id INTO project;
  INSERT INTO tandem.project_grants(workspace_id,project_id,identity_id,role) VALUES(ws,project,actor,'editor')
    ON CONFLICT(workspace_id,project_id,identity_id) DO UPDATE SET role='editor';
  RETURN project;
END $$;
CREATE FUNCTION tandem.change_project_grant(project uuid, person uuid, requested_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
  PERFORM 1 FROM tandem.workspaces WHERE id=ws FOR UPDATE;
  PERFORM 1 FROM tandem.project_links WHERE workspace_id=ws AND id=project FOR UPDATE;
  IF NOT FOUND OR NOT tandem.can_access_project(project,true) OR tandem.current_member_role(ws) NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Project grant forbidden' USING ERRCODE='42501';
  END IF;
  IF requested_role IS NULL THEN
    DELETE FROM tandem.project_grants WHERE workspace_id=ws AND project_id=project AND identity_id=person;
  ELSE
    IF requested_role NOT IN ('viewer','editor') OR NOT EXISTS(SELECT 1 FROM tandem.workspace_members WHERE workspace_id=ws AND identity_id=person) THEN
      RAISE EXCEPTION 'Unknown workspace member or role' USING ERRCODE='22023';
    END IF;
    INSERT INTO tandem.project_grants(workspace_id,project_id,identity_id,role) VALUES(ws,project,person,requested_role)
      ON CONFLICT(workspace_id,project_id,identity_id) DO UPDATE SET role=EXCLUDED.role;
  END IF;
  UPDATE tandem.project_links SET cache_version=cache_version+1 WHERE workspace_id=ws AND id=project;
END $$;
CREATE FUNCTION tandem.add_task_message(project uuid, external_task text, message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
BEGIN
  IF NOT tandem.can_access_project(project,true) THEN RAISE EXCEPTION 'Project write forbidden' USING ERRCODE='42501'; END IF;
  INSERT INTO tandem.task_messages(workspace_id,project_id,task_id,actor_id,body)
    VALUES(nullif(current_setting('app.workspace_id',true),'')::uuid,project,external_task,nullif(current_setting('app.actor_id',true),'')::uuid,message);
END $$;
-- An internal formatter. Not executable by runtime roles on arbitrary IDs.
CREATE FUNCTION tandem.project_draft_json(target uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
  SELECT jsonb_build_object('id',d.id,'workspaceId',d.workspace_id,'projectId',d.project_id,'actorId',d.actor_id,
    'sessionId',d.session_id,'title',v.title,'action',v.action,'version',d.version,'status',d.status,
    'reviewerId',d.reviewer_id,'reviewedAt',d.reviewed_at,'receipt',d.receipt,'error',d.error,'createdAt',d.created_at,'updatedAt',d.updated_at)
  FROM tandem.project_drafts d JOIN tandem.project_draft_versions v ON v.workspace_id=d.workspace_id AND v.draft_id=d.id AND v.version=d.version WHERE d.id=target
$$;
CREATE FUNCTION tandem.save_project_draft(project uuid, auth_session uuid, heading text, content jsonb, request_key uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; draft uuid; old_content jsonb; old_heading text;
BEGIN
  IF NOT tandem.can_access_project(project,true) OR NOT EXISTS(SELECT 1 FROM tandem.sessions WHERE id=auth_session AND identity_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Original session/project forbidden' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(ws::text||actor::text||request_key::text,0));
  SELECT id INTO draft FROM tandem.project_drafts WHERE workspace_id=ws AND actor_id=actor AND request_id=request_key;
  IF draft IS NOT NULL THEN
    SELECT action,title INTO old_content,old_heading FROM tandem.project_draft_versions WHERE workspace_id=ws AND draft_id=draft AND version=1;
    IF old_content<>content OR old_heading<>heading OR NOT EXISTS(SELECT 1 FROM tandem.project_drafts WHERE id=draft AND project_id=project AND session_id=auth_session) THEN
      RAISE EXCEPTION 'Request content conflict' USING ERRCODE='23505';
    END IF;
    RETURN draft;
  END IF;
  INSERT INTO tandem.project_drafts(workspace_id,project_id,actor_id,session_id,request_id) VALUES(ws,project,actor,auth_session,request_key) RETURNING id INTO draft;
  INSERT INTO tandem.project_draft_versions(workspace_id,project_id,draft_id,version,title,action) VALUES(ws,project,draft,1,heading,content);
  RETURN draft;
END $$;
CREATE FUNCTION tandem.revise_project_draft(target uuid, expected integer, heading text, content jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE d tandem.project_drafts;
BEGIN
  SELECT * INTO d FROM tandem.project_drafts WHERE id=target FOR UPDATE;
  IF d.id IS NULL OR NOT tandem.can_access_project(d.project_id,true) OR d.actor_id<>nullif(current_setting('app.actor_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Draft edit forbidden' USING ERRCODE='42501';
  END IF;
  IF d.version<>expected OR d.status NOT IN ('pending','rejected','failed') THEN RAISE EXCEPTION 'Draft version/state conflict' USING ERRCODE='23505'; END IF;
  INSERT INTO tandem.project_draft_versions(workspace_id,project_id,draft_id,version,title,action) VALUES(d.workspace_id,d.project_id,d.id,d.version+1,heading,content);
  UPDATE tandem.project_drafts SET version=version+1,status='pending',reviewer_id=NULL,reviewed_at=NULL,job_id=NULL,error=NULL,receipt=NULL,updated_at=clock_timestamp() WHERE id=d.id;
  RETURN d.id;
END $$;
CREATE FUNCTION tandem.review_project_draft(target uuid, expected integer, approve boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE d tandem.project_drafts; queued uuid; ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
  PERFORM 1 FROM tandem.workspaces WHERE id=ws FOR UPDATE;
  SELECT * INTO d FROM tandem.project_drafts WHERE id=target AND workspace_id=ws FOR UPDATE;
  IF d.id IS NULL OR NOT tandem.can_access_project(d.project_id,true) OR tandem.current_member_role(ws) NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Draft review forbidden' USING ERRCODE='42501';
  END IF;
  IF d.version<>expected OR d.status<>'pending' THEN RAISE EXCEPTION 'Draft review version/state conflict' USING ERRCODE='23505'; END IF;
  IF approve THEN
    IF NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m ON m.workspace_id=g.workspace_id AND m.identity_id=g.identity_id WHERE g.workspace_id=ws AND g.project_id=d.project_id AND g.identity_id=d.actor_id AND g.role='editor') THEN
      RAISE EXCEPTION 'Original actor revoked' USING ERRCODE='42501';
    END IF;
    INSERT INTO tandem.jobs(workspace_id,kind,reference,dedupe_key,max_attempts) VALUES(ws,'draft.execute',d.id::text,'draft:'||d.id::text||':'||d.version::text,3) RETURNING id INTO queued;
  END IF;
  UPDATE tandem.project_drafts SET status=CASE WHEN approve THEN 'approved' ELSE 'rejected' END, reviewer_id=nullif(current_setting('app.actor_id',true),'')::uuid,
    reviewed_at=clock_timestamp(),job_id=queued,updated_at=clock_timestamp() WHERE id=d.id;
  RETURN d.id;
END $$;

CREATE FUNCTION tandem.draft_worker_context(queue_id uuid, lease_token bigint, worker uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE d tandem.project_drafts; s tandem.sessions; i tandem.identities; p tandem.project_links;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tandem.jobs WHERE id=queue_id AND kind='draft.execute' AND execution_token=lease_token AND leased_by=worker AND status='running' AND lease_until>clock_timestamp()) THEN RETURN NULL; END IF;
  SELECT draft.* INTO d FROM tandem.project_drafts draft JOIN tandem.jobs j ON j.id=draft.job_id AND j.workspace_id=draft.workspace_id WHERE j.id=queue_id FOR UPDATE OF draft;
  IF d.id IS NULL OR d.status NOT IN ('approved','executing') THEN RETURN NULL; END IF;
  IF d.status='executing' THEN
    UPDATE tandem.project_drafts SET status='unknown',error='WORKER_INTERRUPTED_AFTER_SEND',updated_at=clock_timestamp() WHERE id=d.id;
    RETURN NULL;
  END IF;
  SELECT * INTO s FROM tandem.sessions WHERE id=d.session_id AND identity_id=d.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp();
  IF s.id IS NULL OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m ON m.workspace_id=g.workspace_id AND m.identity_id=g.identity_id
    WHERE g.workspace_id=d.workspace_id AND g.project_id=d.project_id AND g.identity_id=d.actor_id AND g.role='editor') THEN
    UPDATE tandem.project_drafts SET status='failed',error='ORIGINAL_AUTH_REVOKED',updated_at=clock_timestamp() WHERE id=d.id;
    RETURN NULL;
  END IF;
  SELECT * INTO i FROM tandem.identities WHERE id=d.actor_id;
  SELECT * INTO p FROM tandem.project_links WHERE id=d.project_id AND workspace_id=d.workspace_id;
  RETURN jsonb_build_object('draft',tandem.project_draft_json(d.id),'session',jsonb_build_object('id',s.id,'identity',jsonb_build_object(
    'id',i.id,'providerId',i.provider_id,'subject',i.subject,'displayName',i.display_name,'canCreateWorkspace',i.can_create_workspace),
    'encryptedCredential',s.encrypted_credential,'expiresAt',s.expires_at),
    'project',jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'connectionId',p.connection_id,'externalId',p.external_id,'createdBy',p.created_by,'cacheVersion',p.cache_version::text,'createdAt',p.created_at));
END $$;
CREATE FUNCTION tandem.begin_draft_action(queue_id uuid, lease_token bigint, worker uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE d tandem.project_drafts;
BEGIN
  PERFORM 1 FROM tandem.jobs WHERE id=queue_id AND kind='draft.execute' AND execution_token=lease_token AND leased_by=worker AND status='running' AND lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO d FROM tandem.project_drafts WHERE job_id=queue_id FOR UPDATE;
  IF d.id IS NULL OR d.status<>'approved' OR NOT EXISTS(SELECT 1 FROM tandem.sessions WHERE id=d.session_id AND identity_id=d.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp()) OR
    NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m ON m.workspace_id=g.workspace_id AND m.identity_id=g.identity_id WHERE g.workspace_id=d.workspace_id AND g.project_id=d.project_id AND g.identity_id=d.actor_id AND g.role='editor') THEN RETURN false; END IF;
  UPDATE tandem.project_drafts SET status='executing',updated_at=clock_timestamp() WHERE id=d.id;
  RETURN true;
END $$;
CREATE FUNCTION tandem.finish_draft_action(queue_id uuid, lease_token bigint, worker uuid, outcome text, evidence jsonb, error_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE d tandem.project_drafts;
BEGIN
  PERFORM 1 FROM tandem.jobs WHERE id=queue_id AND kind='draft.execute' AND execution_token=lease_token AND leased_by=worker AND status='running' AND lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO d FROM tandem.project_drafts WHERE job_id=queue_id FOR UPDATE;
  IF d.id IS NULL OR outcome NOT IN ('succeeded','failed','unknown') OR d.status NOT IN ('approved','executing') OR (d.status='approved' AND outcome<>'failed') THEN RETURN false; END IF;
  UPDATE tandem.project_drafts SET status=outcome,receipt=CASE WHEN evidence IS NULL THEN NULL ELSE evidence||jsonb_build_object('recordedAt',clock_timestamp()) END,
    error=error_code,updated_at=clock_timestamp() WHERE id=d.id;
  UPDATE tandem.project_links SET cache_version=cache_version+1 WHERE id=d.project_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION tandem.bind_project(text,text),tandem.change_project_grant(uuid,uuid,text),tandem.add_task_message(uuid,text,text),tandem.project_draft_json(uuid),
  tandem.save_project_draft(uuid,uuid,text,jsonb,uuid),tandem.revise_project_draft(uuid,integer,text,jsonb),tandem.review_project_draft(uuid,integer,boolean),
  tandem.draft_worker_context(uuid,bigint,uuid),tandem.begin_draft_action(uuid,bigint,uuid),tandem.finish_draft_action(uuid,bigint,uuid,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.bind_project(text,text),tandem.change_project_grant(uuid,uuid,text),tandem.add_task_message(uuid,text,text),
  tandem.save_project_draft(uuid,uuid,text,jsonb,uuid),tandem.revise_project_draft(uuid,integer,text,jsonb),tandem.review_project_draft(uuid,integer,boolean) TO tandem_app;
GRANT EXECUTE ON FUNCTION tandem.draft_worker_context(uuid,bigint,uuid),tandem.begin_draft_action(uuid,bigint,uuid),tandem.finish_draft_action(uuid,bigint,uuid,text,jsonb,text) TO tandem_worker;
