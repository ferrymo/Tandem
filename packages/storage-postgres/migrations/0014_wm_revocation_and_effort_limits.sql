-- Project authorship is audit metadata, not an irrevocable project grant.
CREATE OR REPLACE FUNCTION tandem.wm_project_access(target uuid,writing boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
 SELECT EXISTS(SELECT 1 FROM tandem.wm_projects p WHERE p.id=target AND p.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND tandem.current_member_role(p.workspace_id) IS NOT NULL AND (
 tandem.current_member_role(p.workspace_id) IN ('owner','admin') OR p.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid
 OR EXISTS(SELECT 1 FROM tandem.wm_project_members m WHERE m.project_id=p.id AND m.workspace_id=p.workspace_id AND m.participant_id=nullif(current_setting('app.actor_id',true),'')::uuid AND (NOT writing OR m.can_write))))
$$;
ALTER POLICY project_read ON tandem.wm_projects USING(tandem.wm_project_access(id));
DROP POLICY member_creator_insert ON tandem.wm_project_members;

-- The application inserts without RETURNING, then bootstraps exactly its new row.
-- xmin and created_at prevent using this function to restore an old revoked grant.
CREATE FUNCTION tandem.wm_bootstrap_project_member(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;project tandem.wm_projects;
BEGIN
 IF NOT tandem.wm_has_permission('project.create') THEN RAISE EXCEPTION 'Project creation forbidden' USING ERRCODE='42501'; END IF;
 SELECT p.* INTO project FROM tandem.wm_projects p WHERE p.id=target AND p.workspace_id=ws AND p.created_by=actor
 AND p.created_at=transaction_timestamp() AND p.xmin=pg_current_xact_id()::xid;
 IF project.id IS NULL OR EXISTS(SELECT 1 FROM tandem.wm_project_members WHERE workspace_id=ws AND project_id=target)
 OR NOT EXISTS(SELECT 1 FROM tandem.workspace_members WHERE workspace_id=ws AND identity_id=project.owner_id)
 THEN RAISE EXCEPTION 'New project bootstrap forbidden' USING ERRCODE='42501'; END IF;
 INSERT INTO tandem.wm_project_members(workspace_id,project_id,participant_id,role,can_write)
 VALUES(ws,target,actor,'项目经理',true);
END $$;

-- Only the authenticated actor's aggregate is exposed; revoked project details stay hidden.
CREATE FUNCTION tandem.wm_actor_daily_hours(work_date date) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ws uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;total numeric;
BEGIN
 IF work_date IS NULL OR NOT tandem.wm_has_permission('project.manage') THEN RAISE EXCEPTION 'Effort total forbidden' USING ERRCODE='42501'; END IF;
 SELECT coalesce(sum(hours),0) INTO total FROM tandem.wm_efforts WHERE workspace_id=ws AND actor_id=actor AND date=work_date;
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION tandem.wm_bootstrap_project_member(uuid),tandem.wm_actor_daily_hours(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.wm_bootstrap_project_member(uuid),tandem.wm_actor_daily_hours(date) TO tandem_app;
