/**
 * Tandem 自有资产存储（SQLite，WASM 实现——免原生编译，跨平台开箱即用）。
 * 只存 Tandem 配置与协作产物，不复制下游业务数据（docs/02-技术架构文档.md §4）。
 */
import sqliteWasm from 'node-sqlite3-wasm'

/** 运行时构造器（CJS 具名挂在默认导出上）；类型经推断获得 */
const SqliteDatabase = sqliteWasm.Database
import {mkdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {
  joinTags,
  parseTags,
  type AgentProfile,
  type AgentStatus,
  type GroupPermission,
  type ProjectGroup,
  type ProjectGroupNode,
  type ProjectMapping,
  type Team,
  type TeamMember,
} from './model.js'

export interface StoreOptions {
  file: string
}

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS project_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES project_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_project_id INTEGER NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'zentao',
  group_id INTEGER REFERENCES project_groups(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_project_id, source_type)
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
  ref_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  UNIQUE(team_id, kind, ref_id)
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'custom',
  description TEXT,
  capabilities TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '',
  rag_enabled INTEGER NOT NULL DEFAULT 0,
  rag_collections TEXT NOT NULL DEFAULT '',
  owner_account TEXT NOT NULL,
  llm_base_url TEXT,
  llm_model TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_permissions (
  group_id INTEGER PRIMARY KEY REFERENCES project_groups(id) ON DELETE CASCADE,
  viewers TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  owner_account TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  steps INTEGER NOT NULL DEFAULT 0,
  max_steps INTEGER NOT NULL DEFAULT 8,
  error TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  actor TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  actions TEXT NOT NULL,
  checks TEXT NOT NULL,
  results TEXT,
  created_at INTEGER NOT NULL
);
`

type Row = Record<string, unknown>
/** 该 WASM 绑定接受的绑定值类型 */
type Bind = string | number | bigint | null | undefined

export class TandemStore {
  private db: InstanceType<typeof SqliteDatabase>

  private constructor(db: InstanceType<typeof SqliteDatabase>) {
    this.db = db
  }

  static async open(opts: StoreOptions): Promise<TandemStore> {
    if (opts.file !== ':memory:') mkdirSync(dirname(opts.file), {recursive: true})
    const db = await new SqliteDatabase(opts.file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(MIGRATIONS)
    return new TandemStore(db)
  }

  private all<T>(sql: string, params: Bind[] = []): T[] {
    return this.db.all(sql, params as never) as T[]
  }

  private get<T>(sql: string, params: Bind[] = []): T | undefined {
    return this.db.get(sql, params as never) as T | undefined
  }

  private run(sql: string, params: Bind[] = []): {changes: number; lastInsertRowid: number | bigint} {
    return this.db.run(sql, params as never) as {changes: number; lastInsertRowid: number | bigint}
  }

  close() {
    this.db.close()
  }

  // ---------- 分组树 ----------

  listGroups(): ProjectGroup[] {
    return this.all<ProjectGroup>(
      'SELECT id, parent_id AS parentId, name, sort_order AS sortOrder FROM project_groups ORDER BY sort_order, id',
    )
  }

  groupTree(): ProjectGroupNode[] {
    const groups = this.listGroups()
    const mappings = this.listMappings()
    const nodeOf = (g: ProjectGroup): ProjectGroupNode => ({
      ...g,
      children: [],
      projectRefs: mappings.filter((m) => m.groupId === g.id && m.enabled).map((m) => m.sourceProjectId),
    })
    const nodes = new Map(groups.map((g) => [g.id, nodeOf(g)]))
    const roots: ProjectGroupNode[] = []
    for (const g of groups) {
      const n = nodes.get(g.id)!
      if (g.parentId != null && nodes.has(g.parentId)) nodes.get(g.parentId)!.children.push(n)
      else roots.push(n)
    }
    return roots
  }

  createGroup(input: {parentId?: number | null; name: string; sortOrder?: number}): ProjectGroup {
    const r = this.run('INSERT INTO project_groups (parent_id, name, sort_order) VALUES (?, ?, ?)', [
      input.parentId ?? null,
      input.name,
      input.sortOrder ?? 0,
    ])
    return {id: Number(r.lastInsertRowid), parentId: input.parentId ?? null, name: input.name, sortOrder: input.sortOrder ?? 0}
  }

  renameGroup(id: number, name: string) {
    this.run('UPDATE project_groups SET name = ? WHERE id = ?', [name, id])
  }

  moveGroup(id: number, parentId: number | null, sortOrder?: number) {
    if (id === parentId) throw new Error('分组不能挂到自己名下')
    // 防环：向上追溯新父链
    let p = parentId
    while (p != null) {
      if (p === id) throw new Error('不能把分组移动到自己的子孙分组下')
      const row = this.get<{parent_id: number | null}>('SELECT parent_id FROM project_groups WHERE id = ?', [p])
      if (!row) break
      p = row.parent_id
    }
    this.run('UPDATE project_groups SET parent_id = ?, sort_order = COALESCE(?, sort_order) WHERE id = ?', [
      parentId,
      sortOrder ?? null,
      id,
    ])
  }

  deleteGroup(id: number) {
    this.run('DELETE FROM project_groups WHERE id = ?', [id]) // 子分组经 ON DELETE CASCADE 级联；映射 groupId 置空
  }

  // ---------- 项目映射 ----------

  listMappings(): ProjectMapping[] {
    return this.all<ProjectMapping>(
      'SELECT id, source_project_id AS sourceProjectId, source_type AS sourceType, group_id AS groupId, enabled FROM project_mappings',
    )
  }

  /** 幂等登记下游项目（首次发现时建立映射，默认未分组） */
  ensureMapping(sourceProjectId: number, sourceType: ProjectMapping['sourceType'] = 'zentao'): ProjectMapping {
    const hit = this.get<ProjectMapping>(
      'SELECT id, source_project_id AS sourceProjectId, source_type AS sourceType, group_id AS groupId, enabled FROM project_mappings WHERE source_project_id = ? AND source_type = ?',
      [sourceProjectId, sourceType],
    )
    if (hit) return hit
    const r = this.run('INSERT INTO project_mappings (source_project_id, source_type) VALUES (?, ?)', [sourceProjectId, sourceType])
    return {id: Number(r.lastInsertRowid), sourceProjectId, sourceType, groupId: null, enabled: true}
  }

  assignProjectGroup(sourceProjectId: number, groupId: number | null) {
    this.ensureMapping(sourceProjectId)
    this.run('UPDATE project_mappings SET group_id = ? WHERE source_project_id = ?', [groupId, sourceProjectId])
  }

  setProjectEnabled(sourceProjectId: number, enabled: boolean) {
    this.ensureMapping(sourceProjectId)
    this.run('UPDATE project_mappings SET enabled = ? WHERE source_project_id = ?', [enabled ? 1 : 0, sourceProjectId])
  }

  // ---------- 团队 ----------

  listTeams(): Team[] {
    return this.all<Team>('SELECT id, name, description FROM teams ORDER BY id')
  }

  createTeam(name: string, description?: string): Team {
    const r = this.run('INSERT INTO teams (name, description) VALUES (?, ?)', [name, description ?? null])
    return {id: Number(r.lastInsertRowid), name, description}
  }

  updateTeam(id: number, name: string, description?: string) {
    this.run('UPDATE teams SET name = ?, description = ? WHERE id = ?', [name, description ?? null, id])
  }

  deleteTeam(id: number) {
    this.run('DELETE FROM teams WHERE id = ?', [id])
  }

  listMembers(teamId: number): TeamMember[] {
    return this.all<TeamMember>(
      'SELECT id, team_id AS teamId, kind, ref_id AS refId, display_name AS displayName, role, joined_at AS joinedAt FROM team_members WHERE team_id = ? ORDER BY kind, id',
      [teamId],
    )
  }

  addMember(input: {teamId: number; kind: 'human' | 'agent'; refId: string; displayName: string; role?: string}): TeamMember {
    const now = Date.now()
    const r = this.run(
      'INSERT INTO team_members (team_id, kind, ref_id, display_name, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)',
      [input.teamId, input.kind, input.refId, input.displayName, input.role ?? 'member', now],
    )
    return {id: Number(r.lastInsertRowid), teamId: input.teamId, kind: input.kind, refId: input.refId, displayName: input.displayName, role: input.role ?? 'member', joinedAt: now}
  }

  removeMember(id: number) {
    this.run('DELETE FROM team_members WHERE id = ?', [id])
  }

  updateMemberRole(id: number, role: string) {
    this.run('UPDATE team_members SET role = ? WHERE id = ?', [role, id])
  }

  // ---------- Agent ----------

  private rowToAgent(r: Row): AgentProfile {
    return {
      id: r.id as number,
      name: r.name as string,
      role: r.role as string,
      description: (r.description as string) ?? undefined,
      capabilities: parseTags(r.capabilities as string),
      skills: parseTags(r.skills as string),
      ragEnabled: Boolean(r.rag_enabled),
      ragCollections: parseTags(r.rag_collections as string),
      ownerAccount: r.owner_account as string,
      llmBaseUrl: (r.llm_base_url as string) ?? undefined,
      llmModel: (r.llm_model as string) ?? undefined,
      status: r.status as AgentStatus,
      createdAt: r.created_at as number,
    }
  }

  listAgents(): AgentProfile[] {
    return this.all<Row>('SELECT * FROM agents ORDER BY id').map((r) => this.rowToAgent(r))
  }

  getAgent(id: number): AgentProfile | undefined {
    const row = this.get<Row>('SELECT * FROM agents WHERE id = ?', [id])
    return row ? this.rowToAgent(row) : undefined
  }

  createAgent(input: Omit<AgentProfile, 'id' | 'createdAt' | 'status'>): AgentProfile {
    this.run(
      `INSERT INTO agents (name, role, description, capabilities, skills, rag_enabled, rag_collections, owner_account, llm_base_url, llm_model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?)`,
      [
        input.name,
        input.role,
        input.description ?? null,
        joinTags(input.capabilities),
        joinTags(input.skills),
        input.ragEnabled ? 1 : 0,
        joinTags(input.ragCollections),
        input.ownerAccount,
        input.llmBaseUrl ?? null,
        input.llmModel ?? null,
        Date.now(),
      ],
    )
    return this.getAgent(this.lastId())!
  }

  private lastId(): number {
    return Number(this.get<{id: number}>('SELECT last_insert_rowid() AS id')!.id)
  }

  updateAgent(id: number, input: Partial<Omit<AgentProfile, 'id' | 'createdAt'>>): AgentProfile | undefined {
    const cur = this.getAgent(id)
    if (!cur) return undefined
    this.run(
      `UPDATE agents SET name=?, role=?, description=?, capabilities=?, skills=?, rag_enabled=?, rag_collections=?, llm_base_url=?, llm_model=?, status=? WHERE id=?`,
      [
        input.name ?? cur.name,
        input.role ?? cur.role,
        input.description ?? cur.description ?? null,
        joinTags(input.capabilities ?? cur.capabilities),
        joinTags(input.skills ?? cur.skills),
        (input.ragEnabled ?? cur.ragEnabled) ? 1 : 0,
        joinTags(input.ragCollections ?? cur.ragCollections),
        input.llmBaseUrl ?? cur.llmBaseUrl ?? null,
        input.llmModel ?? cur.llmModel ?? null,
        input.status ?? cur.status,
        id,
      ],
    )
    return this.getAgent(id)
  }

  deleteAgent(id: number) {
    this.run('DELETE FROM agents WHERE id = ?', [id])
    this.run("DELETE FROM team_members WHERE kind = 'agent' AND ref_id = ?", [String(id)])
  }

  // ---------- 分组权限 ----------

  getGroupPermission(groupId: number): GroupPermission {
    const row = this.get<{viewers: string}>('SELECT viewers FROM group_permissions WHERE group_id = ?', [groupId])
    return {groupId, viewers: parseTags(row?.viewers)}
  }

  setGroupPermission(groupId: number, viewers: string[]) {
    this.run(
      'INSERT INTO group_permissions (group_id, viewers) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET viewers = excluded.viewers',
      [groupId, joinTags(viewers)],
    )
  }

  // ---------- Agent 运行（runs / steps） ----------

  createRun(input: {id: string; agentId: number; agentName: string; ownerAccount: string; goal: string; maxSteps: number}): void {
    this.run(
      'INSERT INTO runs (id, agent_id, agent_name, owner_account, goal, status, steps, max_steps, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      [input.id, input.agentId, input.agentName, input.ownerAccount, input.goal, 'running', input.maxSteps, Date.now()],
    )
  }

  updateRun(id: string, patch: {status?: string; steps?: number; error?: string | null; summary?: string | null}) {
    const cur = this.get<{status: string; steps: number}>('SELECT status, steps FROM runs WHERE id = ?', [id])
    if (!cur) return
    const done = patch.status && patch.status !== 'running'
    this.run('UPDATE runs SET status = ?, steps = ?, error = ?, summary = ?, finished_at = ? WHERE id = ?', [
      patch.status ?? cur.status,
      patch.steps ?? cur.steps,
      patch.error ?? null,
      patch.summary ?? null,
      done ? Date.now() : null,
      id,
    ])
  }

  addRunStep(runId: string, kind: string, title: string, detail?: unknown) {
    const seq = Number(
      (this.get<{n: number}>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_steps WHERE run_id = ?', [runId])?.n ?? 1),
    )
    this.run('INSERT INTO run_steps (run_id, seq, kind, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      runId,
      seq,
      kind,
      title,
      detail === undefined ? null : JSON.stringify(detail),
      Date.now(),
    ])
  }

  getRun(id: string): (AgentRun & {stepsList: RunStep[]}) | undefined {
    const row = this.get<Row>(
      'SELECT id, agent_id AS agentId, agent_name AS agentName, owner_account AS ownerAccount, goal, status, steps, max_steps AS maxSteps, error, summary, created_at AS createdAt, finished_at AS finishedAt FROM runs WHERE id = ?',
      [id],
    )
    if (!row) return undefined
    const stepsList = this.all<Row>('SELECT seq, kind, title, detail, created_at AS createdAt FROM run_steps WHERE run_id = ? ORDER BY seq', [id]).map((s) => ({
      seq: s.seq as number,
      kind: s.kind as string,
      title: s.title as string,
      detail: s.detail ? JSON.parse(s.detail as string) : undefined,
      createdAt: s.created_at as number,
    }))
    return {...(row as unknown as AgentRun), stepsList}
  }

  listRuns(limit = 30): AgentRun[] {
    return this.all<AgentRun>(
      'SELECT id, agent_id AS agentId, agent_name AS agentName, owner_account AS ownerAccount, goal, status, steps, max_steps AS maxSteps, error, summary, created_at AS createdAt, finished_at AS finishedAt FROM runs ORDER BY created_at DESC LIMIT ?',
      [limit],
    )
  }

  // ---------- 草案持久化 ----------

  saveDraft(d: {id: string; source: string; actor: string; runId?: string; actions: unknown; checks: unknown}) {
    this.run('INSERT INTO drafts (id, source, actor, run_id, status, actions, checks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      d.id,
      d.source,
      d.actor,
      d.runId ?? null,
      'pending',
      JSON.stringify(d.actions),
      JSON.stringify(d.checks),
      Date.now(),
    ])
  }

  getDraftRow(id: string): {id: string; source: string; actor: string; runId: string | null; status: string; actions: unknown[]; checks: unknown[]; results: unknown[] | null} | undefined {
    const r = this.get<Row>('SELECT * FROM drafts WHERE id = ?', [id])
    if (!r) return undefined
    return {
      id: r.id as string,
      source: r.source as string,
      actor: r.actor as string,
      runId: (r.run_id as string) ?? null,
      status: r.status as string,
      actions: JSON.parse(r.actions as string),
      checks: JSON.parse(r.checks as string),
      results: r.results ? JSON.parse(r.results as string) : null,
    }
  }

  setDraftStatus(id: string, status: string, results?: unknown) {
    this.run('UPDATE drafts SET status = ?, results = ? WHERE id = ?', [status, results ? JSON.stringify(results) : null, id])
  }

  listPendingDrafts(): Array<{id: string; source: string; actor: string; runId: string | null; actions: unknown[]; checks: unknown[]; createdAt: number}> {
    return this.all<Row>("SELECT * FROM drafts WHERE status = 'pending' ORDER BY created_at DESC").map((r) => ({
      id: r.id as string,
      source: r.source as string,
      actor: r.actor as string,
      runId: (r.run_id as string) ?? null,
      actions: JSON.parse(r.actions as string),
      checks: JSON.parse(r.checks as string),
      createdAt: r.created_at as number,
    }))
  }
}

export interface AgentRun {
  id: string
  agentId: number
  agentName: string
  ownerAccount: string
  goal: string
  status: 'running' | 'waiting_approval' | 'done' | 'failed' | 'stopped'
  steps: number
  maxSteps: number
  error?: string | null
  summary?: string | null
  createdAt: number
  finishedAt?: number | null
}

export interface RunStep {
  seq: number
  kind: string
  title: string
  detail?: unknown
  createdAt: number
}

export async function defaultStore(dataDir: string): Promise<TandemStore> {
  return TandemStore.open({file: join(dataDir, 'tandem.db')})
}
