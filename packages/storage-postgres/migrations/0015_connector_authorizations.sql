-- External connector credentials belong to the actual authorizing member, never a global fallback.
CREATE TABLE tandem.wm_connector_authorizations (
 workspace_id uuid NOT NULL,connector_id uuid NOT NULL,actor_id uuid NOT NULL,
 configuration_version integer NOT NULL CHECK(configuration_version>0),
 encrypted_values text NOT NULL CHECK(length(encrypted_values) BETWEEN 1 AND 65536),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connector_id,actor_id),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES tandem.wm_connectors(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,actor_id) REFERENCES tandem.workspace_members(workspace_id,identity_id) ON DELETE CASCADE
);
ALTER TABLE tandem.wm_connector_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.wm_connector_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_authorization_internal ON tandem.wm_connector_authorizations TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY connector_authorization_self ON tandem.wm_connector_authorizations TO tandem_app
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IS NOT NULL);
GRANT SELECT,INSERT,UPDATE,DELETE ON tandem.wm_connector_authorizations TO tandem_app;

-- Current members may authorize themselves for an explicitly identified connection.
-- Credentials and other members' authorization state are not part of this metadata.
CREATE FUNCTION tandem.wm_connector_configuration(target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE config tandem.wm_connectors;space uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
 IF tandem.current_member_role(space) IS NULL THEN RAISE EXCEPTION 'Workspace member revoked' USING ERRCODE='42501'; END IF;
 SELECT * INTO config FROM tandem.wm_connectors WHERE id=target AND workspace_id=space;
 IF config.id IS NULL THEN RAISE EXCEPTION 'Connector unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('id',config.id,'version',config.version,'name',config.name,'kind',config.kind,'baseUrl',config.base_url,'databaseHost',config.database_host,'databasePort',config.database_port,'databaseName',config.database_name,'databaseUser',config.database_user,'credentialRef','','enabled',config.enabled);
END $$;
REVOKE ALL ON FUNCTION tandem.wm_connector_configuration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.wm_connector_configuration(uuid) TO tandem_app;
