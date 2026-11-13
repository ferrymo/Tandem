CREATE FUNCTION tandem.delivery_deployment_write_allowed(queue_id uuid, lease_token bigint, worker uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ctx jsonb; run tandem.delivery_runs;
BEGIN
 ctx:=tandem.deployment_worker_context(queue_id,lease_token,worker);
 IF ctx IS NULL THEN RETURN false; END IF;
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=(ctx->'run'->>'id')::uuid;
 RETURN EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.actor_id AND g.role='editor')
 AND EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.owner_id AND g.role='editor');
END $$;
REVOKE ALL ON FUNCTION tandem.delivery_deployment_write_allowed(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.delivery_deployment_write_allowed(uuid,bigint,uuid) TO tandem_worker;
