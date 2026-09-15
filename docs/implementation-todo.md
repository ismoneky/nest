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

### 7. bookings 新增过期与核销留痕字段（4 个列）— 订单过期与退款闭环 v2

```bash
sqlite3 data/prod.db "ALTER TABLE bookings ADD COLUMN expiredAt integer; ALTER TABLE bookings ADD COLUMN expireNotifiedAt integer; ALTER TABLE bookings ADD COLUMN verifiedAt integer; ALTER TABLE bookings ADD COLUMN verifiedBy varchar;"
```

字段含义：

| 列 | 类型 | 含义 |
|---|------|------|
| `expiredAt` | integer（毫秒 epoch） | 被 T1 翻转为 `expired` 的时刻。**退款申请 7 天时限的计算基准** |
| `expireNotifiedAt` | integer | 「已过期」通知已发出的时刻。**防漏发的标记位**（NULL = 未通知，下轮继续扫到） |
| `verifiedAt` | integer | 核销时刻。**新增核销留痕** |
| `verifiedBy` | varchar | 核销人 openid |

全部可空、无默认值 → `ALTER TABLE ADD COLUMN` 只改表头元数据，不重建表、不触碰任何已有行。存量订单这 4 列均为 NULL，语义即「未曾过期 / 未曾通知 / 未曾核销」。

### 7b. 关于方案 §5.2 声称要新建的两个索引（**不建，已核实为冗余**）

方案 §5.2 让执行：

```bash
# 【不要执行】CREATE INDEX idx_bookings_status_date_time ON bookings (status, bookingDate);
# 【不要执行】CREATE INDEX idx_bookings_expire_notify ON bookings (status, expireNotifiedAt);
```

**第一条是纯重复**：生产库已有 `idx_bookings_status_date (status, bookingDate)`（见本文档第 2 节，列完全相同），再建一个只换名字的索引不会有任何查询收益，只增加写放大——本库是 SQLite 单写者，写放大是稀缺资源。

**第二条当前无收益**：`expireNotifiedAt` 在「待通知」状态下恒为 NULL，索引该列无选择率；`status` 已有单列索引（实体的 `@Index()` 装饰器）。T1 稳定态每次扫描命中约 0 行（池子每小时被排空一次，新行一天只出现一批）。

**真正的判断依据应是 `EXPLAIN QUERY PLAN`，不是猜测。** 上生产后按下面的查询实测，只有确认走了低效计划才补索引：

```bash
sqlite3 data/prod.db "EXPLAIN QUERY PLAN SELECT id FROM bookings WHERE status='confirmed' AND bookingDate < date('now') AND refundStatus NOT IN ('refunding','refunded');"
sqlite3 data/prod.db "EXPLAIN QUERY PLAN SELECT id FROM bookings WHERE status='expired' AND expireNotifiedAt IS NULL AND createdAt <= (strftime('%s','now')*1000 - 7200000) ORDER BY expiredAt ASC LIMIT 200;"
```

预期第一条走 `idx_bookings_status_date`，第二条走 `status` 单列索引或不走索引（因命中行数极少，全表扫反而更快）。**T2 的「近 7 天已过期」查询上线前另测一次**（`status='expired' AND expiredAt >= ?`），它是唯一可能真正需要 `(status, expiredAt)` 的查询。

> **2026-09-15 订正**：第二条样本里的 `LIMIT 200`（`MESSAGE_SCAN_BATCH_LIMIT`）已随站内信
> 分批限制一并删除，实测请用下面这条（同时含新增的软删除过滤）：
>
> ```bash
> sqlite3 data/prod.db "EXPLAIN QUERY PLAN SELECT id FROM bookings WHERE status='expired' AND expireNotifiedAt IS NULL AND createdAt <= (strftime('%s','now')*1000 - 7200000) AND deletedByUserAt IS NULL ORDER BY expiredAt ASC;"
> ```
>
> 计划不应变化：`LIMIT` 与 `deletedByUserAt IS NULL` 都不参与索引选择。
> 删除理由、代价与「将来如何恢复保护」见 `BookingRepository.findExpiredNotNotified` 的注释。

### 7c. 回滚（阶段 2A）

```bash
sqlite3 data/prod.db "ALTER TABLE bookings DROP COLUMN verifiedBy; ALTER TABLE bookings DROP COLUMN verifiedAt; ALTER TABLE bookings DROP COLUMN expireNotifiedAt; ALTER TABLE bookings DROP COLUMN expiredAt;"
```

> 回滚前必须先把 `status='expired'` 的订单改回 `confirmed`，否则这些订单会卡在一个代码已不认识的状态上（`BookingStatus` 枚举里没有 `expired`，前端/看板会渲染成未知状态）：
> ```bash
> sqlite3 data/prod.db "UPDATE bookings SET status='confirmed' WHERE status='expired';"
> ```
> **注意方向**：这会把这些订单退回到「待使用」，而不是原实现会给出的「已完成」。若回滚是因为新逻辑有 bug，需要同时把 `runExpireScan` 的 cron 摘掉并恢复 `updatePastBookings`，否则下一轮扫描又不会把它们变成 `completed`——它们会永远停在 `confirmed`。

### 8. 新建 refund_applies 退款申请单表 — 订单过期与退款闭环 v2 阶段 3

```bash
sqlite3 data/prod.db "CREATE TABLE IF NOT EXISTS refund_applies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  applyNo varchar NOT NULL,
  bookingId varchar NOT NULL,
  wechatOpenId varchar NOT NULL,
  applyCount integer NOT NULL,
  reason varchar(500) NOT NULL,
  status varchar NOT NULL DEFAULT 'pending',
  refundAmount integer NOT NULL,
  outRefundNo varchar,
  auditAdminId integer,
  auditAdminName varchar,
  auditAt integer,
  auditRemark varchar,
  rejectReason varchar(500),
  createdAt integer NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updatedAt integer NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS IDX_refund_applies_applyNo ON refund_applies (applyNo);
CREATE UNIQUE INDEX IF NOT EXISTS IDX_refund_applies_booking_count ON refund_applies (bookingId, applyCount);
CREATE INDEX IF NOT EXISTS IDX_refund_applies_status_created ON refund_applies (status, createdAt);
CREATE INDEX IF NOT EXISTS IDX_refund_applies_user ON refund_applies (wechatOpenId, createdAt);
CREATE INDEX IF NOT EXISTS IDX_refund_applies_out_refund_no ON refund_applies (outRefundNo);"
```

字段含义：

| 列 | 类型 | 含义 |
|---|------|------|
| `applyNo` | varchar（唯一） | 申请单号 `RAxxxxxxxxxxx`（业务主键，对外暴露的标识） |
| `bookingId` | varchar | 订单号。**不加外键约束**：本库整体无外键，保持一致；申请单与订单的关联由应用层保证 |
| `applyCount` | integer | 第几次申请，从 1 起。与 `bookingId` 组成唯一索引——**这是并发重复提交的最终兜底** |
| `reason` | varchar(500) | 用户填写的退款原因（必填） |
| `status` | varchar | `pending` / `approved` / `rejected` / `success` / `failed` |
| `refundAmount` | integer（分） | 申请退款金额，落库时取 `bookings.amount` 快照（订单金额后续若变，以快照为准） |
| `outRefundNo` | varchar | 审核通过时生成并写入的微信退款单号（`RF{bookingId}` / `RF{bookingId}-N`） |
| `auditAdminId` / `auditAdminName` / `auditAt` / `auditRemark` | — | 审核留痕。**可空**：管理端仅有 `x-admin-key`（无 `x-admin-token`）时记 NULL |
| `rejectReason` | varchar(500) | 驳回理由，随站内信原样下发 |

**索引名是显式指定的**（实体上写 `@Index('IDX_...')`，不使用 TypeORM 自动命名）：自动命名是 `IDX_<table>_<hash>`，dev 环境 `synchronize` 生成的名字与这里手写的必须逐字一致，否则会出现「开发库有索引、生产库也有，但名字不同」的隐性漂移。

**本表是新增表，不动 `bookings` 一行数据。** 唯一一处 `bookings` 相关的语义变更是
`markRefundStarting` 的 status 条件（见「实现说明 24」），无 DDL 变更。

### 8b. 回滚（阶段 3）

```bash
sqlite3 data/prod.db "DROP TABLE IF EXISTS refund_applies;"
```

> **回滚前必须先确认没有 `status='approved'` 的申请单在途**：
> ```bash
> sqlite3 data/prod.db "SELECT applyNo, bookingId, outRefundNo FROM refund_applies WHERE status='approved';"
> ```
> `approved` 意味着已经调用过 `initiateRefund`、微信侧可能已产生退款单（订单 `refundStatus='refunding'`），
> 甚至在回滚后才到账。这些退款由既有的 15 分钟对账 Cron 收敛到 `bookings.refundStatus`，
> **不依赖本表**——所以回滚不会让钱卡住，只是丢了「这笔退款对应哪次申请」的记录。
> 建议把上面的查询结果留档后再删表。
>
> 回滚后 `GET /bookings/:bookingId` 不再下发 `refundEntry`，小程序端读不到 `visible` 就不渲染申请按钮；
> 但**已经提出的申请单随表一起消失**，用户在审核队列里的待办全部丢失——这是删表不可逆的部分。

### 9. 新建 messages 站内信表 — 订单过期与退款闭环 v2 阶段 4

```bash
sqlite3 data/prod.db "CREATE TABLE IF NOT EXISTS messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  userId varchar NOT NULL,
  msgType varchar NOT NULL,
  title varchar NOT NULL,
  content varchar(500) NOT NULL,
  bizType varchar,
  bizId varchar,
  jumpPath varchar,
  senderType varchar NOT NULL DEFAULT 'SYSTEM',
  adminId integer,
  dedupeKey varchar,
  oaSendStatus integer NOT NULL DEFAULT 3,
  oaAttempts integer NOT NULL DEFAULT 0,
  oaLastError varchar,
  isRead integer NOT NULL DEFAULT 0,
  readAt integer,
  createdAt integer NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updatedAt integer NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS IDX_messages_dedupe ON messages (dedupeKey);
CREATE INDEX IF NOT EXISTS IDX_messages_user_read ON messages (userId, isRead, id);
CREATE INDEX IF NOT EXISTS IDX_messages_user_type ON messages (userId, msgType, createdAt);
CREATE INDEX IF NOT EXISTS IDX_messages_oa_retry ON messages (oaSendStatus, oaAttempts);"
```

字段含义：

| 列 | 类型 | 含义 |
|---|------|------|
| `userId` | varchar | 接收人 **wechatOpenId**（不是 `users.id`）。与 `bookings` / `feedbacks` / `members` 一致，避免每发一条消息都反查 users 表 |
| `msgType` | varchar | 见 `MessageType` 枚举：`ORDER_EXPIRE_REMINDER` / `ORDER_EXPIRED` / `REFUND_ACCEPTED` / `REFUND_APPROVED` / `REFUND_REJECTED` / `REFUND_SUCCESS` / `FEEDBACK_REPLIED` / `ADMIN_NOTICE` |
| `title` / `content` | varchar / varchar(500) | 卡片标题与正文。**发送时即固化**，不回查业务表——订单改了号、申请单归档了，历史消息仍要能读。驳回理由就在正文里（≤500，与 `rejectReason` 同长） |
| `bizType` / `bizId` | varchar（可空） | 业务对象类型与 ID（`booking` / `refund_apply` / `feedback`）。退款类 `bizId` 存 **applyNo**。`ADMIN_NOTICE` 为 NULL |
| `jumpPath` | varchar（可空） | 点击跳转的小程序路径。**这是历史字符串**：页面改名后旧消息会指向上一版路径，小程序端跳转前必须做白名单校验并降级为「不跳转」 |
| `senderType` / `adminId` | varchar / integer | `SYSTEM` / `ADMIN`；`adminId` 仅管理员手动消息非空。**管理端只有 `x-admin-key`（无 `x-admin-token`）时记 NULL** |
| `dedupeKey` | varchar（**唯一**） | 防重键 `{msgType}:{业务ID}`。**退款类必须带 applyNo 而非 bookingId**——v1 用订单号，同一订单第 2、3 次申请的 key 完全相同，第二条起被静默去重，用户永远收不到审核结果（方案 §4.4 表注）。`ADMIN_NOTICE` 为 NULL，靠 SQLite「唯一索引下多个 NULL 互不冲突」支持无限多条 |
| `oaSendStatus` / `oaAttempts` / `oaLastError` | integer / integer / varchar | 服务号（OA）模板消息台账。**主流程 `OA_ENABLED=false`，这三列恒为 `3 / 0 / NULL`** |
| `isRead` / `readAt` | integer / integer（可空） | SQLite 无 boolean，用 0/1。`readAt` 仅在置已读时写入 |

**三列 OA 字段本期不写入任何业务逻辑，但必须先建**：服务号是独立分支
`feat/oa-template-message`（方案 §4.6），等它落地时补 DDL 意味着要在生产上做一次
「加列 + 回填」的二次变更；而现在建好，那个分支只改代码、不碰 schema。

**索引名同样是显式指定的**（`@Index('IDX_messages_*')`），与第 8 节同款理由。
注意本仓更早的表有小写 `idx_` 开头的既有索引（如 `idx_bookings_status_date`），
那是历史遗留；**新表一律用 `IDX_` 前缀**，不要再引入第二种风格。

**本表是新增表，不动任何既有表一行数据。** 阶段 4 的全部改动都是「新增消息」，
`bookings.status` / `paymentStatus` / `refundStatus` 的取值集合与流转规则均无变化。

### 9b. 回滚（阶段 4）

```bash
sqlite3 data/prod.db "DROP TABLE IF EXISTS messages;"
```

> **回滚是安全的，不涉及钱。** messages 是纯记录层（方案 §3.4「站内信是记录层，
> 服务号是触达层」），没有任何业务状态机的读依赖它：
> `bookings.expireNotifiedAt` 是独立的标记位列，退款/审核流程也不查 messages。
> 删表后唯一的影响是**用户看不到历史通知**，订单与资金流转完全不受影响。
>
> 两个必须在回滚**同时**处理的事项：
> 1. 停掉 T2/T3 两个 Cron（或直接回滚到旧代码），否则它们会持续尝试写一张不存在的表；
> 2. `bookings.expireNotifiedAt` **不要一起清空**——它记录的是「已经打扰过用户了」，
>    留着可以避免「表删了 → 标记位清了 → 重新上线时给全部历史订单补发一遍通知」。
>
> 建议留档后再删：
> ```bash
> sqlite3 data/prod.db "SELECT msgType, COUNT(*) FROM messages GROUP BY msgType;"
> ```

### 9c. 服务号相关表（**本阶段不建**）

方案 §4.6 的 `user_wx_oa` 表属于独立分支 `feat/oa-template-message`，
**不在本期手工 SQL 范围内**。该分支落地时在文档末尾继续追加（第 10 节已被占用）。

### 10. bookings 新增用户删除标记字段（1 个列）— C 端订单软删除

```bash
sqlite3 data/prod.db "ALTER TABLE bookings ADD COLUMN deletedByUserAt integer;"
```

| 列 | 类型 | 含义 |
|---|------|------|
| `deletedByUserAt` | integer（毫秒 epoch） | 用户在小程序端删掉该订单的时刻。**只影响用户侧可见性**：用户列表、角标计数、订单详情、退款申请入口、三个扫描类通知的取单查询都会过滤它；后台列表/导出/看板、资金链路（支付、退款、对账）、核销、名额与统计**一律不过滤** |

全部可空、无默认值 → `ALTER TABLE ADD COLUMN` 只改表头元数据，不重建表、不触碰任何已有行。存量订单该列为 NULL，语义即「未被用户删除」。

**不建索引**：用户侧列表走既有的 `wechatOpenId`（+`status`）索引，`IS NULL` 只是过滤条件、不是索引列；本库是 SQLite 单写者，无 `EXPLAIN` 证据不加索引（与 7b 同一口径）。

**⚠️ 上线顺序（硬约束）**：生产 `synchronize=false`，**必须先执行本 SQL、再发代码**。反过来的话，用户端每一次订单一览 / 详情 / 角标计数都会 500（`no such column: deletedByUserAt`）。这与第 17 条「删 `updatePastBookings` 与上 T1 必须同一次发布」是同一类约束。

删除**不会**让任何已有数据消失，只是给了用户一个「不再看到它」的开关；因此它不需要 backfill、也不参与状态机。

### 10b. 回滚（C 端订单软删除）

```bash
sqlite3 data/prod.db "ALTER TABLE bookings DROP COLUMN deletedByUserAt;"
```

> 回滚会让**所有被用户删掉的订单重新出现在用户列表里**（标记列被丢弃）。
> 订单与资金数据本身完好，没有任何不可逆的损失。
> 若需要保留「谁删过」这一事实，回滚前先导出：
>
> ```bash
> sqlite3 data/prod.db "SELECT bookingId, wechatOpenId, deletedByUserAt FROM bookings WHERE deletedByUserAt IS NOT NULL;"
> ```

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
- [x] 用户删除订单（booking.service.ts，软删除；后台排查「用户说订单不见了」的唯一依据）
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

## 事故记录：SQLite 单连接并发事务（2026-09-13，已修复）

**现象**：线上出现一次事务阻塞后，写入全部停留在 Node 内存未落盘，任何访问数据库的请求都返回 `database is locked`。

**根因**（`typeorm` 0.3.28 + `type: 'sqlite'`）：

1. **全进程只有一条 sqlite 连接** —— `SqliteDriver.createQueryRunner()` 永远返回同一个 runner，进程内不存在真正的并发事务。
2. **驱动不拦嵌套事务** —— `AbstractSqliteDriver.transactionSupport = 'nested'`，而 `startTransaction()` 顶部的 `TransactionAlreadyStartedError` 守卫只对 `'simple'` 生效，于是两个并发调用会各发一条 `BEGIN TRANSACTION`。
3. **记账错位** —— 第二个 `BEGIN` 报 `cannot start a transaction within a transaction`，其失败清理发出的**裸 `ROLLBACK` 回滚掉的是另一个请求的事务**；`transactionDepth > 1` 时 commit/rollback 走 `RELEASE` / `ROLLBACK TO SAVEPOINT`，而后者既不结束事务也不复位 `isTransactionActive`。
4. **结果** —— 留下**没有任何代码会去提交的开放事务**：写入只在内存、外部访问报锁、重启即丢。事务本身不阻塞时不会暴露，所以此前一直潜伏。
5. **放大器**：`EntityPersistExecutor` 在 `!queryRunner.isTransactionActive` 时会自行 BEGIN/COMMIT，因此**每一处 `repo.save()` / `repo.remove()` 都是一次事务发起**（本仓库共 19 处），未排队就会把「并发事务」装回来，写入还可能被卷进别人的事务随之回滚（典型：支付回调更新订单状态时被一个失败的下单事务带走 → 用户付了钱、订单仍是未支付）。`createBooking` 事务体内的 `setImmediate` 会在同一连接上另起一次 BEGIN/COMMIT，与父事务的 COMMIT 交错，是本次的触发点之一。

**修复**（`src/common/transaction-runner.ts`，模块级单例，非 Nest provider）：

- 按 DataSource 建 **FIFO 串行队列**（`WeakMap`，主库与 logs 库互不阻塞）：`serialTransaction`（显式事务）、`serialSave` / `serialRemove`（包装自开事务的 save/remove）、`serialWrite`（其它非事务写）。
- `AsyncLocalStorage` 标记事务上下文：**禁止嵌套事务**（事务内再调 `serialTransaction` 直接抛错，要求显式透传 EntityManager）；`serialWrite` 在事务内调用则并入外层事务，不排队、不碰 BEGIN/COMMIT。
- 看门狗与超时：等锁 >5s 告警、事务体 >30s 告警、等锁 >30s 拒绝并给出「唯一恢复手段是重启进程」的提示（超时的等待者持「放弃」标志，绝不在事后偷偷执行）。
- 同步改动：`createBooking` 事务体内的 `setImmediate` 移到事务提交之后并经 `serialWrite` 排队；`booking.repository` 两处显式事务改走 `serialTransaction`；`app.module.ts` 给 logs DataSource 补 `busyTimeout: 5000`。

**为什么不在 SQL 层排队（为什么必须把等待搬到事件循环）**：

修复前的 `createBooking` 事务里那条「无副作用 UPDATE 抢 RESERVED 锁 + `busyTimeout: 5000`」就是**在 SQL 层排队**的尝试 —— 让后到的写事务在数据库里等锁。这条路线在 sqlite 上有独立的高危副作用：`node-sqlite3` 是原生异步驱动，SQL 跑在 **libuv 线程池**（默认 4 线程）上，而「等锁」会**占住线程池线程不动**。4 个这样的等待即可占满线程池，此后所有需要线程池的工作全部饿死 —— 首当其冲是 `dns.lookup`（HTTP 建连前的域名解析）与 socket 建立，于是微信支付请求发不出去、页面一直转圈。这正是 `scripts/diagnose-sqlite-payment-contention.js` 里 `SQLITE_LIBUV_COUPLING`（severity: high，"SQLite lock waits can starve DNS/socket setup in the default libuv threadpool"）所指，该脚本另有一条 `KEEPALIVE_BYPASSES_LOOKUP` 发现被采纳在 `wechat-pay.service.ts:111/120`（HTTPS Agent 已开 `keepAlive`）。

**结论：在等锁这条路上，"等"本身就是危险动作。** 串行器把等待从线程池搬回了事件循环：排队期间不占用任何线程池线程、也不向 sqlite 下发任何语句，因此「线程池被等锁占满」这个成因在新路径上不存在。本机临时库实测（60 并发）：

| 场景 | 结果 |
| --- | --- |
| 修复前写法（并发 `dataSource.transaction`） | 60/60 请求报错（`cannot start a transaction within a transaction`），61 行只落 2 行 → 59 笔写入丢失 |
| `serialTransaction` | 0 错误，61/61 行落盘，总耗时 245ms |
| `serialSave`（仓库写入路径） | 0 错误，61/61 行落盘，255ms |
| 写突发期间的读（模拟支付状态轮询） | 突发期间 31 次读，延迟 p50=0ms / p95=3ms / max=3ms —— **读不走队列** |
| `dns.lookup` 探针（线程池是否被占） | 加载期间 p95=1ms / max=5ms；事件循环延迟 max 8ms |

**部署约束（重要）**：串行器是**进程内**的。必须保持**单进程单写者**（当前 pm2 单实例 + 进程内 cron 符合）。若将来开多实例、或另起进程/脚本连同一个 db 文件，跨进程的锁等待会重新出现（`busyTimeout` 只把等待压到 5s，等待期间仍占线程池）。

**已知残留（后续项，非本次范围）**：

1. **未启用 WAL** —— 开启会永久改变生产库的 journal_mode（若库位于 NFS / Windows bind mount 上有损坏风险），且 WAL 治不了上述记账错位，只是让外部读不再撞锁。`busyTimeout` 只对「其它连接持锁」有效，进程内并发走不到它。
2. **`wechat-pay.controller` 的异步处理段未整体包锁** —— webhook 先应答 200 再 `setImmediate` 异步处理（内部含网络调用，不适合放进串行队列）。其中的 repository 写入**已在 2026-09-14 补上排队**，见下方订正。
3. **`createBooking` 事务未瘦身** —— 免费名额判定必须与写在同一事务内才有防超卖意义，串行化后已无碰撞风险，搬出去反而引入超卖。
4. **logs 库唯一事务点**（`logging.service.ts` 日志清理）保持原样：独立 DB、单点发起，不存在本节的并发形态。

### 订正与补修：`update().execute()` 这条路当时漏了（2026-09-14）

上文第 2 条原写「其中的 repository 条件更新**已由串行器覆盖**」——**这句话当时不成立，已订正并补修。**

**为什么漏**：2026-09-13 的排查口径是「`EntityPersistExecutor` 在 `!queryRunner.isTransactionActive` 时会自行 BEGIN/COMMIT，因此每一处 `repo.save()` / `repo.remove()` 都是一次事务发起（共 19 处）」。`save()`/`remove()` 那条线据此被系统性换成 `serialSave`/`serialRemove`。

但 TypeORM 的 `createQueryBuilder().update().execute()`（以及 `repo.update()` / `repo.delete()` 这两个快捷方法）**不走 EntityPersistExecutor**，不自开事务、不撞坏 BEGIN/COMMIT 记账——所以它既不在「那 19 处」里，也不表现为「并发事务」。**它不制造事故，但会被事故吃掉**：事务持锁期间下发的语句会被卷进那个未提交事务，随它的回滚一起消失，而它返回的 `affected` 仍是正常值（调用方以为写成功了）。

**实测**（`src/common/write-isolation.spec.ts`，该文件已成为回归网）：

```
事务自己的写            存活=false   ← 回滚确实发生，实验有效
裸 update().execute()   存活=false   ← 被卷进事务，随回滚消失，affected=1
serialWrite(...)        存活=true
```

**影响面**：支付回调链 `wechat-pay.controller → setImmediate → handlePaymentSuccess → markPaymentSucceeded` 全程无排队——正是本节开头举的那个例子「用户付了钱、订单仍是未支付」。

**修复**：全仓约 30 处裸写补 `serialWrite`——`booking.repository.ts`（支付族 9、退款族 2、`markVerified`/`markExpired`/`markExpireNotified`、`resolveAnomaly`）、`refund-apply.repository.ts`（审核三态）、`message.repository.ts`（标记已读 / 治理）、`admin-application.repository.ts`（审批）。

**为什么补排队不会再引出「开放事务」那个故障**：那个状态由并发 `BEGIN`/`COMMIT` 造成，只有 `serialTransaction` 那条路能产生；`serialWrite` 不发 BEGIN 也不发 COMMIT，结构上造不出来。且 `serialWrite` 在事务体内调用会**内联**（并入外层事务），不会自己等自己——这条契约由同文件的第二个用例锁定。

**约定（新增写操作时必须遵守）**：`createQueryBuilder()` 的 `.execute()`、以及 `repo.update()` / `repo.delete()`，**都要包在 `serialWrite` 里**。`repo.save()` / `repo.remove()` 用 `serialSave` / `serialRemove`。

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
13. 新增条件更新原语 `markCancelledByUser`（用户主动取消）。之前不存在该原语：取消一直走 `PUT /bookings/:id` 的裸读-改-写。终态字段刻意与 `markPaymentClosed` 对齐（`cancelled` + `failed` + 清 `reconcileKind`/`reconcileNextAt`），使「超时关单」与「用户取消」产出同一终态，下游无需分支。**只受理 `pending + unpaid`**：`markPaymentStarting` 在调微信前即原子写入 `PAYING + outTradeNo`，`markPaymentStartRejected` 仅在微信明确拒绝（未建单）时退回 `UNPAID`，因此 `UNPAID ⟺ 微信侧无预支付单`，清 close 调度安全；`PAYING` 可能已在途，交给超时关单对账判定，否则会出现「已取消却收到钱」。
14. `PUT /bookings/:bookingId` **已废弃**，现为仅受理 `status:'cancelled'` 的兼容壳，并补上了 `JwtAuthGuard` + 归属校验。保留原因：未更新的小程序版本仍在打该接口，直接删会导致这些用户取消失败。新版走 `POST /bookings/:bookingId/cancel`。**小程序全量更新后应删除该端点、`UpdateBookingDto` 及 `fctl/pages/booking/booking.vue` 的兼容分支。** 同时 `UpdateBookingDto` 不再 `extends PartialType(CreateBookingDto)`——旧实现允许任意改写 `bookingDate`/`personCount`/`passengers`/`isAdmin`，且当时无 Guard，未登录即可把订单改成 `confirmed`（伪造核销码）。仓库层 `updateBooking` 的方法签名已与 HTTP DTO 解耦（改收 `Partial<Booking>`），避免接口字段收窄波及 `booking.processor` / `verifyBooking` 等内部调用点。
15. `BookingService.getBookingById` 的 `openid` 参数由可选改为**必填**：旧签名传空即静默跳过归属校验，任何人拿到订单号即可读到姓名/手机号/身份证。管理端读订单不经过该方法（走 `getBookingsForAdmin` / 导出）。另：`admin/src/api/bookings.ts` 中同名函数 `getBookingById` 指向用户端点 `/bookings/:id` 却是死代码（管理端是 API Key 鉴权、非用户 JWT，调用必然 401），已删除以免被误用。
16. `booking.processor.ts`（`@nestjs/bull` 的 `completeBooking`）为**死代码**：`BullModule` 在 `src/` 中从未注册，队列不会消费。本次仅将其调用点适配为新签名，未删除——删除涉及是否保留异步完成能力的判断，另行排期。
17. **T1 取代 `updatePastBookings`，`completed` 语义收窄**（订单过期与退款闭环 v2 阶段 2A）：
    - `updatePastBookings` **已删除**（不是保留换目标状态），新原语 `markExpired(todayStart, now)` 置 `expired` + 写 `expiredAt`，并排除 `refundStatus IN ('refunding','refunded')`（修 §8 第 4 条现存缺陷：退款中的订单 `status` 仍为 `confirmed`，旧实现会把它们错置成 `completed`）。
    - 定时任务从 `runHistoricalBookingUpdate`（`taskRunning.historical`）改为 `runExpireScan`（`taskRunning.expire`），**cron 槽位 `0 13 * * * *` 不变**。
    - 由此 `completed` **唯一写入方是 `markVerified`**，严格等价于「已核销」。这是 `verifiedAt`/`verifiedBy` 有意义的前提，也是 `completed` 从「混合值」变成「可信值」的分界点。
    - **「今天」改用 `beijingDateStr()`**，不再用 `new Date()` 的服务器本地年月日。原实现在服务器跑 UTC 时，过期边界会比北京零点晚最多 8 小时。构造方式 `new Date(\`${beijingDateStr()}T00:00:00\`)` 的时区无关性已由测试锁定（TypeORM 对 `date` 列按本地分量格式化，该 Date 恰好落回同一字符串）。
    - **上线硬约束**：删 `updatePastBookings` 与上 T1 必须同一次发布。T1 先上而旧 cron 还在 → 旧 cron 抢先把订单刷成 `completed`，T1 的 `WHERE status='confirmed'` 永远匹配不到，`expired` 形同虚设。
    - **阶段拆分**：2A 只实现 T1 的**步骤①（状态流转）**。步骤②（发「已过期」通知）与 T2 双扫描依赖 `messages` 表与 MessageService，**已于阶段 4 接线完成**（说明 28）。两者解耦，通知靠 `expireNotifiedAt IS NULL` 标记位补发，**先上状态流转不会造成永久漏发**。
    - ⚠️ **补发突发**（本节原写作「2B 上线时的风险」，现已按此实施）：步骤②的扫描条件是「`status='expired' AND expireNotifiedAt IS NULL`」，而 2A 到 4 之间累积的所有过期订单一旦接线会**一次性补发**。实际做法：`ORDER BY expiredAt ASC LIMIT 200`（`MESSAGE_SCAN_BATCH_LIMIT`）每轮消化一批 + 每个用户每日 5 条上限（`MESSAGE_DAILY_LIMIT`）双重收敛，按小时级别的 T1 扫描逐轮排空积压。**若某景区积压量远超 200 × 每小时，需要临时调大 `MESSAGE_SCAN_BATCH_LIMIT` 或接受数天的排空期**——不要改成「无 LIMIT」，那会在同一分钟把全部积压发出去并写满 SQLite 的单写者预算。
    - 🔴 **2026-09-15 订正：上面这整套分批与配额都已删除，原文「不要改成「无 LIMIT」」不再成立。**
      - **删了什么**：`MESSAGE_SCAN_BATCH_LIMIT`（单轮 200）与 `MESSAGE_DAILY_LIMIT`（每用户每日 5 条）**双双移除**。三个扫描查询（`findExpiredNotNotified` / `findTodayUnverified` / `findExpiredForRefundReminder`）不再收 `limit` 形参；`MessageService.send` 不再查配额，`MessageRepository.countTodaySystemMessages` 与 `common/date-utils.ts` 的 `beijingDayStartMs` 随之删除（后者唯一调用方就是那条配额统计）。
      - **为什么可以改**：原文依据是「2A→4 累积的历史积压会被一次性倾泻」，而那批积压早已被 hourly 扫描排空。稳态下待通知池 = **当天过期未核销的几十单**（`markExpired` 在北京零点后那一轮一次性写入），200 这条上限从未成为有效约束；它带来的却是一个真实代价——任何积压都只能**逐小时**排空，而「已过期可退款」的正文里写着**退款申请截止日**，迟到比打扰严重。配额同理：它唯一的作用是把通知推迟到次日。
      - **代价（有意接受）**：若某天真的出现巨量积压，一轮扫描会把它们全部 INSERT 出去，占用 SQLite 单写者数秒到数十秒（每条一次自动提交，不存在长事务持锁；支付回调与对账只是排队变慢，不会失败）。届时手动触发接口的 `notifiedCount` 会是个刺眼的四位数，**这是可观测的**。
      - **要恢复保护怎么做**：给那三个仓库方法加回 `limit` 形参（不要写死常量）、调用点显式传值、常量放回 `message-policy.ts`。入口写在 `BookingRepository.findExpiredNotNotified` 的注释里；更彻底的替代是键集分页，不要在方法里藏魔法数。
18. **核销改条件更新 + 留痕**（同阶段）：`verifyBooking` 原来调 `updateBooking(bookingId, {status: COMPLETED})`——`Object.assign` + `save` 的**无条件写**，与 T1 并发时后写者赢，会把已过期订单写回 `completed`（等价于一次绕过审核的补核销，Q2 不允许）。改为 `markVerified(bookingId, openid, now)` 条件更新（`WHERE status='confirmed'`），`affected=0` 时重读最新状态并报明确错误。`verifiedBy` 记的是**核销员** openid（`openid` 入参已由 `findApprovedByOpenid` 校验权限）。`verifyBooking` 的返回值由「save 后的实体」改为「重读的实体」，字段更全（含 `verifiedAt`/`verifiedBy`），响应结构不变。
19. `markExpired` 的判定谓词与 `updatePastBookings` 一致（同为 `bookingDate < 今天` 的 `<` 比较、同为「昨天及更早」），只改 SET 内容与补排除条件。
    - ⚠️ **本节原有一处错误判断，已于 2026-09-13 订正**：原文写「同为 Date 参数…这是刻意的，不应顺手改动边界语义」，并称「边界用例证明 TypeORM 对 date 列按**本地分量**而非 `toISOString()` 格式化」。**这两句都是错的**——Date 参数并不是安全的边界载体，它使谓词的正确性依赖进程时区（UTC 服务器下会把当天订单也置为 expired）。详见说明 23。现已改为传日期字符串，边界语义（{bookingDate ≤ 昨天}）在 UTC+8 下与改动前完全等价。
    - 边界由 `booking-expire.spec.ts` 的「今天不下沉」用例锁定，且**整套 spec 通过 jest `globalSetup`（`test/jest-tz-setup.js`）跑在 UTC 下**（最坏时区），使这条边界在任何开发机上都被最坏环境检验。
20. **经营看板实收金额与「量」的口径拆开**（阶段 2A′，随 2A 一起上）：`getBookingDashboard` 原先把实收金额与有效订单数放在同一个 `status IN (confirmed, completed)` 里算。T1 上线后订单由 `completed` 变 `expired`，**同一批订单的实收金额会凭空下降**，看起来像数据丢失。现拆为两套：
    - 「量」（有效订单数 / 总人数 / 车辆数 / 出行方式分布 / dailyTrend 的订单与人数）＝ `validStatuses` = `confirmed` + `completed`，含义是「有多少人真的来了」；
    - 「钱」（`summary.receivedAmount` / `dailyTrend[].receivedAmount`）＝ `receivedStatuses` = `validStatuses` + `expired`，含义是「钱还在不在景区手上」。
    - 实现方式：实收金额改为**单独一条按 `bookingDate` 分组的查询**（`receivedByDate`），summary 求和、dailyTrend 逐日取值，避免查两遍；原先挂在 summary/dailyTrend 两条查询上的 `receivedAmount` 列已移除，保证**金额只有一处计算**。原先那种「WHERE 收窄到 validStatuses 再用 CASE 挑金额」的写法做不到这件事——被 WHERE 排除的行 CASE 救不回来。
    - **代价是有意接受的**：会出现「某天有效订单 0 但实收 > 0」（当天订单全部过期）。这是口径正确的表现，**不要**把 `expired` 加回 `validStatuses` 去「修」它；方法注释与 `booking.repository.spec.ts` 的用例标题都写了这一点。
    - 顺带修掉一个**静默缺陷**：`statusDistribution` 的**结果数组是按硬编码的 `allStatuses` 组装的**，而 SQL 是按 `GROUP BY status` 返回的——枚举漏列不报错，只会静默少一项。已补 `EXPIRED`；spec 里的 `length` 断言（5→6）是这类漏列的唯一守卫，**新增状态时不要只改代码不改它**。
    - 无 schema 变更，无需 DDL；回滚只需还原该方法的查询。

21. `admin` 订单列表的状态筛选下拉是 `Object.entries(BOOKING_STATUS_MAP)` 生成的，故阶段 2A′ 往常量表补 `expired` 后，**筛选器自动获得「已过期」选项**（后端 `getBookingsForAdmin` 的 `status` 本就收数组）。这是阶段 0 收敛成单一来源的直接收益。
22. **Q1「过期订单停用自助退款入口」提前到 2A 落地**（原计划在阶段 3，见方案 §4.3.3.1 改动 2）。`initiateRefund` 追加 `status='expired' && !asAdmin` 即拒绝，并新增可选入参 `options.asAdmin`（阶段 3 的审核通过路径传 `true`，与计划中的 `outRefundNo` 共用一个 options 对象）。
    - **为什么必须提前**：`initiateRefund` 里原有的 `status === COMPLETED` 拦截在 2A 之后对过期单不再命中（过期单 status 是 `expired`，不再是 `completed`），此时挡住自助退款的其实是 `markRefundStarting` 的 `status='confirmed'` 条件。而阶段 3 的第一项改动正是把该条件放开成 `status IN ('confirmed','expired')`——**那一刻仓库层对过期单的 status 守卫就恒真了，本判断成为唯一的自助退款拦截面**。若把两者放在同一次改动里、或顺序颠倒，就会出现「审核制形同虚设」的窗口（用户点旧入口即可直接退款，绕过人工）。故本判断先落地，且必须早于 `markRefundStarting` 放开的发布。
    - 方案 §1.4 Q1 把风险描述为「不加拦截则审核制形同虚设」，该因果在 2A 之前并不成立（`markRefundStarting` 本就在拦），真正的风险窗口在阶段 3 打开条件的那一刻——Q1 的结论不变，但失效时点要按本节理解。
    - 测试：`booking-expire.spec.ts` 新增 2 条（自助路径被拒且 `refundStatus` 确认未进 REFUNDING、`asAdmin` 不被 Q1 拦截）。第二条在阶段 3 放开 `markRefundStarting` 后语义会从"停在下游条件"变为"直接成功"，断言用的是"不命中 Q1 文案"，两种情况都成立。
    - **残留（阶段 3 实施时确认）**：`POST /bookings/:bookingId/refund` 的响应体只回 `error: error.message`、不回 `errorCode`（与 2A 新增的 `/cancel` 端点不同）。过期拦截目前靠中文文案识别即可——小程序端在 `expired` 状态下根本不渲染退款按钮，这个判断是安全边界而非交互路径。若阶段 3 要让前端按码分支，需按 `booking-errors.ts` 的模式补 `errorCode`。
23. **`markExpired` 的边界必须传日期字符串，不能传 `Date`**（2026-09-13 实测发现并修复，2A 上线前）。
    - **症状**：`TZ=UTC` 下跑 `npx jest` 有一条失败——`booking-expire.spec.ts` 的「今天当天的订单不得被置为 expired」把当天订单也置成了 expired。开发机是 UTC+8，所以默认跑全绿，问题被时区掩盖。
    - **机制**（实测绑定值，非推断）：TypeORM 对 `where` 中的 `Date` 参数走 `AbstractSqliteDriver.escapeQueryWithParameters` → `DateUtils.mixedDateToUtcDatetimeString`，绑定的是**UTC 分量**的 `'YYYY-MM-DD HH:mm:ss.SSS'`；而 `bookings.bookingDate` 是 `type:'date'`、存纯 `'YYYY-MM-DD'`。字符串比较下 `'2026-09-13' < '2026-09-13 00:00:00.000'` **为真**（短串是长串前缀），于是「`< 今天`」退化成「`≤ 今天`」，**当天订单被误伤**。
      | 进程时区 | 绑定的边界参数 | 结果 |
      |---|---|---|
      | UTC+8 | `'2026-09-12 16:00:00.000'` | 只有昨天 expired ✓（碰巧正确） |
      | UTC | `'2026-09-13 00:00:00.000'` | **今天也 expired** ✗ |
    - **影响判断**：本仓其余 13 处 `bookingDate` 比较（免费名额、看板、当日查询）一律传日期字符串，只有这里传 `Date`。同一谓词在旧 `updatePastBookings` 里就存在，故**不是本次引入**；但后果不同——旧代码在 UTC 下会把当天订单刷成 `completed`（核销时提示状态不可核验），新代码会刷成 `expired`（当天完全无法核销）。两个后果都严重，且都依赖服务器时区。
    - **修复**：`markExpired(todayStr: string, now)`，比较 `bookingDate < :todayStr`。`beijingDateStr()` 的返回值直接传入，不再构造 `Date`。在 UTC+8 下结果集与改动前**完全等价**（同为「昨天及更早」），在其它时区下才正确。参数类型是 `string`，退回 `Date` 会直接编译失败。
    - **回归锁定**：新增 `test/jest-tz-setup.js`，通过 jest `globalSetup`（`package.json` 的 `jest.globalSetup`）把 `process.env.TZ` 置为 `UTC`，**整套 spec 都跑在 UTC 下**——这类缺陷只在非 UTC+8 时区暴露，跑 UTC 才能让它变成红灯而不是留到生产。
      - 为什么用 `globalSetup` 而不是某个 spec 的 `beforeAll`：jest 的 node 环境会**复制** `process.env` 给沙箱，spec 里改 `process.env.TZ` 影响不到 Node 原生的时区解析。**这一点是实测出来的**：一开始把强制写在 `booking-expire.spec.ts` 的 `beforeAll` 里 + 加了一条自证断言，结果默认时区下那条断言失败、UTC 下通过——反过来证明了 spec 内强制无效。改成 globalSetup 后默认时区下自证断言通过。
      - 自证断言保留在 `booking-expire.spec.ts` 首条用例里（`getTimezoneOffset() === 0`）：globalSetup 一旦失效会立即飘红，而不是悄悄退回"只在 UTC+8 下碰巧通过"。
    - **验证**：`npx tsc --noEmit` 通过；`npx jest` **162/162**、`TZ=UTC npx jest` **162/162**、`npm test`（jest + diagnostics 15 项）全通过。修复前默认时区 161/161、UTC 下 160/161。
    - **顺带确认**：整套 spec 在 UTC 下全绿，说明其余 spec 的日期构造（纯日期字符串、显式 `Z` 的 ISO 串、`beijingDateStr()`）确实都与时区无关，没有第二处同类隐患。
    - **仍需人工确认的一项**：**生产服务器的实际时区**。代码现在与时区无关了，但需要知道它，才能理解历史数据——若生产一直跑 UTC，则旧的每小时 cron 一直在把「当天」的订单刷成 `completed`（表现为当天扫码核销失败、自助退款被 `status===COMPLETED` 拒绝）；若跑 UTC+8 则无影响。5 秒可查：在服务器上执行 `date`。
10. 环境配置（`payment-reliability-design.md`「SQLite 写锁预算」）：`RECONCILIATION_ENABLED`（默认 true，false 时跳过支付兜底/关单/退款/异常 4 个微信任务）、`RECONCILIATION_BATCH_SIZE`（默认 20，异常任务固定 5）、`RECONCILIATION_CONCURRENCY`（默认 2，全局信号量上限）；`LOG_DB_SIZE_WARN_MB`（logs.db 体积告警阈值，默认 512）。
    - 阶段 3 追加：`REFUND_APPLY_DEADLINE_DAYS`（默认 7，过期后仍可申请退款的时限，硬性上限）、`REFUND_MAX_APPLY_COUNT`（默认 3，同一订单最多申请次数，**被驳回不计入**）、`REFUND_CONTACT_PHONE`（默认空串，驳回/失败/超期文案里的客服电话，空则整行隐藏）。三者均只读环境变量，非法值静默回落默认值而不抛错——配置写错不该让退款入口在线上 500。
11. ~~开发模式 `synchronize=true` 在全新空库上会触发既有 bug（`index already exists`）：开发环境请使用已有 dev.db 或先手工建表；生产 `synchronize=false` 不受影响。~~ **已定位根因并修复，见说明 25。**
12. 本地验证库：`data/dev.db`（`.env.development` 指向，旧结构）；`data/prod.db` 为 0 字节占位文件，仅生产环境使用。本地启动默认读 `.env`（DATABASE_PATH=data/prod.db），空占位库上业务查询会因缺表失败——开发时请设置 `DATABASE_PATH=data/dev.db` 或使用已有开发库。

25. **`user_profiles` 重复索引（说明 11 的根因，已修）**——阶段 4 定位。
    - **根因**：`user-profile.entity.ts` 上类级 `@Index(['wechatOpenId'])` 与列级 `@Index()` **同时存在**。TypeORM 的默认索引名只由「表名 + 列名」决定，两处算出同一个名字 `IDX_509e7b1ba196e6202213b75eda`，于是 `synchronize` 连发两条一模一样的 `CREATE INDEX`，第二条必然报 `SQLITE_ERROR: index ... already exists`。**删除类级那一条即可**，生成的 schema 与之前完全一致（名字和列都没变）。
    - **为什么长期没被发现**：`.env` 里 `NODE_ENV=production` → `synchronize=false`，而生产建表走手写 SQL（那里只建了一次）。只有 `NODE_ENV!=production` **且**面对一个全新空库时才会踩到；一旦库已建好，`synchronize` 的 diff 结果是「已存在、无需变更」，同样不报错。所以「用过一段时间的开发库 + 生产库」两条路径都是绿的。
    - **修它的直接动因**：新增的 AppModule 装配冒烟测试（说明 26）用 `:memory:` 跑 `synchronize=true`，一上来就红了——**这个测试顺带成了「全新空库能不能建起来」的唯一守卫**，请勿删。
    - 精确的失败 SQL（`DATABASE_LOGGING=true npx jest`）：
      ```
      query: CREATE INDEX "IDX_509e7b1ba196e6202213b75eda" ON "user_profiles" ("wechatOpenId")
      query: CREATE INDEX "IDX_509e7b1ba196e6202213b75eda" ON "user_profiles" ("wechatOpenId")
      query failed: ... error: SQLITE_ERROR: index ... already exists
      ```

26. **守卫的依赖必须在宿主模块内解析**（阶段 3 遗留的启动期缺陷，阶段 4 修复；已加测试守住）。
    - **机制**：`@UseGuards(SomeGuard)` 的守卫实例是在**宿主模块的注入上下文**里创建的。只要守卫构造函数有依赖，宿主模块就必须自己能解析它——**Nest 的模块可见性不会沿 import 链向上传递**，即使某个被 import 的模块内部 import 了提供者所在模块，也不会传递过来（除非对方显式 re-export）。
    - **阶段 3 踩的坑**：给共享守卫 `common/guards/admin-jwt-auth.guard.ts` 加了 `JwtService` 注入（用于验 `x-admin-token`），却只改了 `AdminModule`。结果是**应用完全起不来**：
      - `AdminModule`：`AdminService` 注入 `LoggingService`，但 AdminModule 从未 import `LoggingModule`（BookingModule 虽然 import 了它，但没 re-export）→ `Nest can't resolve dependencies of the AdminService (..., ?)`；
      - `MemberModule`：`MemberController` 用了该守卫，而 MemberModule 只 import 了 `TypeOrmModule.forFeature([Member])` → `... of the AdminAuthGuard (?)`。
    - **为什么阶段 3 的验收没发现**：当时的验收是 `tsc --noEmit` + `npx jest`——**两者都看不见这类错误**。tsc 只管类型；每个 spec 自己搭 `Test.createTestingModule`，走不到真实模块图；而 `node dist/main` 那次启动读的是 `.env`（`NODE_ENV=production`），生产配置下 `synchronize=false`，四类问题里只暴露了 DI 这一类，但当时**没有真的启动过**。
    - **修复**：`AdminModule` 补 `LoggingModule`；`MemberModule`、`MessageModule` 补 `UserModule`（后者提供并导出 JwtModule）。三处都在模块注释里写明了「不能靠传递」。
    - **守住它的测试**：`src/app.module.spec.ts`。它在 import 之前把 `DATABASE_PATH`/`LOG_DATABASE_PATH` 置为 `:memory:`（`forRoot` 在模块文件加载时求值，晚设不生效），然后 `Test.createTestingModule({imports:[AppModule]}).compile()`。**它不测业务行为，只回答「这个应用能不能装配起来」**。失败时错误信息直接指出是哪个服务在哪一个模块里解析不了。
      - 代价：整个套件多约 0.1 秒（装配内存库）；修好说明 25 之前它是 24 秒的重试超时，修好后是 97 ms。
      - **新增模块 / 新增带依赖的守卫时，先跑它**，不要等部署时才发现。
    - **仍未解决的结构性隐患**：这个陷阱会随「新模块用了带依赖的守卫」反复出现。彻底的解法是让 `JwtModule` 全局化（`JwtModule.register({ global: true, ... })`，一处注册、处处可注入），但那会改变全应用的提供者可见性、属于安全敏感的改动，**未在本阶段擅自实施**，留待决策。当前的显式 import 与本仓既有约定（LoggingModule / BookingModule / AdminModule 都是这么做的）一致。

27. **阶段 4「站内信」数据层与服务**（本阶段只做**数据层 + 用户端读接口**，各发送点接线见说明 28）。
    - **`createOnce` 刻意不用 `.orIgnore()`**，改用「普通 INSERT + 接住唯一约束错误」。理由：`INSERT OR IGNORE` 撞索引时**不说话**，TypeORM 在 sqlite 下不回传「本次有没有真插进去」（`raw`/`identifiers` 语义与 mysql/postgres 不一致，本仓 `logging.service.ts` 用 orIgnore 时干脆丢弃返回值就是这个原因）。而调用方**必须**知道是不是自己插的——它决定要不要发一遍服务号推送，报错了就等于给用户重复推送。抛错与没抛错本身是最可靠的判据。返回 `{ message, created }` 而不是裸实体。`serialWrite` 不开事务，插入失败不会留下未提交状态。
    - **`send()` 的三步顺序是有意的**：① 先按键查重（命中直接返回）→ ② 再查当日配额 → ③ 最后插入。第 ① 步必须在 ② 之前：配额统计的是「今天已有几条」，若先插再统计，任务重跑会把同一条消息重复计数、把配额提前吃满。第 ③ 步的唯一索引兜住 ① 到 ③ 之间的并发窗口。
    - **`markRead` / `markAllRead` 的归属校验写在 SQL 的 `WHERE userId = :userId` 里**，不是先查后判——先查后判有「查完到更新之间」的窗口且多一次查询；条件更新天然把别人的消息过滤成 `affected=0`：传别人的 id 不报错、也不越权，只是不计入 affected。
      - **「全部已读」必须是显式动作**（`{ all: true }`）：若定义成「`ids` 为空 = 全部已读」，一个空 body、一次拼错的请求、一个被序列化成 `null` 的数组都会**静默清空用户全部未读**，而用户察觉不到（角标先没了，消息还躺在列表里）。两个参数都没给 → 控制器 400。
    - ~~**每日上限按北京日切分**，且上限 5 只统计**系统消息**：`ADMIN_NOTICE` 不计入，因为那是人对人的沟通，被系统配额挡住会出现「管理员想解释却发不出去」。超限**不是错误**：返回 `{ sent: false, reason: 'DAILY_LIMIT' }` 且不落库，调用方据此不写「已通知」标记位、留给下一轮补发。`MESSAGE_DAILY_LIMIT=0` 表示不限。~~
      - 🔴 **2026-09-15：整套每日配额已删除**，本段描述不再适用。`SendResult.reason` 字段与 `countTodaySystemMessages` 一并移除；`SendResult.sent` 保留但恒为 true（调用方仍拿它当「可以写已通知标记位」的判据）。理由与代价见本章第 17 条的订正说明与 `MessageService.send` 的注释。
      - 连带变化：`ADMIN_NOTICE` 与系统消息的**唯一**区别现在只剩「不去重」（`dedupeKey` 为 NULL，可无限多条）。
    - **OA 分支只留了一个空方法** `trySendOa()`，由 `OA_ENABLED`（默认 false）门控；未启用时 `oaSendStatus` 落 `SKIPPED`。服务号属独立分支 `feat/oa-template-message`，那三列**本期不写入任何业务逻辑但已建好**，届时只改代码、不碰 schema。误开 `OA_ENABLED=true` 时会打一条 warn 而不是静默 return——否则「消息发出去了但用户没收到推送」无从查起。
    - **`MessageModule` 是叶子模块**：只依赖 `TypeOrmModule.forFeature([Message])` 与 `UserModule`（后者仅为 `MessageController` 的 `JwtAuthGuard` 提供 JwtService），**不 import 任何业务模块**。发消息需要的一切业务数据（订单号、申请单号、金额、驳回理由）由调用方读好后传参进来。这不是洁癖：`MessageService` 会被 Booking / Refund / WechatPay / Admin / Feedback 五个模块同时导入，只要它反过来依赖其中任何一个就会立刻成环。**只导出 Service、不导出 Repository**——仓库层的条件更新是归属校验的落点，暴露出去等于给「绕过归属校验直接写 messages 表」开门；治理类操作（T3 置已读/删除）已由 Service 转发。
    - **模板单独成文件**（`message-templates.ts`，纯函数无 IO）：这 8 种消息的文案是产品口径、会被反复调整，拆出来后改文案的 diff 只落在一个文件里，评审时一眼看全，也不会碰到幂等/配额那段代码。
    - **`jumpPath` 是存进库的历史字符串**：页面改名后旧消息的跳转会指向上一版路径，小程序端跳转前必须做白名单校验并降级为「不跳转」。已写进实体注释与 DTO 说明。
    - **本阶段已验证**：`npx tsc --noEmit` 通过；`npx jest` **13 套 / 215 条全绿**（新增 `message.spec.ts` 18 条、`app.module.spec.ts` 1 条）；`node`/`ts-node src/main.ts` 真实启动成功。新增的 18 条里有 3 条是 **v1 缺陷回归**：同一订单第 2、3 次申请必须各收到一条审核结果（v1 按订单号去重，第二条起被静默吞掉）。
    - **发送点接线见说明 28**（T1 ② / T2 / T3、四个退款发送点、`POST /admin/messages/send` 均已完成）。
    - **前端已接线**（小程序消息中心 / 角标、管理端发消息页），见说明 29。
28. **阶段 4「站内信」发送点接线**（T1 ② / T2 / T3、四个退款发送点、`POST /admin/messages/send`）
    - **无 schema 变更**：`messages` 表与 `bookings.expireNotifiedAt` 分别已在第 9、7 节登记，本批次只写代码。**不需要执行任何手工 SQL。**
    - **T1 步骤②（`BookingService.runExpireScan` 内，cron 槽位 `0 13 * * * *` 不变）**：先 `markExpired`（状态流转），再 `findExpiredNotNotified(now, quietWindowMs)` 逐条发（**2026-09-15 去掉了 200 条上限**，见第 17 条订正）。两步各自可重入——**这是 v1 漏发缺陷的修复点**：v1 用「`expiredAt` 落在本轮扫描窗口内」挑待通知订单，某轮中途失败/进程重启时那批订单的 `expiredAt` 已写入而通知未发，下一轮它们早于窗口下限，**永远不再被取到**。`dedupeKey` 只防重复、不防漏发，标记位才能防漏发。
    - **A 规则（`now - createdAt >= 2h`）的作用域**：只在 `findExpiredNotNotified` 与 `findTodayUnverified` 两条查询里（常量 `MESSAGE_QUIET_WINDOW_MS`，`src/modules/message/message-policy.ts`）。**两个不满足 A 规则的陷阱都已锁死**：① 不满足时**不写** `expireNotifiedAt`（写了 = 这条通知永远发不出去，而库里显示「已通知」——这是标记位方案唯一可能失效的方式）；② ~~被每日配额挡下时同样**不写**~~（配额已于 2026-09-15 删除，现在只剩「单条发送抛异常」这一种不写的情形，见第 17 条订正）。退款受理/通过/驳回/到账四条**不套** A 规则，否则会出现「申请了退款却收不到审核结果」。
    - **T2 每日 22:00**（`BookingService.runDailyReminderScan`，新 cron 槽位 `0 0 22 * * *`，`taskRunning.dailyReminder`）：① 当天未核销 → `ORDER_EXPIRE_REMINDER`，**不写标记位**（次日 `bookingDate = 今天` 已不成立，该订单自然不再被扫到，不会永久漏发）；② 近 N 天已过期未通知 → `ORDER_EXPIRED` + 写标记位。② 的 N **与退款申请时限同源**（`getRefundApplyDeadlineDays()`），保证提醒只落在「还能退」的区间内。22:00 而非更晚：当天核销提醒必须在**当天还能核销**时送达。
    - **两条路径共用 dedupeKey `ORDER_EXPIRED:{bookingId}`**（T1 ② 与 T2 ②），谁先到谁生效、另一条被去重拦下也照样写标记位。**若两处 key 不一致，同一个用户会收到两条「订单已过期」**——这是本批次最容易在后续改动中被破坏的不变式，`booking-notify.spec.ts` 有专门一条守着。
    - **T2 ② 的 `refundStatus = 'none'` 条件**：已提交申请（`refunding`）的不再推「可申请退款」（文案与事实矛盾），且**不写标记位**——将来退款失败回到 `none` 时仍应能提醒。`refunding/refunded` 的订单不满足扫描条件，也就不会形成「取到却不标记」的队头堵塞。
    - **T3 治理 03:24**（`MessageService.runDailyGovernance`，新 cron 槽位 `0 24 3 * * *`）：30 天未读置已读 + 删除 90 天前消息。`readAt` 记**治理时刻**而不是 cutoff（记 cutoff 会让将来排查「用户到底看没看过」拿到假答案）。治理失败只记日志，不产生告警噪音。
    - **cron 槽位**：`0 0 22 * * *` 与 `0 24 3 * * *` 都是空闲槽位。既有的 `0 13 * * * *`（T1）、`0 21 3 * * *`（日志清理）、`0 23 * * * *`（日志落盘）**均未改动**。
    - **退款有四个发送点，但它们不在同一个地方**（这是本批次最容易搞错的一点）：
      - **受理 / 通过 / 驳回三个在 `RefundApplyService` 内**，统一走私有 `notifySafely()` 兜住一切异常：站内信是**通知**不是业务结果，写不进去不该让用户看到「申请提交失败」（申请单其实已落库，重试还会撞「请勿重复提交」），更不该让管理员看到 500 而以为「审核没生效」再点一次通过。
      - **到账（`REFUND_SUCCESS`）不在这个服务里**，而在**三处镜像各自的调用点**（`RefundApplyService.syncSettledByOutRefundNo`、`BookingService.mirrorRefundSettlement`、`WechatPayService.mirrorRefundSettlement`），经 `MessageService.notifyRefundSettled(apply, success)` 这个**单一出口**发出。
    - ⚠️ **上面那条「到账通知不能在 `RefundApplyService` 里」是本批次实际踩到并修掉的缺陷**，写在这里防止将来有人「顺手统一一下」。`markSettled` 有三个调用方，它们**刻意直接注入 `RefundApplyRepository` 而不经过 `RefundApplyService`**（避开模块环，是阶段 3 的设计）。最初把通知写在 `RefundApplyService.syncSettledByOutRefundNo` 里，后果是：单元测试全绿（那条路径确实会发），而**真实的微信回调路径上这条通知一条也发不出去**——因为回调走的是 `WechatPayService` 私有的 `mirrorRefundSettlement`。修法是把通知下沉到 `MessageService.notifyRefundSettled`，三处镜像各自 `if (affected > 0)` 调用它。
      - 该方法**永不抛异常**：调用点在微信回调里，抛出去会让回调返回失败并被微信重推。这与 `send()` 的抛错策略（数据库真故障应让定时任务失败并重跑）**刻意不同**，差别在调用方能否安全重试。
      - 「只发一次」由调用方的 `affected > 0` 保证（三条路径并发收敛时只有先到的那个拿到 1），即便漏了，`dedupeKey = REFUND_SUCCESS:{applyNo}` 也会兜住。**退款失败不发消息**（`refundStatus=failed` 需人工介入，让管理员去沟通，而不是推一条用户看不懂的「退款失败」）。
      - 金额取**申请单上的快照**（`refund_applies.refundAmount`）而不是订单当前金额：退的就是申请时那笔，订单金额后续若变，这条消息不能跟着变。
      - 新增 `refund-settle-broadcast.spec.ts` 把「三条路径都必须发得出去」锁死（含 `success=false` 不发、三条并发只发一条、写消息失败不反噬资金）。**已做过变异验证**：把 `WechatPayService` 那处的调用注释掉，该套件立刻 2 条红灯——它不是一条「无论实现怎样都会绿」的空测试。
    - **`RefundModule`、`WechatPayModule` 因此 import 了 `MessageModule`**。`MessageModule` 是叶子（只依赖 `TypeOrmModule.forFeature([Message])` + `UserModule`），**不反向依赖任何业务模块**——它被 Booking / Refund / WechatPay / Admin 四方同时 import 而不成环，靠的正是这一点。`BookingModule`、`AdminModule` 同样各补了 `MessageModule`。
    - **申请截止日的公式抽成了 `src/modules/refund/refund-deadline.ts`**（纯函数，无 DI）。原因：站内信正文要写「申请截止：YYYY-MM-DD」，而 `BookingService` **不能**注入 `RefundApplyService`（该类构造函数注释里的模块环理由），若公式留在服务里，T1/T2 只能把 `expiredAt + 7 天` 再抄一遍——两处各自演化迟早出现「站内信说 10 月 1 日截止、点进去接口说已超期」。日期用**北京日**（`beijingDateStr`）：服务器跑 UTC 时用 `toISOString().substring(0,10)` 会把 10 月 1 日写成 9 月 30 日。
    - **`POST /admin/messages/send`**（`SendMessageDto`：`{ openid, title, content, sendOa? }`，§6）。**不校验 openid 是否存在**：服务端只能拿 `user_profiles.wechatOpenId` 反查，那是「填过资料的用户」而非「登录过的用户」，很多用户只下单不填资料，校验会把他们挡在外面；放行的代价只是消息躺在 `messages` 里，用户下次进消息中心就能看到。手动消息 `dedupeKey = NULL`（唯一索引下多个 NULL 互不冲突）且**不计入每日配额**。`sendOa` 是**预留字段**：本期 `OA_ENABLED=false`，传 `true` 也只落库、不投递，响应里的 `oaSent` 恒为 false——由**后端下发**而不是让前端硬编码那句「仅站内信」提示，服务号分支上线后前端不用改。
    - **本批次已验证**：`npx tsc --noEmit` 通过；`npx jest` **16 套 / 260 条全绿**（新增 `booking-notify.spec.ts` 17 条、`refund-settle-broadcast.spec.ts` 9 条、`refund-apply.spec.ts` 追加 7 条站内信用例）；`DATABASE_PATH=:memory: LOG_DATABASE_PATH=:memory: npx ts-node src/main.ts` **真实启动成功**，四条新路由均 `Mapped`（`/messages` GET、`/messages/unread-count` GET、`/messages/read` POST、`/admin/messages/send` POST）。
      - `booking-notify.spec.ts` 的时间基准是**相对当前时刻**（`runExpireScan` 内部取 `Date.now()`，注入不了），期望值用该文件自带的独立算法计算、**不 import 生产实现**（否则测的是「自己等于自己」），因此不会随时间失效。
      - `refund-apply.spec.ts` 的站内信部分用**真实** `MessageService`（不是桩）：要验证的正是「业务动作真的落了一条消息」，桩掉它只剩「调用了一次方法」。其中一条是 **v1 缺陷回归**：同一订单第 2 次申请必须仍收到审核结果（v1 按订单号去重，第二条起被静默吞掉）。
    - **本批次连带修了 5 个既有 spec 的装配**：`BookingService` 新增必填依赖后，用 DI 容器搭它的 3 个（`booking-today-quota` / `booking-eligibility` / `system-config-limit`）报 `Nest can't resolve dependencies ... at index [9]`，直接 `new BookingService(...)` 的 2 个（`booking-expire` / `booking-cancel`）报 `Expected 10 arguments, but got 9`。**给这个类加必填依赖时按此清单同步**：前 3 个补 `{ provide: MessageService, useValue: {} }`，后 2 个在末位补一行（现已改成带参数名的注释形式，下次漏了能一眼看出补的是哪个）。

29. **阶段 4「站内信」前端**（小程序消息中心 / 角标、管理端发消息页）
    - **无后端改动、无 schema 变更**：本批次只碰 `fctl` 与 `admin`，后端一行未动（唯一例外是 `message.entity.ts` 里 `jumpPath` 的注释把「见消息中心页的 resolveJumpPath」改成了「见 `fctl/utils/message-center.js` 的 resolveJumpPath」——落点变了，注释必须跟着走）。
    - **未读数是「storage + storage 时间戳」，不是页面 data、也不是模块变量**（§4.4）。切 tab 走 `uni.reLaunch`，每次都是**全新页面实例**，页面级节流形同虚设；时间戳放 storage 才能跨页面、跨切 tab 生效。落在 `src/utils/message-center.js`（三个 tab 页 + 消息中心页共用），而不是写进某个页面——写进去另外三处就得复制一份，四个副本迟早出现「同一个红点在不同页显示不同数字」。
      - 未读数**存在 storage 而不是模块变量**：冷启动时模块变量没了，三个 tab 页会在 `data()` 里先渲染成 0、两百毫秒后再跳一下。
      - 失败**不抛不提示**，且保持上一次的值（不是 0）：一次网络抖动把角标清空比晚一点显示更糟。失败同样记时刻，避免后端不可用时每次切 tab 都重试。
    - **`fetchUnreadCount(force)` 的 `force` 有两个调用点，缺一不可**：① 首页微信登录**成功之后**——`onShow` 在 `onLoad` 之后立刻触发，那时 token 还没写进来（首页正是登录的发起处），只靠 `onShow` 会漏掉第一次；② 消息中心读完消息后强制刷新，且 `setUnreadCount` 会**重置节流窗口**，否则返回「我的」页时 30 秒窗口内还会把那个已经不准的数字发回去。
    - **跳转白名单在端上**（`resolveJumpPath`，`fctl/utils/message-center.js`）：`messages.jumpPath` 是**落库时的历史字符串**，页面改名后旧消息指向上一个版本，而端上无从知道它是否还有效。白名单放行、其余一律不跳；tabBar 页面走 `switchTab` 且**丢掉 query**（switchTab 不接受参数）。`jumpPath` 为空（反馈类消息）与「有路径但已失效」**分开处理**：前者静默，后者提示「链接已失效」——否则用户会以为「点了没反应」是卡住了。**新增可跳转页面时两端要同步改**（后端改文案路径、端上加白名单项）。
    - **`fctl/tests/message-center.test.js`（9 条）守住的就是上面两条**。跳转白名单的用例包括「前缀相同但不是白名单项」（`/pages/booking-detail/booking-detail-evil`）——防止将来有人把 `indexOf` 改成 `startsWith`；未读数用**内存版 `uni` 打桩**，锁的是「写进去的一定读得出来」和「脏值不渲染成 NaN 气泡」。`node --test tests/` **69 条全绿**（原 60 条 + 新增 9 条）。
    - **消息中心页**（`pages/messages/messages.vue`，已在 `pages.json` 注册并开 `enablePullDownRefresh`）：分组筛选（全部/订单/退款/通知）、点击已读、全部已读、触底加载。**前端不做任何规则判定**——分组只决定 `msgType` 发哪几个枚举值（逗号分隔，`GetMessagesDto` 的注释写了为什么不用数组），已读/未读、能否跳转全部由后端下发字段决定。
      - **「全部已读」显式传 `{all:true}`**，不是「ids 为空」。后端刻意不接受后者（一个空 body 会静默清空用户全部未读），端上也不做那层「宽容」。
      - 点击已读**先本地置已读再发请求**：用户点开就要立刻看到红点消失。失败不回滚——服务端没记住的话下次进来还能再点一次，代价可接受。
      - **未读数只在「全部」分组下用列表校正**：其它分组只加载了一部分类型，统计出的未读数偏小，拿它覆盖角标会把红点错误地消掉。
    - **管理端**（`admin/src/pages/messages/index.tsx` + `api/messages.ts` + `App.tsx` 路由 + `MainLayout.tsx` 菜单）：只有发送，没有列表/撤回。**没有「撤回」这个概念**——站内信没有推送，用户可能几天后才打开，撤回需要一个「用户还没看到」的窗口，而那个窗口无法定义。
      - 「仅站内信 / 已推送服务号」的提示文案取自**响应里的 `oaSent`**，不是前端写死：服务号分支上线后 `oaSent` 变 true，前端自动改口。
      - 页面上写明**接收人从订单/反馈详情复制 openid**，并解释为什么不能填手机号（`user_profiles.phone` 不唯一）。
    - **本批次已验证**：`node --test tests/` **69 条全绿**；四个改动过的 `.vue` 的 `<script>` 块过 `node --check`（uni-app 本仓无构建脚本，这是能做到的最强的静态检查）；`admin` 端 `npx tsc -b` + `npx vite build` 通过；`nest` 全量 `npx jest` **16 套 / 260 条**仍全绿。
    - **未做（明确不在本批次）**：① 方案 §7.1 的「首页强提醒横幅」——§4.4 的原文是「**如需**强提醒用首页顶部非阻断横幅」，属可选增强，且方案没定义「哪些消息算强提醒」「『同一消息只出现一次』记在哪里」，实现它等于现编一套规则，未擅自实施；② 方案 §7.1 的「**退款详情页（新增）**」——阶段 3 已把退款进度卡片做进了 `booking-detail` 页（`expired` 分支 + 申请弹窗 + 展示态 + 重新申请入口），独立页面未建，功能上不缺，是否拆页另议；③ 反馈列表页/详情页属阶段 5。
24. **阶段 3：退款申请/审核落地**（订单过期与退款闭环 v2 §4.3）
    - **`markRefundStarting` 放开 `status IN ('confirmed','expired')`**（§4.3.3.1 改动 1）。这是全方案唯一触碰并发临界区的地方：不改则过期单的退款条件 UPDATE 恒返回 `affected=0`，**退款永远发不出去**。改动已按硬约束**晚于** Q1 拦截（说明 22）发布，二者不能同批。`markRefundSucceeded/Failed` 未改动——它们的 WHERE 只判 `refundStatus` + `outRefundNo`，不判 `status`，`expired → refunded` 天然成立。
    - **`initiateRefund` 增加 `options.outRefundNo` 入参**（改动 2 的 ①，②的 Q1 拦截已在 2A 提前落地）。传入时不走 `booking.outRefundNo ?? 'RF'+bookingId`。原有那条幂等规则是为「自助退款重试单号不变」设计的；审核路径下「同一次退款重试不重复退」由 `prepareApproval` 复用申请单上已落库的 `outRefundNo` 保证，若仍沿用 `RF{bookingId}`，用户第二次申请会命中微信对同一 `out_refund_no` 的幂等返回（返回那张已 CLOSED 的退款单），**资金永远退不出去**。单号规则：`RF{bookingId}` / `RF{bookingId}-2` / `RF{bookingId}-3`（`buildOutRefundNo`）。
    - **审核通过路径传 `openid = ''`**：`initiateRefund` 第二步是归属校验，而审核的操作者是管理员、不是下单人，该分支由 `options.asAdmin` 显式跳过。调用方是 `AdminService.approveRefundApply`，编排顺序为「先落 approved，再调 `initiateRefund`」——反过来会在「微信成功 + 落库失败」时留下可重复点通过的 pending 单，即重复退款。`initiateRefund` 抛错**不回滚 approved**，订单停在 `refunding` 由既有 15 分钟对账收敛，与用户自助退款同一套容错。
      - ⚠️ 本行原文写「该分支由 `options.asAdmin` 显式跳过（2A 已就位）」，**与当时的代码不符**：2A 里 `asAdmin` 只放行了 `expired` 拦截，归属校验仍是无条件的。据此写出的调用方（传空 openid）会让审核通过 100% 抛「无权操作该订单」。**缺陷与修复见说明 30。**
    - **`refundEntry` 的下发位置**：`RefundApplyService.buildRefundEntry(booking)` 由 `BookingController.getBookingById` 组合进订单详情响应（`data.refundEntry`）。服务**不注入 `BookingRepository`**，订单由调用方读好传入——一旦注入，`RefundModule` 就必须 import `BookingModule`，与 `BookingModule → RefundModule` 立刻成环。`RefundModule` 因此不含控制器也不依赖任何业务模块，可被 Booking / WechatPay / Admin 三个模块安全 import。
    - **资金结果镜像共三个调用点**（`syncSettledByOutRefundNo`）：`WechatPayService.handleRefundCallback`、`BookingService.applyRefundReconcileResult`、`BookingService.applyAnomalyAction` 的 `refundSucceeded`/`refundFailed`。三个调用点都注入 `RefundApplyRepository`（不注入 `RefundApplyService`，同样是为了避开模块环），并在各模块内直接 `TypeOrmModule.forFeature([RefundApply])`。`markSettled` 只在 `status='approved'` 时生效，重复收敛是 no-op；反查不到申请单（自助退款/管理员直接退款）**静默返回**，是正常路径。
    - **`parseRefundNotify` 追加返回 `outRefundNo`**：镜像按退款单号反查申请单，必须用**回调携带的本次单号**，不能用订单上当前的 `outRefundNo`。`handleRefundCallback` 的第三参可选，缺省时退回订单上的值（历史报文/测试桩兼容）。
    - **`RefundException`/`RefundForbiddenException` 重写了 `getResponse()`**，把 `code` 放进响应体。`booking-errors.ts` / `payment-errors.ts` 的同名模式只 `super(message)`，Nest 构造的响应体里没有 `code` 字段，`HttpExceptionFilter` 的 `responseObj.code` 恒为 undefined——**那些码目前实际传不到前端**。本期新写的两个类刻意不再沿用那个写法；是否回头统一另议（改动会让既有端点的响应体多出一个字段）。
    - **`GET /bookings/:bookingId` 的响应体结构有变**：`data` 由订单实体变为 `{ ...订单实体, refundEntry }`。字段只增不减，但严格比对响应结构的调用方需知悉。
    - **审核操作人（§4.3.4）**：`login()` 追加返回 `adminToken`（JWT `{adminId, username, name, type:'admin'}`，12h）；`AdminAuthGuard` 读 `x-admin-token` 验签后置 `req.admin`，无 token 时回退 `x-admin-key` 并置 `req.admin = null`（审核照常可用，`auditAdminId/auditAdminName` 记 NULL，日志标 `operatorUnknown: true`）。**与方案原文的一处偏离**：原文是「token 存在但无效则回退 key」，实现改为**严格模式直接 401**——回退会在 token 过期后静默降级，所有审核的 operator 悄悄变成 null，等发现时已攒下一批无法追责的记录。CORS `allowedHeaders` 已加 `x-admin-token`。
    - **阶段 3 不含任何通知代码**：方案 §4.3.1/§4.3.3 的站内信（受理/通过/驳回/到账）依赖 `messages` 表与 `MessageService`，二者属阶段 4（§4.6 明确「阶段 4 完整落地」）。本阶段的单据状态与资金结果都已落到 `refund_applies`，阶段 4 直接读表补发即可，不存在需要回填的中间态。
    - **`refundEntry` 追加下发 `contactPhone`**：驳回理由、退款失败、申请超期三处文案都要带客服电话（§4.3.5），而这三处**都由 `refundEntry` 触发**。让小程序端另调 `/system-config/*` 会出现「状态显示了、电话还没到」的中间态，且多一次请求，故随入口一起下发。取 `REFUND_CONTACT_PHONE` 环境变量，**未配置下发空串**（不是 undefined，避免前端各写一套兜底），前端整行隐藏——宁可少一句电话，也不编一个打不通的号码。
    - **小程序端（`fctl/pages/booking-detail/booking-detail.vue`）**：`expired` 的 hero 区由单一「订单已过期」文案改为 §4.3.5 的展示态分支，判定**只读 `refundEntry`**（`latestApply.status` 决定展示态，`visible` 决定按钮，`reason` 只用于文案兜底），前端不重复实现任何一条规则。被驳回时按钮文案自动变「重新申请退款」（`visible` 会回到 true，无需特判）。新增自绘退款申请弹窗（原因必填、200 字上限）——不用 `uni.showModal` 是因为它只有单行输入（`editable`），写不下审核员赖以判断的说明。
    - **`expiredAt` 与 `applyDeadline` 的口径**：两者都是时刻值（后者是 epoch ms），展示前端的 `formatDateText` 只处理日期字符串，故另加了 `formatDateTimeText`，不把毫秒塞进前者（会丢掉时分，且两种语义混在一个方法里下次改动必踩）。
    - **阶段 3 未做的两项**（留待后续，非疏漏）：
      1. **小程序订单列表**仍未按 §4.3.5 显示「退款审核中 / 已驳回」等态。列表接口 `GET /bookings` 目前不下发 `refundEntry`，要支持需为每行补一次申请单查询（当前 `pageSize=99`），属接口级改动，未在本阶段顺手做。
      2. `POST /bookings/:bookingId/refund`（自助退款，`confirmed` 单）的响应体仍不回 `errorCode`（说明 22 末尾的残留项）——本阶段新增的 `/refund-apply` 端点已按 `RefundException.getResponse()` 回码，两者不一致。
    - **测试**：`src/modules/refund/refund-apply.spec.ts` 34 条，覆盖入口显隐五条件与优先级、服务端拦截独立于显隐、序号递增 vs 额度消耗的双口径、「申请→驳回→再申请」、审核互斥（并发第二个拿 `APPLY_ALREADY_HANDLED`）、镜像幂等与「只对 approved 生效」、退款单号换号、客服电话下发。全仓 `npx jest` 196/196；`npx tsc --noEmit` 通过；`admin` 端 `tsc -b` + `vite build` 通过（新增退款审核页）。
      - ⚠️ **这 34 条全部只搭 `RefundApplyService`**（providers 里只有仓库 + MessageService + 配置桩），**没有任何测试把 `AdminService → RefundApplyService → BookingService.initiateRefund` 这条链接起来**。说明 30 的缺陷正是从这条缝里漏过去的：三个类各自单测全绿，而「点一下就把钱退出去」这条唯一动钱的路径是断的。链路级测试已补在 `refund-approve-chain.spec.ts`（4 条，含变异验证）。

30. **【阶段 3 断链，已修】审核通过后退款 100% 发不出去——`asAdmin` 没有跳过归属校验**（阶段 4 复审时发现）
    - **症状**：管理员点「通过」→ 申请单落 `approved`（已写库）→ `initiateRefund` 抛「无权操作该订单」→ 管理端报错。**钱一分没发起**，而用户端已经看到「审核已通过，款项将在 1–3 个工作日内原路退回」。更麻烦的是**不可重试**：单据状态已不是 `pending`，再点一次会被条件更新拦成 `APPLY_ALREADY_HANDLED`；`refundStatus` 从未进入 `refunding`、`reconcileKind` 也没写，所以既有 15 分钟退款对账**不会**接管（它只扫 `reconcileKind='refund'` 的单）。这张单永久卡在 `approved`。
      - 唯一线索是审计日志里的 `approve-refund-failed`（带 `outRefundNo`，能与微信账单对上）——**得上人工捞**，见说明 31 的建议。
    - **根因**：`initiateRefund` 的归属校验 `if (booking.wechatOpenId !== openid)` 是无条件的（说明 22 里 `asAdmin` 的引入只服务于放行 `expired`，那句「为 true 时放行 expired」是准确的），而阶段 3 的审核路径按「asAdmin 已就位」的假设传了 `openid = ''` 且未复核这一条。**两个阶段各自看都对，接起来是断的。**
    - **修复**：`if (!options?.asAdmin && booking.wechatOpenId !== openid)`。用户自助路径（`POST /bookings/:id/refund`）不带 `asAdmin`，归属校验原样保留——他人 openid 与空 openid 都仍被拒，已锁进测试。
      - 为什么是「asAdmin 跳过校验」而不是「让审核路径传下单人的 openid」：后者要求审核路径先读一次订单拿 openid（多一次查询），且语义上是在**冒充用户**去通过一个本该为空的校验；`asAdmin` 的语义应是「服务端内部可信调用方，跳过用户范围的检查」，与它放行 `expired` 是同一件事的两面。
    - **回归锁**：新增 `src/modules/refund/refund-approve-chain.spec.ts`（4 条）。它**不测任何类内部的行为，只测接线**，断言落在**数据库状态**上——「审核通过后 `bookings.refundStatus` 必须真的变成 `refunding`、`reconcileKind='refund'`、`outRefundNo` 落库」，而不是「调用过某个方法」（后者在接线断掉时同样会通过）。
      - **已做变异验证**：把修复退回原样，4 条里红 3 条；恢复后 4/4 绿。它不是「无论实现怎样都会绿」的空测试。
      - 为什么用 `AdminService` 入口而不是直接调 `initiateRefund`：缺陷就发生在这个组合关系里，从 `initiateRefund` 单点测不到——当时阶段 3 的单测正是这么做的。
    - **教训（写在这里供后续阶段复用）**：新增一条横跨多个类的调用链时，「每个类都有单测」不等于「链路是通的」。**跨类的接线要有一条从真实入口进入、断言落在持久化状态上的测试**；只 mock 下一环的测试无法发现参数契约错位（本例就是 `openid` 该不该受 `asAdmin` 影响这种口头契约）。

31. **`approved` 申请单缺一条收敛哨兵**（说明 30 的连带发现，**未实现，待决策**）
    - **缺口**：申请单落到 `approved` 之后、`bookings.refundStatus` 进入 `refunding` 之前，**没有任何机制核对这两者是否对应**。15 分钟退款对账只扫 `reconcileKind='refund'` 的订单，所以「单据 approved 而订单从未进 refunding」这类单不会被任何任务捞起——说明 30 的缺陷就停在这个状态里，且只能靠人工翻审计日志发现。
    - **建议**：沿用 §9.3 的形态加一条哨兵——`refund_applies.status='approved' AND auditAt < now - 30min` 且对应订单 `refundStatus NOT IN ('refunding','refunded')` → 告警（或直接进 `booking_anomalies` 走人工通道）。§9.3 目前只有「待审核积压 > 48h」，覆盖的是 `pending`，覆盖不到 `approved`。
    - **同时要改一句文案**：管理端在 approve 失败时提示「系统将自动重试对账」。失败发生在 `markRefundStarting` 成功**之前**时（说明 30 就是），订单既没进 `refunding` 也没写 `reconcileKind`，**没有任何东西会重试**——这句话在那类失败上是假的。要么把文案改成「退款未发起，请查日志后重试」，要么让后端回一个可区分的错误码（如 `REFUND_NOT_STARTED`）由前端分支。
    - 未实现的原因：属监控/告警范畴，需要先定告警通道；记在这里是为了避免它被默认成「已经有人管了」。

32. **业务规则变更：驳回即终态，不允许再次申请**（2026-09-13 决策，阶段 4 复审时落地）
    - **决策**：订单的退款申请一旦被驳回，该订单**不再开放申请入口**，前端引导用户联系管理员（客服电话已在驳回文案里）。
    - **为什么**：原方案（§3.1 / §11 Q13）允许「驳回 → 再申请」，但「被驳回不计入消耗次数」的口径与「`applyCount` 必须单调递增」的唯一索引约束打架——结果是**申请次数实际无上限**：用户可以反复提交，每次新增一条待审单 + 一条受理站内信，单人就能刷满管理员队列。改成终态后这条路径直接消失；**只剩「审核通过 → 资金执行失败（failed）」允许再申请**，而 failed 消耗额度，所以总次数仍受 3 次上限约束。
    - **实现**（三处，缺一不可，否则「前端没有按钮」不等于「接口拦住」）：
      1. `RefundApplyRepository.hasRejectedApply(bookingId)`（新增原语）；
      2. `resolveEntryReason`：`APPLY_REJECTED`，**优先级放在超期/审核中之前**——「这笔退款被驳回了」比「已超期」更贴近用户要处理的实事；
      3. `assertCanApply`：`REFUND_APPLY_REJECTED`，硬拦截（旧版小程序、直接调接口都走这里）。
    - **前端**（fctl `booking-detail`）：删掉「重新申请退款」按钮文案分支（按钮的显隐本来就只认 `visible`，后端不再下发 true 即自然消失），并把 `APPLY_REJECTED` / `DEADLINE_UNAVAILABLE` 两个原因码加进兜底文案表。
    - **连带更新**：`refund-entry.interface.ts`、`refund-errors.ts`、`refund-apply.entity.ts`（`failed`/`rejected` 的对比注释）、方案 §3.1 / §3.3 / §4.3.3 / §4.3.5 / §7.1 / §11 Q13。既有用例「申请→驳回→再申请」改写为「驳回即终态」，v1 缺陷回归用例（第 2 次申请仍能收到审核结果）改用 **failed → 再申请** 这条仅存的路径构造——被测的不变式（dedupeKey 带 applyNo）没变。
    - **`outRefundNo` 的序号后缀**（`-2` / `-3`）现在只在 failed 重试时用到，**不要因此删掉**：它的存在理由就是「同一订单的第二笔退款必须换号」，而这正是 failed 重试的场景。

33. **微信退款「异常」（ABNORMAL）改为非终态**（2026-09-13，修一个重复退款敞口）
    - **敞口**：`handleRefundCallback` 与 `applyRefundReconcileResult` 原先把 `ABNORMAL` 与 `CLOSED` 一起判为**终态失败**（`refundStatus=failed`）。微信的「退款异常」常见原因是商户可用余额不足，**补足后这笔退款仍可能成功**。判失败的直接后果不是「多一条失败记录」，而是：用户重新申请（`failed` 允许重提）→ 换号重发 `RF{id}-2` → 第一笔后来成功 → **同一订单退两次**。
      - 为什么以前不会：初版 `initiateRefund` 用固定单号 `RF{bookingId}` 重试，微信对同一 `out_refund_no` 幂等，**天然不可能产生第二笔**。阶段 3 为了「第二次申请是一笔新退款」把单号改成带序号——这是设计明确要的（§3.3），代价就是这里必须补上「不判终态」。
    - **修复**：`ABNORMAL` 移出终态失败分支，与 `UNKNOWN`/临时错误同侧——**保留 `REFUNDING` + 保留 `reconcileKind='refund'`（继续对账，等它自愈）+ 记一条异常**：
      - 回调路径（`WechatPayService.handleRefundCallback`）：`markRefundResultUnknown(..., 'REFUND_ABNORMAL', now)` + `upsertAnomaly(REFUND_QUERY_REPEATED_FAILURE, 'REFUND_ABNORMAL', '微信退款异常（非终态）：常见原因是商户可用余额不足，需人工核查商户账户')`；
      - 对账路径（`applyRefundReconcileResult`）：`case 'ABNORMAL'` 并入 `UNKNOWN`/default 分支，并按 `result.state` 给出对应 summary；
      - `queryRefund` 给 ABNORMAL 附 `errorCode='REFUND_ABNORMAL'`，让这个码落进 `booking_anomalies.lastErrorCode`——运营排查「这笔钱卡在哪」的入口。
    - **为什么复用 `REFUND_QUERY_REPEATED_FAILURE` 而不新增异常类型**：该类型的每一处终态分支都会 `resolveAnomaly` 把它关掉（成功/失败都会），新增类型就得同步补 resolve 调用点，否则退款成功后异常永远挂着 OPEN；而 `lastErrorCode='REFUND_ABNORMAL'` 已经足够精确。`ANOMALY_RECOVERY_POLICY` 为 auto（继续查询，可能自愈），退避 30min→2h，与既有异常通道一致。
    - **取舍**：代价是「异常单可能多挂一会儿」而不是「立刻报失败」；这是刻意选的方向——**判错的代价是重复退款（涉及资金、不可逆），判慢的代价只是一次人工排查**。不对称，所以往慢的一侧靠。
    - **测试**：`refund-settle-broadcast.spec.ts` 新增 2 条（ABNORMAL 保持 refunding/approved + 记异常 + 不发到账消息；**对照：CLOSED 仍判失败**——防止把改动扩大成「什么都不判失败」）。

34. **两处按建议修正**（同批）
    - **入口短路**：`buildRefundEntry` 在 `status !== 'expired'` 时**直接返回，不查申请单表**。原先无条件执行 3 个查询（`countConsumedApplies`/`hasOpenApply`/`hasRejectedApply`/`findLatestByBookingId`），而它们的结论在非 expired 时必然用不到（`resolveEntryReason` 第一行就返回 `NOT_EXPIRED`）。订单详情是热点接口——小程序在 `pending`/`confirmed` 下**每 5 秒轮询一次详情**，不短路等于每个打开着的详情页每分钟多 36 次查询，而本库是单连接 SQLite。测试用 `jest.spyOn` 断言「这三个方法一次都没被调用」，避免将来有人把短路优化掉。
    - **`expiredAt` 为空时时限 fail-closed**：原实现 `if (applyDeadline != null && ...)` 在 `expiredAt` 为空时**跳过时限校验**，于是入口变成永久可申请——把「数据缺失」翻译成了「没有时限」，与 §4.3.5「7 天是硬性上限」冲突（`refund-deadline.ts` 的注释还写着「由调用方落到『未过期』分支」，与代码不符，已一并订正）。现在：入口给 `DEADLINE_UNAVAILABLE`、提交给 `REFUND_DEADLINE_UNAVAILABLE`，两处都拒绝。触发条件只有手工 SQL（`markExpired` 必写 `expiredAt`），属防御性分支。
    - **本批次验证**：`npx tsc --noEmit` 通过；`npx jest` **17 套 / 269 条全绿**；`npm run smoke:expire` **21/21**；`fctl` 的 `node --test tests/` **69/69**；`admin` 的 `tsc -b` + `vite build` 通过。

35. **C 端订单软删除（2026-09-15）**：用户可删掉自己的订单记录，「只有用户自己看不到」——数据不真删，后台照旧可见，管理员不能删。
    - **接口**：`DELETE /bookings/:bookingId`（`JwtAuthGuard` + 归属校验，无 body）。首次与重复删除**都是 200**，用 `data.alreadyDeleted` 区分。选 DELETE 而不是 `POST /:id/delete`：本控制器的 `POST /:id/xxx` 全是**状态机动作**（cancel/pay/verify/refund/refund-apply），而删除不改任何状态。失败**不 catch**，交给全局过滤器（越权 400 / 订单号不存在 404 / 无 token 401）——删除没有任何稳定错误码要保，包一层只会把 404 压成 400。
    - **schema**：`bookings.deletedByUserAt`（可空 integer，**毫秒** epoch，由 `timestampTransformer` 与 Date 互转），见第 10 节 DDL。**必须先执行 SQL、再发代码**。
    - **为什么不用 `@DeleteDateColumn`**：TypeORM 会给所有 `find/count` 自动加 `deletedAt IS NULL`，而 `BookingRepository.getBookingById` 被核销、退款、支付回调、对账、管理端快照共 17 处共用（外加 `wechat-pay.service.ts` 绕开仓库的独立读入口）。自动过滤会**静默掐断资金链路**，且没有任何编译期提示。过滤点因此显式写在用户侧那三处。
    - **过滤点（用户侧，全部在 `deletedByUserAt IS NULL` 上）**：`getBookings`（列表）、`countBookingsByStatus`（角标计数）、`booking.service.ts` 的 `getBookingById`（详情 + 退款申请入口，判断写在**归属校验之后**，反了会把「这单存在、只是被删了」泄露给非本人）、三个扫描查询（`findExpiredNotNotified` / `findTodayUnverified` / `findExpiredForRefundReminder`——已删订单不再收任何过期/退款提醒）。
    - **绝不过滤（改错一处就是事故）**：仓库 `getBookingById`、管理端四条链路（列表/导出/看板/`getBookingByIdForAdmin`）、**名额与统计**（`getBookingStatsByDate`、`buildDailyFreeQuotaInfo`、下单时的容量判定）、资金与核销（`initiatePayment`/`initiateRefund`/`verifyBooking`/`getPaymentStatus`）。给名额统计加过滤会造出「删单即可重领当天免费名额」的薅羊毛洞，与既有「取消/退款不退还名额」直接冲突——`booking-delete.spec.ts` 有一条用例专门守着它。
    - **删除不参与状态机**：`markDeletedByUser(bookingId, openid, now)` 只写 `deletedByUserAt`，不改 status/paymentStatus/refundStatus、不清 reconcile 调度、不做状态前置条件（**任意状态可删**，含 PAYING——钱照常落到一张用户看不见的单上，由对账收敛）。条件里的 `deletedByUserAt IS NULL` 让重复删除只有第一次 `affected=1`，也让重复点击**不会把删除时刻越刷越新**。
    - **归属校验在 SQL 里**（`WHERE wechatOpenId = :openid`），与 `MessageRepository.markRead` 同款；服务层另外先做一次未过滤的读做归属判定，那是为了让「重复删除」幂等返回成功（用过滤过的读会把第二次删除变成 404）。
    - **「管理员不能删除」当前天然成立**：admin 控制器没有任何 `@Delete` 订单路由，本次也不新增。治理类后台操作（导出等）读的是不过滤的链路，因此用户删过的单在后台一切照旧——管理端类型是手写 interface，多一个字段不影响渲染，将来想在详情里显示「用户已删除」**后端零改动**。
    - **小程序**：`fctl/pages/booking/booking.vue` 与 `fctl/pages/booking-detail/booking-detail.vue` 的 `confirmDeletePreview()` 补上真实请求（此前是 `'删除接口暂未接入'` 占位）。列表页删除后 `getList()` 重拉；详情页删除后 `uni.reLaunch` 回列表——详情页每 5 秒轮询一次 `GET /bookings/:id`，留在原页会持续 404。
    - **验证**：`npx tsc --noEmit` 通过；`npx jest` **25 套 / 349 条全绿**（新增 `booking-delete.spec.ts` 17 条 + `booking-delete-endpoint.spec.ts` 6 条）；`fctl` 的 `node --test tests/` **91/91**。

36. **手动触发接口的过期边界改为「此刻之前」（含当天）**（2026-09-15）
    - **背景**：cron 的过期判定 `bookingDate < 今天` 意味着「当天全天可核销」，当天的单要等过了北京零点才下沉——这是对的，且不变。但 `POST /admin/tasks/expire-scan` 的定位不同：它是管理员用来**清干净当前状态**的入口，点完之后不该再剩下任何「日子已经过了却还挂在 `confirmed`」的单。管理员实际想要的判据是「此刻之前」，而不是「今天之前」。
    - **改动**：`markExpired(todayStr, now, options)` 增加 `options.includeToday`——true 用 `bookingDate <= :todayStr`，false（默认）沿用 `<`。`TaskTriggerOptions` / `TriggerTaskDto` 同步加 `includeToday`；`ExpireScanResult` 回传 `includedToday`，接口 message 里写明「（含当天）/（不含当天）」，管理端结果表格新增「过期边界」一行。
    - **默认值**：service 默认 `false`（**cron 调用点不传，行为一字不变**）；手动接口默认 `true`，用 `dto.includeToday !== false` 实现——只认显式关闭，字段缺失/undefined/null 一律按「含当天」走。理由是接口语义就是「此刻之前」，若默认退回 cron 边界，管理员点一次却清不干净当天的单，而界面文案还写着「含当天」。
    - **⚠️ 含当天的连带后果（必须在界面上说清）**：
      1. 当天未核销的订单一律 `expired`，**此后无法核销**（`markVerified` 要求 `status='confirmed'`，会返回「当前状态：expired」）；
      2. **当天名额被释放**——`getBookingStatsByDate` 只统计 `pending/confirmed`（与下单容量校验同源），刷完之后当天会重新变成「可预约」；
      3. 这些单的资金出口只剩「申请 → 审核」，与其它过期单一致。
      **要「把当天封盘」请用预约开关（`isBookingEnabled`），不要用这个接口**——上面第 2 条正是它做不到这件事的原因。
    - **管理端**：过期扫描卡片加了「包含今天」勾选框（默认勾选，含红色警示文案说明上面三条），二次确认里带上本次边界；不勾选时提示「与定时任务同一判据」。
    - **没有改通知链路**：当天被刷过期的单会被步骤②按既有规则扫到（受 A 规则静默期约束），文案与截止日照旧。
    - **验证**：`npx tsc --noEmit` 通过；`npx jest` **25 套 / 357 条全绿**（`booking-expire.spec.ts` 的 `includeToday` 子 describe 4 条 + `admin-tasks-endpoint.spec.ts` 的「过期边界」describe 3 条 + 响应结构 1 条）；`admin` 的 `tsc -b` 通过。
    - **顺带记录一次实测（回答「日期累积会不会拖慢扫描」）**：10 万行 / 3 年的合成库上，`markExpired` 的实际计划是 `SEARCH bookings USING INDEX idx_bookings_status_date (status=? AND bookingDate<?)`——**索引第一列是 `status`**，所以它定位的是「当前还挂在 confirmed 的行」，而不是按日期扫全部历史；被刷过的行永久离开这个集合，工作集只与近日单量有关、与历史总量无关。首次（469 单待刷）47 ms，排空后再跑 0 ms；即使去掉复合索引只剩单列 `status` 索引，计划仍是 `SEARCH ... USING INDEX IDX_status`（43 ms）。作为对照，**强制**走单列 `IDX_bookingDate`（等价于扫全部 3 年历史）是 265 ms——那才是「累积」会发生的样子。上生产后按 7b 节的规矩用 `EXPLAIN QUERY PLAN` 自检一次，只要不是按 `bookingDate` 单列索引打头就没有累积问题。

37. **年龄免费开关打开：13 岁及以下、70 岁及以上恢复人员级免费**（2026-09-15）
    - **改的是什么**：`AGE_FREE_ENABLED` 由 `false` 改为 `true`，两处同名同值的常量必须同改——后端 `nest/src/modules/booking/passenger-pricing.ts`（**唯一有效的那处**，决定实付金额）与前端 `fctl/utils/passenger-pricing.js`（只决定人员卡片上那行绿色「13岁及以下，年龄免费」标签显不显示）。前端改慢一步不会算错钱，只是标签晚一轮小程序版本出现；**后端先发是安全的**。
    - **这个开关的来历**：`93af88b`（2026-08-17，commit message 只有「更新」）在**把儿童边界从 7 岁提到 13 岁**的同一次提交里加了这个开关并置 false，之后无人记录原因。后果是「13 岁/70 岁」这组数字一切可见的地方（校验文案、类型自动分类、管理端标签）都在，唯独**不再免费**——因为 `calculateAgePricing` 里 `ageFree = true` 的整个分支被 `AGE_FREE_ENABLED &&` 短路掉了。本次是把它恢复到该提交之前的语义（边界数字按新口径 13/70），不是新功能。
    - **打开后的计费口径**（`composeOrderPricing`）：`金额 = 收费人数 × 单价`，收费人数 = 总人数 − 年龄免费人数。部分免费（如 1 成人 + 1 儿童）→ `isFree=false`、`freeReason=null`、金额为 1 个单价，走正常微信支付；**全员免费 → `amount=0`、`isFree=true`、`freeReason='age'`，`createBooking` 直接落 `confirmed` + `paid`，不调微信支付**。
    - **`ageValue` 仍照常落快照**（`idCardUnavailable` 的儿童/老人仍按 `id_card_unavailable` 正常收费，与 `regular` 区分）。这一点在开关关闭期间也是成立的，所以**历史订单不受本次改动影响**——订单详情读的是 `passengers` JSON 里存下的 `ageFree`/`pricingReason`，不按当前开关重算。同理，2026-08-17 之前产生的老年龄免费订单本来就在库里，本次不会把它们变回收费。
    - **不受影响的三处**（改开关时逐条确认过，均有测试守着）：
      1. **会员 / 每日名额整单免费**优先级更高，命中时 `pricingReason` 统一成 `member_order_free` / `daily_quota_order_free`；被覆盖的人员 `ageFree` 仍保留为 true，`ageFreePeople` 统计不归零（这是 `composeOrderPricing` 的既有语义，不是本次引入）。
      2. **年龄全免费订单不占每日免费名额**——名额统计只认 `freeReason='dailyQuota'`，`booking-eligibility.spec.ts` 有专条守着，否则会出现「用儿童单消耗掉当天的免费名额」。
      3. **退款入口对 `isFree` 订单本就不可见**（`refund-apply.service.ts` 的 `!isFree` 条件），所以全额免费单不会出现「申请退 0 元」的入口；部分免费单退的是它真正付过的那笔金额（`booking.amount`）。
    - **边界**：13 岁免费、14 岁不免费；70 岁免费、69 岁不免费。年龄仍是 `预约游玩年份 − 出生年份` 的粗算（生日误差是既有口径，未改）。未来出生年份（`age < 0`）即使漏过前置校验也不免费——`calculateAgePricing` 里有独立守卫。
    - **没有 schema 变更，不需要任何手工 SQL**。上线的两件事：后端发版（金额立即变）、小程序发新版本（绿色标签才会出现）。小程序未更新期间，老版本用户拿到的 preview 金额**已经是 0**，因为金额以后端返回为准，前端只是不显示那行标签。
    - **测试改动不是「顺手删」而是「按打开后的预期重写」**：`passenger-pricing.spec.ts` 与 `booking-eligibility.spec.ts` 里有 9 条断言是按关闭状态写的（标题含「年龄免费关闭」），逐条改写成打开后的金额与 `pricingReason`，并新增 4 条：13/14 与 70/69 的**双向边界**、未显式选类型的 13 岁联系人**单人成单直接全免**、**全员年龄免费经 `createBooking` 落 `confirmed`/`paid` 且金额 0**（这条路径在开关关闭期间不可达，此前没有覆盖）。
    - **验证**：`npx tsc --noEmit` 通过；`npx jest` **25 套 / 359 条全绿**；`fctl` 的 `node --test tests/` **91/91**。
    - ⚠️ **要不要改成运行时开关**（挪进 `SystemConfig`，像 `freeQuotaEnabled` 那样让运营自己开关）**未做**：那会把一个编译期常量变成每次下单都要读一次的配置项，且管理端要新增开关与文案。本次按「恢复业务规则」处理，需要再关时仍改代码。
