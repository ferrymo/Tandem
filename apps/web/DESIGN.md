---
name: Tandem
description: 六入口协作工作台、任务草案、T 组运行与能力管理的当前视觉系统
colors:
  primary: '#3964fe'
  primary-soft: '#eef2ff'
  text: '#0f1115'
  text-secondary: '#626b78'
  neutral-muted: '#81858c'
  background: '#f9fafb'
  surface: '#ffffff'
  divider: '#e9eaf0'
  control-border: '#81858c'
  success-marker: '#22c55e'
  success-text: '#15803d'
  warning-marker: '#f59e0b'
  warning-text: '#a16207'
  danger-marker: '#ef4444'
  danger-text: '#b42318'
typography:
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    fontSize: '14px'
    fontWeight: 600
    lineHeight: 1.6
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    fontSize: '14px'
    fontWeight: 500
    lineHeight: 1.6
  secondary:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.6
  code:
    fontFamily: 'ui-monospace, Consolas, monospace'
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: '6px'
  surface: '8px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '6': '24px'
  '8': '32px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.surface}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    height: '36px'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    height: '36px'
  button-text:
    textColor: '{colors.primary}'
    typography: '{typography.body}'
    padding: '0'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    height: '36px'
  navigation-current:
    backgroundColor: '{colors.primary-soft}'
    textColor: '{colors.text}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '8px 12px'
  content-panel:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    rounded: '{rounded.surface}'
    padding: '24px'
  state-label:
    textColor: '{colors.text-secondary}'
    typography: '{typography.secondary}'
  disclosure:
    textColor: '{colors.text}'
    typography: '{typography.body}'
    padding: '8px 0'
---

# Design System: Tandem

## Overview

**Creative North Star: "Operate 工具界面"**

紧凑的蓝白协作工具界面，以文字、分隔行、细边界和留白组织工作信息。层级服务于扫描、审阅与操作；主色提示行动和选择，内容面保持平静。产品和视觉权威见 [PRODUCT.md](PRODUCT.md) 与 [03 设计规范](../../docs/03-设计规范.md)，本文件提取当前实现，不新增视觉方向。

同一体系覆盖登录、空间成员、六入口、任务列表/看板、草案审阅、运行详情及 Skills/MCP 管理。状态来自授权范围内的事实和持久化记录，版本、执行身份、回执及证据比装饰性统计更重要。功能与真实验收边界集中在 [07 一期实现与验收](../../docs/07-一期实现与验收.md)，不将模型待配置或本地演示发布描述为生产交付完成。

**Key Characteristics:**

- 单一蓝色强调与白色内容面，信息密度服务于操作。
- 标题与正文同级字号，通过字重、间距及分隔线建立层级。
- 状态带文字，配置、授权、审批、执行和交付各有明确含义。
- 列表、详情、表单沿用同一组 token，窄屏保留完整范围和操作。

## Colors

颜色来自 [`src/app/tokens.css`](src/app/tokens.css)，本文件 frontmatter 为规范化摘录。运行时由 [`Providers`](src/components/providers.tsx) 读取 CSS 变量并映射 antd 6 主题；页面复用这些变量，控件交互色由同一主题派生。

### Primary

**主蓝**用于主操作、链接、选择和焦点；**浅蓝选中底**用于当前导航和文本选区。导航选中项同时使用正文色、中等字重、左侧指示线及 `aria-current`，不依赖背景色独自表达当前位置。

### Neutral

**页面底**承托**白色内容面**；**正文**与**辅助文字**区分阅读层级。**分隔线**划分非交互内容，**控件边框**保持输入边界可辨。中性标记色不代替需要阅读的辅助文字。

成功、警示和危险分别具有标记色与文字色；状态点仅辅助文字。执行成功和已交付使用成功文字，失败、退回与结果未知使用危险文字；待配置仍明确显示其原因。

**The Text State Rule.** 状态必须可用文字理解；已批准不等于执行成功，模型已配置不等于运行完成，未知不能填零。

## Typography

标题、正文与标签共用 Inter 和系统中文无衬线回退栈，不使用展示字体。标题加重、标签与当前导航使用中等字重，辅助文字缩小一档；具体字级与字重见 frontmatter。ID、版本和代码使用系统等宽栈，表格与分页使用等宽数字。

空态说明与纯文本说明保留可阅读行长（72ch）；长名称、ID、错误和工具 schema 可换行。文档内容保留原始换行并采用较松行高（1.7），不将正文渲染成代码截图。

**The Compact Hierarchy Rule.** 用位置、字重、分节和留白建立层级，不靠大展示标题或巨大数字挤占工作台首屏。

## Layout

桌面采用固定侧栏（208px）和顶部栏（56px），内容最大宽度（1440px）。主内容外边距及内容面默认使用 `space-6`；工具栏和行操作可换行。六入口固定为关注、Agents、任务、观察、连接、能力；项目范围位于业务内容前，空间和账号位于顶栏。

宽度不超过（1279px）时收紧内容和顶栏横向间距；不超过（959px）时侧栏改为可展开菜单，取消内容左侧占位。菜单按钮具有展开状态和关联导航，选择入口或按 Escape 后关闭。宽度不超过（639px）时表单双列改为单列、详情字段上下排列，按钮、输入、选择、披露标题及主要文本操作的触屏高度至少（44px）。内容面留白收紧为 `space-4`，长内容继续纵向滚动。

任务列表使用表格及容器内横向滚动，任务看板按状态分列并可水平滚动；这是任务视图的布局，不规定其他模块必须使用看板。代码、工具 schema 与文件名在各自容器内处理长内容，不撑宽整页。登录保持单列表单，最大宽度（440px），不附加营销区。

## Elevation & Depth

界面没有阴影、渐变、玻璃质感或装饰光效。通过页面底、白色内容面、细线与空间建立层级；antd 主题关闭阴影和动效，CSS 的减少动态效果规则禁用过渡。加载使用静态占位行，进度不制造百分比。

**The Flat Surface Rule.** 用边界和位置表达层次；键盘焦点使用主色轮廓（2px，偏移 4px），不用阴影模拟焦点。

## Shapes

控件和导航使用较小圆角，独立内容面使用稍大的面圆角；数值见 frontmatter。内容列表多采用平面分隔行，不为每个字段增加容器。状态点为小圆点（6px），线性 SVG 图标保持同一风格，装饰图标对辅助技术隐藏。

## Components

### Buttons

主操作使用实心主蓝，次操作使用白底和可辨边界，文字操作使用主蓝；危险动作使用危险语义。常规尺寸见 frontmatter，窄屏遵循 Layout 的触屏尺寸。hover/active 沿用 antd 主题派生色或文本下划线，键盘焦点统一使用轮廓。请求中显示 loading 并限制重复提交，失败原因留在内容区。

### Inputs / Fields

标签常驻，帮助、校验和错误与字段就近展示；placeholder 不替代标签。登录具有账号与密码自动填充语义，不提供模拟身份。敏感凭据不回显，保存失败需要重新输入时明确说明。非敏感编辑在失败后保留内容。

任务线程、任务/状态/工时草案、技能安装、工具服务及团队配置统一使用 [`useUnsavedChanges`](src/components/use-unsaved-changes.tsx)：关闭或应用内切换时，未保存内容先询问，默认“继续编辑”；成功保存直接关闭。刷新离开使用浏览器原生提示。有索引的浏览器历史先确认再切换，旧历史无法确定偏移时保留表单并提供恢复说明。空间切换已接入同一入口，但当前单授权空间下尚未完成实际交互验证。

### Navigation

导航文字和线性图标同行，默认辅助色，悬停使用页面底与正文色。URL 保留入口与空间，支持前进后退；跳转链接可直达主内容。切换范围时旧请求不能覆盖新范围，失效或撤权后清除敏感详情。空间、项目和账号操作均需经过未保存保护后再离开编辑上下文。

### Cards / Containers

白底内容面使用细边框和统一留白；列表、线程、草案及能力条目使用分隔行。区块标题与对应动作对齐，辅助说明就近显示。当前任务的列表、看板和详情可共享任务名称、状态、负责人和来源，不要求所有内容采用同一种排列。

### Status / Empty / Error

状态标签保持文字可读，不使用仅靠颜色区分的胶囊。草案展示待审阅、已批准等待执行、执行中、成功、失败、退回及结果未知；运行单独展示阶段、配置/授权/决策阻塞、暂停及交付状态。观察页的运行计数来自已读取记录，人员负载缺少完整容量与日历依据时显示待评估。

首次读取采用静态占位；错误提供就地原因和“重新读取”。空态区分尚无授权项目、没有任务、筛选无结果、尚未安装能力和还没有运行。缺少有效时间显示“待记录”，不伪造日期。异步回执决定写入结果，按钮点击不直接生成成功状态。

### Drawers / Dialogs

任务和运行详情使用抽屉保留列表上下文；必要输入、配置及确认使用对话框。标题描述对象与目的，常用主次按钮明确，长表单允许滚动到末尾操作。成员移除确认显示目标、影响和资产保留说明，焦点先落在保留操作；未保存确认默认继续编辑。未提交的关闭动作统一走同一保护入口。

### Draft / Delivery Evidence

草案行展示版本、更新时间、具体操作、执行身份、审批记录及回执，详细证据可展开。修改产生新版本后重新审阅；结果未知保留核对入口。任务、运行、草案和产物保持独立名称，不合并成含糊的完成标签。

运行详情通过页签组织阶段、事件、文档、预算和交付物。产物区包含可用预览、ZIP 下载、文件清单、验证证据及模拟范围；本地演示发布、部署批准、健康检查和回滚分别显示。模型输出结束或构建通过均不单独证明交付完成。

### Skills / MCP

能力页使用 Skills、MCP Server、当前项目使用记录页签。技能披露项展示来源、固定版本、资源、权限和绑定，安装、启用与绑定分别表达。MCP 连接测试、服务启停、本人凭据、工具分类和逐项目/角色授权分别表达；连接成功不代表工具全部可调用。长 schema/工具内容在限高区域内滚动，凭据使用掩码或配置状态，不能进入截图样例。

## Do's and Don'ts

### Do:

- **Do** 复用 CSS token 与 antd 主题映射，保持紧凑字级、平面内容和可见焦点。
- **Do** 按真实权限和回执呈现状态，保留来源、执行身份、版本、更新时间及证据。
- **Do** 为关闭、导航和历史切换保留未保存内容，默认继续编辑，保存成功后正常关闭。
- **Do** 在窄屏保留完整审批范围、长内容和可达操作，使用局部滚动处理复杂内容。

### Don't:

- **Don't** 用未知零值、虚构负载、预置成功记录或“已批准”代替实际运行与执行证据。
- **Don't** 把模型待配置、管理链路验证或本地演示发布写成真实模型和生产交付已验收。
- **Don't** 增加阴影、渐变、巨大展示标题或第四个默认 Agent 角色。
- **Don't** 将任务看板的分列方式或单个页面的组合推广成全局布局要求。
