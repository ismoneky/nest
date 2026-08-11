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
}
```

业务日志写入失败不得改变预约或支付请求的业务结果。失败时使用 Nest 原生日志输出一次错误，但不能递归写入 `app_logs`。

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
- 队列超过限制时优先丢弃最旧的 `debug`、`info`，最后才丢弃 `warn`、`error`。
- 未登录、离线或上报失败时保留队列。
- 登录成功、网络恢复、队列达到 20 条、记录 `error` 或应用进入后台时触发上报。

### 批量上报

`POST /client-logs/batch` 使用现有 JWT，单次最多接收 50 条。登录前产生的日志先缓存在本地，登录成功后补传。

上报使用独立的 `uni.request`，不经过现有通用请求封装，避免“上报失败 → 记录网络失败 → 再次上报”的递归。

成功响应返回已接受的 `logId`；客户端只删除服务端确认接受的日志。网络错误或服务端 5xx 使用递增退避，单次小程序会话内最长退避至 5 分钟。4xx 表示日志格式不可接受，客户端删除对应无效日志，避免永久重试。

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
  ]
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

服务端不信任客户端过滤结果，写库前必须再次递归过滤。批量接口限制日志数量、单条消息长度、上下文大小和请求总体积。未通过 JWT 的请求不写库。

## 保留与清理

- 默认保留 30 天。
- 每日低峰期执行一次删除：`createdAt < now - 30 days`。
- 每次分批删除，避免长事务阻塞 SQLite。
- 清理任务记录删除数量和耗时；清理失败仅记录后端原生日志，下一日重试。

## 错误处理

- 日志记录失败不阻断预约和支付主流程。
- 小程序上传失败不弹 Toast，不影响用户操作。
- 管理后台查询失败使用现有统一错误提示。
- 无法序列化的上下文替换为 `{ "serializationError": true }`，不抛出到业务调用方。

## 验收标准

- 小程序离线产生日志后，在恢复网络并完成登录时能够补传。
- 同一批日志重复上传不会产生重复记录。
- 小程序上报失败不会形成递归日志或持续请求风暴。
- 管理后台可以按来源、级别、分类、时间和关键词查询。
- 日志中不存在明文 token、身份证、手机号、完整 OpenID 或支付密钥。
- 超过 30 天的日志会被分批清理。
- 日志存储不可用时，预约和支付接口仍按原业务结果返回。

## 上线顺序

1. 在 `nest` 增加日志表、写入模块、批量上报、后台查询和清理任务。
2. 在 `admin` 增加日志管理页面。
3. 在 `fctl` 增加 logger、本地队列和批量上报，先接入全局异常、网络错误和支付流程。
4. 观察日志量与 SQLite 写入耗时，再逐步增加业务记录点。
