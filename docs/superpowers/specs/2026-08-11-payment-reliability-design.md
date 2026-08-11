# 支付发起与定时对账可靠性设计

## 目标

在保持单 Nest 实例、SQLite 和现有微信支付接入方式不变的前提下，降低重复点击、网络重试和后台对账并发造成的支付卡顿。设计只增加小范围的并发控制、任务调度字段和异常订单记录，不引入 PaymentAttempt 表、队列服务或新的数据库。

本设计跨越两个仓库：

- `nest`：支付 single-flight、短期结果缓存、微信请求分类和定时任务拆分。
- `fctl`：可恢复的支付准备状态和重复点击保护。

## 当前问题

### 发起支付不幂等

当前 `POST /bookings/:bookingId/pay` 每次调用都会读取订单、关闭旧微信订单、创建新的 `outTradeNo`，最后覆盖本地支付状态。支付成功回调具备条件更新保护，退款也使用固定退款单号，但“发起支付”本身没有幂等保护。

当同一订单出现两个重叠请求时，它们可能分别关闭旧单、分别创建微信订单，最后一次数据库写入覆盖前一次 `outTradeNo`。前一次微信订单可能仍然存在，但本地已无法通过订单主记录定位它。

小程序目前只有两秒点击节流，而通用请求超时为 60 秒。第一次请求尚未结束时，用户两秒后仍能再次点击，因此节流不能防止重叠请求。

### 定时任务形成周期性突发

当前每五分钟同时启动历史订单更新、退款对账、支付对账和支付超时关单。各分支及分支内部都使用 `Promise.allSettled`，待处理订单越多，瞬间发往微信的请求越多。

用户支付和后台对账共用 `maxSockets=5` 的 HTTPS Agent。后台查询和关单可以占满 socket，使用户发起支付在 Agent 队列中等待。简单把全部任务改成十或十五分钟只能降低触发频率，也可能让单次批次积累更多订单。

## 支付 single-flight

### 语义

同一订单同一时刻最多执行一次支付准备。后到的重叠请求不排队执行第二次，而是等待并复用第一个请求的 Promise 和结果。

```text
请求 A ──→ 关闭旧单 → 微信下单 → 保存 PAYING → 返回支付参数
请求 B ──┐
请求 C ──┴→ 复用请求 A 的 Promise，返回相同结果
```

single-flight 是短期进程内并发控制，不等同于订单的持久 `PAYING` 状态。它不写入数据库，Nest 重启后自然清空。

### 后端数据结构

```ts
type PaymentParams = {
  outTradeNo: string;
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
};

type RecentPaymentResult = {
  value: PaymentParams;
  expiresAt: number;
};

private readonly paymentFlights = new Map<string, Promise<PaymentParams>>();
private readonly recentPaymentResults = new Map<string, RecentPaymentResult>();
```

Map 的键使用 `bookingId`。每个请求在读取缓存或 flight 之前都必须重新读取订单并验证当前 JWT 用户是订单所有者，不能因为复用结果而跳过授权。

### 固定执行顺序

1. 读取订单并验证所有者、免费状态、订单状态和支付期限。
2. 已支付订单返回稳定的“订单已经支付”结果，不返回旧支付参数。
3. 若存在未过期的成功结果缓存，且缓存的 `outTradeNo` 与订单当前值一致，直接返回缓存。
4. 若 `paymentFlights` 中已有该订单，返回已有 Promise。
5. 同步创建新的 Promise 并立即放入 Map，避免两个请求在第一次 `await` 前同时穿过检查。
6. 执行现有流程：必要时关闭旧单、向微信创建新单、保存本地 `PAYING/outTradeNo`。
7. 只有微信下单和本地状态保存都成功后，才缓存支付参数 30 秒。
8. 无论成功、失败或超时，都在 `finally` 中删除对应 flight；删除前确认 Map 中仍是当前 Promise，避免误删后继任务。

### 超时与恢复

- 单次微信 HTTP 请求继续使用 10 秒超时。
- 后端支付准备的整体预算为 22 秒，覆盖一次旧单关闭、一次微信下单和本地更新，并确保前端 25 秒超时之前有时间接收响应。
- 整体超时实现必须能够中止当前 HTTPS Request；不能只用不会取消底层工作的 `Promise.race`。
- 任何异常路径都执行 `finally` 清理 flight。
- 30 秒成功缓存使用惰性过期清理，并设置最大条目数，避免 Map 长期增长。
- Nest 重启会丢失 flight 和短期缓存，这是本阶段接受的限制；数据库中的 `outTradeNo` 和定时对账继续承担恢复职责。

如果微信下单成功但本地 `PAYING/outTradeNo` 保存失败，不得把结果放入缓存。该情况记录高优先级结构化日志，后续由持久 PaymentAttempt 方案彻底解决；本阶段不扩大数据库模型。

## 小程序可恢复锁

前端使用 `paymentLaunching` 表示“正在获取支付参数”，不能复用订单的 `PAYING` 名称。

行为如下：

1. 点击支付后立即设置 `paymentLaunching=true`，按钮显示“正在准备支付…”并禁用。
2. 支付接口单独使用 25 秒请求超时，不沿用通用的 60 秒超时。
3. 获取参数成功后进入 `uni.requestPayment`；获取失败或超时则提示用户并恢复按钮。
4. `finally` 必须释放 `paymentLaunching`，页面卸载时也清理本地定时器。
5. 支付接口超时后先查询一次本地支付状态，再允许用户重试。若本地仍为 `PAYING`，重试请求可命中后端 30 秒结果缓存；缓存到期后再按正常流程关闭旧单并创建新单。
6. `handlePayment` 模块按 `bookingId` 维护前端进行中的 Promise，避免预约表单页和订单详情页在短时间内重复触发。

该锁只覆盖“准备支付”阶段，最长约 25 秒。它不会依赖微信回调释放，也不会让按钮因订单长期处于 `PAYING` 而永久禁用。

## 定时任务拆分

将当前单一 `handleCron` 拆成四个独立任务，但仍保留在现有 Booking Service/Controller 分层内，不新增复杂模块。

| 任务 | 周期 | 单批上限 | 微信并发 | 说明 |
| --- | --- | --- | --- | --- |
| 支付状态兜底 | 5 分钟 | 20 | 2 | 按 `reconcileNextAt` 查询到期且未过期的 `PAYING` 订单 |
| 支付超时关单 | 5 分钟 | 20 | 2 | 与支付兜底错开至少 2 分钟，关单后批量更新本地状态 |
| 退款对账 | 15 分钟 | 20 | 2 | 与支付任务错开执行，处理 `REFUNDING` |
| 历史订单更新 | 每小时 | 数据库批量更新 | 0 | 不调用微信，避开上述任务启动分钟 |
| 异常订单低频重试 | 30 分钟 | 5 | 1 | 仅处理 `OPEN` 且 `nextRetryAt` 已到期的可自动恢复异常 |

每个任务使用独立的进程内运行标记，防止自身重入。当前只有一个 Nest 实例，因此本阶段不增加数据库 job lease；未来出现多实例时再改为持久租约。

### 批量和并发规则

- Repository 查询必须带 `take/limit`，一次最多返回 20 条。
- 禁止对数据库返回的全部订单直接执行无限制 `Promise.allSettled`。
- 使用并发上限为 2 的 worker 循环处理微信请求。
- 本批未处理的订单留到下一次任务，不在同一轮无限追赶积压。
- 单个订单失败不终止整批；错误进入结构化日志。
- 每个任务设置运行时间预算，超过预算停止领取新订单，已开始的请求正常收尾。

### 精准候选查询

当前微信相关任务并非无条件读取整张订单表，但会一次取出所有符合状态的记录：退款任务取全部 `REFUNDING`，支付任务取最近 30 分钟且未过期的全部 `PAYING`，超时任务取全部已过期的 `UNPAID/PAYING`。这些查询都缺少批量上限。历史订单任务是单条条件 UPDATE，不调用微信，可以继续保留批量更新。

订单增加一组通用调度字段：

```text
reconcileKind             payment | refund | close | null
reconcileNextAt           integer nullable
reconcileAttempts         integer default 0
reconcileLastAt           integer nullable
reconcileLastErrorCode    varchar nullable
```

支付和退款不会在同一订单上同时进行，因此本阶段共用一组调度字段，不为每类流程重复增加列。

正常对账候选使用固定条件：

```text
业务状态仍符合
AND reconcileKind = 当前任务类型
AND reconcileNextAt <= 当前时间
ORDER BY reconcileNextAt ASC, id ASC
LIMIT 20
```

不得使用“只查最近一天”之类的绝对时间窗口丢弃旧订单。服务停机、部署失败或异常持续数日后，未解决订单仍必须能够进入对账；缩小范围依赖状态、下次执行时间、索引和批量上限，而不是直接忽略较老记录。

状态进入 `PAYING` 或 `REFUNDING` 时必须同时初始化对应调度字段。上线迁移负责为已有 `PAYING/REFUNDING` 记录补齐 `reconcileKind/reconcileNextAt`，之后正常查询不把 `reconcileNextAt IS NULL` 当作到期，以便人工暂停异常订单。

处理结果更新：

- 微信返回成功终态：更新订单业务状态并清空调度字段。
- 微信仍在正常处理中：保留业务状态，设置下一次执行时间。
- 临时网络错误：增加 `reconcileAttempts`，记录稳定错误码，并按退避时间设置下一次执行。
- 达到异常条件：写入异常订单表并清空订单上的正常通道调度字段；可自动恢复的异常由异常通道降低重试频率，需要人工处理的异常暂停自动请求。

新增索引：

```text
(reconcileKind, reconcileNextAt)
(paymentStatus, paymentExpiredAt)
(status, bookingDate)
```

历史订单仍使用 `bookingDate < today AND status = CONFIRMED` 的单条 UPDATE。`(status, bookingDate)` 复合索引用于缩小更新范围；不能只更新“昨天”，否则停机多日后会漏掉更早订单。

### 超时关单的更新边界

当前实现先查询全部超时订单并逐个关单，最后执行一条按时间和状态过滤的全量 UPDATE。加入 `LIMIT 20` 后不能继续使用这条全量 UPDATE，否则未进入本批、尚未调用微信关单的订单也会被标成失败。

每批必须记录实际完成处理的 `bookingId`，并且只对这些 ID 做条件更新：

```sql
UPDATE bookings
SET status = 'cancelled',
    paymentStatus = 'failed',
    reconcileKind = NULL,
    reconcileNextAt = NULL
WHERE bookingId IN (:processedBookingIds)
  AND paymentStatus IN ('unpaid', 'paying')
  AND paymentExpiredAt < :now;
```

只有微信明确关单成功、明确已经关闭，或业务规则确认无需再关单的订单才能进入 `processedBookingIds`。网络超时和不确定错误保留原状态并安排重试。条件中的当前支付状态用于防止支付成功回调刚完成后又被超时任务覆盖。

当前 `closeOrder` 会吞掉所有微信错误并返回成功语义，调用者无法区分“已经关闭”和“网络状态未知”。实现时必须将其改为结构化结果，例如 `CLOSED / ALREADY_CLOSED / ALREADY_PAID / UNKNOWN`；后台任务只有收到前三类明确结果并重新检查本地状态后才能更新订单，`UNKNOWN` 必须重试或进入异常通道。

## 异常订单记录

新增 `booking_anomalies` 表，记录持续异常和需要人工关注的订单。订单表仍是预约、支付和退款状态的唯一事实来源；异常表不能反向充当第二套订单状态机。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer | 自增主键 |
| `bookingId` | varchar | 关联订单编号 |
| `type` | varchar | 稳定异常类型 |
| `status` | varchar | `OPEN`、`RESOLVED` 或 `IGNORED` |
| `firstSeenAt` | integer | 首次发现时间 |
| `lastSeenAt` | integer | 最近发生时间 |
| `occurrenceCount` | integer | 累计发生次数 |
| `lastErrorCode` | varchar nullable | 过滤后的稳定错误码 |
| `lastErrorSummary` | varchar nullable | 不含敏感数据的错误摘要 |
| `nextRetryAt` | integer nullable | 异常通道的低频重试时间 |
| `resolvedAt` | integer nullable | 解决时间 |
| `resolution` | varchar nullable | 自动恢复或人工处理说明 |

同一 `bookingId + type` 只保留一条记录。相同异常再次出现时增加 `occurrenceCount` 并更新 `lastSeenAt`；已解决异常再次出现时重新打开并保留历史累计次数。

索引包括唯一 `(bookingId, type)` 和查询索引 `(status, nextRetryAt)`。

首批异常类型：

```text
PAYMENT_QUERY_REPEATED_FAILURE
REFUND_QUERY_REPEATED_FAILURE
CLOSE_ORDER_REPEATED_FAILURE
PAYING_WITHOUT_OUT_TRADE_NO
REMOTE_ORDER_NOT_FOUND
LOCAL_REMOTE_STATUS_MISMATCH
PAYMENT_CREATED_LOCAL_SAVE_FAILED
```

进入异常表的规则：

- 普通网络错误连续失败三次后创建或更新异常，避免一次瞬时超时污染异常列表。
- `PAYING` 但缺少 `outTradeNo` 时立即记录。
- 微信明确返回订单不存在、本地和微信终态冲突，或微信下单成功但本地保存失败时立即记录。
- 可自动恢复的异常由独立异常任务按 `status=OPEN AND nextRetryAt<=now` 每批最多取 5 条，以 30 分钟起步、最长 2 小时的退避时间低频重试。处理前必须重新读取订单并验证当前业务状态仍然符合该异常；异常表只充当低频工作清单，不覆盖订单事实。
- 无法安全自动决定状态的异常暂停自动重试，等待人工处理。
- 后续对账成功时自动标记 `RESOLVED` 并写入解决说明。

`app_logs` 用于回答“发生过什么”，按既定保留周期清理；`booking_anomalies` 用于回答“现在还有哪些订单需要处理”，不能随普通日志一起过期删除。后续管理后台日志入口增加“异常订单”独立列表，默认只显示 `OPEN`。

### HTTPS Agent 隔离

微信请求分成两类：

- `interactiveAgent`：用户发起支付以及用户重试时关闭旧单使用，`maxSockets=5`，保留现有 keep-alive。
- `reconciliationAgent`：后台支付查询、退款查询和超时关单使用，`maxSockets=2`，独立 keep-alive 池。

后台任务不能借用 `interactiveAgent`。因此即使对账积压，最多占用两个后台 socket，不会排在用户支付所使用的五个 socket 前面。

## 日志与观测

每次用户支付准备记录一条阶段日志，使用同一个 `requestId`，至少包括：

- `bookingId`、是否命中 single-flight、是否命中短期缓存。
- 关闭旧单、微信下单、本地保存分别耗时。
- 最终结果、稳定错误码和总耗时。

每个定时任务每轮只记录一条摘要和必要的单项错误：

- 扫描数量、实际处理数量、成功数、失败数、跳过数。
- 微信请求 p50/p95 或最小/最大耗时。
- Agent 排队时间、任务总耗时和是否达到批量/时间上限。
- 新增、重复出现、自动解决和人工忽略的异常订单数量。

日志不得包含完整 OpenID、支付签名、证书、token 或微信回调原始密文。日志存储失败不得改变支付或对账业务结果。

## 错误处理

- 重叠支付请求共享第一次调用的成功或失败结果。
- 第一次调用失败后 flight 立即清理，用户可以重新发起。
- 前端超时不把订单标记为支付失败，只显示“支付准备超时，请稍后重试”。
- 定时任务查询微信失败时保留当前本地状态，下一周期重试；只有微信明确返回终态时才更新本地终态。
- 异常订单写入失败时不得猜测或覆盖订单状态；保留原业务状态并输出 Nest 原生日志。
- 后台对账不得在用户查询接口中同步执行。

## 不包含

- PaymentAttempt/RefundAttempt 新表和跨进程持久幂等。
- Redis、Bull worker 或独立微服务。
- 修改订单、支付、退款状态枚举。
- 以 WAL 或更换数据库代替支付并发控制。
- 自动调整任务周期或动态扩容 Agent。

## 验收标准

- 同一订单同时发起 10 个支付请求时，微信创建支付订单接口只调用一次，10 个请求获得相同 `outTradeNo`。
- 第一次支付准备失败或超时后，flight 被清理，下一次请求能够重新执行。
- 支付参数成功返回后的 30 秒内重试，不关闭旧单、不创建新的 `outTradeNo`。
- 前端支付准备超过 25 秒后恢复按钮，不出现永久 loading。
- 后台对账同时运行时，用户支付不会进入后台 Agent 的 socket 队列。
- 任一定时任务同时最多存在两个微信请求，单批最多处理 20 条。
- 超时关单只更新本批已明确处理且当前状态仍符合条件的订单。
- 服务停机数日后重新启动，遗留的 `PAYING/REFUNDING` 订单仍能按 `reconcileNextAt` 进入处理，不因创建时间较早而遗漏。
- 同一订单的同类异常重复出现时只更新一条 `booking_anomalies`，不会持续插入重复记录。
- 连续三次临时失败后异常变为 `OPEN`，成功恢复后自动变为 `RESOLVED`。
- 五类定时任务不会在同一分钟启动。
- 支付成功回调仍是主要确认路径；无任务积压时，支付兜底最迟在下一轮五分钟任务中处理。
- 无任务积压时，退款兜底最迟在下一轮十五分钟任务中处理；存在积压时按 `reconcileNextAt, id` 从旧到新推进，并在日志中暴露待处理数量。

## 上线顺序

1. 增加对账调度字段、复合索引和 `booking_anomalies`，迁移时补齐已有待处理订单。
2. 拆分定时任务，改为精准候选查询、批量上限 20 和微信并发上限 2；超时关单只更新本批明确处理的 ID。
3. 将用户支付与后台对账切换到独立 HTTPS Agent。
4. 后端增加 single-flight、22 秒整体预算和 30 秒成功结果缓存。
5. 小程序增加 `paymentLaunching`、25 秒超时和模块级重复调用保护。
6. 接入已设计的结构化日志和异常订单管理入口，观察对账积压、异常数量、single-flight 命中及 Agent 排队。
7. 使用迁移、并发、重试和停机恢复测试验证验收标准，再逐步上线。
