# 管理端单笔退款 — 产品与技术方案

> 状态：方案设计（未实施）
> 日期：2026-08-16
> 说明：本方案独立于批量退款方案（见 `batch-refund-design.md`，两者互不影响）。本期优先实施本方案。

---

## 一、产品方案

### 1.1 场景

用户因天气/行程变化无法出行但不会自己操作退款，或客服接到投诉需当场处理时，管理员在后台订单列表里**替用户发起退款**。

现状：退款能力只有小程序用户自助（booking-detail 页"申请退款"→ `POST /bookings/:bookingId/refund`，JwtAuthGuard + 归属校验）；管理端订单页只有"详情"按钮，**没有任何退款入口**。

### 1.2 交互设计

订单查询页（orders）**详情弹窗底部**加"退款"按钮（不放列表操作列——资金类低频操作，在详情里看清完整信息再动手更稳）：

```
┌─ 订单详情 Modal ──────────────────────────┐
│  商户订单号 / 姓名 / 手机号 / 身份证        │
│  预约日期 / 人数 / 金额 / 状态 …            │
│                                            │
│  ┌─ 退款区域（仅满足条件时显示）──────────┐  │
│  │ 退款原因（选填输入框）                  │  │
│  │ [退款] 红色按钮 + Popconfirm：          │  │
│  │   "确认对订单 TLxxx 退款 ¥xx.xx？"      │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

**按钮显示条件**（与后端退款条件一致，所见即所能做）：

```
status === 'confirmed' && paymentStatus === 'paid'
&& refundStatus ∈ ('none', 'failed') && !isFree
```

其他状态（退款中/已退款/已完成/免费单）只展示对应 Tag，不渲染按钮。

### 1.3 退款原因

本次**选填、纯记录**：写入 app_logs 操作日志（客服场景"用户电话要求退款"这类原因留痕），不透传微信。透传微信 reason 字段留作增强项。

### 1.4 退款后反馈

- **成功**：message 提示"退款申请已提交，1-3 个工作日内原路退回"，刷新列表与详情
- **失败**：展示后端具体错误（"订单已完成，无法退款"/"退款处理中，请勿重复提交"等）
- **用户侧感知**：微信支付原生退款通知（APIv3 退款自带，零开发）

### 1.5 权限

复用现有 AdminAuthGuard 登录态（已确认不做单独角色）。退款走现有 initiateRefund 的 PAYMENT 日志，天然操作留痕，日志 context 中区分 `asAdmin: true`。

---

## 二、技术方案

### 2.1 核心思路

**后端把现有 `initiateRefund` 开放一个管理员入口，复用全部退款状态机，不新建退款逻辑。**

现有链路（`booking.service.ts` L1032-1110）已完备：

1. 归属校验 `booking.wechatOpenId === openid`（L1038）← 管理员不满足，需绕过
2. isFree / COMPLETED / PAID / REFUNDED / REFUNDING 前置校验
3. `markRefundStarting` 条件 UPDATE（原子防并发：与用户自助退款、对账 Cron 三方互斥）
4. `refund()` 调微信；失败不回滚 REFUNDING，退款对账 Cron（每 15 分钟）接管
5. 退款回调 `markRefundSucceeded` 落终态

### 2.2 后端改动（nest，3 处）

**1. `src/modules/booking/booking.service.ts`**

```typescript
async initiateRefund(bookingId: string, openid: string, opts?: { asAdmin?: boolean })
```

- `asAdmin=true` 跳过归属校验，其余校验、状态机、时序、日志完全不变
- 日志 context 加 `asAdmin: true` 便于审计

**2. `src/modules/admin/admin.controller.ts`** — 新端点：

```
POST /admin/bookings/:bookingId/refund
Body: { reason?: string }     // 选填，≤80 字
Guard: AdminAuthGuard
```

- 调 `bookingService.initiateRefund(bookingId, '', { asAdmin: true })`
- reason 写入 app_logs（PAYMENT 分类，context 含 reason + bookingId）
- 模块零改动：admin.module.ts 已 imports BookingModule（L10）

**3. DTO** — AdminRefundDto（reason 可选字符串，≤80 字）

### 2.3 前端改动（admin，2 处）

**1. API 封装**（`src/api/` 下新建或并入 bookings.ts）：`adminRefundBooking(bookingId, reason?)`

**2. `src/pages/orders/index.tsx`** — 详情 Modal 加退款区域：

- 按 1.2 显示条件渲染：退款原因 Input + 退款 Button(danger)
- Popconfirm 二次确认（含订单号与金额）
- 提交 → loading → 成功 message + 刷新表格与详情；失败 message.error(后端 message)
- 状态 Tag 已有（STATUS_MAP / refundStatus），无需新增

### 2.4 边界情况

| 场景 | 行为 |
|---|---|
| 管理员与用户同时发起退款 | markRefundStarting 条件 UPDATE 原子互斥，后到者 affected=0 → 明确报错 |
| 订单已被每小时 Cron 转 completed | WHERE status=confirmed 返回 0 → "订单状态不允许退款" |
| 微信退款调用失败/超时 | 订单保持 REFUNDING，对账 Cron 15min 内接管收敛（现有机制，零新增） |
| 免费单 / 未支付 / 已退款 / 退款中 | 前置校验拦截返回明确文案；前端按钮不渲染 |
| 重复点击 | 按钮 loading + 后端状态机双保险 |

### 2.5 验证

- 后端：`npm run build`；curl 覆盖正常单 / completed 单 / refunding 单 / 免费单
- 回归：小程序用户自助退款不受影响（openid 传参路径不变）
- 前端：`npm run build` + dev 联调详情弹窗退款全流程
- 并发：同一单同时以用户和管理员身份发起，验证只一方成功

### 2.6 工作量

后端约 30 行（service 5 行 + controller 20 行 + DTO），前端约 60 行。半天可完成上线。
