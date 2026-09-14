# SQLite 与支付卡顿诊断脚本

## 用途

`scripts/diagnose-sqlite-payment-contention.js` 用于验证以下风险是否存在于当前服务器环境：

- SQLite 写锁等待占满默认 libuv 线程池后，是否拖慢支付请求所需的 DNS 查询。
- `UV_THREADPOOL_SIZE=16` 是否能隔离这种资源竞争。
- keep-alive 复用连接后，是否能绕过重复 DNS 与建连等待。
- `maxSockets=5` 在支付请求突发时是否形成明显排队。
- 测试期间是否出现明显的事件循环延迟。

脚本不会调用真实微信支付，不会读取生产数据库，也不会修改生产数据。它使用唯一命名的临时 SQLite 文件和仅监听 `127.0.0.1` 的模拟支付服务器。

## 服务器运行

进入后端部署目录：

```bash
cd /app/backend
```

确认运行依赖存在：

```bash
node --version
npm ls sqlite3 typeorm
```

执行完整诊断：

```bash
node scripts/diagnose-sqlite-payment-contention.js \
  --output=sqlite-payment-diagnostic.json
```

开发机快速验证：

```bash
node scripts/diagnose-sqlite-payment-contention.js \
  --quick \
  --output=sqlite-payment-diagnostic-quick.json
```

脚本会在终端显示摘要，并把完整 JSON 写入指定文件。请返回终端摘要和 JSON 文件；报告不包含数据库记录、token 或微信密钥。

不要同时运行多个诊断实例。完整诊断会制造数秒钟的临时 SQLite 锁等待和本地 HTTP 流量，建议在低峰期运行。

## 报告解释

### `SQLITE_LIBUV_COUPLING`

默认线程池下，SQLite 锁等待明显拖慢模拟支付的 DNS；线程池 16 下恢复。说明服务器具备本次事故所需的底层资源竞争条件，但仍需生产链路时序日志确认事故当时是否由它触发。

### `KEEPALIVE_BYPASSES_LOOKUP`

预热后的 keep-alive 连接跳过 DNS 与建连，绕开了线程池竞争。说明生产侧已落地的 keep-alive Agent 在正常路径下能避免重复 DNS/握手——但若连接因空闲超时被回收或被对账任务占满，仍会退回到竞争路径。

### `TYPEORM_PRAGMA_CONFIGURATION_IGNORED` / `TYPEORM_SYNCHRONOUS_NOT_NORMAL`

脚本会检测到当前 `extra.pragma` 写法既没启用 WAL 也没设到 5000ms busy_timeout，synchronous 也仍是 FULL。**这两条本期不调整**，列为 `info` 级别仅供参考，不是本次事故的诊断重点；WAL 与 `synchronous=NORMAL` 的修复另行排期。

### `HTTP_AGENT_SOCKET_QUEUE`

并发请求数量超过 `maxSockets` 后出现连接排队。这是连接上限的正常背压，但如果对账查询和用户支付共享同一个 Agent，用户请求可能排在后台任务之后。

### `eventLoopDelayMs`

SQLite 异步锁等待通常不应显著阻塞 JavaScript 事件循环。如果该值很高，应继续排查同步加密、JSON 处理、CPU 饱和或其他同步代码。

报告的 `riskClassifications` 会把风险标为：

- `observed`：在这次隔离诊断中观察到。
- `not_observed`：本次诊断没有观察到；不代表线上事故时一定不存在。
- `production_only`：隔离测试无法判断，必须依赖线上结构化日志或高峰压测。

## 能确认与不能确认的内容

本脚本可以确认服务器上的资源竞争机制和配置行为，但不能确认：

- 事故时微信真实 DNS、TCP、TLS 或 API 响应是否异常。
- 事故时小程序是否发生重复提交或轮询风暴。
- 每五分钟对账任务是否恰好占用全部支付连接。
- 生产进程当时的 CPU、内存、文件描述符和磁盘延迟。

这些信息需要已设计的结构化日志记录每个支付阶段的耗时，并结合真实高峰压测完成确认。
