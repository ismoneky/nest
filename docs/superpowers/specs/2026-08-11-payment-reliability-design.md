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
3. 只有订单同时满足 `status=PENDING`、`paymentStatus=PAYING`、未超过 `paymentExpiredAt`，并且缓存 `outTradeNo` 与订单当前值一致时，才能返回未过期的成功结果缓存。任一条件不满足都立即逐出缓存并按当前订单状态响应，不能把已支付、已取消、退款中或已过期订单的旧支付参数返回前端。
4. 若 `paymentFlights` 中已有该订单，返回已有 Promise。
5. 同步创建新的 Promise 并立即放入 Map，避免两个请求在第一次 `await` 前同时穿过检查。
6. flight 内再次读取订单并执行相同状态校验，避免第一次读取后订单状态已经变化。
7. 没有可用缓存但订单已有 `outTradeNo` 时，无论当前是 `UNPAID` 还是 `PAYING`，都必须先查询微信旧单：成功则推进本地已支付；已关闭或明确不存在时允许换单；仍处于未支付活动态时必须先调用结构化 `closeOrder`，只有明确关闭后才允许换单；查询或关单结果未知时返回 `PAYMENT_RESULT_UNKNOWN`。首次发起支付时订单没有 `outTradeNo`，必须跳过旧单查询，直接进入步骤 8。不能因为内存缓存丢失或到期就直接关闭旧单。
8. 只有首次发起没有旧单号，或步骤 7 已经取得明确结果并允许创建新单时，才能进入本步。由 Booking Service 生成新的 `outTradeNo`，使用条件 UPDATE 校验旧支付状态以及旧 `outTradeNo` 仍和步骤 7 读取值一致，再写入新的 `PAYING/outTradeNo` 和支付对账调度字段；首次发起则要求旧 `outTradeNo IS NULL`。更新成功后才把新单号传给微信下单，微信适配层不再自行生成单号。步骤 7 返回已支付或未知结果时禁止执行本步。
9. 微信明确返回 `prepay_id` 后才生成并缓存支付参数 30 秒。缓存值必须同时保存 `outTradeNo`，供每次命中时和数据库重新比较。
10. 无论成功、失败或超时，都在 `finally` 中删除对应 flight；删除前确认 Map 中仍是当前 Promise，避免误删后继任务。

### 超时与恢复

- 单次微信 HTTP 请求继续使用 10 秒超时。
- 每个 flight 创建一个共享 `AbortController` 和 22 秒 deadline timer。关闭旧单和创建支付两个 HTTPS Request 都必须接收同一个 `AbortSignal`，并将其传入 `https.request({ signal })`；deadline 到达时调用 `controller.abort()`，不能只使用不会取消底层工作的 `Promise.race`。
- `request()` 收到 abort 后必须销毁当前 request，并统一转换成稳定错误 `PAYMENT_PREPARATION_TIMEOUT`。关闭旧单阶段被 abort 后不得继续创建新单。
- 微信创建支付请求一旦发出，abort 或网络断开只能说明本地没有拿到确定响应，不能证明微信没有受理。由于新的 `outTradeNo` 已经提前落库，此时订单保持 `PAYING`，设置 `reconcileKind=payment`、`reconcileNextAt=now`，返回 `PAYMENT_RESULT_UNKNOWN`，禁止立即关闭并创建另一个新单。
- 微信明确返回业务拒绝且能够确认没有创建支付单时，使用条件 UPDATE 把订单恢复为 `UNPAID` 并安排用户重试，但保留本次 `outTradeNo`。只有经过枚举的微信业务拒绝码可以进入该分支，不能把任意 HTTP 4xx 或解析错误当作“未建单”。下次发起仍按步骤 7 查询该号码，明确不存在或已关闭后才能换号；这样即使错误分类出现偏差，本地仍保有查询微信侧状态的键。不确定错误不能执行该回退。
- 微信已明确返回 `prepay_id` 后，即使 22 秒 deadline 恰好到达，也必须完成本地结果确认和短期缓存写入；该阶段不再把成功结果降级成“未创建”。本地操作应保持为短小的单行更新，前端 25 秒超时为响应留出余量。
- 任何异常路径都执行 `finally` 清理 flight。
- 30 秒成功缓存使用惰性过期清理，并设置最大条目数，避免 Map 长期增长。
- Nest 重启会丢失 flight 和短期缓存，这是本阶段接受的限制；数据库中的 `outTradeNo` 和定时对账继续承担恢复职责。

新的 `outTradeNo` 在请求微信前已经通过条件 UPDATE 落库，因此不再保留“微信下单成功后才保存本地单号”的窗口。如果预写本地状态失败，不得调用微信；如果微信结果未知，则使用已落库单号对账。

### 支付与调度字段转换协议

订单业务状态和 `reconcile*` 字段必须在同一条条件 UPDATE 或同一 SQLite 事务中改变。Repository 只提供带期望状态条件的原子更新，不决定业务转换；WechatPay Service 只负责微信协议、验签和 HTTP，不直接写 Booking。转换决策统一由 Booking Service 中的命名动作完成，Controller 和定时方法只能调用这些动作。

| 触发者 | Booking Service 动作 | 期望旧状态 | 同一原子更新的新状态与调度字段 |
| --- | --- | --- | --- |
| 用户发起支付 | `markPaymentStarting` | `PENDING + UNPAID/PAYING` 且未过期；旧 `outTradeNo` 与步骤 7 读取值相同（首次为 NULL，被拒后带号 `UNPAID` 换单时为保留的旧号） | `PENDING + PAYING`，写新 `outTradeNo`，`reconcileKind=payment`，`reconcileNextAt=now+5min`，attempts 清零 |
| 微信明确拒绝且未建单 | `markPaymentStartRejected` | `PAYING + 相同 outTradeNo` | `UNPAID`，保留该 `outTradeNo`，清空 payment 调度字段，保留稳定错误码；下次重试先查询该单号 |
| 微信请求结果未知 | `markPaymentResultUnknown` | `PAYING + 相同 outTradeNo` | 保持 `PAYING`，`reconcileKind=payment`，`reconcileNextAt=now`，attempts 加一 |
| 支付成功回调 | `markPaymentSucceeded` | 非支付终态且 `outTradeNo` 相同 | `CONFIRMED + PAID`，写 transactionId/paidAt，清空全部调度字段 |
| 支付对账仍未支付 | `reschedulePaymentCheck` | `PAYING + 相同 outTradeNo` | 保持业务状态，`reconcileNextAt=now+5min`，清空本次临时错误 |
| 支付对账明确终态失败 | `markPaymentFailed` | `PAYING + 相同 outTradeNo` | 按微信终态设为 `FAILED/CANCELLED`，清空调度字段 |
| 支付到期待关单 | `markCloseDue` | `UNPAID/PAYING` 且已过期 | 保持业务状态，`reconcileKind=close`，`reconcileNextAt=now` |
| 微信明确关单 | `markPaymentClosed` | `UNPAID/PAYING + 相同 outTradeNo` 且已过期 | `CANCELLED + FAILED`，清空调度字段 |
| 用户申请退款 | `markRefundStarting` | `CONFIRMED + PAID + refund NONE/FAILED` | `REFUNDING`，写 outRefundNo，`reconcileKind=refund`，`reconcileNextAt=now+15min`，attempts 清零 |
| 退款回调或对账成功 | `markRefundSucceeded` | `REFUNDING + 相同 outRefundNo` | 退款成功终态，写 refundedAt，清空调度字段 |
| 退款仍处理中 | `rescheduleRefundCheck` | `REFUNDING + 相同 outRefundNo` | 保持业务状态，`reconcileNextAt=now+15min` |
| 达到异常阈值 | `escalateReconciliationAnomaly` | 当前状态仍符合异常类型 | 同一事务 upsert anomaly，并清空正常通道调度字段 |

所有回调和对账动作都必须带 `outTradeNo/outRefundNo + expectedStatus` 条件。affected rows 为 0 表示订单已被其他流程推进，应重新读取后按幂等结果结束，不能强行覆盖。人工处理异常时也必须调用上述命名动作，不能直接编辑异常表或通用更新订单状态。

`markPaymentStarting` 接受旧状态 `PAYING` 的前提是步骤 7 已经取得微信旧单的明确结果并确认允许换单；接受带旧 `outTradeNo` 的 `UNPAID` 也必须满足同一前提。只有不带 `outTradeNo` 的首次 `UNPAID` 可以跳过步骤 7。结果未知时不得调用该动作。

微信回调为最高优先级确认。当本地预判（`markPaymentStartRejected` 或 `markPaymentResultUnknown`）与随后到达的支付成功回调冲突时，以回调为准：只要 `markPaymentSucceeded` 的条件（非支付终态且 `outTradeNo` 相同）满足，就必须把订单推进到 `CONFIRMED + PAID`，覆盖此前的预判结论。被拒保留的 `outTradeNo` 在回调到达时同样适用该规则。

步骤 7 调用 `closeOrder` 明确关闭旧单后，到步骤 8 `markPaymentStarting` 落库新号之前，仍可能被支付成功回调抢先（旧号其实被用户付了）。此时 `markPaymentStarting` 的条件 UPDATE 因订单已被回调改为 `CONFIRMED + PAID` 而返回 affected=0，按上述"affected=0 重新读取后按幂等结果结束"处理，改走 `markPaymentSucceeded` 路径，不得强行换单。

## 小程序可恢复锁

前端使用 `paymentLaunching` 表示“正在获取支付参数”，不能复用订单的 `PAYING` 名称。

行为如下：

1. 点击支付后立即设置 `paymentLaunching=true`，按钮显示“正在准备支付…”并禁用。
2. 支付接口单独使用 25 秒请求超时，不沿用通用的 60 秒超时。
3. 获取参数成功后进入 `uni.requestPayment`；获取失败或超时则提示用户并恢复按钮。
4. `finally` 必须释放 `paymentLaunching`，页面卸载时也清理本地定时器。
5. 支付接口超时后先查询一次本地支付状态，再允许用户重试。若本地仍为 `PAYING`，重试请求优先命中后端 30 秒结果缓存；没有缓存时由后端先查询现有 `outTradeNo`，只有微信状态明确后才能决定复用、关单或新建，前端不能自行把 `PAYING` 当成失败。
6. `handlePayment` 模块按 `bookingId` 维护前端进行中的 Promise，避免预约表单页和订单详情页在短时间内重复触发。

该锁只覆盖“准备支付”阶段，最长约 25 秒。它不会依赖微信回调释放，也不会让按钮因订单长期处于 `PAYING` 而永久禁用。

## 定时任务拆分

将当前单一 `handleCron` 拆成五个独立任务，但仍保留在现有 Booking Service/Controller 分层内，不新增复杂模块。

| 任务 | 周期 | 每小时启动分钟 | 单批上限 | 微信并发 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 支付状态兜底 | 5 分钟 | `00,05,10,...,55` | 20 | 共享上限 2 | 按 `reconcileNextAt` 查询到期且未过期的 `PAYING` 订单 |
| 支付超时关单 | 5 分钟 | `02,07,12,...,57` | 20 | 共享上限 2 | 与支付兜底错开 2 分钟，关单后更新本地状态 |
| 退款对账 | 15 分钟 | `04,19,34,49` | 20 | 共享上限 2 | 处理 `REFUNDING` |
| 异常订单低频重试 | 30 分钟 | `08,38` | 5 | 共享上限 2、任务自身上限 1 | 仅处理 `OPEN` 且 `nextRetryAt` 已到期的可自动恢复异常 |
| 历史订单更新 | 每小时 | `13` | 数据库批量更新 | 0 | 不调用微信，避开上述任务启动分钟 |

上述分钟以服务器配置的 `Asia/Shanghai` 时区为准，Cron 秒字段固定为 `0`。实现和测试以这张表为唯一分配规则，不再只验证“相差至少两分钟”。分钟错开只能控制启动突发；若上轮因网络慢仍未结束，新任务仍可能重叠，因此后台所有微信任务还必须共用同一个全局并发限制器。

每个任务使用独立的进程内运行标记，防止自身重入。当前只有一个 Nest 实例，因此本阶段不增加数据库 job lease；未来出现多实例时再改为持久租约。

### 批量和并发规则

- Repository 查询必须带 `take/limit`，一次最多返回 20 条。
- 禁止对数据库返回的全部订单直接执行无限制 `Promise.allSettled`。
- 支付查询、退款查询和关单共用一个全局并发上限为 2 的 worker/信号量，不是每个任务各自拥有 2 个并发。异常任务在该全局上限内自身最多只占 1 个。
- 本批未处理的订单留到下一次任务，不在同一轮无限追赶积压。
- 单个订单失败不终止整批；错误进入结构化日志。
- 每个任务设置运行时间预算，超过预算停止领取新订单，已开始的请求正常收尾。
- 外部微信请求完成后，结果进入当前批次最多 20 条的 FIFO 写回队列，由单一 SQLite writer 顺序提交。两个外部 worker 无需等待前一个订单写库完成即可继续获取后续微信结果；任务只有在停止领取新订单并等待写回队列排空后才结束。这样保持“微信并发 2、SQLite 写入 1”，不会把整个外部请求阶段错误实现成串行。

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

现有代码中 `closeOrder` 只有两个调用点，实现时必须同时改造，不能只改定时任务：

- `BookingService.initiatePayment`：`CLOSED/ALREADY_CLOSED` 才能继续步骤 8；`ALREADY_PAID` 必须查询/推进本地支付成功并停止创建新单；`UNKNOWN` 返回 `PAYMENT_RESULT_UNKNOWN`，不得继续换单。
- 支付超时关单任务：`CLOSED/ALREADY_CLOSED` 才能执行 `markPaymentClosed`；`ALREADY_PAID` 必须重新查询订单并执行 `markPaymentSucceeded`；`UNKNOWN` 保持当前状态并重新调度。

当前取消和退款流程没有调用 `closeOrder`。若以后新增调用点，也必须穷举结构化结果，禁止恢复成“捕获全部错误后继续”的语义。

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

同一 `bookingId + type` 只保留一条记录。相同异常再次出现时增加 `occurrenceCount` 并更新 `lastSeenAt`；进入 `RESOLVED` 或 `IGNORED` 时必须同时写 `resolvedAt` 和 `resolution`，再次出现时重新打开、清空 `resolvedAt/resolution` 并保留历史累计次数。

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
- `PAYING` 但缺少 `outTradeNo` 时立即记录。该类型只用于上线前历史数据或状态被外部错误修改的兜底；新流程的 `markPaymentStarting` 会原子写入 `PAYING + outTradeNo`，不得再产生这种组合。历史记录不自动猜测微信状态，由一次性校验脚本或人工结合支付平台记录处理。
- 微信明确返回订单不存在、本地和微信终态冲突，或微信下单成功但本地保存失败时立即记录。`REMOTE_ORDER_NOT_FOUND` 只适用于本地状态表示“微信单本应已创建”的 `PAYING`/结果未知场景；明确拒绝后处于 `UNPAID` 且保留的单号查询为不存在，是步骤 7 允许换单的预期结果，不记异常。
- 可自动恢复的异常由独立异常任务按 `status=OPEN AND nextRetryAt<=now` 每批最多取 5 条，以 30 分钟起步、最长 2 小时的退避时间低频重试。处理前必须重新读取订单并验证当前业务状态仍然符合该异常；异常表只充当低频工作清单，不覆盖订单事实。
- 无法安全自动决定状态的异常暂停自动重试，等待人工处理。
- 后续对账成功时自动标记 `RESOLVED` 并写入解决说明。

`app_logs` 用于回答“发生过什么”，按既定保留周期清理；`booking_anomalies` 用于回答“现在还有哪些订单需要处理”，不能随普通日志一起过期删除。后续管理后台日志入口增加“异常订单”独立列表，默认只显示 `OPEN`。

异常记录清理采用独立规则：`OPEN` 永不自动删除；`RESOLVED` 和 `IGNORED` 在 `resolvedAt` 后保留 365 天，每周日低峰期的 `03:16` 分批删除，每批最多 100 条、单轮最多 10 批。清理只删除异常工作记录，不修改订单；没有 `resolvedAt` 的非 `OPEN` 记录视为数据异常并保留，不能按 `lastSeenAt` 猜测删除。

### HTTPS Agent 隔离

微信请求分成两类：

- `interactiveAgent`：用户发起支付以及用户重试时关闭旧单使用，`maxSockets=5`，保留现有 keep-alive。
- `reconciliationAgent`：后台支付查询、退款查询和超时关单使用，`maxSockets=2`，独立 keep-alive 池。

后台任务不能借用 `interactiveAgent`。支付、退款和关单后台任务有意共享同一个 `reconciliationAgent`，不再按业务类型拆 Agent；它们同时共享一个全局并发限制器，所以即使因上一轮运行过久而重叠，后台整体也最多存在两个微信请求。先进入限制器的任务先取得 socket，后来的任务排队并受各自运行时间预算约束；本期不提供支付/退款之间的严格公平调度。单批 20 条、并发 2 与分钟错峰足以满足当前小服务容量，独立 Agent 的目标是保护用户支付的五个 socket，而不是提高后台吞吐。

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

## SQLite 写锁预算

本期明确不调整 WAL；业务库 `prod.db` 仍只有一个 writer。新增调度字段和 `booking_anomalies` 会增加业务库写放大，因此“表很小”不能作为忽略锁竞争的理由。`app_logs` 已按日志设计改放独立 `logs.db`，不会直接争用 `prod.db` 的文件写锁，但两个文件仍共享磁盘、Node 进程和 libuv 线程池。本设计通过减少写次数、缩短事务和错开后台工作来接受这些约束：

- 订单状态与 `reconcile*` 字段必须合并为同一条 UPDATE，禁止先改业务状态、再单独更新五个调度字段。
- 异常升级使用一个短事务完成 anomaly upsert 和订单调度字段清理；普通第一次、第二次临时失败只更新订单计数，不写异常表。
- 微信 HTTP 请求绝不放在 SQLite 事务内。先完成外部查询，再按确定结果执行单行条件更新。
- 外部微信请求可以并发 2 个，但处理结果按完成顺序进入批内 FIFO，写回 SQLite 时由单 writer 串行提交，不对一批结果再次 `Promise.all` 并发写库。外部 worker 可以继续获取后续结果，只有入库动作排队；任务结束前必须等待 FIFO 排空。
- 每批最多 20 个正常订单、5 个异常订单；完成一批即释放执行权，不在一轮任务中循环清空全部积压。
- 结构化日志不得加入订单状态事务；业务事务提交后再交给独立 `logs.db` 的日志写入队列。
- 定时任务必须错峰。日志清理每日 `03:21`（Asia/Shanghai）启动，落在支付兜底/关单/退款/异常/历史订单所有启动分钟并集之外；异常表清理每周日 `03:16`，两者相隔 5 分钟，互不重叠。两类清理均不与对账任务同一分钟启动。
- 提供 `RECONCILIATION_ENABLED`、`RECONCILIATION_BATCH_SIZE` 和 `RECONCILIATION_CONCURRENCY` 配置。发现锁等待上升时可先停后台对账或把批量降为 5，不影响微信回调主路径。

上线前后使用现有 SQLite 支付竞争诊断和同一组业务压测对比。验收要求：加入日志写入和对账任务后，用户支付压测 p95 相对无后台任务基线增长不超过 20%，不出现 `SQLITE_BUSY`，单次订单/调度状态写事务 p95 不超过 50ms。任何一项不满足都先降低后台批量和日志刷盘频率，本期不以开启 WAL 掩盖问题。

## 不包含

- PaymentAttempt/RefundAttempt 新表和跨进程持久幂等。
- Redis、Bull worker 或独立微服务。
- 修改订单、支付、退款状态枚举。
- 以 WAL 或更换数据库代替支付并发控制。
- 自动调整任务周期或动态扩容 Agent。
- 启用 WAL 或修改 `synchronous`；这些配置保持现状，另行验证后决策。

## 验收标准

- 同一订单同时发起 10 个支付请求时，微信创建支付订单接口只调用一次，10 个请求获得相同 `outTradeNo`。
- 首次支付的 `UNPAID` 订单没有 `outTradeNo` 时不查询或关闭微信旧单，直接预写新单号后创建支付。
- 明确拒绝创建后订单回到 `UNPAID` 但保留被拒的 `outTradeNo`；下次重试先查询该号码，未取得明确结果前不生成新号码。
- 第一次支付准备失败或超时后，flight 被清理，下一次请求能够重新执行。
- 支付参数成功返回后的 30 秒内重试，不关闭旧单、不创建新的 `outTradeNo`。
- 前端支付准备超过 25 秒后恢复按钮，不出现永久 loading。
- 后台对账同时运行时，用户支付不会进入后台 Agent 的 socket 队列。
- 全部后台微信任务合计同时最多存在两个请求，异常任务自身最多一个；单个正常任务单批最多处理 20 条。
- 外部微信请求保持并发 2 时，SQLite 写入始终为单 writer FIFO；慢写库只让结果等待入库，不把微信请求循环降为并发 1。
- 超时关单只更新本批已明确处理且当前状态仍符合条件的订单。
- 服务停机数日后重新启动，遗留的 `PAYING/REFUNDING` 订单仍能按 `reconcileNextAt` 进入处理，不因创建时间较早而遗漏。
- 同一订单的同类异常重复出现时只更新一条 `booking_anomalies`，不会持续插入重复记录。
- 连续三次临时失败后异常变为 `OPEN`，成功恢复后自动变为 `RESOLVED`。
- 五类定时任务严格按 `00/05/...`、`02/07/...`、`04/19/34/49`、`08/38`、`13` 的分钟表启动，不会在同一分钟启动。
- `closeOrder` 的用户发起支付和超时关单两个现有调用点都穷举四种结构化结果，`UNKNOWN` 路径不会更新为成功或继续创建新单。
- `OPEN` 异常不会自动清理；超过 365 天的 `RESOLVED/IGNORED` 只按每批 100 条、单轮 10 批清理。
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
