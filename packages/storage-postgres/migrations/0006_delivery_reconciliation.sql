-- Recover a local-demo result by inspecting its immutable publication receipt; never resend an unknown action.
CREATE FUNCTION tandem.delivery_reconciliation_context(target_run uuid, target_draft uuid, auth_session uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE run tandem.delivery_runs; d tandem.project_drafts; action jsonb; s tandem.sessions; os tandem.sessions; i tandem.identities; oi tandem.identities;
BEGIN
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=target_run AND workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid;
 IF run.id IS NULL OR NOT tandem.can_access_project(run.project_id,true) THEN RAISE EXCEPTION 'Original actor/project forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM tandem.project_drafts WHERE id=target_draft AND workspace_id=run.workspace_id AND project_id=run.project_id AND actor_id=run.actor_id;
 IF d.id IS NULL OR d.status<>'unknown' OR EXISTS(SELECT 1 FROM tandem.jobs WHERE id=d.job_id AND status='running' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'Draft is not an inactive unknown action' USING ERRCODE='23505'; END IF;
 SELECT v.action INTO action FROM tandem.project_draft_versions v WHERE v.workspace_id=d.workspace_id AND v.draft_id=d.id AND v.version=d.version;
 IF action->>'kind' NOT IN('delivery.deploy','delivery.rollback') OR action->>'runId' IS DISTINCT FROM run.id::text OR (action->>'version')::integer IS DISTINCT FROM run.revision THEN RAISE EXCEPTION 'Deployment version mismatch' USING ERRCODE='23505'; END IF;
 IF action->>'kind'='delivery.deploy' AND (action->>'artifactRef' IS DISTINCT FROM run.artifact->>'artifactRef' OR action->>'contentHash' IS DISTINCT FROM run.artifact->>'contentHash') THEN RAISE EXCEPTION 'Deployment digest mismatch' USING ERRCODE='23505'; END IF;
 SELECT * INTO s FROM tandem.sessions WHERE id=auth_session AND identity_id=run.actor_id AND revoked_at IS NULL AND expires_at>clock_timestamp();
 SELECT * INTO os FROM tandem.sessions WHERE identity_id=run.owner_id AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1;
 IF s.id IS NULL OR os.id IS NULL OR NOT EXISTS(SELECT 1 FROM tandem.project_grants g JOIN tandem.workspace_members m USING(workspace_id,identity_id) WHERE g.workspace_id=run.workspace_id AND g.project_id=run.project_id AND g.identity_id=run.owner_id) THEN RAISE EXCEPTION 'Actor or owner authorization unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM tandem.identities WHERE id=run.actor_id;SELECT * INTO oi FROM tandem.identities WHERE id=run.owner_id;
 RETURN jsonb_build_object('draft',tandem.project_draft_json(d.id),'delivery',jsonb_build_object('run',to_jsonb(run),'profiles',NULL,'documents','[]'::jsonb,
 'project',(SELECT jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'connectionId',p.connection_id,'externalId',p.external_id,'createdBy',p.created_by,'cacheVersion',p.cache_version::text,'createdAt',p.created_at) FROM tandem.project_links p WHERE p.id=run.project_id AND p.workspace_id=run.workspace_id),
 'session',jsonb_build_object('id',s.id,'encryptedCredential',s.encrypted_credential,'expiresAt',s.expires_at,'identity',jsonb_build_object('id',i.id,'providerId',i.provider_id,'subject',i.subject,'displayName',i.display_name,'canCreateWorkspace',i.can_create_workspace)),
 'ownerSession',jsonb_build_object('id',os.id,'encryptedCredential',os.encrypted_credential,'expiresAt',os.expires_at,'identity',jsonb_build_object('id',oi.id,'providerId',oi.provider_id,'subject',oi.subject,'displayName',oi.display_name,'canCreateWorkspace',oi.can_create_workspace))));
END $$;

CREATE FUNCTION tandem.reconcile_delivery_deployment(target_run uuid, target_draft uuid, auth_session uuid, evidence jsonb, confirm_not_published boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE ctx jsonb; run tandem.delivery_runs; d tandem.project_drafts; action jsonb; document_version integer;
BEGIN
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=target_run FOR UPDATE;
 SELECT * INTO d FROM tandem.project_drafts WHERE id=target_draft FOR UPDATE;
 ctx:=tandem.delivery_reconciliation_context(target_run,target_draft,auth_session);
 action:=ctx->'draft'->'action';
 IF evidence IS NOT NULL THEN
  IF evidence->>'id' IS DISTINCT FROM d.id::text OR evidence->>'environment' IS DISTINCT FROM 'local-demo' OR evidence->>'status' NOT IN('healthy','failed','rolled_back') OR length(evidence::text)>10000 THEN RAISE EXCEPTION 'Invalid deployment evidence' USING ERRCODE='22023'; END IF;
  IF action->>'kind'='delivery.deploy' AND (evidence->>'artifactRef' IS DISTINCT FROM action->>'artifactRef' OR evidence->>'contentHash' IS DISTINCT FROM action->>'contentHash' OR (evidence->>'version')::integer IS DISTINCT FROM (action->>'version')::integer) THEN RAISE EXCEPTION 'Evidence digest/version mismatch' USING ERRCODE='23505'; END IF;
  IF action->>'kind'='delivery.rollback' AND evidence->>'previousDeploymentId' IS DISTINCT FROM action->>'deploymentId' THEN RAISE EXCEPTION 'Rollback evidence mismatch' USING ERRCODE='23505'; END IF;
  UPDATE tandem.project_drafts SET status='succeeded',error=NULL,receipt=jsonb_build_object('status',evidence->>'status','reference',d.id,'summary','已核对持久部署回执和HTTP健康检查','recordedAt',clock_timestamp()),updated_at=clock_timestamp() WHERE id=d.id;
  UPDATE tandem.delivery_runs SET deployment=evidence,status=CASE WHEN evidence->>'status'='failed' THEN 'needs_decision' ELSE 'delivered' END,error=CASE WHEN evidence->>'status'='failed' THEN '已核对部署失败，保留前一发布版本' ELSE NULL END,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE id=run.id;
 ELSE
  IF NOT confirm_not_published THEN RAISE EXCEPTION 'Explicit unpublished confirmation required' USING ERRCODE='22023'; END IF;
  SELECT coalesce(max(version),0)+1 INTO document_version FROM tandem.delivery_documents WHERE run_id=run.id AND kind='deployment_reconciliation';
  INSERT INTO tandem.delivery_documents(workspace_id,run_id,kind,role,version,content) VALUES(run.workspace_id,run.id,'deployment_reconciliation','engineer',document_version,jsonb_build_object('draftId',d.id,'draftVersion',d.version,'outcome','not_published','confirmedAt',clock_timestamp(),'environment','local-demo')::text);
  UPDATE tandem.delivery_runs SET status='needs_decision',error='本地发布记录不存在；已确认重新提案，旧草案保留未知状态',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE id=run.id;
 END IF;
 INSERT INTO tandem.delivery_events(workspace_id,run_id,sequence,kind,phase,summary) VALUES(run.workspace_id,run.id,run.event_sequence+1,'deployment_reconciled','delivery',CASE WHEN evidence IS NULL THEN '已检查本地发布存储并明确确认尚未发布；旧草案不重试，续跑将重新提交审批' ELSE '已核对不可变发布回执和实际HTTP结果，恢复交付记录' END);
END $$;

CREATE OR REPLACE FUNCTION tandem.control_delivery_run(target uuid, command text, auth_session uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tandem AS $$
DECLARE run tandem.delivery_runs; actor uuid; next_status text; queued uuid; deployment_state text; deployment_id uuid; deployment_version integer;
BEGIN
 actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
 SELECT * INTO run FROM tandem.delivery_runs WHERE id=target AND workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid FOR UPDATE;
 IF run.id IS NULL OR NOT tandem.can_access_project(run.project_id,false) OR actor NOT IN(run.actor_id,run.owner_id) THEN RAISE EXCEPTION 'Run access forbidden' USING ERRCODE='42501'; END IF;
 IF command='resume' THEN
  IF actor<>run.actor_id OR NOT EXISTS(SELECT 1 FROM tandem.sessions WHERE id=auth_session AND identity_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Original actor required' USING ERRCODE='42501'; END IF;
  IF run.status NOT IN('paused','needs_auth','needs_configuration','needs_decision','failed','awaiting_deployment') THEN RAISE EXCEPTION 'Run cannot resume' USING ERRCODE='22023'; END IF;
  IF run.phase='delivery' THEN
   SELECT d.status,d.id,d.version INTO deployment_state,deployment_id,deployment_version FROM tandem.project_drafts d JOIN tandem.project_draft_versions v ON v.draft_id=d.id AND v.workspace_id=d.workspace_id AND v.version=d.version WHERE d.workspace_id=run.workspace_id AND d.project_id=run.project_id AND v.action->>'kind'='delivery.deploy' AND v.action->>'runId'=run.id::text ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
   IF deployment_state IN('pending','approved','executing') OR deployment_state='unknown' AND NOT EXISTS(SELECT 1 FROM tandem.delivery_documents WHERE run_id=run.id AND kind='deployment_reconciliation' AND content::jsonb->>'draftId'=deployment_id::text AND (content::jsonb->>'draftVersion')::integer=deployment_version AND content::jsonb->>'outcome'='not_published') THEN RAISE EXCEPTION 'Deployment pending or result unknown; reconcile first' USING ERRCODE='23505'; END IF;
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
REVOKE ALL ON FUNCTION tandem.delivery_reconciliation_context(uuid,uuid,uuid),tandem.reconcile_delivery_deployment(uuid,uuid,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.delivery_reconciliation_context(uuid,uuid,uuid),tandem.reconcile_delivery_deployment(uuid,uuid,uuid,jsonb,boolean) TO tandem_app;
