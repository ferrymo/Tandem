-- Native collaboration assets are distinct from connector-owned external records.
CREATE TABLE tandem.wm_project_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
 parent_id uuid, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120), sort_order integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,parent_id) REFERENCES tandem.wm_project_groups(workspace_id,id), CHECK(parent_id IS DISTINCT FROM id)
);
CREATE TABLE tandem.wm_teams (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),description text NOT NULL DEFAULT '',
 created_by uuid NOT NULL REFERENCES tandem.identities(id), version integer NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(workspace_id,id)
);
CREATE TABLE tandem.wm_team_members (
 workspace_id uuid NOT NULL,team_id uuid NOT NULL,identity_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,team_id,identity_id),FOREIGN KEY(workspace_id,team_id) REFERENCES tandem.wm_teams(workspace_id,id),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES tandem.workspace_members(workspace_id,identity_id) ON DELETE CASCADE
);
CREATE TABLE tandem.wm_projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),group_id uuid,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),description text NOT NULL DEFAULT '',
 stage text NOT NULL CHECK(stage IN ('presales','initiated','executing','launched','maintenance','closed','frozen','cancelled')),
 owner_id uuid NOT NULL REFERENCES tandem.identities(id),created_by uuid NOT NULL REFERENCES tandem.identities(id),
 initiated_on date,launch_on date,acceptance_on date,maintenance_until date,
 planned_days numeric(12,2) CHECK(planned_days>=0),planned_amount numeric(16,2) CHECK(planned_amount>=0),
 repository_url text NOT NULL DEFAULT '',deployment_target text NOT NULL DEFAULT '',deployment_branch text NOT NULL DEFAULT '',deployment_command text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,group_id) REFERENCES tandem.wm_project_groups(workspace_id,id),
 CHECK(launch_on IS NULL OR initiated_on IS NULL OR launch_on>=initiated_on),
 CHECK(acceptance_on IS NULL OR launch_on IS NULL OR acceptance_on>=launch_on),
 CHECK(maintenance_until IS NULL OR acceptance_on IS NULL OR maintenance_until>=acceptance_on)
);
CREATE TABLE tandem.wm_project_members (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,project_id uuid NOT NULL,participant_id uuid NOT NULL,
 role text NOT NULL CHECK(length(btrim(role)) BETWEEN 1 AND 80),can_write boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 FOREIGN KEY(workspace_id,project_id) REFERENCES tandem.wm_projects(workspace_id,id),UNIQUE(workspace_id,project_id,participant_id,role),UNIQUE(workspace_id,id)
);
CREATE TABLE tandem.wm_modules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,project_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),description text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1 CHECK(version>0),
 FOREIGN KEY(workspace_id,project_id) REFERENCES tandem.wm_projects(workspace_id,id),UNIQUE(workspace_id,id),UNIQUE(workspace_id,project_id,id)
);
CREATE TABLE tandem.wm_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),body text NOT NULL DEFAULT '' CHECK(length(body)<=500000),
 scope text NOT NULL CHECK(scope IN ('project','team','personal')),project_id uuid,team_id uuid,
 visibility text NOT NULL CHECK(visibility IN ('space','private')),owner_id uuid NOT NULL REFERENCES tandem.identities(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,project_id) REFERENCES tandem.wm_projects(workspace_id,id),
 FOREIGN KEY(workspace_id,team_id) REFERENCES tandem.wm_teams(workspace_id,id),UNIQUE(workspace_id,id),
 CHECK((scope='project' AND project_id IS NOT NULL AND team_id IS NULL) OR (scope='team' AND team_id IS NOT NULL AND project_id IS NULL) OR (scope='personal' AND project_id IS NULL AND team_id IS NULL AND visibility='private'))
);
CREATE TABLE tandem.wm_document_versions (
 workspace_id uuid NOT NULL,document_id uuid NOT NULL,version integer NOT NULL,title text NOT NULL,body text NOT NULL,
 actor_id uuid NOT NULL REFERENCES tandem.identities(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,document_id,version),FOREIGN KEY(workspace_id,document_id) REFERENCES tandem.wm_documents(workspace_id,id)
);
CREATE TABLE tandem.wm_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,project_id uuid NOT NULL,module_id uuid,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),description text NOT NULL DEFAULT '',assignee_id uuid,
 planned_start date,planned_end date,planned_hours numeric(12,2) CHECK(planned_hours>=0),actual_start date,actual_end date,
 actual_hours numeric(12,2) NOT NULL DEFAULT 0 CHECK(actual_hours>=0),status text NOT NULL CHECK(status IN ('not_started','in_progress','completed','closed','paused','cancelled')),
 cancellation_reason text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,id),UNIQUE(workspace_id,project_id,id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES tandem.wm_projects(workspace_id,id),
 FOREIGN KEY(workspace_id,project_id,module_id) REFERENCES tandem.wm_modules(workspace_id,project_id,id),
 CHECK(status<>'cancelled' OR length(btrim(cancellation_reason))>0),CHECK(planned_start IS NULL OR planned_end IS NULL OR planned_end>=planned_start),CHECK(actual_start IS NULL OR actual_end IS NULL OR actual_end>=actual_start)
);
CREATE TABLE tandem.wm_task_collaborators (
 workspace_id uuid NOT NULL,task_id uuid NOT NULL,participant_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,task_id,participant_id),FOREIGN KEY(workspace_id,task_id) REFERENCES tandem.wm_tasks(workspace_id,id)
);
CREATE TABLE tandem.wm_task_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,task_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES tandem.identities(id),
 kind text NOT NULL CHECK(kind IN ('created','updated','comment','effort')),body text NOT NULL DEFAULT '',changes jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,task_id) REFERENCES tandem.wm_tasks(workspace_id,id)
);
CREATE TABLE tandem.wm_effort_batches (
 workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),actor_id uuid NOT NULL REFERENCES tandem.identities(id),request_id uuid NOT NULL,
 content_hash text NOT NULL,PRIMARY KEY(workspace_id,actor_id,request_id)
);
CREATE TABLE tandem.wm_efforts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,project_id uuid NOT NULL,task_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES tandem.identities(id),date date NOT NULL,hours numeric(5,2) NOT NULL CHECK(hours>0 AND hours<=24),note text NOT NULL DEFAULT '',
 request_id uuid NOT NULL,line_number integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,project_id,task_id) REFERENCES tandem.wm_tasks(workspace_id,project_id,id),UNIQUE(workspace_id,actor_id,request_id,line_number)
);
CREATE TABLE tandem.wm_sandboxes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),name text NOT NULL,image text NOT NULL,
 workdir text NOT NULL DEFAULT '/workspace',network_policy text NOT NULL CHECK(network_policy IN ('none','restricted')),
 cpu numeric(5,2) NOT NULL CHECK(cpu>0 AND cpu<=64),memory_mb integer NOT NULL CHECK(memory_mb BETWEEN 128 AND 131072),enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,UNIQUE(workspace_id,id)
);
CREATE TABLE tandem.wm_model_channels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),name text NOT NULL,base_url text NOT NULL,
 protocol text NOT NULL CHECK(protocol IN ('openai','anthropic','ollama')),models text[] NOT NULL DEFAULT '{}',credential_ref text NOT NULL DEFAULT '',enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,UNIQUE(workspace_id,id)
);
CREATE TABLE tandem.wm_agents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),name text NOT NULL,description text NOT NULL DEFAULT '',avatar text NOT NULL DEFAULT '',
 team_id uuid,model_channel_id uuid,model text NOT NULL DEFAULT '',protocol text NOT NULL CHECK(protocol IN ('openai','anthropic','ollama')),sandbox_id uuid,
 skill_ids uuid[] NOT NULL DEFAULT '{}',mcp_server_ids uuid[] NOT NULL DEFAULT '{}',enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,team_id) REFERENCES tandem.wm_teams(workspace_id,id),
 FOREIGN KEY(workspace_id,model_channel_id) REFERENCES tandem.wm_model_channels(workspace_id,id),
 FOREIGN KEY(workspace_id,sandbox_id) REFERENCES tandem.wm_sandboxes(workspace_id,id)
);
CREATE TABLE tandem.wm_roles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),name text NOT NULL,description text NOT NULL DEFAULT '',permissions text[] NOT NULL DEFAULT '{}',enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,UNIQUE(workspace_id,id)
);
CREATE TABLE tandem.wm_menus (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),key text NOT NULL,label text NOT NULL,visible boolean NOT NULL DEFAULT true,sort_order integer NOT NULL DEFAULT 0,version integer NOT NULL DEFAULT 1,UNIQUE(workspace_id,key),UNIQUE(workspace_id,id)
);
CREATE TABLE tandem.wm_plugins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),name text NOT NULL,description text NOT NULL DEFAULT '',source text NOT NULL,pinned_version text NOT NULL,enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,UNIQUE(workspace_id,id)
);
CREATE TABLE tandem.wm_connectors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),name text NOT NULL,kind text NOT NULL CHECK(kind='zentao'),base_url text NOT NULL,
 database_host text NOT NULL DEFAULT '',database_port integer NOT NULL DEFAULT 3306 CHECK(database_port BETWEEN 1 AND 65535),database_name text NOT NULL DEFAULT '',database_user text NOT NULL DEFAULT '',
 credential_ref text NOT NULL DEFAULT '',enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,UNIQUE(workspace_id,id)
);
CREATE TABLE tandem.wm_attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),project_id uuid,task_id uuid,document_id uuid,
 owner_id uuid NOT NULL REFERENCES tandem.identities(id),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 250),mime text NOT NULL,size bigint NOT NULL CHECK(size BETWEEN 1 AND 20971520),
 storage_key uuid NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,project_id) REFERENCES tandem.wm_projects(workspace_id,id),
 FOREIGN KEY(workspace_id,project_id,task_id) REFERENCES tandem.wm_tasks(workspace_id,project_id,id),
 FOREIGN KEY(workspace_id,document_id) REFERENCES tandem.wm_documents(workspace_id,id),CHECK((task_id IS NOT NULL)::integer+(document_id IS NOT NULL)::integer=1)
);
CREATE INDEX wm_tasks_project ON tandem.wm_tasks(workspace_id,project_id);
CREATE INDEX wm_efforts_date ON tandem.wm_efforts(workspace_id,date,actor_id);
CREATE INDEX wm_task_events_order ON tandem.wm_task_events(workspace_id,task_id,created_at);

CREATE FUNCTION tandem.wm_lock_scope() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid; member_role text;
BEGIN
 PERFORM 1 FROM tandem.workspaces WHERE id=ws FOR SHARE;
 member_role:=tandem.current_member_role(ws);
 IF member_role IS NULL THEN RAISE EXCEPTION 'Workspace member revoked' USING ERRCODE='42501'; END IF;
 RETURN member_role;
END $$;
REVOKE ALL ON FUNCTION tandem.wm_lock_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.wm_lock_scope() TO tandem_app;

CREATE FUNCTION tandem.wm_project_access(target uuid,writing boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
 SELECT EXISTS(SELECT 1 FROM tandem.wm_projects p WHERE p.id=target AND p.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND tandem.current_member_role(p.workspace_id) IS NOT NULL AND (
 tandem.current_member_role(p.workspace_id) IN ('owner','admin') OR p.created_by=nullif(current_setting('app.actor_id',true),'')::uuid OR p.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid
 OR EXISTS(SELECT 1 FROM tandem.wm_project_members m WHERE m.project_id=p.id AND m.workspace_id=p.workspace_id AND m.participant_id=nullif(current_setting('app.actor_id',true),'')::uuid AND (NOT writing OR m.can_write))))
$$;
CREATE FUNCTION tandem.wm_team_access(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
 SELECT EXISTS(SELECT 1 FROM tandem.wm_teams t WHERE t.id=target AND t.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND tandem.current_member_role(t.workspace_id) IS NOT NULL AND (tandem.current_member_role(t.workspace_id) IN ('owner','admin') OR t.created_by=nullif(current_setting('app.actor_id',true),'')::uuid
 OR EXISTS(SELECT 1 FROM tandem.wm_team_members m WHERE m.team_id=t.id AND m.workspace_id=t.workspace_id AND m.identity_id=nullif(current_setting('app.actor_id',true),'')::uuid)))
$$;
CREATE FUNCTION tandem.wm_document_access(target uuid,writing boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
 SELECT EXISTS(SELECT 1 FROM tandem.wm_documents d WHERE d.id=target AND d.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND tandem.current_member_role(d.workspace_id) IS NOT NULL
 AND (d.visibility='space' OR d.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid)
 AND ((d.scope='personal' AND d.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid)
 OR (d.scope='project' AND tandem.wm_project_access(d.project_id,writing)) OR(d.scope='team' AND tandem.wm_team_access(d.team_id))))
$$;
REVOKE ALL ON FUNCTION tandem.wm_project_access(uuid,boolean),tandem.wm_team_access(uuid),tandem.wm_document_access(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.wm_project_access(uuid,boolean),tandem.wm_team_access(uuid),tandem.wm_document_access(uuid,boolean) TO tandem_app;
DO $$
DECLARE target text;
BEGIN
 FOREACH target IN ARRAY ARRAY['wm_project_groups','wm_teams','wm_team_members','wm_projects','wm_project_members','wm_modules','wm_documents','wm_document_versions','wm_tasks','wm_task_collaborators','wm_task_events','wm_effort_batches','wm_efforts','wm_sandboxes','wm_model_channels','wm_agents','wm_roles','wm_menus','wm_plugins','wm_connectors','wm_attachments'] LOOP
 EXECUTE format('ALTER TABLE tandem.%I ENABLE ROW LEVEL SECURITY',target);
 EXECUTE format('ALTER TABLE tandem.%I FORCE ROW LEVEL SECURITY',target);
 EXECUTE format('CREATE POLICY internal ON tandem.%I TO tandem_migrator USING(true) WITH CHECK(true)',target);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON tandem.%I TO tandem_app',target);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['wm_project_groups','wm_sandboxes','wm_agents','wm_roles','wm_menus','wm_plugins'] LOOP
 EXECUTE format('CREATE POLICY read_scope ON tandem.%I FOR SELECT TO tandem_app USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL)',target);
 EXECUTE format('CREATE POLICY write_scope ON tandem.%I FOR ALL TO tandem_app USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin'')) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin''))',target);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['wm_model_channels','wm_connectors'] LOOP
 EXECUTE format('CREATE POLICY admin_scope ON tandem.%I TO tandem_app USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin'')) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.current_member_role(workspace_id) IN (''owner'',''admin''))',target);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['wm_modules','wm_tasks','wm_efforts'] LOOP
 EXECUTE format('CREATE POLICY project_read ON tandem.%I FOR SELECT TO tandem_app USING(tandem.wm_project_access(project_id))',target);
 EXECUTE format('CREATE POLICY project_write ON tandem.%I FOR ALL TO tandem_app USING(tandem.wm_project_access(project_id,true)) WITH CHECK(tandem.wm_project_access(project_id,true))',target);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['wm_task_collaborators','wm_task_events'] LOOP
 EXECUTE format('CREATE POLICY task_read ON tandem.%I FOR SELECT TO tandem_app USING(EXISTS(SELECT 1 FROM tandem.wm_tasks t WHERE t.id=%I.task_id AND t.workspace_id=%I.workspace_id))',target,target,target);
 EXECUTE format('CREATE POLICY task_write ON tandem.%I FOR ALL TO tandem_app USING(EXISTS(SELECT 1 FROM tandem.wm_tasks t WHERE t.id=task_id AND tandem.wm_project_access(t.project_id,true))) WITH CHECK(EXISTS(SELECT 1 FROM tandem.wm_tasks t WHERE t.id=task_id AND tandem.wm_project_access(t.project_id,true)))',target);
 END LOOP;
END $$;
CREATE POLICY project_read ON tandem.wm_projects FOR SELECT TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL AND (created_by=nullif(current_setting('app.actor_id',true),'')::uuid OR owner_id=nullif(current_setting('app.actor_id',true),'')::uuid OR tandem.wm_project_access(id)));
CREATE POLICY project_insert ON tandem.wm_projects FOR INSERT TO tandem_app WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL AND created_by=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY project_update ON tandem.wm_projects FOR UPDATE TO tandem_app USING(tandem.wm_project_access(id,true)) WITH CHECK(tandem.wm_project_access(id,true));
CREATE POLICY member_read ON tandem.wm_project_members FOR SELECT TO tandem_app USING(tandem.wm_project_access(project_id));
CREATE POLICY member_write ON tandem.wm_project_members FOR ALL TO tandem_app USING(tandem.wm_project_access(project_id,true)) WITH CHECK(tandem.wm_project_access(project_id,true));
CREATE POLICY team_read ON tandem.wm_teams FOR SELECT TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL AND (created_by=nullif(current_setting('app.actor_id',true),'')::uuid OR tandem.wm_team_access(id)));
CREATE POLICY team_write ON tandem.wm_teams FOR ALL TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IN ('owner','admin')) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IN ('owner','admin'));
CREATE POLICY team_member_scope ON tandem.wm_team_members TO tandem_app USING(tandem.wm_team_access(team_id)) WITH CHECK(tandem.wm_team_access(team_id) AND tandem.current_member_role(workspace_id) IN ('owner','admin'));
CREATE POLICY document_read ON tandem.wm_documents FOR SELECT TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL AND (visibility='space' OR owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) AND ((scope='personal' AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid) OR(scope='project' AND tandem.wm_project_access(project_id)) OR(scope='team' AND tandem.wm_team_access(team_id))));
CREATE POLICY document_update ON tandem.wm_documents FOR UPDATE TO tandem_app USING(tandem.wm_document_access(id,true)) WITH CHECK(tandem.wm_document_access(id,true));
CREATE POLICY document_insert ON tandem.wm_documents FOR INSERT TO tandem_app WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL AND ((scope='personal' AND visibility='private') OR(scope='project' AND tandem.wm_project_access(project_id,true)) OR(scope='team' AND tandem.wm_team_access(team_id))));
CREATE POLICY document_version_read ON tandem.wm_document_versions FOR SELECT TO tandem_app USING(tandem.wm_document_access(document_id));
CREATE POLICY document_version_insert ON tandem.wm_document_versions FOR INSERT TO tandem_app WITH CHECK(tandem.wm_document_access(document_id,true) AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY batch_scope ON tandem.wm_effort_batches TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL);
CREATE POLICY attachment_read ON tandem.wm_attachments FOR SELECT TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND ((task_id IS NOT NULL AND tandem.wm_project_access(project_id)) OR (document_id IS NOT NULL AND tandem.wm_document_access(document_id))));
CREATE POLICY attachment_write ON tandem.wm_attachments FOR ALL TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND ((task_id IS NOT NULL AND tandem.wm_project_access(project_id,true)) OR(document_id IS NOT NULL AND tandem.wm_document_access(document_id,true)))) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND ((task_id IS NOT NULL AND tandem.wm_project_access(project_id,true)) OR(document_id IS NOT NULL AND tandem.wm_document_access(document_id,true))));
-- Lifecycle and effort evidence is append-only for the runtime account.
REVOKE UPDATE,DELETE ON tandem.wm_task_events,tandem.wm_efforts,tandem.wm_effort_batches,tandem.wm_document_versions FROM tandem_app;
