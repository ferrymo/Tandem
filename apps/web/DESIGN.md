---
name: Tandem
description: 当前登录、协作外壳、空间成员与 T 组界面的实现记录
colors:
  primary: '#3964fe'
  primary-soft: '#eef2ff'
  text: '#0f1115'
  text-secondary: '#626b78'
  background: '#f9fafb'
  surface: '#ffffff'
  divider: '#e9eaf0'
  control-border: '#81858c'
  success-marker: '#22c55e'
  success-text: '#15803d'
  warning-marker: '#f59e0b'
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
  secondary:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
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
    rounded: '{rounded.control}'
    height: '36px'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    rounded: '{rounded.control}'
    height: '36px'
  navigation-current:
    backgroundColor: '{colors.primary-soft}'
    textColor: '{colors.text}'
    rounded: '{rounded.control}'
    padding: '8px 12px'
  content-panel:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    rounded: '{rounded.surface}'
    padding: '24px'
---

# Design System: Tandem

## Overview

**Creative North Star: "Operate 工具界面"**

紧凑的蓝白协作工具界面，以文字、成员行、细分隔线和留白组织工作信息。产品、架构及视觉权威分别是 [01 产品设计](../../docs/01-产品设计文档.md)、[02 技术架构](../../docs/02-技术架构文档.md)、[03 设计规范](../../docs/03-设计规范.md)；本文件记录实际代码，不新增视觉决策。

当前 `/` 已提供协作账号登录、六入口外壳、工作空间创建与切换、空间成员管理和 T 组三角色展示；基础状态页迁至 `/health`。项目与任务读取、草案、Agent 执行、Skills/MCP 管理尚未开放，界面使用明确说明，不将入口或占位页视为功能完成。

**Key Characteristics:**

- 单一蓝色强调与白色内容面，信息密度服务于操作。
- 标题与正文同级字号，通过字重、间距及分隔线建立层级。
- 状态带文字；未配置、未知和未开放保留其真实含义。

## Colors

颜色取自 [`src/app/tokens.css`](src/app/tokens.css)。上述 frontmatter 是本记录的 token 摘录，CSS 为运行时来源；[`Providers`](src/components/providers.tsx) 读取 CSS 变量并映射 antd 主题，不在页面另配近似色。

### Primary

主蓝用于主操作、链接、输入光标和焦点；浅蓝用于当前导航背景及文本选区。当前导航另以文字字重、左侧指示线和 `aria-current` 标识选中状态。

### Neutral

页面浅底承托白色内容面。正文、辅助说明分层，浅分隔线划分内容；控件边框使用较深中性色以保持边界可辨。

成功标记与成功文字用于已核验身份和成功回执，警示标记用于待配置，错误文字用于失败与权限问题。状态点是辅助提示，不承担完整状态表达。

**The Text State Rule.** 颜色必须伴随明确文字；T 组的“待配置”不能改写成空闲、运行或已完成。

## Typography

全界面使用 frontmatter 中的 Inter 与系统中文无衬线回退栈。标题与正文保持同一字号，标题加重；表单标签与导航选中项使用中等字重（500），辅助文字使用较小字号。成员 ID 使用 `ui-monospace, Consolas, monospace`，允许选择与换行。

**The Compact Hierarchy Rule.** 通过字重、分节和留白建立层级，不为当前工作台增加大展示标题；说明正文限制在可阅读行长（72ch）内。

## Layout

桌面采用固定侧栏（208px）与顶部栏（56px）；内容位于侧栏右侧，最大宽度（1440px）。内容外边距与面内留白采用 `space-6`，窄桌面改为 `space-4`。导航固定为：关注、Agents、任务、观察、连接、能力。

登录页是单列表单，容器最大宽度（440px），桌面页头高（64px），表单上方保留空间；不叠加营销面板。工作台页首为入口标题、当前空间及角色，右侧提供“空间成员”；空间与账号操作位于顶栏。

宽度不超过（1279px）时缩小内容及顶栏横向间距；不超过（959px）时侧栏折叠为菜单，内容取消左侧占位。菜单按钮为触屏目标（44×44px），带展开状态与关联导航；选择入口或按 Escape 后收起，并恢复适当焦点。

宽度不超过（639px）时，按钮和表单控件最小高度（44px），导航行最小高度（44px）；Agent 状态换至描述下方，账号及连接详情改为单列。顶部隐藏新建空间按钮，但“我的账号”和无空间空态保留创建入口。长名称、ID 和错误允许换行。

## Elevation & Depth

界面无阴影、渐变或装饰光效，使用底色、细边框和间距区分内容层。antd 主题关闭阴影与动效；减少动态效果设置下禁用 CSS 过渡。加载使用静态占位行，不制造进度百分比。

**The Flat Surface Rule.** 内容面与成员行保持平面层级，焦点使用清晰轮廓，不用阴影代替。

## Shapes

按钮、输入和导航使用控件圆角，独立内容面使用稍大的面圆角，数值见 frontmatter。常规控件高度见组件 token，窄屏遵循上述触屏规则。状态点为小圆点（6px）；导航与 Agent 使用线性 SVG 图标，装饰图标对辅助技术隐藏。

## Components

### 登录与表单

登录表单使用可见标签、账号与密码自动填充语义和单个主按钮。请求中禁用输入并显示按钮 loading，失败就地提示，提交后清空密码。身份连接未配置、服务连接失败与登录失败分别说明，并提供对应重试操作；产品没有模拟登录入口。

### 外壳与导航

导航保持文字与图标同行，默认辅助文字色，悬停以页面底色和正文色加强；选中态遵循 Colors。URL 保存当前入口与空间，可前进后退。跳转链接可直接进入主内容，键盘焦点使用主色轮廓（2px，偏移 4px）。切换空间、会话失效或撤权后清除旧范围内容，读取中显示占位，失败提供重试。

### 内容面与 T 组

内容面用白底、细边框和统一留白组织独立内容，成员使用分隔行。T 组展示挂靠人、模板版本及三个真实角色：产品设计师负责需求、体验和验收；技术架构师负责技术与部署设计及复核；研发工程师负责开发、测试、修复及获批部署执行。职责文本来自服务端模板。

团队及成员当前均为“待配置”。关注页说明模型、项目授权与执行环境缺失；Agents 页说明执行条件以及尚未开始的运行与交付物，不展示虚构预算、负载或运行进度。任务、观察、能力页说明未开放或缺少事实依据；连接页分别展示账号已验证和项目/任务读取尚未开放。

### 空间与成员对话框

创建空间是单列表单，说明自动建立 T 组但不授予项目权限或启动运行。成员对话框默认宽（640px），展示成员及空间角色；可管理项按当前角色显示，读取、提交、成功与失败均有明确反馈。

移除成员先在对话框内展示目标成员、目标空间、权限影响与资产保留说明；焦点先落在“保留成员”，只有点击“移出空间”才提交。请求中禁用重复操作。账号对话框提供成员 ID、复制反馈和退出登录。

### 本轮验证范围

本轮记录包含 51 项单元测试、PG 集成、生产构建、真实生产 HTTP 链路回归、16 项桌面/手机浏览器测试，以及生产 API 的浏览器链路。浏览器和截图使用隔离数据库与测试协作服务；尚未进行真实协作站点联调，不能据此声称完成生产部署或全产品验收。

桌面、手机、登录及成员确认截图位于根目录 `.impeccable/review/`。`zoom.png` 是（683×384）视口的等效 reflow 检查，不是真实浏览器 200% 缩放。独立复核的最终通过结论仅覆盖导航按钮宽度与移出成员确认两项修复；屏幕阅读器实际播报和真实浏览器缩放未验证。

## Do's and Don'ts

### Do:

- **Do** 使用 CSS token 和统一 antd 映射，并保留紧凑字级、平面内容和可见焦点。
- **Do** 按真实权限显示操作，清楚呈现读取中、失败、撤权、待配置和未开放状态。
- **Do** 保留空间、挂靠人、模板版本及真实职责，窄屏保持文字与操作可读。

### Don't:

- **Don't** 将六入口外壳、账号已验证或基础健康就绪标成业务功能、项目授权或部署交付完成。
- **Don't** 用零值、成功色、空闲标签、虚构预算或运行记录填补未知状态。
- **Don't** 在当前体系增加阴影、渐变、大展示标题或第四个默认 Agent 角色。
