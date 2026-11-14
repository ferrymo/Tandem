CREATE TABLE tandem.wm_role_assignments (
 workspace_id uuid NOT NULL,role_id uuid NOT NULL,identity_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,role_id,identity_id),
 FOREIGN KEY(workspace_id,role_id) REFERENCES tandem.wm_roles(workspace_id,id),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES tandem.workspace_members(workspace_id,identity_id) ON DELETE CASCADE
);
ALTER TABLE tandem.wm_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.wm_role_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_internal ON tandem.wm_role_assignments TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY assignment_read ON tandem.wm_role_assignments FOR SELECT TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL);
CREATE POLICY assignment_admin ON tandem.wm_role_assignments TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IN ('owner','admin')) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IN ('owner','admin'));
GRANT SELECT,INSERT,DELETE ON tandem.wm_role_assignments TO tandem_app;

-- Assignments never alter workspace roles. Resource ACLs remain an independent gate.
CREATE FUNCTION tandem.wm_permissions() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;member_role text;result text[];
BEGIN
 member_role:=tandem.current_member_role(ws);
 IF member_role IS NULL THEN RETURN ARRAY[]::text[]; END IF;
 IF member_role IN ('owner','admin') THEN RETURN ARRAY['project.create','project.manage','document.manage','team.manage','agent.manage','config.manage']; END IF;
 IF NOT EXISTS(SELECT 1 FROM tandem.wm_role_assignments WHERE workspace_id=ws AND identity_id=actor) THEN
  RETURN ARRAY['project.create','project.manage','document.manage'];
 END IF;
 SELECT coalesce(array_agg(DISTINCT permission),'{}'::text[]) INTO result FROM tandem.wm_role_assignments a
 JOIN tandem.wm_roles r ON r.id=a.role_id AND r.workspace_id=a.workspace_id CROSS JOIN LATERAL unnest(r.permissions) AS permission
 WHERE a.workspace_id=ws AND a.identity_id=actor AND r.enabled;
 RETURN result;
END $$;
CREATE FUNCTION tandem.wm_has_permission(permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$ SELECT permission=ANY(tandem.wm_permissions()) $$;
CREATE FUNCTION tandem.wm_lock_scope_exclusive() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;member_role text;
BEGIN
 PERFORM 1 FROM tandem.workspaces WHERE id=ws FOR UPDATE;
 member_role:=tandem.current_member_role(ws);
 IF member_role IS NULL THEN RAISE EXCEPTION 'Workspace member revoked' USING ERRCODE='42501'; END IF;
 RETURN member_role;
END $$;
REVOKE ALL ON FUNCTION tandem.wm_permissions(),tandem.wm_has_permission(text),tandem.wm_lock_scope_exclusive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.wm_permissions(),tandem.wm_has_permission(text),tandem.wm_lock_scope_exclusive() TO tandem_app;

ALTER POLICY project_insert ON tandem.wm_projects WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL AND created_by=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.wm_has_permission('project.create'));
ALTER POLICY project_update ON tandem.wm_projects USING(tandem.wm_project_access(id,true) AND tandem.wm_has_permission('project.manage')) WITH CHECK(tandem.wm_project_access(id,true) AND tandem.wm_has_permission('project.manage'));
ALTER POLICY member_write ON tandem.wm_project_members USING(tandem.wm_project_access(project_id,true) AND tandem.wm_has_permission('project.manage')) WITH CHECK(tandem.wm_project_access(project_id,true) AND tandem.wm_has_permission('project.manage'));
CREATE POLICY member_creator_insert ON tandem.wm_project_members FOR INSERT TO tandem_app WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND participant_id=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.wm_has_permission('project.create') AND EXISTS(SELECT 1 FROM tandem.wm_projects p WHERE p.id=project_id AND p.workspace_id=wm_project_members.workspace_id AND p.created_by=nullif(current_setting('app.actor_id',true),'')::uuid));
ALTER POLICY team_write ON tandem.wm_teams USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('team.manage') AND (tandem.current_member_role(workspace_id) IN ('owner','admin') OR created_by=nullif(current_setting('app.actor_id',true),'')::uuid)) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('team.manage') AND (tandem.current_member_role(workspace_id) IN ('owner','admin') OR created_by=nullif(current_setting('app.actor_id',true),'')::uuid));
ALTER POLICY team_member_scope ON tandem.wm_team_members USING(tandem.wm_team_access(team_id)) WITH CHECK(tandem.wm_has_permission('team.manage') AND EXISTS(SELECT 1 FROM tandem.wm_teams t WHERE t.id=team_id AND t.workspace_id=wm_team_members.workspace_id AND(tandem.current_member_role(t.workspace_id) IN ('owner','admin') OR t.created_by=nullif(current_setting('app.actor_id',true),'')::uuid)));
-- Restrictive policies add capability checks without weakening existing ACL policies.
CREATE POLICY team_member_update ON tandem.wm_team_members AS RESTRICTIVE FOR DELETE TO tandem_app USING(tandem.wm_has_permission('team.manage') AND EXISTS(SELECT 1 FROM tandem.wm_teams t WHERE t.id=team_id AND t.workspace_id=wm_team_members.workspace_id AND(tandem.current_member_role(t.workspace_id) IN ('owner','admin') OR t.created_by=nullif(current_setting('app.actor_id',true),'')::uuid)));
ALTER POLICY document_update ON tandem.wm_documents USING(tandem.wm_document_access(id,true) AND tandem.wm_has_permission('document.manage')) WITH CHECK(tandem.wm_document_access(id,true) AND tandem.wm_has_permission('document.manage'));
-- A document keeps its original owner/scope; a different space requires a new copy.
REVOKE UPDATE ON tandem.wm_documents FROM tandem_app;
GRANT UPDATE(title,body,visibility,version,updated_at) ON tandem.wm_documents TO tandem_app;
ALTER POLICY document_insert ON tandem.wm_documents WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.wm_has_permission('document.manage') AND ((scope='personal' AND visibility='private') OR(scope='project' AND tandem.wm_project_access(project_id,true)) OR(scope='team' AND tandem.wm_team_access(team_id))));
ALTER POLICY document_version_insert ON tandem.wm_document_versions WITH CHECK(tandem.wm_document_access(document_id,true) AND tandem.wm_has_permission('document.manage') AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
ALTER POLICY attachment_write ON tandem.wm_attachments USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND ((task_id IS NOT NULL AND tandem.wm_project_access(project_id,true) AND tandem.wm_has_permission('project.manage')) OR(document_id IS NOT NULL AND tandem.wm_document_access(document_id,true) AND tandem.wm_has_permission('document.manage')))) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND owner_id=nullif(current_setting('app.actor_id',true),'')::uuid AND ((task_id IS NOT NULL AND tandem.wm_project_access(project_id,true) AND tandem.wm_has_permission('project.manage')) OR(document_id IS NOT NULL AND tandem.wm_document_access(document_id,true) AND tandem.wm_has_permission('document.manage'))));
DO $$
DECLARE target text;
BEGIN
 FOREACH target IN ARRAY ARRAY['wm_modules','wm_tasks','wm_efforts'] LOOP
 EXECUTE format('ALTER POLICY project_write ON tandem.%I USING(tandem.wm_project_access(project_id,true) AND tandem.wm_has_permission(''project.manage'')) WITH CHECK(tandem.wm_project_access(project_id,true) AND tandem.wm_has_permission(''project.manage''))',target);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['wm_task_collaborators','wm_task_events'] LOOP
 EXECUTE format('ALTER POLICY task_write ON tandem.%I USING(tandem.wm_has_permission(''project.manage'') AND EXISTS(SELECT 1 FROM tandem.wm_tasks t WHERE t.id=task_id AND tandem.wm_project_access(t.project_id,true))) WITH CHECK(tandem.wm_has_permission(''project.manage'') AND EXISTS(SELECT 1 FROM tandem.wm_tasks t WHERE t.id=task_id AND tandem.wm_project_access(t.project_id,true)))',target);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['wm_sandboxes','wm_plugins'] LOOP
 EXECUTE format('ALTER POLICY write_scope ON tandem.%I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.wm_has_permission(''config.manage'')) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND tandem.wm_has_permission(''config.manage''))',target);
 END LOOP;
END $$;
ALTER POLICY write_scope ON tandem.wm_agents USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('agent.manage')) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('agent.manage'));
ALTER POLICY admin_scope ON tandem.wm_model_channels USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('config.manage')) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('config.manage'));
CREATE POLICY model_agent_read ON tandem.wm_model_channels FOR SELECT TO tandem_app USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('agent.manage'));
ALTER POLICY admin_scope ON tandem.wm_connectors USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('config.manage')) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.wm_has_permission('config.manage'));
