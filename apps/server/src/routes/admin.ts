/** 管理模块 API：项目分组树 / 项目映射 / 团队与成员 / Agent 档案（仅负责人） */
import type {FastifyInstance} from 'fastify'
import {defaultStore, type AgentProfile} from '@tandem/core'
import {storeConfig} from '../config.js'
import {config} from '../config.js'

interface AgentInput {
  name?: string
  role?: string
  description?: string
  capabilities?: string[]
  skills?: string[]
  ragEnabled?: boolean
  ragCollections?: string[]
  ownerAccount?: string
  llmBaseUrl?: string
  llmModel?: string
  status?: AgentProfile['status']
}

export async function adminRoutes(app: FastifyInstance) {
  const store = await defaultStore(storeConfig.file)

  // 管理模块仅负责人可用（数据权限的管理面）
  app.addHook('onRequest', async (req, reply) => {
    if (!config.leadAccounts.has(req.session.account)) {
      return reply.code(403).send({message: '仅负责人可管理组织与 Agent'})
    }
  })

  // ---------- 项目分组 ----------

  app.get('/api/admin/groups', async () => ({tree: store.groupTree()}))

  app.post('/api/admin/groups', async (req, reply) => {
    const {parentId, name, sortOrder} = (req.body ?? {}) as {parentId?: number; name?: string; sortOrder?: number}
    if (!name?.trim()) return reply.code(400).send({message: '分组名不能为空'})
    return store.createGroup({parentId: parentId ?? null, name: name.trim(), sortOrder})
  })

  app.put('/api/admin/groups/:id', async (req) => {
    const {id} = req.params as {id: string}
    const {name, parentId, sortOrder} = (req.body ?? {}) as {name?: string; parentId?: number | null; sortOrder?: number}
    if (name !== undefined) store.renameGroup(Number(id), name)
    if (parentId !== undefined) store.moveGroup(Number(id), parentId, sortOrder)
    return {ok: true}
  })

  app.delete('/api/admin/groups/:id', async (req) => {
    store.deleteGroup(Number((req.params as {id: string}).id))
    return {ok: true}
  })

  app.put('/api/admin/groups/:id/permissions', async (req) => {
    const {id} = req.params as {id: string}
    const {viewers} = (req.body ?? {}) as {viewers?: string[]}
    store.setGroupPermission(Number(id), viewers ?? [])
    return store.getGroupPermission(Number(id))
  })

  // ---------- 项目映射 ----------

  app.get('/api/admin/mappings', async () => ({mappings: store.listMappings()}))

  app.put('/api/admin/mappings/:sourceProjectId', async (req) => {
    const {sourceProjectId} = req.params as {sourceProjectId: string}
    const {groupId, enabled} = (req.body ?? {}) as {groupId?: number | null; enabled?: boolean}
    if (groupId !== undefined) store.assignProjectGroup(Number(sourceProjectId), groupId)
    if (enabled !== undefined) store.setProjectEnabled(Number(sourceProjectId), enabled)
    return {ok: true}
  })

  // ---------- 团队 ----------

  app.get('/api/admin/teams', async () => {
    const teams = store.listTeams().map((t) => ({...t, members: store.listMembers(t.id)}))
    return {teams}
  })

  app.post('/api/admin/teams', async (req, reply) => {
    const {name, description} = (req.body ?? {}) as {name?: string; description?: string}
    if (!name?.trim()) return reply.code(400).send({message: '团队名不能为空'})
    return store.createTeam(name.trim(), description)
  })

  app.put('/api/admin/teams/:id', async (req) => {
    const {id} = req.params as {id: string}
    const {name, description} = (req.body ?? {}) as {name?: string; description?: string}
    store.updateTeam(Number(id), name ?? '', description)
    return {ok: true}
  })

  app.delete('/api/admin/teams/:id', async (req) => {
    store.deleteTeam(Number((req.params as {id: string}).id))
    return {ok: true}
  })

  app.post('/api/admin/teams/:id/members', async (req, reply) => {
    const {id} = req.params as {id: string}
    const {kind, refId, displayName, role} = (req.body ?? {}) as {
      kind?: 'human' | 'agent'
      refId?: string
      displayName?: string
      role?: string
    }
    if (kind !== 'human' && kind !== 'agent') return reply.code(400).send({message: 'kind 必须是 human 或 agent'})
    if (!refId?.trim() || !displayName?.trim()) return reply.code(400).send({message: 'refId 与 displayName 必填'})
    return store.addMember({teamId: Number(id), kind, refId: refId.trim(), displayName: displayName.trim(), role})
  })

  app.put('/api/admin/members/:id', async (req) => {
    const {id} = req.params as {id: string}
    const {role} = (req.body ?? {}) as {role?: string}
    if (role) store.updateMemberRole(Number(id), role)
    return {ok: true}
  })

  app.delete('/api/admin/members/:id', async (req) => {
    store.removeMember(Number((req.params as {id: string}).id))
    return {ok: true}
  })

  // ---------- Agent ----------

  app.get('/api/admin/agents', async () => ({agents: store.listAgents()}))

  app.post('/api/admin/agents', async (req, reply) => {
    const input = (req.body ?? {}) as AgentInput
    if (!input.name?.trim()) return reply.code(400).send({message: 'Agent 名不能为空'})
    return store.createAgent({
      name: input.name.trim(),
      role: input.role ?? 'custom',
      description: input.description,
      capabilities: input.capabilities ?? [],
      skills: input.skills ?? [],
      ragEnabled: input.ragEnabled ?? false,
      ragCollections: input.ragCollections ?? [],
      ownerAccount: input.ownerAccount ?? req.session.account,
      llmBaseUrl: input.llmBaseUrl,
      llmModel: input.llmModel,
    })
  })

  app.put('/api/admin/agents/:id', async (req, reply) => {
    const {id} = req.params as {id: string}
    const updated = store.updateAgent(Number(id), (req.body ?? {}) as AgentInput)
    if (!updated) return reply.code(404).send({message: 'Agent 不存在'})
    return updated
  })

  app.delete('/api/admin/agents/:id', async (req) => {
    store.deleteAgent(Number((req.params as {id: string}).id))
    return {ok: true}
  })
}
