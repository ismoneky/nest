# 接口与签名调整对照

## 背景

支付可靠性设计（`2026-08-11-payment-reliability-design.md`）和日志设计改变了后端多个方法签名、Controller 响应结构，并要求小程序 `fctl` 配套调整。本文档列出改造前后对照，确保实现时前后端、Service/Repository 分层不出现错位。

实现时以本文档为单一事实来源；若代码与本文档冲突，以本文档为准并更新代码，或先更新本文档再改代码。

## WechatPayService（`src/modules/wechat-pay/wechat-pay.service.ts`）

### `createPayment` —— 改为不自行生成单号

| | 现状 | 改造后 |
| --- | --- | --- |
| 签名 | `createPayment(bookingId, amount, description, openid, paymentExpiredAt)` | `createPayment(outTradeNo: string, amount, description, openid, paymentExpiredAt, signal?: AbortSignal)` |
| 行为 | 内部用 `bookingId+Date.now()+随机数` 生成 `outTradeNo`（`:210`） | 单号由 Booking Service 经 `markPaymentStarting` 落库后传入；本方法不再生成单号 |
| 超时 | 无整体预算 | 接受 `AbortSignal`，传入 `https.request({ signal })`；abort 时抛 `PAYMENT_PREPARATION_TIMEOUT` |

### `closeOrder` —— 改为结构化结果

| | 现状 | 改造后 |
| --- | --- | --- |
| 签名 | `closeOrder(outTradeNo: string): Promise<void>`（`:258`） | `closeOrder(outTradeNo: string, signal?: AbortSignal): Promise<CloseOrderResult>` |
| 行为 | 吞所有错误，永远 resolve（`:266-269`） | 返回 `CLOSED \| ALREADY_CLOSED \| ALREADY_PAID \| UNKNOWN`；只有明确终态才返回前三类，网络超时/解析失败返回 `UNKNOWN` |

```ts
type CloseOrderResultKind = 'CLOSED' | 'ALREADY_CLOSED' | 'ALREADY_PAID' | 'UNKNOWN';
interface CloseOrderResult {
  kind: CloseOrderResultKind;
  // UNKNOWN 时附带稳定错误码，供日志和异常通道使用
  errorCode?: string;
}
```

调用点（共 2 处，必须同时改造）：

| 调用点 | 文件:行 | 处理规则 |
| --- | --- | --- |
| `BookingService.initiatePayment` | `booking.service.ts:544` | `CLOSED/ALREADY_CLOSED` → 步骤 8 允许换单；`ALREADY_PAID` → 停止创建新单，走 `markPaymentSucceeded`；`UNKNOWN` → 返回 `PAYMENT_RESULT_UNKNOWN` |
| 超时关单任务 | `booking.service.ts:496` | `CLOSED/ALREADY_CLOSED` → `markPaymentClosed`；`ALREADY_PAID` → `markPaymentSucceeded`；`UNKNOWN` → 保留状态重新调度 |

设计文档明确：取消、退款流程当前不调用 `closeOrder`，若以后新增调用点必须穷举四类结果。

### `queryOrder` / `queryRefund` —— 增加结果分类

| | 现状 | 改造后 |
| --- | --- | --- |
| `queryOrder(outTradeNo)` | 抛 `BadRequestException`（`:300`） | 返回结构化结果，区分明确终态 / 处理中 / 未知；不抛异常，由调用方判断 |
| `queryRefund(outRefundNo)` | 抛异常 | 同上 |

调用点：支付兜底任务（`booking.service.ts:474`）、退款对账任务（`:439`）。改造后调用方根据结构化结果决定走 `markPaymentSucceeded` / `markPaymentFailed` / `reschedulePaymentCheck` / `escalateReconciliationAnomaly`。

### `getLocalPaymentStatus` —— 保持不变

`getLocalPaymentStatus(outTradeNo)`（`:276`）当前只读库返回 booking 字段，无需改。`/wechat-pay/notify` 轮询仍用它。

## BookingService（`src/modules/booking/booking.service.ts`）

### `initiatePayment` —— 改造为 single-flight 入口

| | 现状 | 改造后 |
| --- | --- | --- |
| 签名 | `initiatePayment(bookingId, openid): Promise<PaymentParams>`（`:513`） | 同签名，但内部走 single-flight + 22 秒预算 + 30 秒缓存 + 步骤 7/8 旧单查询 |
| 行为 | 每次关旧单→createPayment→updatePaymentStatus | 按设计文档「固定执行顺序」10 步执行；不再每次都关单 |

新增字段（进程内，不写库）：

```ts
private readonly paymentFlights = new Map<string, Promise<PaymentParams>>();
private readonly recentPaymentResults = new Map<string, RecentPaymentResult>();
```

新增方法（转换协议命名动作，由 `initiatePayment` 和定时任务调用，不直接暴露给 Controller）：

| 动作 | 现状对应代码 | 职责 |
| --- | --- | --- |
| `markPaymentStarting` | `initiatePayment` 末尾 `updatePaymentStatus`（`:556`） | 条件 UPDATE 写 `PAYING + 新 outTradeNo + payment 调度字段` |
| `markPaymentStartRejected` | 无 | 条件回退 `UNPAID`，保留 outTradeNo，清空调度字段 |
| `markPaymentResultUnknown` | 无 | 保持 `PAYING`，`reconcileNextAt=now`，attempts+1 |
| `markPaymentSucceeded` | `handlePaymentSuccess`（`wechat-pay.service.ts:437`） | 条件置 `CONFIRMED+PAID`，清空调度字段 |
| `markPaymentFailed` | `handlePaymentTimeout`（`:654`） | 按微信终态置 `FAILED/CANCELLED` |
| `markCloseDue` | 超时任务（`:491`） | 置 `reconcileKind=close, reconcileNextAt=now` |
| `markPaymentClosed` | 超时任务末尾 | 条件置 `CANCELLED+FAILED`，清空调度字段 |
| `markRefundStarting` | `initiateRefund`（`:587`） | 条件置 `REFUNDING + outRefundNo + refund 调度字段` |
| `markRefundSucceeded` | `handleRefundCallback` | 退款成功终态，清空调度字段 |
| `reschedulePaymentCheck` | 支付兜底任务 | 保持状态，`reconcileNextAt=now+5min` |
| `rescheduleRefundCheck` | 退款对账任务 | 保持状态，`reconcileNextAt=now+15min` |
| `escalateReconciliationAnomaly` | 无 | 同事务 upsert `booking_anomalies` + 清空正常通道调度字段 |

### `handleCron` —— 拆分为五个方法

| | 现状 | 改造后 |
| --- | --- | --- |
| 入口 | 单个 `@Cron(EVERY_5_MINUTES) handleCron()`（`:413`） | 五个独立 `@Cron` 方法 |
| 周期 | 全部 5 分钟 | 按分钟表：`00/05/…`、`02/07/…`、`04/19/34/49`、`08/38`、`13` |
| 时区 | 默认 | `@Cron` 显式 `timeZone: 'Asia/Shanghai'` |
| 并发 | `Promise.allSettled` 无限制 | 全局信号量上限 2，异常任务自身上限 1；外部并发 2 + FIFO 单 writer 串行写库 |

五个新方法名（建议）：

- `runPaymentReconciliation()` —— 支付兜底
- `runPaymentTimeoutClose()` —— 超时关单
- `runRefundReconciliation()` —— 退款对账
- `runAnomalyRetry()` —— 异常低频重试
- `runHistoricalBookingUpdate()` —— 历史订单

### `getPaymentStatus` —— 保持不变

`getPaymentStatus(bookingId)`（`:569`）返回 `{status, paidAt, transactionId}`，前端轮询不变。

## BookingRepository（`src/repositories/booking.repository.ts`）

### 现有方法改造

| 方法 | 现状 | 改造 |
| --- | --- | --- |
| `getRefundingOrders()`（`:434`） | 取全部 `REFUNDING` | 加 `take: 20` + `reconcileKind=refund AND reconcileNextAt<=now` 排序 |
| `getPayingOrders(now)`（`:469`） | 取最近 30 分钟全部 `PAYING` | 加 `take: 20` + `reconcileKind=payment AND reconcileNextAt<=now` 排序 |
| `getPaymentTimeoutOrders(now)`（`:449`） | 取全部超时 | 加 `take: 20`，改按 `reconcileKind=close AND reconcileNextAt<=now` 候选 |
| `updatePaymentTimeoutOrders(now)`（`:488`） | 全量 UPDATE | **废弃**，改为按 `processedBookingIds` 条件更新（设计文档「超时关单的更新边界」） |
| `updatePaymentStatus`（`:334`） | `save()` 覆盖 | 改为条件 UPDATE（`outTradeNo + expectedStatus`），返回 affected rows |
| `updatePaymentStatusByOutTradeNo`（`:368`） | 条件 `outTradeNo=` | 加 `expectedStatus` 条件，写调度字段 |
| `updateRefundStatus`（`:398`） | `save()` | 改为条件 UPDATE + 调度字段 |

### 新增方法

| 方法 | 职责 |
| --- | --- |
| `findReconcileCandidates(kind, now, limit)` | 统一精准候选查询，返回 `(bookingId, outTradeNo/outRefundNo, 状态)` |
| `markPaymentStarting(bookingId, oldOutTradeNo, newOutTradeNo, ...)` | 条件 UPDATE，affected=0 时返回 null |
| `markPaymentSucceeded(outTradeNo, transactionId, paidAt)` | 条件置 CONFIRMED+PAID |
| `markPaymentClosed(bookingIds, now)` | 按 `processedBookingIds` 批量条件更新 |
| `upsertAnomaly(bookingId, type, errorCode, summary, nextRetryAt)` | 同事务 upsert |
| `findOpenAnomalies(now, limit)` | 异常任务候选查询 |

原则（设计文档「支付与调度字段转换协议」）：Repository 只提供带期望状态条件的原子更新，不决定业务转换；所有业务决策由 Booking Service 命名动作完成，Controller 和定时方法只能调用命名动作。

## Controller 路由

### `POST /bookings/:bookingId/pay` —— 响应体保持兼容

| | 现状 | 改造后 |
| --- | --- | --- |
| 路由 | `booking.controller.ts:168` | 不变 |
| 响应 | `{ data: paymentParams }` | 不变；`paymentParams` 字段结构不变（`outTradeNo/appId/timeStamp/nonceStr/package/signType/paySign`） |
| 超时 | 通用 60 秒 | 调用方（前端）单独 25 秒超时；后端 22 秒预算 |

新增可能的响应分支（不改变 200 结构，但错误码需约定）：

- 订单已支付：返回稳定的"已支付"结果，前端据此跳转（设计文档步骤 2）。
- 支付准备超时：后端不把订单标失败，返回 `PAYMENT_PREPARATION_TIMEOUT` 错误码，前端提示"支付准备超时，请稍后重试"。
- 结果未知：返回 `PAYMENT_RESULT_UNKNOWN`，前端先查本地状态再决定重试。

### `GET /bookings/:bookingId/pay-status` —— 保持不变

`getPaymentStatus`（`:194`）响应不变。

### `POST /wechat-pay/notify` —— 保持不变

回调入口不变，内部走 `markPaymentSucceeded`（条件 UPDATE + 调度字段清理）。

## 小程序 `fctl` 配套改动

| 文件 | 现状 | 改造 |
| --- | --- | --- |
| 支付调用处 | 通用 60 秒超时 | 支付接口单独 25 秒超时 |
| 点击节流 | 2 秒节流 | 改为 `paymentLaunching` 状态锁 + `handlePayment` 模块按 `bookingId` 维护进行中 Promise |
| 超时处理 | 直接提示失败 | 先查本地支付状态，本地 `PAYING` 时重试可命中后端 30 秒缓存 |
| 按钮状态 | 订单 `PAYING` 时可能禁用 | 只在 `paymentLaunching`（准备阶段）禁用，不依赖订单 `PAYING` |

## 错误码

本期涉及的稳定错误码（供 `errorCode` 字段和日志使用，实现时建立完整列表）：

```text
PAYMENT_PREPARATION_TIMEOUT      支付准备 22 秒预算超时
PAYMENT_RESULT_UNKNOWN           微信下单结果未知（abort/断连）
PAYMENT_START_REJECTED           微信明确业务拒绝且未建单
CLOSE_ORDER_UNKNOWN              关单结果未知
CLOSE_ORDER_ALREADY_PAID         关单时发现已支付
QUERY_ORDER_UNKNOWN              查询订单结果未知
QUERY_REFUND_UNKNOWN             查询退款结果未知
```

异常类型码以 `payment-reliability-design.md`「首批异常类型」为准。

## 验证

- `initiatePayment` 改造后，现有 `POST /bookings/:bookingId/pay` 200 响应结构不变，前端无需改 `paymentParams` 解析。
- `closeOrder` 返回结构化结果后，两个调用点都穷举四类 `kind`，`UNKNOWN` 不更新为成功。
- Repository 现有 4 个查询方法都带 `take: 20`，`updatePaymentTimeoutOrders` 废弃。
- 转换协议 12 个命名动作都有对应 Repository 条件 UPDATE，affected=0 返回 null。
- `fctl` 支付超时从 60 秒改为 25 秒，且使用 `paymentLaunching` 状态锁。
