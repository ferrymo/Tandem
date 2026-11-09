/** 禅道对象的最小字段集（SDK 只声明用到的字段，其余原样透传） */

export interface ZtProgram {
  id: number
  name: string
  parent: number
  status: string
  begin: string
  end: string
  progress: string
}

export interface ZtProject {
  id: number
  name: string
  code: string
  status: string
  model: string
  parent: number
  begin: string
  end: string
  progress: string
  pm?: string
  delay?: number
}

export interface ZtExecution {
  id: number
  name: string
  project: number
  status: string
  type: string
  begin: string
  end: string
  progress: string
  delay?: number
}

export interface ZtTask {
  id: number
  name: string
  project: number
  execution: number
  parent: number
  status: 'wait' | 'doing' | 'done' | 'closed' | 'cancel' | 'pause' | string
  pri: number
  type: string
  estimate: string
  consumed: string
  left: string
  deadline: string
  estStarted: string
  assignedTo: { account: string; realname: string } | null
  story?: number
  desc?: string
  color?: string
}

export interface ZtUser {
  id: number
  account: string
  realname: string
  dept: number
  role: string
  email: string
}

export interface ZtPage<T> {
  page: number
  total: number
  limit: number
}

export class ZentaoError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message)
    this.name = 'ZentaoError'
  }
}

/** 禅道强制改密导致网页会话不可用（记工时依赖网页桥接） */
export class PasswordChangeRequiredError extends Error {
  constructor() {
    super('禅道要求先修改密码，网页会话不可用')
    this.name = 'PasswordChangeRequiredError'
  }
}
