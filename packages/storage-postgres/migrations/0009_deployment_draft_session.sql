-- A deployment draft freezes its own actor session. A later login by the same
-- actor may propose a new deployment without rewriting the originating run's
-- session history or borrowing the approver's credentials.
CREATE OR REPLACE FUNCTION tandem.deployment_worker_context(queue_id uuid, lease_token bigint, worker uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE d tandem.project_drafts; action jsonb; run tandem.delivery_runs; s tandem.sessions; os tandem.sessions; i tandem.identities; oi tandem.identities;
BEGIN
 SELECT draft.* INTO d FROM tandem.project_drafts draft JOIN tandem.jobs j ON j.id=draft.job_id WHERE j.id=queue_id AND j.kind='draft.execute' AND j.execution_token=lease_token AND j.leased_by=worker AND j.status='running' AND j.lease_until>clock_timestamp();
 IF d.id IS NULL OR d.status NOT IN('approved','executing') THEN RETURN NULL; END IF;
 SELECT v.action INTO action FROM tandem.project_draft_versions v WHERE v.draft_id=d.id AND v.workspace_id=d.workspace_id AND v.version=d.version;
 IF action->>'kind' IS NULL OR action->>'kind' NOT IN('delivery.deploy','delivery.rollback') THEN RETURN NULL; END IF;
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=(action->>'runId')::uuid AND workspace_id=d.workspace_id AND project_id=d.project_id AND actor_id=d.actor_id;
 IF run.id IS NULL OR run.status NOT IN('awaiting_deployment','delivered') OR run.revision IS DISTINCT FROM (action->>'version')::integer OR coalesce((run.artifact->>'passed')::boolean,false)=false THEN RETURN NULL; END IF;
 IF action->>'kind'='delivery.deploy' AND (run.artifact->>'artifactRef' IS DISTINCT FROM action->>'artifactRef' OR run.artifact->>'contentHash' IS DISTINCT FROM action->>'contentHash') THEN RETURN NULL; END IF;
 IF action->>'kind'='delivery.rollback' AND (run.deployment->>'id' IS DISTINCT FROM action->>'deploymentId' OR run.deployment->>'contentHash' IS DISTINCT FROM action->>'contentHash' OR run.deployment->>'previousDeploymentId' IS NULL) THEN RETURN NULL; END IF;
 SELECT * INTO s FROM tandem.sessions WHERE id=d.session_id AND identity_id=run.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp();
 SELECT * INTO os FROM tandem.sessions WHERE identity_id=run.owner_id AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1;
 IF s.id IS NULL OR os.id IS NULL OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.actor_id AND g.role='editor') OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.owner_id) THEN RETURN NULL; END IF;
 SELECT * INTO i FROM tandem.identities WHERE id=run.actor_id; SELECT * INTO oi FROM tandem.identities WHERE id=run.owner_id;
 RETURN jsonb_build_object('run',to_jsonb(run),'profiles',(SELECT profiles FROM tandem.delivery_profiles WHERE workspace_id=run.workspace_id),'project',(SELECT jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'connectionId',p.connection_id,'externalId',p.external_id,'createdBy',p.created_by,'cacheVersion',p.cache_version::text,'createdAt',p.created_at) FROM tandem.project_links p WHERE p.id=run.project_id AND p.workspace_id=run.workspace_id),'documents','[]'::jsonb,
 'session',jsonb_build_object('id',s.id,'encryptedCredential',s.encrypted_credential,'expiresAt',s.expires_at,'identity',jsonb_build_object('id',i.id,'providerId',i.provider_id,'subject',i.subject,'displayName',i.display_name,'canCreateWorkspace',i.can_create_workspace)),
 'ownerSession',jsonb_build_object('id',os.id,'encryptedCredential',os.encrypted_credential,'expiresAt',os.expires_at,'identity',jsonb_build_object('id',oi.id,'providerId',oi.provider_id,'subject',oi.subject,'displayName',oi.display_name,'canCreateWorkspace',oi.can_create_workspace)));
END $$;
REVOKE ALL ON FUNCTION tandem.deployment_worker_context(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.deployment_worker_context(uuid,bigint,uuid) TO tandem_worker;
