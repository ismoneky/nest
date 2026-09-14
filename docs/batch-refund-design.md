# 一键批量退款 + 用户通知体系 — 产品与技术方案

> 状态：方案设计（未实施）
> 日期：2026-08-16
> 关联：天气应急关闭场景；日单量 1000-1500，节假日峰值更高

---

## 一、产品方案

### 1.1 业务场景

天气不稳定临时关闭景区时，管理员需要把"某日期预约但未完成核验"的订单**批量退款**并**触达用户**。核心诉求：

- 应急操作，路径要短、防误触
- 量大（最多一次约 1500 单），不能卡页面
- 用户必须知道"钱退了、为什么退、几天到账"

### 1.2 已确认的产品决策

| 决策点 | 结论 |
|---|---|
| 管理端入口 | **独立"批量退款"菜单页**（含历史任务列表） |
| 退款范围 | **按预约日期整批**：该日全部"已支付未核验"订单，不做细分筛选 |
| 用户感知 | **静默退款 + 多渠道告知**（见 1.4） |
| 确认强度 | 预览（单数/金额/不可退明细）→ 填退款原因 → Popconfirm 点击确认 |
| 通知形态 | **定向站内通知（新能力）**：管理员编辑文案 → 发给被执行退款的用户 → 小程序内未读展示 → 点"我知道了"标记已读 |
| 权限 | 复用现有管理端登录，不做单独角色 |
| 补退 | 本次不做；被排除订单（如已完成核验）走订单页详情手动处理 |
| 执行模式 | 异步任务 + 进度轮询，页面可关闭，任务后台执行 |

### 1.3 管理端交互流程

```
┌─ 批量退款页 ────────────────────────────────────────────┐
│                                                          │
│  ① 选预约日期 ────→ ② 预览                               │
│     DatePicker        ├ 可退：1234 单 / ¥61,700 / 3100 人 │
│                      ├ 不可退分桶：已完成 45 / 退款中 3 /    │
│                      │   已退款 12 / 免费单 80 / 未支付 30  │
│                      └ 折叠明细（前 200 条，掩码展示）      │
│                                                          │
│  ③ 退款原因（2-80 字，透传微信退款单，用户微信账单可见）      │
│  ④ 通知标题 + 内容（预填建议文案，可编辑；含到账说明）        │
│                                                          │
│  ⑤ [红色按钮] 执行批量退款 ── Popconfirm："将向微信提交      │
│     1234 笔退款申请，确认执行？"                            │
│                                                          │
│  ⑥ 进度面板：Progress 条 + 已退/成功/失败/跳过 计数          │
│     + 已退金额；3s 轮询；完成后展示结果与失败单去向说明       │
│                                                          │
│  ⑦ 底部：历史任务表（最近 20 条，可查看每次执行详情）         │
└──────────────────────────────────────────────────────────┘
```

### 1.4 用户触达（三渠道，优先级从高到低）

| 渠道 | 内容 | 依赖 | 覆盖率 |
|---|---|---|---|
| 微信支付原生退款通知 | 微信"服务通知"里的绿字退款提醒 | 无需开发（APIv3 退款自带） | 100%（已关注服务通知的用户） |
| 站内通知（本次新建） | 管理员编辑的文案，未读强提示，点"我知道了"变已读 | 新实体 + 小程序通知中心 | 100%（下次打开小程序时） |
| 订阅消息 | 退款结果摘要（一次性订阅模板） | 后端 access_token + 小程序端授权采集 + 模板申请 | 有限（一次性授权，发一条耗一次） |

设计要点：**站内通知为主渠道**（确定触达、可承载完整文案、可读状态闭环），订阅消息为增强（不依赖其成功），微信原生通知为兜底（零成本自带）。

### 1.5 小程序端通知交互

- **App onShow**：有登录态时静默拉未读数（失败无感），驱动 tabbar/首页红点
- **首页**：公告轮播条上方显示"通知条"（有未读时），点击进入通知中心
- **通知中心**（新页面）：未读在前 + 时间；内容展示 + "我知道了"按钮 → 调已读接口 → 未读数刷新

---

## 二、技术方案

### 2.1 核心设计原则（已对现有代码验证）

1. **不新建退款状态机**：逐单复用 `markRefundStarting`（条件 UPDATE：confirmed+paid+refundStatus IN(none,failed) → REFUNDING，原子防并发，与用户自助退款/退款对账 Cron 天然互斥）
2. **先落库再调微信**：微信调用失败不回滚 REFUNDING，交给现有退款对账 Cron（每 15 分钟）+ 异常升级通道收敛——单笔退款的既有语义，批量照抄
3. **执行引擎独立**：不共享 BookingService 的 writeChain/semaphore（避免上千单拖慢对账 Cron 写回），自建单写者 FIFO + 并发 5（对齐 `interactiveAgent` maxSockets=5，本身就是限流）
4. **bookings 表即逐单真相**：任务表只存计数 + bookingId 快照（targetsJson），不建逐单明细表；恢复 = 重扫快照，幂等（已处理单 markRefundStarting 返回 0 自动跳过）
5. **通知尽力而为**：收尾统一发送（openid 去重一人一条）、订阅消息 43101（未授权）静默、通知失败绝不影响退款状态

### 2.2 后端架构（nest）

#### 新增模块

```
src/entities/user-notification.entity.ts     # 站内通知（user_notifications 表）
src/entities/batch-refund-task.entity.ts     # 批量任务（batch_refund_tasks 表）
src/repositories/user-notification.repository.ts
src/repositories/batch-refund-task.repository.ts
src/modules/batch-refund/                    # 批量退款（controller + service + dto + module）
src/modules/wechat-mp/                       # 小程序 access_token + 订阅消息发送
```

#### 修改文件

| 文件 | 变更 |
|---|---|
| `modules/wechat-pay/wechat-pay.service.ts` | `refund()` 加可选 `opts?: { reason?: string }`（截断 80 字符），现有调用点零改动 |
| `repositories/booking.repository.ts` | 新增 3 个查询：预览聚合（GROUP BY 分桶）、不可退明细（限量 200）、可退目标列表 |
| `entities/system-config.entity.ts` | 加 `mpMessageConfigJson` 列（订阅消息开关 + 模板 ID），照抄 noticeConfig 虚拟 getter/setter 模式 |
| `modules/system-config/` | DTO 加 MpMessageConfigDto；加公开子端点 `GET /system-config/mp-message-config-public`（小程序拉模板 ID） |
| `modules/user/user.controller.ts` | 用户侧通知端点：未读列表 / 标记已读 / 未读数（wx-login 响应顺带 unreadCount） |
| `app.module.ts` | 注册新实体与模块 |
| `docs/implementation-todo.md` | 生产环境手工 SQL（两张新表 + system_configs 加列） |

#### API 设计（批量退款，全部 AdminAuthGuard）

```
GET  /admin/batch-refund/preview?bookingDate=YYYY-MM-DD
     → { refundable: {count, totalAmount, peopleCount},
         unrefundable: [{reason, label, count}...],
         detailPreview: [...前200条掩码明细],
         suggestedNotice: {title, content},   # 预填文案
         runningTask: null | {taskId, processed, total} }

POST /admin/batch-refund/execute
     ← { bookingDate, reason, notifyTitle, notifyContent }
     → { taskId, totalTarget, status: 'running' }   # 立即返回
     错误：409 已有任务执行中 / 400 无可退订单

GET  /admin/batch-refund/tasks            # 最近 20 条历史
GET  /admin/batch-refund/tasks/:taskId    # 进度（前端 3s 轮询）
```

#### 执行引擎时序

```
管理员点执行 → INSERT task → 抢占 running → 返回 taskId
→ setImmediate 主循环（逐单）：
    markRefundStarting ── affected=0 → skipped（已被转 completed/并发退款等）
    └─ 成功 → semaphore(5) 调 refund(outTradeNo, RF${bookingId}, amount, amount, {reason})
              → 受理成功 succeeded / throw failed（不回滚，对账 Cron 接管）
    进度计数进独立单写者 FIFO（与微信调用隔离，SQLite 写串行）
→ 主循环完 → 写队列排空 → 等 90s（退款回调窗口）
→ 收尾：
    按 bookings 实际 REFUNDED 汇总 refundedTotalAmount
    → targets 按 openid 去重，批量创建站内通知（一人一条：您有 N 单共 X 元已退款…）
    → 订阅消息（去重，并发 2，43101 静默）
    → markFinished('completed')
→ 退款回调全程随时到达（markRefundSucceeded），与任务互不干扰
```

#### 防重入与恢复

- 同进程：service 内存锁 `runningTaskId` + controller 层 `findLatestRunning()` 双重检查（409）
- 服务重启：任务表保持 running；恢复 Cron（`@Cron('0 11,41 * * * *')`，错开现有任务）发现无内存锁的 running 任务 → 从 targetsJson 筛"仍满足可退条件"的单幂等续跑；卡 REFUNDING 的交给对账 Cron

#### 站内通知设计

- `user_notifications` 以 **openid 为键**（不依赖 users 表外键，历史订单用户未注册 users 也兼容）
- 字段：notificationId(唯一)、wechatOpenId、type（'batch_refund'，留扩展）、title、content、relatedBookingDate、taskId、isRead、readAt
- 批量插入分批 100 条；标记已读用"notificationId + openid"双条件 UPDATE（防越权）
- 内容模板（收尾时按用户聚合）：`您预约 {date} 的 {N} 笔订单共 {X} 元已退款，预计 1-3 个工作日内原路退回。{管理员填写的原因补充}`

#### 订阅消息（WechatMpService）

- `getAccessToken(force?)`：GET /cgi-bin/token（复用 WX_APPID/WX_SECRET 环境变量），进程内缓存（提前 5 分钟过期）+ 单飞刷新（防并发击穿）；不用 stable_token（单实例无必要）
- `sendRefundNotify(openid, page, data)`：POST /cgi-bin/message/subscribe/send；errcode 40001/42001（token 失效）强刷重试一次；43101（未授权）/47003/40003 静默返回 false；**任何情况不抛异常**
- 独立 https.Agent(maxSockets=2)，与支付通道隔离
- 前置：微信公众平台申请"退款通知"一次性订阅模板，模板 ID 配置进 system-config（管理端可改，运营可自助换模板）

### 2.3 管理端（admin）

- **MainLayout 加菜单"批量退款"**（SafetyCertificateOutlined）+ 路由
- **新页面 `src/pages/batch-refund/index.tsx`**：预览区（DatePicker + Statistic 四卡 + 不可退 Alert + Collapse 明细）→ 表单区（原因/通知标题/通知内容，通知文案预填可编辑）→ 执行按钮（红色 + Popconfirm）→ 进度面板（Progress + 计数 + 轮询，>90% 降频 10s）→ 历史任务表
- **系统配置页**加"通知设置"卡片：订阅消息开关 + 退款模板 ID
- 新建 `src/api/batchRefund.ts`（四个接口封装）
- antd 6：Modal 用 `open`；不引入新依赖；页面组件拆分（PreviewPanel / ProgressPanel / HistoryTable）避免单文件膨胀

### 2.4 小程序端（fctl）

- **新建 `utils/subscribe.js`**：拉公开配置拿模板 ID → enabled 才 `uni.requestSubscribeMessage`，全链路 catch 静默（免费单不采集，避免无谓弹窗）
- **授权采集时机**：booking-detail"立即支付"按钮 tap 回调为主（手势链路内最稳）+ `payment.js checkPayStatusOnce` paid 分支为兜底（fire-and-forget）
- **新建 `pages/notifications/notifications.vue`** + pages.json 注册：通知列表，未读在前，"我知道了"调已读接口
- **App.vue onShow**：有 token 时静默拉未读数存 globalData（失败无感）
- **首页 index.vue**：公告轮播条上方加通知条（未读 > 0 时显示），点击跳通知中心

### 2.5 边界情况

| # | 场景 | 行为 |
|---|---|---|
| 1 | 部分成功部分失败 | succeeded/failed/skipped 如实展示；failed 单卡 REFUNDING 由退款对账 Cron 15min 后收敛（NOT_EXIST→failed 可重试 / attempts≥3→异常表人工处理） |
| 2 | 并发点击执行 | DB findLatestRunning 409 + service 内存锁 |
| 3 | 历史日期订单已被每小时 Cron 转 completed | 预览列入"已完成"分桶明示；执行时 markRefundStarting=0 → skipped |
| 4 | isFree / amount=0 | 目标查询排除（isFree=false AND amount>0，微信拒绝 0 元退款单） |
| 5 | 重复执行同一天 | 第二次预览只剩残余可退单；已 REFUNDING/REFUNDED 进不可退分桶；条件 UPDATE 防重复扣款 |
| 6 | 用户自助退款撞上批量 | markRefundStarting 原子互斥，后到者 affected=0 → skipped |
| 7 | 执行中服务重启 | 任务表保持 running；恢复 Cron 30 分钟内幂等续跑；窗口期前端显示进行中 |
| 8 | 退款回调先于计数落库 | 无冲突：回调写 bookings，计数写任务表，两张表互不依赖 |
| 9 | 微信退款网络超时（结果未知） | 保持 REFUNDING + 固定 RF 单号 → 对账 Cron 查证收敛（与单笔退款同语义） |
| 10 | access_token 失效 | 强刷一次重试；再失败静默 |
| 11 | 订阅消息发送失败 | 全静默；不影响退款与任务状态 |
| 12 | 站内通知创建失败 | failureSummary 记录，任务仍 completed；管理员可手动补发 |
| 13 | reason 超 80 字符 | DTO 校验 + 传微信前截断 |
| 14 | 管理员执行中关页面 | 任务后台继续；重开页面通过历史任务/进行中提示续看 |
| 15 | 用户不点"我知道了" | 未读持续保留，不强制消费 |

### 2.6 性能与容量估算

- 1500 单 × 每单约 300-500ms（并发 5）≈ **8-12 分钟**跑完，符合"轮询看进度"预期
- 进度计数每单一次单行 UPDATE（SQLite 微秒级），无压力
- 站内通知：1500 单 → 按 openid 去重后约 1000+ 条插入，分批 100 条 × 10 批
- SQLite 全程无长事务（单写者 FIFO 模式），不影响在线业务

## 三、实施顺序（每步独立可验证）

| 步骤 | 内容 | 验证方式 |
|---|---|---|
| 1 | 站内通知底座（实体/仓储/端点/小程序通知中心） | 独立可先上线积累能力 |
| 2 | `refund()` 加 reason 参数 | 单笔退款回归 |
| 3 | 任务实体 + system-config 加列 + 生产 SQL 文档 | dev 启动建表验证 |
| 4 | 预览接口 | curl 对比订单页筛选结果 |
| 5 | 执行引擎 + 进度端点 + 恢复 Cron | 测试库造数（含异常单）验证流转；kill 进程验证恢复 |
| 6 | 收尾链路（金额汇总 + 站内通知 + 订阅消息） | 任务收尾后通知落库 |
| 7 | WechatMpService（token + 发送） | 测试号模板自测 |
| 8 | admin 前端（批量退款页 + 配置卡片） | dev 联调全流程 |
| 9 | fctl 授权采集 + 首页通知条 | 支付授权弹窗 → 退款收消息 |

**前置条件**：微信公众平台申请"退款通知"订阅消息模板（拿模板 ID）；生产库执行手工 SQL。

依赖链：2→5、3→4、3→5、5→6、7→6、6→8、7→9；步骤 1 独立；8/9 可并行。
