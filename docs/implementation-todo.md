# 实现跟踪文档（nest 仓库）

本仓库范围内按设计文档实现的工作清单。fctl（小程序）与 admin（管理后台）在各自仓库中另行实现，此处只记 TODO。

- 设计文档依据：`docs/superpowers/specs/` 下 `2026-08-11-payment-reliability-design.md`、`2026-08-11-logging-design.md`、`2026-08-11-migration-setup.md`、`2026-08-11-interface-contract.md`。
- 实现原则：只实现文档明确定义的部分；实现决策与待确认问题都记录在下方「实现说明与待确认问题」中，不擅自扩展设计。
- **schema 变更方式（重要决策）**：**不引入 TypeORM migration runner**（migration-setup.md 已声明废弃）。生产 `synchronize=false` 下所有 schema 变更通过**手工 SQL 执行**，SQL 全部记录在本文档「生产 schema 变更 SQL（手工执行）」章节。`app.module.ts` 保持 `synchronize: NODE_ENV !== 'production'` 不变。

## 状态图例

- [x] 已完成并验证
- [ ] 待实现
- [~] 部分完成 / 有依赖
- [!] 被待确认问题阻塞

## 生产 schema 变更 SQL（手工执行）

> 上线时在服务器部署目录下执行（库文件在 `data/` 下；若直接 cd 到库所在目录，把 `data/prod.db` 换成 `prod.db` 即可）。**不影响现有数据**：全部为加列、加索引、建新表，不修改、不删除、不迁移任何已有数据。执行前先备份 prod.db。
>
> 开发环境（NODE_ENV=development）`synchronize=true`，会自动同步 schema，无需手工执行。

### 1. bookings 表新增对账调度字段（5 个列）

```bash
sqlite3 data/prod.db "ALTER TABLE bookings ADD COLUMN reconcileKind varchar; ALTER TABLE bookings ADD COLUMN reconcileNextAt integer; ALTER TABLE bookings ADD COLUMN reconcileAttempts integer NOT NULL DEFAULT 0; ALTER TABLE bookings ADD COLUMN reconcileLastAt integer; ALTER TABLE bookings ADD COLUMN reconcileLastErrorCode varchar;"
```

字段含义：`reconcileKind`（payment | refund | close | null）、`reconcileNextAt`（下次对账时间，毫秒 epoch，null 表示未排期）、`reconcileAttempts`（连续失败次数）、`reconcileLastAt`（最近对账时间）、`reconcileLastErrorCode`（最近稳定错误码）。

### 2. bookings 新增复合索引（3 个）

```bash
sqlite3 data/prod.db "CREATE INDEX idx_bookings_reconcile ON bookings (reconcileKind, reconcileNextAt); CREATE INDEX idx_bookings_payment_expired ON bookings (paymentStatus, paymentExpiredAt); CREATE INDEX idx_bookings_status_date ON bookings (status, bookingDate);"
```

### 3. 新建 booking_anomalies 异常订单表

```bash
sqlite3 data/prod.db "CREATE TABLE booking_anomalies (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    bookingId varchar NOT NULL,
    type varchar NOT NULL,
    status varchar NOT NULL DEFAULT ('OPEN'),
    firstSeenAt integer NOT NULL,
    lastSeenAt integer NOT NULL,
    occurrenceCount integer NOT NULL DEFAULT (1),
    lastErrorCode varchar,
    lastErrorSummary varchar,
    nextRetryAt integer,
    resolvedAt integer,
    resolution varchar
); CREATE UNIQUE INDEX IDX_anomaly_booking_type ON booking_anomalies (bookingId, type); CREATE INDEX IDX_anomaly_status_retry ON booking_anomalies (status, nextRetryAt);"
```

`status` 取值：`OPEN`（待处理）| `RESOLVED`（已解决）| `IGNORED`（人工忽略）。

### 4. 已有待处理订单补齐调度字段（一次性，只补 reconcileNextAt IS NULL 的记录）

```bash
sqlite3 data/prod.db "UPDATE bookings SET reconcileKind = 'payment', reconcileNextAt = (strftime('%s','now')*1000) WHERE paymentStatus = 'paying' AND reconcileNextAt IS NULL; UPDATE bookings SET reconcileKind = 'refund', reconcileNextAt = (strftime('%s','now')*1000) WHERE refundStatus = 'refunding' AND reconcileNextAt IS NULL;"
```

> 只补 `reconcileNextAt IS NULL`，不覆盖人工暂停的订单。注意退款走 `refundStatus` 字段（与 `paymentStatus` 区分）。
> 已过期未关单的订单（paymentExpiredAt 已过）不在上述补齐范围，由支付超时关单任务的发现步骤兜住，见待确认问题 1。

### 5. logs.db 初始化（独立文件，首次自动创建空库）

```bash
sqlite3 data/logs.db "CREATE TABLE app_logs (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    logId varchar NOT NULL,
    source varchar NOT NULL,
    level varchar NOT NULL,
    category varchar NOT NULL,
    message varchar NOT NULL,
    requestId varchar,
    sessionId varchar,
    route varchar,
    contextJson text,
    appVersion varchar,
    platform varchar,
    clientCreatedAt integer,
    createdAt integer NOT NULL
); CREATE UNIQUE INDEX IDX_app_logs_logId ON app_logs (logId); CREATE INDEX IDX_app_logs_created_level ON app_logs (createdAt, level); CREATE INDEX IDX_app_logs_source_created ON app_logs (source, createdAt); CREATE INDEX IDX_app_logs_category_created ON app_logs (category, createdAt); CREATE INDEX IDX_app_logs_requestId ON app_logs (requestId); CREATE INDEX IDX_app_logs_sessionId ON app_logs (sessionId);"
```

> 删除或损坏 logs.db 时日志功能降级到 stdout，不影响 prod.db 的预约和支付。禁止把 `LOG_DATABASE_PATH` 与 `DATABASE_PATH` 配成同一文件。

### 6. 回滚（如上线后发现问题需要撤销本期 schema 变更）

```bash
sqlite3 data/prod.db "DROP TABLE booking_anomalies; DROP INDEX idx_bookings_status_date; DROP INDEX idx_bookings_payment_expired; DROP INDEX idx_bookings_reconcile; ALTER TABLE bookings DROP COLUMN reconcileLastErrorCode; ALTER TABLE bookings DROP COLUMN reconcileLastAt; ALTER TABLE bookings DROP COLUMN reconcileAttempts; ALTER TABLE bookings DROP COLUMN reconcileNextAt; ALTER TABLE bookings DROP COLUMN reconcileKind;"
```

> 回滚会丢弃补齐的调度字段值（只影响本期新增数据，不影响原有列与订单数据）。SQLite 3.35+ 支持 `DROP COLUMN`。

## 支付可靠性（payment-reliability-design.md）

### Repository（interface-contract.md「BookingRepository」节）

- [x] 候选查询统一为 `findReconcileCandidates(kind, now, limit=20)`（payment=PAYING 未过期 / refund=REFUNDING / close=UNPAID/PAYING 已过期；按 reconcileNextAt, id 升序；替换原 getRefundingOrders / getPayingOrders / getPaymentTimeoutOrders 三个无上限查询）
- [x] `updatePaymentTimeoutOrders`：废弃删除（改为 findReconcileCandidates('close') + markPaymentClosed 按 processedBookingIds 更新）
- [x] `updatePaymentStatus`：读改写 `save()` → 由 markPaymentStarting 等条件 UPDATE 取代
- [x] `updatePaymentStatusByOutTradeNo`：由 markPaymentSucceeded（含 expectedStatus 条件 + 清调度字段）取代
- [x] `updateRefundStatus`：由 markRefundStarting / markRefundSucceeded / markRefundFailed 条件 UPDATE 取代
- [x] 新增：`findReconcileCandidates / markPaymentStarting / markPaymentSucceeded / markPaymentClosed / upsertAnomaly / findOpenAnomalies / resolveAnomaly`
- [x] 转换协议其余动作条件更新原语（markPaymentStartRejected / markPaymentResultUnknown / reschedulePaymentCheck / markPaymentFailed / markCloseDue / markRefundStarting / markRefundSucceeded / rescheduleRefundCheck / escalateReconciliationAnomaly / markRefundResultUnknown / rescheduleAnomalyRetry）

### WechatPayService（interface-contract.md「WechatPayService」节）

- [x] `createPayment(outTradeNo, amount, description, openid, paymentExpiredAt, signal?)`：不再自行生成单号
- [x] `closeOrder(outTradeNo, opts?)` → `CloseOrderResult`（CLOSED / ALREADY_CLOSED / ALREADY_PAID / UNKNOWN），不再吞错误（ORDER_PAID→ALREADY_PAID；ORDER_CLOSED/ORDER_NOT_EXIST→ALREADY_CLOSED；其余→UNKNOWN）
- [x] `queryOrder` / `queryRefund`：结构化结果（含 NOT_EXIST / USERPAYING 分类），不抛异常
- [x] HTTPS Agent 隔离：`interactiveAgent`（maxSockets=5，用户支付/重试关单/退款）+ `reconciliationAgent`（maxSockets=2，后台对账）
- [x] `request()` 支持 `AbortSignal`（abort/超时统一转 `PAYMENT_PREPARATION_TIMEOUT`）
- [x] `handlePaymentSuccess` → 调 repository.markPaymentSucceeded（条件更新 + 清调度）；`handleRefundCallback` → markRefundSucceeded/markRefundFailed

### BookingService（interface-contract.md「BookingService」节）

- [x] `initiatePayment` 改造为 single-flight + 22 秒整体预算（AbortController）+ 30 秒结果缓存（含 outTradeNo 校验）+ 固定执行顺序 10 步
- [x] 12 个命名转换动作（薄包装 repository 条件更新，供 initiatePayment 与定时任务调用）
- [x] `initiateRefund` 改造（markRefundStarting 条件 UPDATE 防并发重复退款）
- [x] `handleCron` 拆分为 5 个独立 `@Cron`（分钟表 + timeZone Asia/Shanghai + 独立运行标记）
- [x] 全局并发信号量（微信任务共享上限 2，异常任务自身上限 1）
- [x] FIFO 写回队列 + 单 SQLite writer（外部并发 2 / 写库串行，任务结束前等待排空）
- [x] 每任务运行时间预算（60 秒）
- [x] 超时关单：发现（markCloseDue 扫描）+ 按 `processedBookingIds` 条件更新
- [x] 异常订单任务：`OPEN + nextRetryAt<=now` 每批 5 条，30 分钟起步最长 2 小时退避，成功后自动 RESOLVED
- [x] 异常记录清理：每周日 `03:16`，RESOLVED/IGNORED 保留 365 天，每批 100 条、单轮 10 批（只删异常工作记录，不修改订单）
- [x] 历史订单任务：每小时 `:13`，保留批量 UPDATE

## 日志模块（logging-design.md）

- [x] `AppLog` entity（logs.db，`app_logs` 表，建表 SQL 见上）
- [x] 命名 `logs` 的 DataSource（`LOG_DATABASE_PATH`，只注册 AppLog，无条件 `synchronize: false`）
- [x] `AppLogWriter` 接口 + 进程内串行 writer 队列（500 条 / 20 条或 5 秒刷盘 / 级别淘汰 / 失败不阻断业务）
- [x] `persistClientBatch`（等 writer 3 秒，INSERT OR IGNORE 幂等，成功才确认 acceptedLogIds）
- [x] `POST /client-logs/batch`（JwtAuthGuard / 最多 20 条 / bodyParser 192 KiB / 每用户每分钟 6 批 429 限流 / writer 忙返回 503）
- [x] `GET /admin/logs`（AdminAuthGuard / 来源/级别/分类/关键词/时间筛选 / pageSize 最大 100）
- [x] `GET /admin/logs/stats`（总量/按来源/按级别/最近错误数）
- [x] 敏感字段递归过滤（5 层 / 50 键 / 50 项 / 2000 字符 / 8 KiB / [MaxDepth] / [Circular] / truncated）
- [x] 每日清理任务（`03:21` Asia/Shanghai，每批 200 条、间隔 100ms、单轮 10 批，保留 30 天）
- [x] `logs.db` 512 MiB 监控告警（每小时检查，限频告警 + 触发时优先清理）
- [x] `APP_LOG_SQLITE_ENABLED` 开关（关闭时后端回退 Nest stdout，上报返回 503）
- [x] 启动时 `logs.db` schema 校验（表 + 6 个索引；失败禁用 SQLite 日志回退 stdout，不影响业务启动）
- [x] `main.ts` bodyParser 上限 192 KiB（保留 rawBody 供微信回调验签）
- [x] requestId 生成（AsyncLocalStorage 中间件，业务日志自动携带）

## 业务记录点（logging-design.md「首批记录点」）

- [x] 预约创建成功 / 容量不足 / 创建异常（booking.service.ts）
- [x] 发起支付：支付准备成功/失败阶段日志（bookingId、命中缓存/single-flight、旧单查询/关单/本地保存/微信下单耗时、稳定错误码、总耗时，同一 requestId）
- [x] 支付回调 / 退款回调处理结果（wechat-pay.controller.ts）
- [x] 退款申请成功 / 失败（booking.service.ts）
- [x] 预约核验成功或失败（booking.service.ts）
- [x] 定时任务完成摘要 / 分支失败（5 个任务，每轮一条）
- [x] 全局异常过滤器捕获的未处理异常（5xx，category=runtime，改为 APP_FILTER 注入 LoggingService）

## 接口响应（interface-contract.md「Controller 路由」）

- [x] `POST /bookings/:bookingId/pay` 响应结构保持兼容，错误响应携带稳定 `errorCode` 字段（见待确认问题 6）
- [x] `POST /wechat-pay/notify`、`GET /bookings/:bookingId/pay-status` 保持不变

## 其他仓库（TODO，不在本仓库实现）

- [ ] fctl：`utils/logger.js`、本地环形缓冲 100 条、批量上报、`paymentLaunching` 状态锁 + 25 秒超时、`handlePayment` 模块级 Promise
- [ ] admin：日志管理页面（筛选/列表/上下文展开/统计）
- [ ] 生产上线：执行上述手工 SQL（先备份 prod.db 与 logs.db 路径配置），验证业务接口

## 验证（已完成）

- [x] `npm run build` 通过
- [x] 生产模式空库启动冒烟：应用成功启动；logs.db 表缺失时 schema 校验失败 → SQLite 日志禁用并回退 stdout，业务不受影响；执行文档 SQL 后校验通过（6 个索引）
- [x] 路由注册验证：`GET /` 200、`POST /client-logs/batch` 无 token 401、`GET /admin/logs` 无 key 401
- [x] 手工 SQL 已在本地 `data/dev.db` 验证可执行、可回滚（列/索引/表均正确生成）
- [~] `npm test`：jest 通过；`test:diagnostics` 在本机 Node 22.12 下 1 项失败（见实现说明 9）
- [ ] 支付并发压测 / 停机恢复测试（上线前执行）

---

# 实现说明与待确认问题

## schema 变更方式（已定，不需要 migration runner）

**决策**：不引入 TypeORM migration runner，不创建 `data-source.ts` / `migrations/` / `migration:*` 脚本，不启用 `migrationsRun`。理由：

1. 生产 `synchronize=false` 下 schema 变更本来就靠手工 SQL，runner 只是多一层维护面（生成、审阅、执行、`migrations` 表），没有实际收益。
2. `migrationsRun: true` 若迁移失败会导致应用启动失败，整个支付服务不可用；手工 SQL 完全可控、可先备份。
3. 本期 schema 变更全部是加列/加索引/建新表，不改动现有数据，SQL 记录在本文档即可重复执行。
4. 已有生产数据不受影响：不复制、不重建、不重命名任何表，不修改现有列。

原 `migration-setup.md` 方案已声明废弃（仅作历史存档）。

## 待确认问题（需设计决策）

### 1. `markCloseDue` 发现步骤与 backfill 缺口（建议优先定）

- 定时任务表定义「支付超时关单」按 `reconcileKind='close' AND reconcileNextAt<=now` 取候选，但转换协议表里 `markCloseDue` 的旧状态条件是「UNPAID/PAYING 且已过期」——**谁把新过期的订单变成 `close` 候选，文档没有明确定义**。
- **已实现**：接口对照文档标注 `markCloseDue` 来自「超时任务（:491）」，因此超时任务实现为两步：①发现扫描 `paymentExpiredAt < now AND paymentStatus IN ('unpaid','paying')`（`markCloseDue` 批量条件 UPDATE 置 `kind='close', nextAt=now`）；②按 `kind='close'` 取候选处理。发现扫描不限制 reconcileKind，从而兜住：从未发起支付的过期订单（kind=NULL）、backfill 未覆盖的已过期订单、人工暂停后 nextAt 被清空的订单（会被重新激活，已知局限，见下）。
- 已知局限：人工暂停（清空调度字段 nextAt=NULL）的过期 PAYING 订单会被发现步骤重新拉回 close 通道，与异常通道形成双通道竞争。当前由条件 UPDATE 的 affected=0 兜底自洽（异常任务处理时发现状态已变则 RESOLVED）。**建议设计确认暂停语义**（如何区分「人工暂停」与「从未排期的过期订单」）。
- 手工 SQL 的 backfill 只补了 `paying→'payment'` 与 `refunding→'refund'`。建议上线 SQL 补一条 `paymentExpiredAt < now AND paymentStatus IN ('unpaid','paying') AND reconcileNextAt IS NULL → reconcileKind='close', reconcileNextAt=now`（当前实现依赖发现步骤兜底，补上更稳）。

### 2. `USERPAYING`（用户支付中）分支缺失 → 重试死循环

- 步骤 7 把微信查询结果归为「已支付 / 已关闭或不存在 / 未支付活动态 / 未知」，未区分 `NOTPAY` 与 `USERPAYING`。微信禁止关闭 USERPAYING 状态的单，`closeOrder` 必然明确失败 → `UNKNOWN` → `PAYMENT_RESULT_UNKNOWN` → 前端重试 → 循环，且每轮烧 2 次微信请求。
- **已实现（按文档路径）**：`queryOrder` 结构化结果保留 `trade_state` 原文（USERPAYING 单独分类），但 initiatePayment 当前按文档「未支付活动态 → closeOrder → UNKNOWN」路径处理 USERPAYING。建议设计拆分：`NOTPAY` → 走 closeOrder 换单；`USERPAYING` → 不做任何动作，返回稳定结果引导「支付进行中」，由回调和 5 分钟兜底接管（改一行 switch 分支即可）。

### 3. 异常类型 → 自动/人工恢复映射未定义

- 异常任务只处理「可自动恢复」的 `OPEN` 异常，但首批 7 种类型中哪些自动重试、哪些暂停等人工，设计未列出（仅 `PAYING_WITHOUT_OUT_TRADE_NO` 明确为人工处理）。
- **已实现**：`src/modules/booking/anomaly-policy.ts` 映射表，`PAYING_WITHOUT_OUT_TRADE_NO = manual`，其余 6 种默认 `auto`（异常重试动作：支付/退款/关单查询对齐、状态已变则 RESOLVED、仍不确定按 30min→2h 退避）。建议设计确认映射。
- 补充：微信下单「明确业务拒绝且未建单」的枚举列表设计未给出，实现取 `PARAM_ERROR / INVALID_REQUEST / NO_AUTH / MCH_NOT_EXISTS / APPID_MCHID_NOT_MATCH`（`PAYMENT_START_REJECTED_CODES`），建议设计确认。
- 附带问题：`markPaymentResultUnknown` 累加 `reconcileAttempts`，连续 3 次未知升级异常并从正常通道踢出；回调随后到达时自动 RESOLVED，但中间暂停正常对账，确认是否符合预期。

### 4. ~~`migrationsRun: true` 失败 = 应用启动失败~~（已解决：方案废弃）

已废弃 runner 方案，改为手工 SQL，不存在该风险。

### 5. `ALREADY_PAID` 时本地拿不到 `transactionId`

- `closeOrder` 返回 `ALREADY_PAID` 时 close 响应不含 `transaction_id`。
- **已实现（按文档「ALREADY_PAID 必须查询/推进本地支付成功」）**：`initiatePayment` 与超时关单任务收到 `ALREADY_PAID` 后先 `queryOrder` 补查一次拿 `transaction_id` 再 `markPaymentSucceeded`；补查失败时 `transactionId` 允许为 null（以回调为准，后续回调会补全）。

### 6. `POST /bookings/:bookingId/pay` 稳定错误码契约未定义

- 设计新增「已支付稳定结果」「PAYMENT_PREPARATION_TIMEOUT」「PAYMENT_RESULT_UNKNOWN」等分支，但错误码放哪个响应字段、HTTP 状态码用什么未约定。
- **已实现（最小落地）**：不改变 200 响应结构与现有 400 错误结构；错误响应新增 `errorCode` 字段（`src/common/payment-errors.ts`：ORDER_ALREADY_PAID / PAYMENT_PREPARATION_TIMEOUT / PAYMENT_RESULT_UNKNOWN / PAYMENT_START_REJECTED / CLOSE_ORDER_UNKNOWN / CLOSE_ORDER_ALREADY_PAID / QUERY_ORDER_UNKNOWN / QUERY_REFUND_UNKNOWN），`message` 保持中文。建议在接口文档正式约定。

### 7. logs.db 的 schema 版本管理

- 按手工 SQL 原则，`app_logs` 后续结构变化同样走本文档记录 + 手工执行，不引入额外机制。本期：初始化 SQL（上文第 5 节）+ 启动 schema 校验（表 + 6 索引存在性，失败禁用日志回退 stdout）。

### 8. `extra.pragma` 被 sqlite3 驱动静默忽略（现状说明，非本期改动）

- 实测 `node_modules/typeorm/driver/sqlite/SqliteDriver.js`：`type: 'sqlite'` 只识别顶层 `enableWAL` / `busyTimeout` 选项，**`extra.pragma` 完全不生效**。线上实际为：无 WAL、busy_timeout=0、synchronous FULL（诊断脚本 `TYPEORM_PRAGMA_CONFIGURATION_IGNORED` 已证实）。
- **本期按设计不调整**；`logs` DataSource 同样不写无效 pragma。以后如需 busy_timeout，用顶层 `busyTimeout` 选项或连接后 PRAGMA，不能用 `extra.pragma`。

### 9. 批量上报重复 `logId` 的幂等语义

- `logId` 唯一索引保证不产生重复记录。**已实现**：`persistClientBatch` 使用 INSERT OR IGNORE，重复 logId 视为已接受并计入 `acceptedLogIds`，客户端可安全删除。

## 实现说明（非问题，供后续维护）

1. 定时任务分钟表（Asia/Shanghai）：支付兜底 `00,05,...,55`；超时关单 `02,07,...,57`；退款对账 `04,19,34,49`；异常重试 `08,38`；历史订单 `13`；日志清理 `03:21`（每日）；异常表清理周日 `03:16`。均为 Cron 秒字段 `0`。
2. `logs` DataSource 无条件 `synchronize: false`；启动 schema 校验失败只禁日志不阻业务（已在冒烟测试验证）。
3. 转换协议 12 个动作之外补充了 3 个设计表格未列的对称原语：`markRefundFailed`（退款明确终态失败）、`markRefundResultUnknown`（退款临时失败计数）、`rescheduleAnomalyRetry`（异常通道退避重排，不累加 occurrenceCount）——记录在此避免误以为遗漏。
4. 定时任务运行时间预算取 60 秒（设计未给具体值）；成功结果缓存最大 200 条，超限删除最早插入的条目（惰性过期）。
5. 敏感过滤的 `key` 字段用变体正则匹配（`key` / `api_key` / `apikey` / `appkey` / `privatekey` / `secretkey` / `accesskey` / `merchantkey` / `paykey`），避免误伤 `keyword`、`bookingKey` 等普通键；8 KiB 总量超限时逐轮截短最长字符串，仍超则存 `{"contextTooLarge":true,"truncated":true}`。
6. `markRefundStarting` 保持 `status=confirmed`、`paymentStatus=paid` 不变（设计表未写状态变化）；现状代码提前置 `status=refunded` 的行为被移除，退款成功终态才置 `REFUNDED`。属行为变化，上线前请确认前端退款中订单列表展示依赖。
7. `queryOrder` 的 404 分类为 `NOT_EXIST`：PAYING 场景记 `REMOTE_ORDER_NOT_FOUND` 异常，UNPAID 保留单号场景为允许换单的预期结果（不记异常）——按设计区分实现。
8. 微信回调路径（wechat-pay.controller → WechatPayService.handlePaymentSuccess/RefundCallback）直接调用 repository 条件更新，未经 BookingService 命名动作，避免模块循环依赖（WechatPayModule 内单独注册 BookingRepository）。语义与转换协议一致（条件 + 清调度）。
9. `test:diagnostics` 在本机（Node v22.12.0）1 项失败：诊断脚本 `scripts/diagnose-sqlite-payment-contention.js` 的自定义 `lookup` 回调与 Node 22 的 `net.emitLookup` 校验不兼容（`ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`，发生在脚本 DNS 模拟场景）。**与本次改动无关**（scripts/ 与 test/ 均未修改，脚本独立运行）。该测试在 Node 18/20 下预期正常；如需在本机全绿可升级诊断脚本的 lookup 回调（另行排期，不在本期范围）。
10. 环境配置（`payment-reliability-design.md`「SQLite 写锁预算」）：`RECONCILIATION_ENABLED`（默认 true，false 时跳过支付兜底/关单/退款/异常 4 个微信任务）、`RECONCILIATION_BATCH_SIZE`（默认 20，异常任务固定 5）、`RECONCILIATION_CONCURRENCY`（默认 2，全局信号量上限）；`LOG_DB_SIZE_WARN_MB`（logs.db 体积告警阈值，默认 512）。
11. 开发模式 `synchronize=true` 在全新空库上会触发既有 bug（`index already exists`，memory 已记录）：开发环境请使用已有 dev.db 或先手工建表；生产 `synchronize=false` 不受影响。
12. 本地验证库：`data/dev.db`（`.env.development` 指向，旧结构）；`data/prod.db` 为 0 字节占位文件，仅生产环境使用。本地启动默认读 `.env`（DATABASE_PATH=data/prod.db），空占位库上业务查询会因缺表失败——开发时请设置 `DATABASE_PATH=data/dev.db` 或使用已有开发库。
