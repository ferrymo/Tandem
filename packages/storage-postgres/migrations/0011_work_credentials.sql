-- Credential material is encrypted with the application session encryption key.
-- Polymorphic metadata references are constrained to exactly one actual resource.
CREATE TABLE tandem.wm_credentials (
 workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
 kind text NOT NULL CHECK(kind IN ('model-channel','connector')),
 resource_id uuid NOT NULL,model_channel_id uuid,connector_id uuid,
 encrypted_values text NOT NULL CHECK(length(encrypted_values) BETWEEN 1 AND 65536),
 fields text[] NOT NULL,updated_by uuid NOT NULL REFERENCES tandem.identities(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,kind,resource_id),
 FOREIGN KEY(workspace_id,model_channel_id) REFERENCES tandem.wm_model_channels(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,connector_id) REFERENCES tandem.wm_connectors(workspace_id,id) ON DELETE CASCADE,
 CHECK((kind='model-channel' AND model_channel_id IS NOT NULL AND model_channel_id=resource_id AND connector_id IS NULL)
 OR(kind='connector' AND connector_id IS NOT NULL AND connector_id=resource_id AND model_channel_id IS NULL)),
 CHECK(cardinality(fields)>0),
 CHECK((kind='model-channel' AND fields <@ ARRAY['apiKey']::text[]) OR(kind='connector' AND fields <@ ARRAY['account','apiPassword','databasePassword']::text[]))
);
ALTER TABLE tandem.wm_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.wm_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_internal ON tandem.wm_credentials TO tandem_migrator USING(true) WITH CHECK(true);
CREATE POLICY credential_admin ON tandem.wm_credentials TO tandem_app
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IN ('owner','admin'))
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND tandem.current_member_role(workspace_id) IN ('owner','admin') AND updated_by=nullif(current_setting('app.actor_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON tandem.wm_credentials TO tandem_app;
