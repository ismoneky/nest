# 轻量日志管理与小程序日志上报设计

## 目标

为当前小型预约系统提供一个低运维成本的日志入口，覆盖后端业务日志、小程序运行日志和管理后台查询。日志保存在现有 SQLite 数据库中，不引入外部日志平台，也不改变预约、支付或认证架构。

本设计跨越三个仓库：

- `nest`：日志存储、批量上报接口、后台查询接口和过期清理。
- `fctl`：小程序日志采集、本地缓冲和批量上报。
- `admin`：日志查询与统计页面。

## 范围

### 包含

- 后端主动记录预约、支付、退款、核验、定时任务和未处理异常。
- 小程序记录运行异常、网络失败、关键业务阶段和页面上下文。
- 小程序离线缓冲、批量上报和失败重试。
- 管理后台按条件查询日志并查看基础统计。
- 日志敏感字段过滤、体积限制和定期清理。

### 不包含

- 全链路追踪、指标监控或外部 APM。
- 实时日志流、告警通知或日志导出。
- 采集所有成功 HTTP 请求。
- 修改现有预约、支付和认证流程。

## 数据模型

新增 `app_logs` 表：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer | 自增主键 |
| `logId` | varchar unique | 日志唯一标识，用于客户端重试去重 |
| `source` | varchar | `backend`、`miniprogram` 或 `admin` |
| `level` | varchar | `debug`、`info`、`warn` 或 `error` |
| `category` | varchar | `request`、`booking`、`payment`、`network`、`ui` 或 `runtime` |
| `message` | varchar | 简短日志消息，最多 2,000 个字符 |
| `requestId` | varchar nullable | 服务端请求关联标识 |
| `sessionId` | varchar nullable | 小程序匿名会话标识 |
| `route` | varchar nullable | 页面路由或后端请求路径 |
| `contextJson` | text nullable | 已过滤的结构化上下文，最多 8 KiB |
| `appVersion` | varchar nullable | 小程序版本 |
| `platform` | varchar nullable | 微信客户端与系统平台摘要 |
| `clientCreatedAt` | integer nullable | 客户端产生日志的时间 |
| `createdAt` | integer | 服务端接收或产生日志的时间 |

索引：

- `(createdAt, level)`：时间范围与级别查询。
- `(source, createdAt)`：按来源查询。
- `(category, createdAt)`：按业务分类查询。
- `requestId`、`sessionId`：关联同一请求或小程序会话。
- `logId` 唯一索引：客户端批量重试时幂等去重。

## 后端日志模块

新增 `LoggingModule`，对业务代码提供小接口：

```ts
interface AppLogWriter {
  write(entry: AppLogEntry): Promise<void>;
  writeMany(entries: AppLogEntry[]): Promise<void>;
  persistClientBatch(entries: AppLogEntry[]): Promise<{ acceptedLogIds: string[] }>;
}
```

业务日志写入失败不得改变预约或支付请求的业务结果。失败时使用 Nest 原生日志输出一次错误，但不能递归写入 `app_logs`。

内部 `write/writeMany` 在日志成功进入内存队列后即可 resolve，不代表已经落盘，业务调用方不得等待 SQLite。只有小程序上报接口调用 `persistClientBatch` 并等待对应批次真实提交后，才能向客户端确认 `acceptedLogIds`。

所有 SQLite 日志写入通过一个进程内 writer 队列串行执行，同一时刻最多一个日志事务。`writeMany` 每次最多接受 20 条；更多数据必须由调用方拆批。后端业务日志队列最多保存 500 条，达到 20 条或最老日志等待 5 秒时触发一次刷盘，每次用一条批量 INSERT 写入最多 20 条。后端队列满时复用小程序队列的级别淘汰顺序，优先保留较新且级别更高的日志。

首批记录点：

- 预约创建成功、容量不足和创建异常。
- 发起支付、支付回调、支付对账异常。
- 退款申请、退款回调和退款对账异常。
- 预约核验成功或失败。
- 定时任务开始、完成和分支失败。
- 全局异常过滤器捕获的未处理异常。

每条业务日志优先包含 `bookingId`、动作、结果和稳定错误码；禁止写入身份证、手机号、token、支付密钥、证书内容或完整 OpenID。

## 小程序日志采集

在 `fctl/utils/logger.js` 提供：

```js
logger.debug(category, message, context)
logger.info(category, message, context)
logger.warn(category, message, context)
logger.error(category, message, context)
logger.flush()
```

每条日志在客户端生成：

- UUID `logId`。
- 匿名 `sessionId`，一次小程序启动周期保持不变。
- 当前页面路由、客户端时间、应用版本和平台摘要。
- 经过敏感字段过滤与长度限制的 `context`。

### 本地缓冲

- 使用小程序本地存储维护最多 100 条的环形队列。
- 新日志进入已满的队列时按明确规则处理：新 `error` 优先淘汰最旧的 `debug/info`，其次最旧 `warn`，全部为 `error` 时淘汰最旧 `error`；新 `warn` 只淘汰最旧 `debug/info` 或最旧 `warn`，队列全部为 `error` 时丢弃新日志；新 `debug/info` 只淘汰最旧的同级或更低级日志，没有可淘汰项时丢弃新日志。
- 每次淘汰或拒绝累计 `droppedLogCount`。下一次成功上报时在批次元数据中携带该计数，服务端接受后清零，避免队列满时完全失去观测。
- 未登录、离线或上报失败时保留队列。
- 登录成功、网络恢复、队列达到 20 条、记录 `error` 或应用进入后台时触发上报。

### 批量上报

`POST /client-logs/batch` 使用现有 JWT，单次最多接收 20 条，请求体最大 192 KiB。登录前产生的日志先缓存在本地，登录成功后补传。

上报使用独立的 `uni.request`，不经过现有通用请求封装，避免“上报失败 → 记录网络失败 → 再次上报”的递归。

同一时刻只允许一个 flush。一次触发最多连续发送两个批次，批次之间至少间隔 500ms；剩余日志等待下一次触发，不能在网络恢复时瞬间清空 100 条队列。

成功响应返回已持久化的 `logId`；客户端只删除服务端确认写入 SQLite 的日志。`persistClientBatch` 最多等待 writer 3 秒，SQLite writer 繁忙、队列已满或超过等待时间时接口返回 503，客户端保留原日志并递增退避，单次小程序会话内最长退避至 5 分钟。4xx 表示日志格式不可接受，客户端删除对应无效日志，避免永久重试。服务端按用户/会话限制为每分钟最多 6 个批次，超出返回 429 并要求客户端退避。

## 接口

### 小程序批量上报

```text
POST /client-logs/batch
Authorization: Bearer <token>
```

请求：

```json
{
  "logs": [
    {
      "logId": "uuid",
      "level": "error",
      "category": "payment",
      "message": "发起支付失败",
      "sessionId": "anonymous-session-id",
      "route": "/pages/booking-detail/booking-detail",
      "context": { "bookingId": "TL...", "stage": "request-payment" },
      "appVersion": "1.0.0",
      "platform": "mp-weixin",
      "clientCreatedAt": 1786400000000
    }
  ],
  "droppedLogCount": 0
}
```

响应：

```json
{
  "success": true,
  "data": {
    "acceptedLogIds": ["uuid"],
    "rejected": []
  }
}
```

### 管理后台查询

```text
GET /admin/logs
  ?source=miniprogram
  &level=error
  &category=payment
  &keyword=支付
  &start=2026-08-01
  &end=2026-08-11
  &page=1
  &pageSize=20
```

使用现有管理员 Guard，默认按 `createdAt DESC, id DESC` 排序。

`pageSize` 默认 20、最大 100；超过最大值按 100 处理，不允许管理员查询接口一次返回全量日志。

### 基础统计

```text
GET /admin/logs/stats?start=2026-08-10&end=2026-08-11
```

返回总量、按来源数量、按级别数量和最近错误数，不提供实时刷新保证。

## 管理后台页面

新增“日志管理”菜单，包含：

- 来源、级别、分类、日期范围和关键词筛选。
- 日志时间、来源、级别、分类、消息、路由和 requestId/sessionId 列表。
- 展开查看过滤后的上下文 JSON。
- 顶部显示日志总量、错误数、小程序错误数和后端错误数。

页面不得展示被过滤的敏感字段，也不提供修改或手动删除单条日志的能力。

## 敏感信息与滥用防护

客户端和服务端都过滤以下字段名及其常见变体：

- `authorization`、`token`、`password`、`secret`、`key`。
- `idCard`、`phone`、`openid`、`wechatOpenId`。
- 支付证书、签名、回调原始密文和完整请求头。

服务端不信任客户端过滤结果，写库前必须再次递归过滤。递归最多 5 层；每个对象最多保留 50 个键，每个数组最多保留 50 项，字符串最多 2,000 个字符，最终 `contextJson` 最多 8 KiB。超过深度替换为 `"[MaxDepth]"`，循环引用替换为 `"[Circular]"`，超出键、数组或字符串限制时截断并增加 `truncated=true`。批量接口限制日志数量、单条消息长度、上下文大小和请求总体积。未通过 JWT 的请求不写库。

## 保留与清理

- 默认保留 30 天。
- 每日低峰期执行一次删除：`createdAt < now - 30 days`。
- 每批最多删除 200 条，批次间隔至少 100ms，每日单轮最多执行 10 批；剩余过期日志下一日继续，避免长事务阻塞 SQLite。
- 清理任务记录删除数量和耗时；清理失败仅记录后端原生日志，下一日重试。

## SQLite 写锁预算

本期不启用 WAL。`app_logs` 和支付可靠性设计中的 `booking_anomalies` 都位于现有 SQLite，因此新增表本身虽然不会锁库，新增写入会与订单状态更新竞争唯一 writer。日志设计按以下预算约束落地：

- 日志绝不参与预约、支付、退款的业务事务；业务提交后才入 writer 队列。
- 后端业务请求不等待日志刷盘。日志队列已满时按级别淘汰并输出一次限频的 Nest stdout 告警，不能阻塞主流程。
- 小程序批量上报需要等待日志持久化后才确认，但所有批次进入同一个串行 writer；最多 20 条一批，不并发开启多个 SQLite 日志事务。
- writer 遇到 `SQLITE_BUSY` 不在 libuv worker 上追加长时间重试。客户端请求返回 503 并退避；后端非关键日志保留在内存队列等待下一轮，超过 30 秒仍无法写入时按队列淘汰规则处理。
- 日志清理、异常订单低频重试和支付对账必须错峰。清理任务达到 200 条批量或当轮时间预算后立即提交并让出 writer。
- 提供 `APP_LOG_SQLITE_ENABLED` 开关。发现写锁等待或支付 p95 恶化时可停止 SQLite 日志持久化，后端继续输出 Nest stdout，小程序上报返回 503 并保留本地队列。

上线前后使用相同的支付并发场景同时注入小程序日志批次。验收要求：开启日志持久化后，用户支付 p95 相对关闭日志时增长不超过 20%，不出现 `SQLITE_BUSY`，日志批量事务 p95 不超过 50ms。超过任一边界时先把日志批量从 20 降到 10、延长刷盘间隔或关闭 SQLite 日志，不以启用 WAL 作为本期补救。

## 错误处理

- 日志记录失败不阻断预约和支付主流程。
- 小程序上传失败不弹 Toast，不影响用户操作。
- 管理后台查询失败使用现有统一错误提示。
- 无法序列化的上下文替换为 `{ "serializationError": true }`，不抛出到业务调用方。

## 验收标准

- 小程序离线产生日志后，在恢复网络并完成登录时能够补传。
- 同一批日志重复上传不会产生重复记录。
- 小程序上报失败不会形成递归日志或持续请求风暴。
- 队列达到 100 条时按级别边界稳定淘汰，并在后续批次上报准确的 `droppedLogCount`。
- 上下文超过 5 层、对象 50 键、数组 50 项、字符串 2,000 字符或总计 8 KiB 时会按规则截断，不导致递归溢出。
- 单次客户端写入最多 20 条、请求最大 192 KiB，多个 flush 不会并发写 SQLite。
- 管理后台可以按来源、级别、分类、时间和关键词查询。
- 日志中不存在明文 token、身份证、手机号、完整 OpenID 或支付密钥。
- 超过 30 天的日志会被分批清理。
- 日志存储不可用时，预约和支付接口仍按原业务结果返回。
- 日志与异常订单写入同时启用后，支付竞争压测仍满足写锁预算中的 p95 和 `SQLITE_BUSY` 边界。

## 上线顺序

1. 在 `nest` 增加日志表、写入模块、批量上报、后台查询和清理任务。
2. 在 `admin` 增加日志管理页面。
3. 在 `fctl` 增加 logger、本地队列和批量上报，先接入全局异常、网络错误和支付流程。
4. 观察日志量与 SQLite 写入耗时，再逐步增加业务记录点。
