# 服务号占位配置版实现计划

> 按已批准的服务号方案执行，使用 executing-plans 与 test-driven-development 工作流；配置、模板示例均为占位，不向真实用户发消息。

**Goal:** 实现登录 UnionID、43 分粉丝同步、持久化发送任务和可替换模板配置。

**Architecture:** Nest Schedule + SQLite，现有 messages 同时保存发送快照；WechatOaModule 管理微信调用和粉丝，MessageModule 管理待发送任务；业务调用链不访问微信消息接口。

**Tech Stack:** NestJS、TypeORM、SQLite、Axios、Jest，不新增依赖。

**Spec:** `docs/wechat-official-account-push-design.md`

## Global Constraints

- 粉丝任务 `0 43 */2 * * *`，`Asia/Shanghai`。
- 默认 `OA_ENABLED=false`、`OA_SYNC_ENABLED=false`；指定单个调度实例。
- 微信 HTTP 不在 SQLite 写锁/事务内；写操作使用 transaction-runner。
- 六类订单/退款通知，服务号卡片跳首页；缺身份等待，超时不盲重发。
- 占位模板关键词可配置映射，不能声称与真实微信模板一致。
- 保留现有用户的环境文件及 gitignore 改动，工作在当前 feature 分支；本次不自动提交或部署。

## Review Focus

1. 分页失败或游标循环不能批量判退订。
2. 同步旧观测不能覆盖发送接口更新的退订状态。
3. 登录或粉丝 UnionID 冲突不能串号或阻止原登录。
4. 发送已受理但本地写回失败不能重发；领取后崩溃结果未知。
5. 占位/无效配置、关闭开关、旧消息不能产生真实发送。

### Task 1: 登录身份

Files: users 实体、repository、service、controller；`user-identity.spec.ts`。

Interface: `findOrCreateUser({wechatOpenId, wechatUnionId?}): Promise<User>`；可空 UnionID 与冲突标记。

- [x] 写 SQLite 集成测试：旧用户补齐、缺字段保留、同 OpenID 值冲突、UnionID 被另一用户占用、并发登录。
- [x] 运行 `node node_modules/jest/bin/jest.js --runInBand user-identity`，预期新增字段行为失败。
- [x] 串行事务中查/建/补齐身份，冲突冻结双方 OA 资格；controller 只接收微信响应的 UnionID。
- [x] 同命令验证通过。

### Task 2: 配置、微信客户端与粉丝同步

Files: `modules/wechat-oa/*`、粉丝与批次实体/repository；对应 spec。

Interfaces: `WechatOaClient.listFans(cursor) / getFanInfo(openids) / sendTemplate(payload, token)`；`WechatOaFanSyncService.sync()`；`WechatOaRepository.resolveRecipient(miniOpenId, oaAppId)`。

- [x] 写配置禁用/占位、token 并发刷新、批量响应校验测试；写粉丝完整/部分/空列表/重复游标/UnionID 冲突测试。
- [x] 运行 `node node_modules/jest/bin/jest.js --runInBand wechat-oa`，预期新模块缺失或行为失败。
- [x] 实现限时 HTTP、共享 token、粉丝批次与完整性校验、增量信息补全和 cron。
- [x] 同命令验证通过。

### Task 3: 持久化投递

Files: messages 实体/repository/service/module、`oa-message-policy.ts`、`oa-delivery.service.ts` 和 spec。

Interfaces: `prepareOaMessage(type, ctx, config, now)` 输出消息插入快照；`OaDeliveryService.run()` 消费 PENDING；repository 条件领取及结算。

- [x] 写落库快照、等待身份、成功受理、未关注、明确重试、UNKNOWN、重启恢复、去重测试。
- [x] 运行 `node node_modules/jest/bin/jest.js --runInBand oa-delivery`，预期新增投递行为失败。
- [x] 单次插入站内信与 OA 快照，后台每分钟消费并保存受理凭证；模板渲染失败仅影响 OA。
- [x] 同命令及原 message 测试通过。

### Task 4: 集成、迁移与交付

Files: app.module、日志脱敏、`.env.example`、占位模板 JSON、生产 SQL、运行说明。

- [x] 为 UnionID 脱敏与 SQL 升级增加验证。
- [x] 完成模块注册、占位模板六类映射、独立同步/发送开关、生产 SQL 和联调步骤。
- [x] 运行完整 Jest、诊断测试、TypeScript 构建与应用模块装配测试。
- [x] 独立审查关注同步/身份隔离/失败语义，修复实际问题并验证。

## 执行记录

- 已读取 spec 与现有代码。Ruling: 使用当前 feature 分支，保留用户暂存的环境清理；不进行 git 提交，避免夹带用户变更。
- Ruling: 拆分 OA_SYNC_ENABLED 与 OA_ENABLED，修正原方案“关闭发送时先同步”的开关矛盾。
- Ruling: 用户授权占位实现；真实微信规则/账号权限仍是上线联调项，自动测试用内存 SQLite 与模拟 HTTP 验证，不访问真实微信。
- 核心身份、同步、投递和脱敏测试先观察失败后实现；最终 `npm test`：32 个 Jest 套件、414 项测试通过，诊断测试 15/15 通过。HTTP 鉴权用例需要本机临时监听端口，完整测试在允许该操作的环境执行。
- `npm run build` 通过；应用模块装配与生产 SQL 升级验证均包含在测试中。SQL 仅操作内存测试库，没有迁移真实数据库。
- 独立审查未发现 Critical / Important；模板占位缺少可见诊断的 Minor 已修复，并补充启动告警、状态接口字段与回归测试。
- 收尾自查修复：空白 msgid 保留 UNKNOWN；某条领取失败时通过 allSettled 等待其他在途任务，防止提前释放 worker 运行锁。两项均先复现失败再修正，审查复核通过。
- 保留用户原有环境清理和 gitignore 变更；未提交、部署或调用真实微信。上线待办见 `docs/wechat-oa-runbook.md`。
