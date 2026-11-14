-- Public model catalogs omit endpoints and credentials; invocation is fenced to a run.
CREATE FUNCTION tandem.wm_available_model_channels()
RETURNS TABLE(id uuid,version integer,name text,protocol text,models text[],enabled boolean,configured boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
 SELECT c.id,c.version,c.name,c.protocol,c.models,c.enabled,
 (c.protocol='ollama' OR EXISTS(SELECT 1 FROM tandem.wm_credentials s WHERE s.workspace_id=c.workspace_id AND s.model_channel_id=c.id AND 'apiKey'=ANY(s.fields)))
 FROM tandem.wm_model_channels c WHERE c.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND tandem.current_member_role(c.workspace_id) IS NOT NULL ORDER BY c.name,c.id
$$;
CREATE FUNCTION tandem.validate_delivery_channel_profile(reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE parts text[]; space uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
 IF reference NOT LIKE 'channel:%' THEN RETURN; END IF;
 IF tandem.current_member_role(space) NOT IN ('owner','admin') THEN RAISE EXCEPTION 'Model configuration forbidden' USING ERRCODE='42501'; END IF;
 parts:=regexp_match(reference,'^channel:([a-fA-F0-9-]{36}):([1-9][0-9]{0,9}):(.{1,200})$');
 IF parts IS NULL OR NOT EXISTS(SELECT 1 FROM tandem.wm_model_channels c WHERE c.workspace_id=space AND c.id=parts[1]::uuid AND c.version=parts[2]::integer AND c.enabled AND parts[3]=ANY(c.models)
 AND(c.protocol='ollama' OR EXISTS(SELECT 1 FROM tandem.wm_credentials s WHERE s.workspace_id=space AND s.model_channel_id=c.id AND 'apiKey'=ANY(s.fields))))
 THEN RAISE EXCEPTION 'Model channel unavailable' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION tandem.delivery_model_channel(target_job uuid,lease_token bigint,worker uuid,reference text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE context jsonb; profiles jsonb; parts text[]; channel tandem.wm_model_channels; secret text; space uuid;
BEGIN
 context:=tandem.delivery_worker_context(target_job,lease_token,worker);
 IF context IS NULL OR context->'run'->>'status' IN ('paused','cancelled','delivered') THEN RAISE EXCEPTION 'Model lease forbidden' USING ERRCODE='42501'; END IF;
 space:=(context->'run'->>'workspace_id')::uuid;
 SELECT content::jsonb INTO profiles FROM tandem.delivery_documents WHERE run_id=(context->'run'->>'id')::uuid AND kind='profiles' ORDER BY version DESC LIMIT 1;
 profiles:=coalesce(profiles,context->'profiles');
 IF profiles IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_each(profiles) item WHERE item.value->>'model'=reference) THEN RAISE EXCEPTION 'Model is outside pinned profiles' USING ERRCODE='42501'; END IF;
 parts:=regexp_match(reference,'^channel:([a-fA-F0-9-]{36}):([1-9][0-9]{0,9}):(.{1,200})$');
 IF parts IS NULL THEN RAISE EXCEPTION 'Invalid model reference' USING ERRCODE='22023'; END IF;
 SELECT * INTO channel FROM tandem.wm_model_channels WHERE workspace_id=space AND id=parts[1]::uuid AND version=parts[2]::integer AND enabled AND parts[3]=ANY(models);
 IF channel.id IS NULL THEN RAISE EXCEPTION 'Model channel changed or disabled' USING ERRCODE='22023'; END IF;
 SELECT encrypted_values INTO secret FROM tandem.wm_credentials WHERE workspace_id=space AND model_channel_id=channel.id AND 'apiKey'=ANY(fields);
 IF channel.protocol<>'ollama' AND secret IS NULL THEN RAISE EXCEPTION 'Model credential missing' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('workspaceId',space,'model',parts[3],'encryptedValues',secret,'channel',jsonb_build_object('id',channel.id,'version',channel.version,'name',channel.name,'baseUrl',channel.base_url,'protocol',channel.protocol,'models',channel.models,'credentialRef','','enabled',channel.enabled));
END $$;
REVOKE ALL ON FUNCTION tandem.wm_available_model_channels(),tandem.validate_delivery_channel_profile(text),tandem.delivery_model_channel(uuid,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.wm_available_model_channels(),tandem.validate_delivery_channel_profile(text) TO tandem_app;
GRANT EXECUTE ON FUNCTION tandem.delivery_model_channel(uuid,bigint,uuid,text) TO tandem_worker;
