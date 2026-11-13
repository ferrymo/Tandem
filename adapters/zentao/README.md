# zentao

`ZentaoIdentityProvider` 实现协作账号身份验证。应用入口注入固定站点地址、连接标识和指挥官账号白名单；产品层只接收统一身份，不接触厂商字段。

- 登录通过 REST v1 `POST /tokens` 换取本人令牌，再调用 `GET /user` 验证当前用户。稳定身份使用服务端用户 ID。
- 每次会话核验重新读取当前用户；游客、删除账号、身份不匹配和失效令牌均拒绝。上游原始错误不进入响应。
- 创建工作空间权限仅取部署端账号白名单，精确匹配当前用户账号；不把职务名称或管理员标记当作团队负责人资格。
- 默认只接受 HTTPS。受信内网站点使用 HTTP 时须由部署端显式启用；禁止 URL 凭证、查询参数及片段。请求禁止重定向，8 秒超时，响应上限 256 KiB。
- 密码只用于单次令牌交换，不记录日志。令牌由调用方加密保存，适配器不持久化业务数据。

协议依据：[令牌入口](https://github.com/easysoft/zentaopms/blob/main/api/v1/entries/tokens.php)、[当前用户入口](https://github.com/easysoft/zentaopms/blob/main/api/v1/entries/user.php)、[路由](https://github.com/easysoft/zentaopms/blob/main/config/apiv1.php)、[Token 请求头](https://github.com/easysoft/zentaopms/blob/main/framework/base/router.class.php)。

当前包含身份验证；项目、任务读取及外部写入尚未实现。单元测试使用 HTTP 替身，真实部署版本须再做只读联调。
