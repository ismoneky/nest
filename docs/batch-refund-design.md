# 选择性批量退款（一期）— 产品与技术方案

> 状态：方案更新（2026-08-21）。前一版为"按预约日期整批退款"，经产品复盘改为"订单列表勾选退款"；日期整批作为"筛选日期 + 全选"的特例被覆盖，不再单独存在。
> 关联：天气应急关闭场景 + 日常运营零散退款；单次规模约数百单。

---

## 一、产品方案

### 1.1 业务场景

- **应急**：天气不稳定临时关闭景区，把某日期已支付订单批量退款（几百到上千单）。
- **日常**：运营/客服在订单管理中挑选特定订单退款（几单到几百单），包括已核验订单的售后处理。

两种场景共用同一个入口和同一条后端链路。

### 1.2 已确认的产品决策（2026-08-21 定稿）

| 决策点 | 结论 |
|---|---|
| 管理端入口 | **订单管理列表页**：复用已有日期等筛选，勾选订单后操作；不做独立菜单页 |
| 选择方式 | 逐单勾选 + "全选当前筛选结果"（经 ID 列表接口收集，见 2.3） |
| 退款资格 | **管理员不看业务状态**（已核验/已取消均可退），仅保留资金硬约束（见 1.4）；用户自助退款规则不变 |
| 退款金额 | **只支持全额退**；一单只退一次，固定单号 `RF{bookingId}` 幂等 |
| 单次规模 | 约数百单；持久化异步任务 + 进度轮询，页面可关闭 |
| 用户感知 | 静默退款 + 微信支付原生退款通知；站内通知放二期 |
| 确认强度 | 预览（单数/金额/不可退明细）→ 填退款原因 → 强确认 |
| 权限 | 复用现有管理端登录；任务记录执行管理员 |
| 补退 | 不做；失败订单从订单详情页人工处理 |
| 暂停/撤销 | 不支持；确认后立即开始向微信提交 |

### 1.3 管理端交互流程

```text
┌─ 订单管理页 ─────────────────────────────────────────────┐
│  ① 用现有筛选（日期/时段/状态等）缩小范围                  │
│  ② 勾选订单（逐单 / 全选本页 / 全选当前筛选结果）           │
│  ③ 点【批量退款】→ 预览弹层：                             │
│     ├ 可退：342 单 / ¥17,100 / 850 人                     │
│     ├ 不可退：未支付 3 / 退款中 1 / 已退款 2 / …          │
│     │   （每桶附具体订单号，供核对剔除）                    │
│     └ 可退明细（掩码，前 200 条）                          │
│  ④ 退款原因（2-80 字，透传微信退款申请）                    │
│  ⑤ [红色按钮] 执行 ── 强确认：                            │
│     "将立即向微信提交 342 笔退款申请，共 ¥17,100。          │
│      执行后不能暂停或撤销，是否确认？"                       │
│  ⑥ 进度面板：待提交 / 处理中 / 已确认 / 失败               │
│     + 已确认退款金额；3-5 秒轮询                           │
│  ⑦ 历史任务表（最近 20 条，可查看执行详情）                 │
└───────────────────────────────────────────────────────────┘
```

预览只反映查询时的状态。管理员确认后，后端按相同条件重新校验并冻结订单，最终任务单数以执行接口返回的 `totalTarget` 为准。

### 1.4 管理员退款资格（相对用户自助的关键变化）

**不检查业务状态**：`status` 为 CONFIRMED / COMPLETED / CANCELLED 均可退。仅保留资金硬约束：

```text
paymentStatus = PAID
refundStatus IN (NONE, FAILED)
isFree = false
amount > 0
outTradeNo IS NOT NULL
paidAt IS NOT NULL
当前时间未超过 paidAt 后一年（微信侧退款有效期，管理员无法突破）
```

不满足的订单按以下原因分桶（附具体订单号）：

- 未支付
- 免费单或金额为 0
- 退款处理中
- 已退款
- 支付时间超过退款有效期
- 数据异常：缺少 `outTradeNo`、`paidAt` 或金额非法

用户自助退款维持原规则（已核验不可退等），两套规则在资格模块中显式分开，不互相复用条件。

### 1.5 一期用户触达

一期只依赖微信支付退款流程自带的原生退款通知。站内通知、订阅消息全部放到二期，一期不修改小程序端。

---

## 二、技术方案

### 2.1 核心设计原则

1. **资格判断只有一份**：预览和执行共用同一个资格模块；执行时必须重新校验，不能信任预览结果。
2. **任务创建和冻结订单同事务**：确认后在一个事务中创建任务并批量标记目标订单，不留半成品。
3. **先冻结再调微信**：目标订单先写入 `REFUNDING + BATCH + PENDING + taskId`，立即阻止用户重复申请；worker 随后逐笔提交。
4. **冻结不排对账**：PENDING 订单**不设置** `reconcileKind/reconcileNextAt`；只有提交拿到微信应答后才排对账（SUBMITTED→15 分钟，UNKNOWN→1 分钟）。PENDING 的恢复只走 worker + Cron 兜底，对账任务不得触碰未提交订单。（否则对账会按 NOT_EXIST 把未提交订单误判 FAILED，worker 随后仍提交，钱退了订单却卡死 FAILED。）
5. **固定退款单号保证幂等**：始终使用已有 `outRefundNo`，没有时生成固定的 `RF${bookingId}`；结果未知时先查询，不生成新退款单号，也不立即重复 POST。
6. **持久化任务、串行提交**：单实例、单 worker、微信请求并发 1；每次只领取一笔 PENDING 订单。
7. **进度以订单真实状态为准**：任务详情按 `refundBatchTaskId` 实时聚合 bookings，不维护另一套逐单累加计数。

### 2.2 管理员退款资格（资格模块改造）

`refund-eligibility.ts` 拆为两套显式规则：

- **管理员版**（选择性批量退款用）：1.4 的资金硬约束，无业务状态检查。
  - `classifyAdminRefundEligibility(booking, now)`：预览分桶（勾选订单逐单分类）。
  - `applyAdminRefundableConditions(qb, alias, now)`：执行冻结的 SQL 条件。
- **用户版**：维持 `initiateRefund` 现有内联校验，不改动。

预览与执行同源，一致性由对照测试保证。

### 2.3 后端架构（nest）

#### 模块结构（已存在，改造）

```text
src/entities/batch-refund-task.entity.ts        # bookingDate 列语义调整（见下）
src/repositories/batch-refund-task.repository.ts # 不变
src/repositories/booking.repository.ts          # 预览/冻结改为按 ID 列表 + 资金条件
src/modules/batch-refund/                       # controller + service + dto + module
```

#### 修改文件

| 文件 | 变更 |
|---|---|
| `modules/batch-refund/refund-eligibility.ts` | 改为管理员版资格（去 status 条件），预览按传入订单分类 |
| `repositories/booking.repository.ts` | `getBatchRefundPreview(bookingIds)` 按 ID 列表取单分类；`freezeBookingsForBatchRefund(em, bookingIds, taskId)` 改 `bookingId IN` + 资金条件，**不再设置 reconcile 调度字段** |
| `modules/batch-refund/dto/batch-refund.dto.ts` | preview/execute 入参改 `bookingIds: string[]`（1-1000 个）+ reason |
| `modules/batch-refund/batch-refund.service.ts` | preview/execute 按 ID 列表；任务摘要写入 selectionSummary |
| `entities/batch-refund-task.entity.ts` | `bookingDate` → `selectionSummary`（可空，存去重日期摘要） |
| `modules/booking/booking.service.ts` | **P0-2 修复**：`initiateRefund` 非 accepted 一律抛 BadRequestException，保持小程序旧契约（fctl 只认 HTTP 状态/success） |
| `modules/wechat-pay/wechat-pay.service.ts` | 已完成：结构化 RefundSubmitResult + batchRefundAgent，不变 |
| `docs/implementation-todo.md` | 更新任务表建表 SQL（表未上生产，直接改不迁移） |

#### 任务表字段

`batch_refund_tasks`（相对前版唯一变化：`bookingDate` → `selectionSummary`）：

```text
taskId                  唯一任务 ID
selectionSummary        选择摘要（去重预约日期逗号拼接，截断 100 字符；可空）
status                  RUNNING | SUBMISSION_COMPLETED | COMPLETED | COMPLETED_WITH_FAILURES
totalTarget             事务冻结成功的实际订单数
reason                  实际使用的退款原因
operatorAdminId         执行管理员 ID
createdAt / startedAt / submissionCompletedAt / completedAt / lastHeartbeatAt
errorSummary            批量提交过程中的错误摘要
```

`refundBatchTaskId` 就是订单目标快照。同一时刻最多一个 RUNNING 任务由数据库部分唯一索引保证。

#### API 设计（全部使用 AdminAuthGuard）

```text
POST /admin/batch-refund/preview
     ← { bookingIds: string[] }（1-1000）
     → { refundable: {count, totalAmount, peopleCount},
         unrefundable: [{reason, label, count, bookingIds}...],
         detailPreview: [...前 200 条掩码明细],
         runningTask: null | {taskId, pending, total} }

POST /admin/batch-refund/execute
     ← { bookingIds: string[], reason }
     → { taskId, totalTarget, status: 'RUNNING' }
     错误：409 已有 RUNNING 任务（同时返回 taskId）/ 400 无可退订单

GET  /admin/batch-refund/tasks        → 最近 20 条历史任务
GET  /admin/batch-refund/tasks/:taskId → 任务元信息 + 实时聚合进度
```

另需订单列表配套（"全选当前筛选结果"）：

```text
GET  /admin/bookings/ids?<与订单列表相同的筛选参数>
     → { ids: string[], total }（超过 1000 报错，提示缩小筛选范围）
```

不提供暂停、继续、撤销或取消接口。

### 2.4 创建任务与冻结订单

```text
BEGIN（事务）
→ 检查是否已有 RUNNING 任务（有则 409 + taskId）
→ INSERT task（selectionSummary = 所选订单去重日期摘要）
→ 批量 UPDATE bookings：
     WHERE bookingId IN (:ids) AND <管理员资金硬条件>
     SET refundStatus = REFUNDING
         refundSource = BATCH
         refundSubmitStatus = PENDING
         refundBatchTaskId = taskId
         outRefundNo = COALESCE(outRefundNo, 'RF' || bookingId)
     -- 不设置 reconcileKind/reconcileNextAt（原则 4）
→ 使用 UPDATE affected 作为 totalTarget
→ affected = 0：ROLLBACK，返回 400
→ 更新 task.totalTarget
COMMIT
→ 立即返回 taskId
→ 启动 worker
```

事务中只做本地数据库操作，绝不调用微信。ID 列表由 DTO 限制 1-1000 个（请求体 192 KiB 内）。

并发 execute 撞上唯一索引时，捕获唯一约束错误 → 查当前 RUNNING → 返回 409 + taskId（不暴露 500）。

### 2.5 退款提交结果接口

`WechatPayService.refund()` 已完成结构化改造：

```typescript
type RefundSubmitResult =
    | { state: 'accepted'; refundStatus?: string }
    | { state: 'rejected'; code: string; message: string }
    | { state: 'unknown'; code: string; message: string };
```

**调用方契约（P0-2）**：

- 批量 worker：按 state 写回 SUBMITTED / FAILED / UNKNOWN。
- 用户自助 `initiateRefund`：**非 accepted 一律抛 BadRequestException**（rejected 透传微信 message，unknown 提示稍后查看）。小程序端按 HTTP 状态/success 判断成败，一期不改 fctl，必须保持旧契约。

### 2.6 worker 执行时序（不变）

```text
事务冻结完成
→ 单 worker 循环领取当前 taskId 下一笔 PENDING 订单
→ 并发 1，相邻请求启动间隔至少 300ms
→ 调微信退款，固定使用订单 outRefundNo

accepted → refundSubmitStatus = SUBMITTED；reconcileKind=refund，15 分钟后对账
rejected → refundSubmitStatus = FAILED；refundStatus = FAILED；保存稳定错误码；清空调度
unknown  → refundSubmitStatus = UNKNOWN；保持 REFUNDING；1 分钟后先查询，不立即重复 POST

→ 无 PENDING → task.status = SUBMISSION_COMPLETED，写 submissionCompletedAt
```

订单结果由现有退款回调和退款对账收敛。NOT_EXIST 按"至少一次延迟复查"处理：第一次查无 → 5 分钟后复查；复查仍无 → FAILED（避免微信建单传播延迟误判；同 outRefundNo 重提幂等，不会双退）。

任务状态推进：仍有 PENDING→RUNNING；无 PENDING 但有 REFUNDING→SUBMISSION_COMPLETED；全部 REFUNDED→COMPLETED；全部终态且有 FAILED→COMPLETED_WITH_FAILURES。回调更新订单后尽力重算关联任务；恢复 Cron 扫描 SUBMISSION_COMPLETED 兜底推进终态。

### 2.7 进度统计（不变）

按 `refundBatchTaskId` 聚合互斥计数：`pending + processing + confirmed + failed = total`；金额单位分。

### 2.8 防重入与恢复（不变）

- 数据库保证同一时刻最多一个 RUNNING 任务；创建与冻结同事务。
- 执行接口重入返回 409 + 当前 taskId。
- 应用启动恢复 RUNNING 任务的 PENDING 订单；Cron 每 10 分钟兜底无活跃 worker 的 RUNNING 任务。
- 恢复依据只能是 `refundBatchTaskId + refundSubmitStatus=PENDING`，不按选择条件重新筛选。
- 单实例部署前提不变。

### 2.9 管理端（admin）

- 订单管理列表页改造：勾选列、全选本页、全选当前筛选结果（调 `/admin/bookings/ids`）、【批量退款】操作按钮
- 预览弹层组件（可退聚合 + 不可退分桶附订单号 + 掩码明细 + 原因输入 + 强确认）
- 进度面板组件（3-5 秒轮询任务详情；失败去向说明）
- 历史任务抽屉/弹层（最近 20 条 + 详情）
- 新建 `src/api/batchRefund.ts`，封装四个接口
- 执行成功后显示实际 `totalTarget` 并切换到进度面板；有 RUNNING 任务时禁止再次执行并跳转当前任务
- 不提供暂停、继续、撤销按钮

### 2.10 小程序端（fctl）

一期不修改。用户自助退款契约保持不变（见 2.5）。

### 2.11 边界情况

| # | 场景 | 行为 |
|---|---|---|
| 1 | 预览后订单状态变化 | 执行时重新按资金条件冻结；最终数量以 totalTarget 为准 |
| 2 | 并发点击执行 | 事务检查 + 唯一索引；后来的请求收到 409 + 当前 taskId |
| 3 | 用户自助退款与批量退款竞争 | 通过 refundStatus 条件 UPDATE 竞争，只有一方能进入 REFUNDING |
| 4 | 勾选了已在退款中/已退款的订单 | 预览分桶展示并排除；执行时条件不符自动剔除 |
| 5 | 勾选已核验/已取消订单 | 管理员版规则允许，正常退款 |
| 6 | 免费、0 元、未支付或数据异常 | 不进入任务，预览按原因分桶附订单号 |
| 7 | 超过退款有效期 | 不进入任务，列入"超过退款有效期"分桶 |
| 8 | 服务在创建任务时退出 | 创建任务与冻结订单同事务，不留半成品 |
| 9 | 服务在微信请求中退出 | 固定退款单号；PENDING 由 worker 恢复续跑，UNKNOWN/SUBMITTED 由对账接管 |
| 10 | 微信请求超时或断开 | 写 UNKNOWN 并先查询，不立即重复 POST |
| 11 | 微信明确拒绝 | 写 FAILED 和错误码，后续从订单详情人工处理 |
| 12 | 回调先于 worker 状态写回 | 使用当前状态条件更新，不允许把 REFUNDED 回退为 REFUNDING |
| 13 | 管理员关闭页面 | worker 后台继续；重开页面从任务接口恢复进度 |
| 14 | 对账扫到 PENDING 订单 | 不会发生：PENDING 不排对账（原则 4），对账候选排除 refundSubmitStatus=PENDING（双保险） |
| 15 | NOT_EXIST 误判 | 第一次查无延迟 5 分钟复查，复查仍无才 FAILED；同单号重提幂等 |

### 2.12 性能与容量

- 单次规模约数百单；DTO 限制 bookingIds 1-1000 个（请求体 192 KiB 内，约 40 KB）
- 批量通道并发 1，相邻请求启动间隔至少 300ms；500 单约 3-7 分钟完成提交
- worker 每次只查询一笔 PENDING，不预加载全部订单
- 微信 HTTP 不在 SQLite 事务内；事务只负责创建任务和冻结目标
- 任务进度每 3-5 秒聚合一次当前 taskId 的订单
- 首版不引入消息队列、分布式任务调度或多实例 worker 租约

---

## 三、实施顺序（每步独立可验证）

| 步骤 | 内容 | 验证方式 |
|---|---|---|
| 0a | **P0-1 修复**：冻结不写 reconcile 调度字段；对账候选排除 PENDING | 回归测试：冻结后 15 分钟对账不触碰未提交订单 |
| 0b | **P0-2 修复**：initiateRefund 非 accepted 抛 400 | 契约测试：rejected/unknown → 400，fctl 无需改动 |
| 1 | 资格模块改管理员版（去 status），预览/执行同源 | 覆盖已核验可退、免费、未支付、超期等数据 |
| 2 | 任务表 selectionSummary + 生产 SQL 更新 | dev 建表检查 |
| 3 | preview/execute 改 ID 列表入参，冻结改 IN 条件 | 并发执行只一个 RUNNING；勾选混合状态订单验证分桶与冻结一致 |
| 4 | 对账 NOT_EXIST 延迟复查（第一次 +5min，第二次 FAILED） | UNKNOWN 订单复查两次才判失败 |
| 5 | execute 唯一索引冲突转 409 | 并发/重复提交返回 409 + taskId |
| 6 | `/admin/bookings/ids` 全选接口 | 与订单列表筛选结果一致；超 1000 报错 |
| 7 | admin 订单页改造（勾选 + 预览弹层 + 进度面板 + 历史） | 筛选 → 全选 → 预览 → 强确认 → 执行 → 关页恢复 |

worker、幂等、恢复、进度聚合已在日期版中实现并通过测试，本次改造保持不变，仅需调整测试夹具（按 ID 列表构造）。

### 前置条件

- 生产环境执行手工 schema SQL（任务表从未部署，直接按新结构建表）
- 确认生产环境为单实例部署
- 使用测试商户或可控测试订单验证微信退款错误分类

### 首版明确不做

- 部分退款（一单只全额退一次）
- 暂停、继续、撤销、取消批量退款
- 站内通知、通知中心和未读数；一次性订阅消息
- 用户自助退款规则调整（已核验仍不可退）
- 多实例 worker、消息队列和分布式租约
- 自动补退；失败订单由订单详情页人工处理

## 四、二期候选范围（不影响一期上线）

- 部分退款（单号规则改 `RF{bookingId}-{n}`，冻结/恢复逻辑配套）
- 定向站内通知表和用户侧通知接口
- 小程序通知中心、首页未读提示和已读状态
- 批量退款结束后按用户聚合通知，区分已确认、处理中和部分失败
- 通知去重、失败补发和管理端查看
- 是否增加一次性订阅消息，根据一期微信原生通知的实际触达效果再决定
