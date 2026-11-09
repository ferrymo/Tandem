/** Tandem 领域模型：分组树 / 项目映射 / 团队 / 成员（人+Agent）/ Agent 档案 */

// ---------- 项目分组树 ----------

export interface ProjectGroup {
  id: number
  parentId: number | null
  name: string
  sortOrder: number
}

/** 树节点（含挂载的项目引用，不含项目详情） */
export interface ProjectGroupNode extends ProjectGroup {
  children: ProjectGroupNode[]
  projectRefs: number[]
}

// ---------- 项目映射（Tandem 侧的项目配置，下游事实源不动） ----------

export interface ProjectMapping {
  /** Tandem 内部 ID */
  id: number
  /** 下游系统项目 ID（当前单适配器=禅道项目 id） */
  sourceProjectId: number
  sourceType: 'zentao'
  groupId: number | null
  /** 是否纳入 Tandem 管理（false=隐藏） */
  enabled: boolean
}

// ---------- 团队与成员 ----------

export interface Team {
  id: number
  name: string
  description?: string
}

/** 成员 = 人或 Agent，同一张表（Worker 统一模型的存储形态） */
export interface TeamMember {
  id: number
  teamId: number
  kind: 'human' | 'agent'
  /** human: 下游账号（如 yongqing.zhao）；agent: 关联 agents 表 */
  refId: string
  /** human: 下游 realname；agent: 冗余 Agent 名（列表展示免 join） */
  displayName: string
  role: string
  joinedAt: number
}

// ---------- Agent 档案 ----------

export type AgentStatus = 'idle' | 'busy' | 'paused' | 'error'

export interface AgentProfile {
  id: number
  name: string
  /** 角色模板：planner/executor/tester/recorder/watcher/custom */
  role: string
  description?: string
  /** 能力声明（自由标签，供派活匹配） */
  capabilities: string[]
  /** 配备的 skills（名字列表，与 skills 目录对应；v2.1 生效） */
  skills: string[]
  /** RAG 2.0：预留位，第一版不实现 */
  ragEnabled: boolean
  ragCollections: string[]
  /** 挂靠人（权限上界）：下游账号 */
  ownerAccount: string
  /** LLM 配置（OpenAI 兼容；null=用系统默认） */
  llmBaseUrl?: string
  llmModel?: string
  status: AgentStatus
  createdAt: number
}

// ---------- 数据权限 ----------

export interface GroupPermission {
  groupId: number
  /** 允许查看该分组的账号（human 下游账号 / agent id 字符串）；空=仅负责人 */
  viewers: string[]
}

export const ARR_SPLIT = ','
export const parseTags = (s: string | undefined): string[] =>
  (s ?? '')
    .split(ARR_SPLIT)
    .map((x) => x.trim())
    .filter(Boolean)
export const joinTags = (arr: string[] | undefined): string => joinSafe(arr ?? [])
function joinSafe(arr: string[]): string {
  return arr.filter(Boolean).join(ARR_SPLIT)
}
