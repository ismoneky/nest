# 接口文档


## 项目概述

本项目是一个基于 NestJS 框架的后端服务，主要提供以下功能模块：
- 管理员管理
- 公告管理
- 预约订单管理（含微信支付）
- 系统配置管理
- 用户管理

## 基础信息

- 接口基础路径：`/`
- 请求/响应格式：JSON
- 成功响应结构：
  ```json
  {
    "success": true,
    "message": "操作成功",
    "data": {...}
  }
  ```
- 失败响应结构：
  ```json
  {
    "success": false,
    "message": "操作失败",
    "error": "错误详情"
  }
  ```

---

## 认证说明

### 用户认证（JWT Bearer Token）

用户通过 `POST /users/wx-login` 登录后获取 JWT Token，后续需要认证的接口需在请求头中携带：

```
Authorization: Bearer <token>
```

Token 有效期为 **30 天**，过期后需重新登录。

### 管理员认证（API Key）

管理员通过 `POST /admin/login` 登录后获取 API Key，管理员接口需在请求头中携带：

```
x-admin-key: <apiKey>
```

---

## 模块接口

### 1. 用户模块

#### 1.1 微信小程序登录

**接口路径**：`POST /users/wx-login`

**说明**：使用微信小程序 `wx.login()` 获取的临时 `code`，换取后端签发的 JWT Token。若用户不存在则自动注册。

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| code | string | 是 | 微信小程序登录临时码 |

**请求示例**：
```json
{
  "code": "01123456789abcdef"
}
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**说明**：
- `token` 为 JWT，有效期 30 天
- 后续所有需要用户身份的接口均需在请求头携带 `Authorization: Bearer <token>`
- Token payload 包含 `openid` 和 `userId`，后端自动从 Token 中获取用户身份，无需前端额外传递

---

### 2. 管理员模块

#### 2.1 管理员登录

**接口路径**：`POST /admin/login`

**说明**：管理员登录，返回 API Key 用于后续管理员接口认证。

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| username | string | 是 | 用户名 |
| password | string | 是 | 密码 |

**请求示例**：
```json
{
  "username": "admin",
  "password": "password123"
}
```

**响应示例**：
```json
{
  "success": true,
  "message": "登录成功",
  "data": {
    "username": "admin",
    "name": "管理员",
    "apiKey": "your-admin-api-key"
  }
}
```

**说明**：
- 登录成功后返回 `apiKey`，后续管理员接口需在请求头携带 `x-admin-key: <apiKey>`
- API Key 无过期时间，服务端重启后仍有效（由环境变量 `ADMIN_API_KEY` 控制）

---

### 3. 公告模块

#### 3.1 创建公告（需要管理员权限）

**接口路径**：`POST /announcements`

**请求头**：`x-admin-key: <apiKey>`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| title | string | 是 | 公告标题 |
| content | string | 是 | 公告内容 |
| isActive | boolean | 否 | 是否启用（默认 true） |
| sortOrder | number | 否 | 排序顺序（默认 0） |

**响应示例**：
```json
{
  "success": true,
  "message": "创建成功",
  "data": {
    "id": "1",
    "title": "系统维护通知",
    "content": "系统将于2024年5月1日进行维护",
    "isActive": true,
    "sortOrder": 1,
    "createdAt": "2024-04-20T10:00:00.000Z",
    "updatedAt": "2024-04-20T10:00:00.000Z"
  }
}
```

#### 3.2 查询所有公告（需要管理员权限）

**接口路径**：`GET /announcements/admin/all`

**请求头**：`x-admin-key: <apiKey>`

#### 3.3 查询启用的公告（无需权限）

**接口路径**：`GET /announcements`

#### 3.4 更新公告（需要管理员权限）

**接口路径**：`PUT /announcements/:id`

**请求头**：`x-admin-key: <apiKey>`

#### 3.5 删除公告（需要管理员权限）

**接口路径**：`DELETE /announcements/:id`

**请求头**：`x-admin-key: <apiKey>`

---

### 4. 预约订单模块

#### 4.1 创建预约订单

**接口路径**：`POST /bookings`

**请求头**：`Authorization: Bearer <token>`

**说明**：创建订单后状态为 `pending`（待支付），需在 30 分钟内完成支付，否则订单自动取消。

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| name | string | 是 | 联系人姓名 |
| phone | string | 是 | 联系人手机号（1开头11位） |
| idCard | string | 是 | 联系人身份证号（18位） |
| bookingDate | string | 是 | 预约日期（格式：YYYY-MM-DD） |
| timeSlot | string | 是 | 预约时间段（`morning` / `afternoon`） |
| travelMode | string | 是 | 出行方式（`scenicBus` / `selfDriving` / `tourGroup`） |
| licensePlate | string | 条件必填 | 车牌号（自驾时必填） |
| vehicleType | string | 条件必填 | 车辆类型（自驾时必填） |
| tourGroupName | string | 条件必填 | 旅游团名称（旅游团时必填） |
| tourOrderNumber | string | 条件必填 | 旅游团订单编号（旅游团时必填） |
| personCount | number | 是 | 预约人数（≥1） |
| remarks | string | 否 | 备注信息 |

> **注意**：无需传递 `wechatOpenId`，后端从 JWT Token 中自动获取用户身份。

**请求示例**：
```json
{
  "name": "张三",
  "phone": "13800138000",
  "idCard": "110101199001011234",
  "bookingDate": "2024-05-01",
  "timeSlot": "morning",
  "travelMode": "selfDriving",
  "licensePlate": "京A12345",
  "vehicleType": "smallCar",
  "personCount": 2,
  "remarks": "带小孩"
}
```

**响应示例**：
```json
{
  "success": true,
  "message": "Booking created successfully",
  "data": {
    "bookingId": "123e4567-e89b-12d3-a456-426614174000",
    "name": "张三",
    "phone": "13800138000",
    "bookingDate": "2024-05-01",
    "timeSlot": "morning",
    "status": "pending",
    "paymentStatus": "unpaid",
    "amount": 20000,
    "paymentExpiredAt": "2024-04-20T10:30:00.000Z",
    "createdAt": "2024-04-20T10:00:00.000Z"
  }
}
```

**校验逻辑**：
- 检查系统配置是否开放预约
- 检查预约时间是否晚于当前时间（上午场截止北京时间 12:00，下午场截止 18:00）
- 检查该时间段剩余名额是否充足
- 支付金额由系统配置决定，单位为分

**可能的错误**：
- `预约功能暂未开放` — 系统配置关闭了预约
- `预约时间必须晚于当前时间` — 时间已过
- `该时间段预约人数已达上限，当前剩余名额：N` — 名额不足

#### 4.2 查询订单列表（分页）

**接口路径**：`GET /bookings`

**请求头**：`Authorization: Bearer <token>`

**说明**：只返回当前登录用户自己的订单。

**查询参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| page | number | 否 | 页码（默认 1） |
| pageSize | number | 否 | 每页数量（默认 10） |
| bookingDate | string | 否 | 预约日期（格式：YYYY-MM-DD） |
| timeSlot | string | 否 | 预约时间段（`morning` / `afternoon`） |
| status | string | 否 | 订单状态 |

> **注意**：无需传递 `wechatOpenId`，后端从 JWT Token 中自动过滤当前用户的订单。

**响应示例**：
```json
{
  "success": true,
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 5,
    "totalPages": 1
  }
}
```

#### 4.3 统计指定日期的预约人数（无需权限）

**接口路径**：`GET /bookings/stats/by-date`

**查询参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| bookingDate | string | 是 | 预约日期（格式：YYYY-MM-DD） |

**响应示例**：
```json
{
  "success": true,
  "data": {
    "morning": {
      "totalPeople": 20,
      "bookingCount": 10
    },
    "afternoon": {
      "totalPeople": 15,
      "bookingCount": 8
    }
  }
}
```

#### 4.4 根据订单ID查询订单详情

**接口路径**：`GET /bookings/:bookingId`

**请求头**：`Authorization: Bearer <token>`

**说明**：只能查询自己的订单，查询他人订单返回 403。

**响应示例**：
```json
{
  "success": true,
  "data": {
    "bookingId": "123e4567-e89b-12d3-a456-426614174000",
    "name": "张三",
    "phone": "13800138000",
    "idCard": "110101199001011234",
    "bookingDate": "2024-05-01",
    "timeSlot": "morning",
    "travelMode": "selfDriving",
    "licensePlate": "京A12345",
    "vehicleType": "smallCar",
    "personCount": 2,
    "remarks": "带小孩",
    "status": "confirmed",
    "paymentStatus": "paid",
    "refundStatus": "none",
    "amount": 20000,
    "transactionId": "4200001234567890",
    "paidAt": "2024-04-20T10:05:00.000Z",
    "createdAt": "2024-04-20T10:00:00.000Z",
    "updatedAt": "2024-04-20T10:05:00.000Z"
  }
}
```

#### 4.5 更新预约订单（管理员）

**接口路径**：`PUT /bookings/:bookingId`

**请求头**：`x-admin-key: <apiKey>`

#### 4.6 删除预约订单（管理员）

**接口路径**：`DELETE /bookings/:bookingId`

**请求头**：`x-admin-key: <apiKey>`

---

### 5. 支付模块

#### 完整支付流程

```
前端小程序                    后端服务                    微信支付平台
    |                            |                              |
    |--- POST /bookings -------->|                              |
    |<-- 返回 bookingId ---------|                              |
    |                            |                              |
    |--- POST /bookings/:id/pay->|                              |
    |                            |--- 调用微信下单 API -------->|
    |                            |<-- 返回 prepay_id -----------|
    |                            |--- 后端用私钥签名 paySign    |
    |<-- 返回支付参数 ------------|                              |
    |                            |                              |
    |--- wx.requestPayment() --->|（微信客户端直接与微信支付交互）|
    |<-- 支付成功/失败回调 -------|                              |
    |                            |                              |
    |（支付成功后开始轮询）        |<-- POST /wechat-pay/notify --|
    |--- GET /bookings/:id/pay-status ->|                       |
    |<-- 返回支付状态 ------------|                              |
```

#### 5.1 发起支付

**接口路径**：`POST /bookings/:bookingId/pay`

**请求头**：`Authorization: Bearer <token>`

**说明**：
- 后端调用微信 JSAPI 下单接口，生成 `prepay_id`
- 后端用商户私钥对支付参数进行 RSA-SHA256 签名
- 返回完整支付参数，前端直接传给 `wx.requestPayment()` 即可

**响应示例**：
```json
{
  "success": true,
  "message": "Payment initiated successfully",
  "data": {
    "outTradeNo": "1234567890123456789abcd",
    "appId": "wx1234567890123456",
    "timeStamp": "1618789200",
    "nonceStr": "5k8264iltkch16cq",
    "package": "prepay_id=wx201410272009395522657a690389285100",
    "signType": "RSA",
    "paySign": "oR9d8PuhnIc+YZ8cBHFCwfgpaK9gd7vaRvkYD7rthRAZ..."
  }
}
```

**前端调用示例**：
```javascript
// 1. 调用后端发起支付接口
const res = await request('POST', `/bookings/${bookingId}/pay`);
const { appId, timeStamp, nonceStr, package: pkg, signType, paySign } = res.data;

// 2. 直接将后端返回的参数传给 wx.requestPayment
wx.requestPayment({
  appId,
  timeStamp,
  nonceStr,
  package: pkg,
  signType,
  paySign,
  success: () => {
    // 支付成功，开始轮询支付状态
    startPollingPaymentStatus(bookingId);
  },
  fail: (err) => {
    console.error('支付失败', err);
  }
});
```

**校验逻辑**：
- 订单必须属于当前用户
- 订单状态不能为已取消
- 支付状态必须为 `unpaid`（未支付）
- 支付超时时间未过

#### 5.2 查询支付状态

**接口路径**：`GET /bookings/:bookingId/pay-status`

**说明**：
- 若本地记录已支付，直接返回
- 若本地未支付但存在微信订单号，主动向微信查询并同步状态（兜底机制）

**响应示例（已支付）**：
```json
{
  "success": true,
  "data": {
    "status": "paid",
    "paidAt": "2024-04-20T10:05:00.000Z",
    "transactionId": "4200001234567890"
  }
}
```

**响应示例（未支付）**：
```json
{
  "success": true,
  "data": {
    "status": "paying"
  }
}
```

**前端轮询建议**：

```javascript
function startPollingPaymentStatus(bookingId) {
  let retries = 0;
  const MAX_RETRIES = 5;
  const INTERVAL = 3000; // 3秒

  const timer = setInterval(async () => {
    retries++;
    const res = await request('GET', `/bookings/${bookingId}/pay-status`);

    if (res.data.status === 'paid') {
      clearInterval(timer);
      // 支付成功，跳转到成功页
      navigateToSuccess();
    } else if (retries >= MAX_RETRIES) {
      clearInterval(timer);
      // 超过最大重试次数，提示用户手动刷新
      showMessage('支付状态确认中，请稍后刷新页面查看');
    }
  }, INTERVAL);
}
```

> **说明**：前端 `wx.requestPayment` 的 `success` 回调不可完全信赖（可能因网络问题不触发），以后端实际支付状态为准。轮询建议在进入订单详情页时也开启（非仅支付回调后）。

#### 5.3 申请退款

**接口路径**：`POST /bookings/:bookingId/refund`

**请求头**：`Authorization: Bearer <token>`

**说明**：
- 订单必须属于当前用户
- 支付状态必须为 `paid`
- 退款状态必须为 `none`（未申请过退款）
- 退款结果通过微信异步回调通知（`POST /wechat-pay/refund-notify`）

**响应示例**：
```json
{
  "success": true,
  "message": "Refund initiated successfully",
  "data": {
    "refund_id": "50000000000000000001",
    "out_refund_no": "REFUND_1234567890123_1618789200000",
    "status": "PROCESSING"
  }
}
```

---

### 6. 微信支付回调（内部接口，由微信服务器调用）

> 以下接口不对外暴露，由微信支付平台主动回调，需在微信商户平台配置回调地址。

#### 6.1 支付结果通知

**接口路径**：`POST /wechat-pay/notify`

**说明**：
- 微信支付平台在用户支付成功后回调此接口
- 后端验证签名并解密回调数据
- 支付成功时：`paymentStatus → paid`，`bookingStatus → confirmed`
- 必须在 5 秒内响应 `{ "code": "SUCCESS" }`，否则微信会重试

#### 6.2 退款结果通知

**接口路径**：`POST /wechat-pay/refund-notify`

**说明**：
- 微信支付平台在退款处理完成后回调此接口
- 退款成功时：`refundStatus → refunded`，`bookingStatus → refunded`
- 退款失败时：`refundStatus → failed`，`paymentStatus → failed`

---

### 7. 系统配置模块

#### 7.1 获取系统配置（无需权限）

**接口路径**：`GET /system-config`

**响应示例**：
```json
{
  "success": true,
  "data": {
    "bookingEnabled": true,
    "bookingDisabledMessage": "当前时间段暂不开放预约，请稍后再试",
    "banners": [],
    "timeSlotLimit": {
      "morningMaxPeople": 100,
      "afternoonMaxPeople": 100
    },
    "paymentConfig": {
      "paymentAmount": 100
    }
  }
}
```

#### 7.2 更新系统配置（需要管理员权限）

**接口路径**：`PUT /system-config`

**请求头**：`x-admin-key: <apiKey>`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| bookingEnabled | boolean | 否 | 是否允许预约 |
| bookingDisabledMessage | string | 否 | 禁止预约时的展示文案 |
| banners | array | 否 | 轮播图配置 |
| timeSlotLimit | object | 否 | 时间段预约人数限制 |
| paymentConfig | object | 否 | 支付配置（`paymentAmount` 单位：元） |

**请求示例**：
```json
{
  "bookingEnabled": true,
  "timeSlotLimit": {
    "morningMaxPeople": 60,
    "afternoonMaxPeople": 60
  },
  "paymentConfig": {
    "paymentAmount": 100
  }
}
```

#### 7.3 获取是否允许预约（无需权限）

**接口路径**：`GET /system-config/booking-enabled`

#### 7.4 获取时间段预约人数限制（无需权限）

**接口路径**：`GET /system-config/time-slot-limit`

#### 7.5 获取支付配置（无需权限）

**接口路径**：`GET /system-config/payment-config`

---

## 数据类型定义

### TimeSlot 枚举
| 值 | 描述 |
| --- | --- |
| `morning` | 上午场（截止北京时间 12:00） |
| `afternoon` | 下午场（截止北京时间 18:00） |

### TravelMode 枚举
| 值 | 描述 |
| --- | --- |
| `scenicBus` | 景区大巴 |
| `selfDriving` | 自驾 |
| `tourGroup` | 旅游团 |

### VehicleType 枚举
| 值 | 描述 |
| --- | --- |
| `smallCar` | 小型车 |
| `mediumCar` | 中型车 |
| `largeCar` | 大型车 |

### BookingStatus 枚举（订单状态）
| 值 | 描述 |
| --- | --- |
| `pending` | 待支付（订单已创建，等待支付） |
| `confirmed` | 已确认（支付成功，预约生效） |
| `completed` | 已完成（游览结束） |
| `cancelled` | 已取消（支付超时或手动取消） |
| `refunded` | 已退款 |

### PaymentStatus 枚举（支付状态）
| 值 | 描述 |
| --- | --- |
| `unpaid` | 未支付 |
| `paying` | 支付中（已发起微信下单，等待用户付款） |
| `paid` | 已支付 |
| `refunding` | 退款中 |
| `refunded` | 已退款 |
| `failed` | 支付/退款失败 |

### RefundStatus 枚举（退款状态）
| 值 | 描述 |
| --- | --- |
| `none` | 无（未申请退款） |
| `refunding` | 退款中 |
| `refunded` | 已退款 |
| `failed` | 退款失败 |

---

## 错误码说明

| HTTP 状态码 | 描述 |
| --- | --- |
| 400 | 请求参数错误或业务校验失败 |
| 401 | 未授权（Token 无效或未携带） |
| 403 | 禁止访问（无权操作该资源） |
| 404 | 资源不存在 |
| 500 | 服务器内部错误 |

---

## 环境变量配置

### 基础配置
| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `PORT` | 服务端口 | `3000` |
| `JWT_SECRET` | JWT 签名密钥（建议 64 位随机字符串） | `your-secret-key` |
| `ADMIN_API_KEY` | 管理员 API Key | `your-admin-api-key` |

### 微信小程序配置
| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `WX_APPID` | 微信小程序 AppID | `wx1234567890123456` |
| `WX_APP_SECRET` | 微信小程序 AppSecret | `your-app-secret` |

### 微信支付配置
| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `WX_MCHID` | 微信支付商户号 | `1234567890` |
| `WX_PRIVATE_KEY_PATH` | 商户私钥文件路径（相对项目根目录） | `cert/apiclient_key.pem` |
| `WX_SERIAL_NO` | 商户证书序列号 | `1234567890ABCDEF` |
| `WX_API_V3_KEY` | 微信支付 API v3 密钥（32位） | `your-32-char-api-v3-key` |

### API 地址配置（用于微信回调地址）
| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `API_PROTOCOL` | 协议（http/https） | `https` |
| `API_HOST` | 域名或 IP | `example.com` |

**注意**：
- 商户私钥文件 `apiclient_key.pem` 需放在项目根目录的 `cert/` 文件夹中
- `WX_API_V3_KEY` 需在微信支付商户平台设置，长度固定为 32 位
- 微信回调地址需为公网可访问的 HTTPS 地址，需在微信商户平台配置

---

## 开发环境启动

```bash
cp .env.example .env
# 编辑 .env 填写配置
npm install
npm run start:dev
```

## 生产环境部署

```bash
npm install
npm run build
npm run start:prod
```
