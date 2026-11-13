-- Identity is verified by the configured collaboration provider; no password is stored.
CREATE TABLE tandem.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  can_create_workspace boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, subject)
);
CREATE TABLE tandem.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES tandem.identities(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  encrypted_credential text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (revoked_at IS NOT NULL OR (encrypted_credential IS NOT NULL AND length(encrypted_credential) BETWEEN 1 AND 32768))
);
CREATE INDEX sessions_expiry ON tandem.sessions (expires_at) WHERE revoked_at IS NULL;
ALTER TABLE tandem.workspaces ADD COLUMN creator_id uuid REFERENCES tandem.identities(id);
ALTER TABLE tandem.workspaces ADD COLUMN initialization_key uuid;
ALTER TABLE tandem.workspaces ADD CONSTRAINT workspace_initialization UNIQUE (creator_id, initialization_key);
CREATE TABLE tandem.workspace_members (
  workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
  identity_id uuid NOT NULL REFERENCES tandem.identities(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, identity_id)
);
CREATE UNIQUE INDEX workspace_single_owner ON tandem.workspace_members (workspace_id) WHERE role = 'owner';
CREATE INDEX members_identity ON tandem.workspace_members (identity_id, workspace_id);
CREATE TABLE tandem.agent_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES tandem.workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  template_key text NOT NULL,
  template_version integer NOT NULL CHECK (template_version > 0),
  owner_id uuid NOT NULL REFERENCES tandem.identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, template_key),
  UNIQUE (workspace_id, id)
);
CREATE TABLE tandem.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('designer', 'architect', 'engineer')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, team_id) REFERENCES tandem.agent_teams(workspace_id, id),
  UNIQUE (workspace_id, team_id, role),
  UNIQUE (workspace_id, id)
);

-- The migration owner has an explicit internal policy, rather than BYPASSRLS.
-- Only restricted functions run as this owner. Runtime roles never inherit it.
ALTER TABLE tandem.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.identities FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.workspace_members FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.agent_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.agent_teams FORCE ROW LEVEL SECURITY;
ALTER TABLE tandem.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tandem.agents FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_internal ON tandem.identities TO tandem_migrator USING (true) WITH CHECK (true);
CREATE POLICY session_internal ON tandem.sessions TO tandem_migrator USING (true) WITH CHECK (true);
CREATE POLICY member_internal ON tandem.workspace_members TO tandem_migrator USING (true) WITH CHECK (true);
CREATE POLICY workspace_internal ON tandem.workspaces TO tandem_migrator USING (true) WITH CHECK (true);
CREATE POLICY team_internal ON tandem.agent_teams TO tandem_migrator USING (true) WITH CHECK (true);
CREATE POLICY agent_internal ON tandem.agents TO tandem_migrator USING (true) WITH CHECK (true);

CREATE FUNCTION tandem.current_member_role(target_workspace uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
  SELECT role FROM tandem.workspace_members
  WHERE workspace_id = target_workspace
    AND identity_id = nullif(current_setting('app.actor_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION tandem.current_member_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.current_member_role(uuid) TO tandem_app;

DROP POLICY workspace_scope ON tandem.workspaces;
CREATE POLICY workspace_scope ON tandem.workspaces TO tandem_app
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND tandem.current_member_role(id) IS NOT NULL);
DROP POLICY job_scope ON tandem.jobs;
CREATE POLICY job_scope ON tandem.jobs TO tandem_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND tandem.current_member_role(workspace_id) IS NOT NULL)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND tandem.current_member_role(workspace_id) IS NOT NULL);
CREATE POLICY member_scope ON tandem.workspace_members TO tandem_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND tandem.current_member_role(workspace_id) IS NOT NULL);
CREATE POLICY team_scope ON tandem.agent_teams TO tandem_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND tandem.current_member_role(workspace_id) IS NOT NULL);
CREATE POLICY agent_scope ON tandem.agents TO tandem_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND tandem.current_member_role(workspace_id) IS NOT NULL);
REVOKE INSERT, UPDATE ON tandem.workspaces FROM tandem_app;
GRANT SELECT ON tandem.workspace_members, tandem.agent_teams, tandem.agents TO tandem_app;

CREATE FUNCTION tandem.create_identity_session(
  provider text, external_subject text, name text, commander boolean,
  digest text, credential text, expiration timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
DECLARE person tandem.identities; auth_session tandem.sessions;
BEGIN
  IF expiration <= clock_timestamp() OR expiration > clock_timestamp() + interval '7 days' THEN
    RAISE EXCEPTION 'Invalid expiration' USING ERRCODE = '22023';
  END IF;
  INSERT INTO tandem.identities (provider_id, subject, display_name, can_create_workspace)
  VALUES (provider, external_subject, name, commander)
  ON CONFLICT (provider_id, subject) DO UPDATE
    SET display_name = EXCLUDED.display_name, can_create_workspace = EXCLUDED.can_create_workspace
  RETURNING * INTO person;
  INSERT INTO tandem.sessions (identity_id, token_hash, encrypted_credential, expires_at)
  VALUES (person.id, digest, credential, expiration) RETURNING * INTO auth_session;
  RETURN jsonb_build_object('id', auth_session.id, 'identity', jsonb_build_object(
    'id', person.id, 'providerId', person.provider_id, 'subject', person.subject,
    'displayName', person.display_name, 'canCreateWorkspace', person.can_create_workspace
  ), 'encryptedCredential', auth_session.encrypted_credential, 'expiresAt', auth_session.expires_at);
END $$;
CREATE FUNCTION tandem.find_identity_session(digest text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
  SELECT jsonb_build_object('id', s.id, 'identity', jsonb_build_object(
    'id', i.id, 'providerId', i.provider_id, 'subject', i.subject,
    'displayName', i.display_name, 'canCreateWorkspace', i.can_create_workspace
  ), 'encryptedCredential', s.encrypted_credential, 'expiresAt', s.expires_at)
  FROM tandem.sessions s JOIN tandem.identities i ON i.id = s.identity_id
  WHERE s.token_hash = digest AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
$$;
CREATE FUNCTION tandem.revoke_identity_session(digest text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
  UPDATE tandem.sessions SET revoked_at = clock_timestamp(), encrypted_credential = NULL
  WHERE token_hash = digest AND revoked_at IS NULL
$$;
CREATE FUNCTION tandem.refresh_identity(person_id uuid, provider text, external_subject text, name text, commander boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
BEGIN
  UPDATE tandem.identities SET display_name = name, can_create_workspace = commander
  WHERE id = person_id AND provider_id = provider AND subject = external_subject;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Identity mismatch' USING ERRCODE = '42501';
  END IF;
END $$;
CREATE FUNCTION tandem.actor_workspaces() RETURNS TABLE(id uuid, name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
  SELECT w.id, w.name, m.role FROM tandem.workspaces w
  JOIN tandem.workspace_members m ON m.workspace_id = w.id
  WHERE m.identity_id = nullif(current_setting('app.actor_id', true), '')::uuid
  ORDER BY w.created_at, w.id
$$;
CREATE FUNCTION tandem.initialize_workspace(workspace_name text, request_key uuid) RETURNS TABLE(id uuid, name text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
DECLARE person tandem.identities; space tandem.workspaces; team uuid;
BEGIN
  SELECT * INTO person FROM tandem.identities
    WHERE identities.id = nullif(current_setting('app.actor_id', true), '')::uuid;
  IF person.id IS NULL OR NOT person.can_create_workspace THEN
    RAISE EXCEPTION 'Workspace creation forbidden' USING ERRCODE = '42501';
  END IF;
  IF request_key IS NULL OR workspace_name IS NULL OR length(btrim(workspace_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Invalid workspace input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(person.id::text || request_key::text, 0));
  SELECT * INTO space FROM tandem.workspaces
    WHERE creator_id = person.id AND initialization_key = request_key;
  IF space.id IS NOT NULL THEN
    IF space.name <> btrim(workspace_name) THEN
      RAISE EXCEPTION 'Request key content conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT space.id, space.name, 'owner'::text;
    RETURN;
  END IF;
  INSERT INTO tandem.workspaces (name, creator_id, initialization_key)
    VALUES (btrim(workspace_name), person.id, request_key) RETURNING * INTO space;
  INSERT INTO tandem.workspace_members (workspace_id, identity_id, role) VALUES (space.id, person.id, 'owner');
  INSERT INTO tandem.agent_teams (workspace_id, name, template_key, template_version, owner_id)
    VALUES (space.id, 'T 组', 'default-t', 1, person.id) RETURNING agent_teams.id INTO team;
  INSERT INTO tandem.agents (workspace_id, team_id, role, name, description) VALUES
    (space.id, team, 'designer', '产品设计师', '精通 UI/UX 的高级前沿产品设计师。负责需求与验收标准、交互和视觉设计，并验收实现体验。'),
    (space.id, team, 'architect', '技术架构师', '简洁务实前沿的高级技术架构师。负责技术与部署架构、接口与权限、监控发布和回滚设计，并复核实现。'),
    (space.id, team, 'engineer', '研发工程师', '严谨的高级研发工程师。负责开发、测试、修复、部署脚本、获批部署、健康检查和必要回滚。');
  RETURN QUERY SELECT space.id, space.name, 'owner'::text;
END $$;
CREATE FUNCTION tandem.visible_workspace_members(target_workspace uuid)
RETURNS TABLE(identity_id uuid, display_name text, role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
BEGIN
  IF target_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid
    OR tandem.current_member_role(target_workspace) IS NULL THEN
    RAISE EXCEPTION 'Workspace access forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT m.identity_id, i.display_name, m.role
    FROM tandem.workspace_members m JOIN tandem.identities i ON i.id = m.identity_id
    WHERE m.workspace_id = target_workspace
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at, m.identity_id;
END $$;
CREATE FUNCTION tandem.change_workspace_member(target_workspace uuid, target_identity uuid, requested_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tandem AS $$
DECLARE actor uuid; actor_role text; target_role text; actor_provider text; target_provider text;
BEGIN
  actor := nullif(current_setting('app.actor_id', true), '')::uuid;
  IF target_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Workspace scope forbidden' USING ERRCODE = '42501';
  END IF;
  -- Serialize all membership mutations, including concurrent demotion/revocation.
  PERFORM 1 FROM tandem.workspaces WHERE id = target_workspace FOR UPDATE;
  actor_role := tandem.current_member_role(target_workspace);
  SELECT role INTO target_role FROM tandem.workspace_members
    WHERE workspace_id = target_workspace AND identity_id = target_identity;
  IF actor_role IS NULL OR actor_role NOT IN ('owner', 'admin') OR target_role = 'owner'
    OR (actor_role = 'admin' AND (target_role = 'admin' OR requested_role = 'admin')) THEN
    RAISE EXCEPTION 'Member management forbidden' USING ERRCODE = '42501';
  END IF;
  IF requested_role IS NULL THEN
    DELETE FROM tandem.workspace_members WHERE workspace_id = target_workspace AND identity_id = target_identity;
    RETURN;
  END IF;
  IF requested_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'Invalid member role' USING ERRCODE = '22023';
  END IF;
  SELECT provider_id INTO actor_provider FROM tandem.identities WHERE id = actor;
  SELECT provider_id INTO target_provider FROM tandem.identities WHERE id = target_identity;
  IF target_provider IS NULL OR target_provider <> actor_provider THEN
    RAISE EXCEPTION 'Unknown identity or provider mismatch' USING ERRCODE = '42501';
  END IF;
  INSERT INTO tandem.workspace_members (workspace_id, identity_id, role)
    VALUES (target_workspace, target_identity, requested_role)
    ON CONFLICT (workspace_id, identity_id) DO UPDATE SET role = EXCLUDED.role;
END $$;
REVOKE ALL ON FUNCTION tandem.create_identity_session(text,text,text,boolean,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION tandem.find_identity_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tandem.revoke_identity_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tandem.refresh_identity(uuid,text,text,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION tandem.actor_workspaces() FROM PUBLIC;
REVOKE ALL ON FUNCTION tandem.initialize_workspace(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION tandem.visible_workspace_members(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION tandem.change_workspace_member(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tandem.create_identity_session(text,text,text,boolean,text,text,timestamptz),
  tandem.find_identity_session(text), tandem.revoke_identity_session(text), tandem.refresh_identity(uuid,text,text,text,boolean), tandem.actor_workspaces(),
  tandem.initialize_workspace(text,uuid), tandem.visible_workspace_members(uuid), tandem.change_workspace_member(uuid,uuid,text)
  TO tandem_app;
