# 接口文档

## 项目概述

本项目是一个基于 NestJS 框架的后端服务，主要提供以下功能模块：
- 管理员管理
- 公告管理
- 预约订单管理
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
    "error": {...}
  }
  ```

## 模块接口

### 1. 管理员模块

#### 1.1 管理员登录

**接口路径**：`POST /admin/login`

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
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "1",
      "username": "admin"
    }
  }
}
```

### 2. 公告模块

#### 2.1 创建公告（需要管理员权限）

**接口路径**：`POST /announcements`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| title | string | 是 | 公告标题 |
| content | string | 是 | 公告内容 |
| isActive | boolean | 否 | 是否启用（默认true） |
| sortOrder | number | 否 | 排序顺序（默认0） |

**请求示例**：
```json
{
  "title": "系统维护通知",
  "content": "系统将于2024年5月1日进行维护",
  "isActive": true,
  "sortOrder": 1
}
```

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

#### 2.2 查询所有公告（需要管理员权限）

**接口路径**：`GET /announcements/admin/all`

**响应示例**：
```json
{
  "success": true,
  "data": [
    {
      "id": "1",
      "title": "系统维护通知",
      "content": "系统将于2024年5月1日进行维护",
      "isActive": true,
      "sortOrder": 1,
      "createdAt": "2024-04-20T10:00:00.000Z",
      "updatedAt": "2024-04-20T10:00:00.000Z"
    }
  ]
}
```

#### 2.3 查询启用的公告（无需权限）

**接口路径**：`GET /announcements`

**响应示例**：
```json
{
  "success": true,
  "data": [
    {
      "id": "1",
      "title": "系统维护通知",
      "content": "系统将于2024年5月1日进行维护",
      "isActive": true,
      "sortOrder": 1,
      "createdAt": "2024-04-20T10:00:00.000Z",
      "updatedAt": "2024-04-20T10:00:00.000Z"
    }
  ]
}
```

#### 2.4 更新公告（需要管理员权限）

**接口路径**：`PUT /announcements/:id`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| title | string | 否 | 公告标题 |
| content | string | 否 | 公告内容 |
| isActive | boolean | 否 | 是否启用 |
| sortOrder | number | 否 | 排序顺序 |

**请求示例**：
```json
{
  "title": "系统维护通知（更新）",
  "content": "系统将于2024年5月1日进行维护，预计持续4小时",
  "isActive": true
}
```

**响应示例**：
```json
{
  "success": true,
  "message": "更新成功",
  "data": {
    "id": "1",
    "title": "系统维护通知（更新）",
    "content": "系统将于2024年5月1日进行维护，预计持续4小时",
    "isActive": true,
    "sortOrder": 1,
    "createdAt": "2024-04-20T10:00:00.000Z",
    "updatedAt": "2024-04-20T11:00:00.000Z"
  }
}
```

#### 2.5 删除公告（需要管理员权限）

**接口路径**：`DELETE /announcements/:id`

**响应示例**：
```json
{
  "success": true,
  "message": "删除成功"
}
```

### 3. 预约订单模块

#### 3.1 创建预约订单

**接口路径**：`POST /bookings`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| wechatOpenId | string | 是 | 微信用户OpenID |
| name | string | 是 | 联系人姓名 |
| phone | string | 是 | 联系人手机号（格式：1开头的11位数字） |
| idCard | string | 是 | 联系人身份证号（18位） |
| bookingDate | string | 是 | 预约日期（格式：YYYY-MM-DD） |
| timeSlot | string | 是 | 预约时间段（morning/afternoon） |
| travelMode | string | 是 | 出行方式（scenicBus/selfDriving/tourGroup） |
| licensePlate | string | 否 | 车牌号（自驾时必填） |
| vehicleType | string | 否 | 车辆类型（自驾时必填） |
| tourGroupName | string | 否 | 旅游团名称（旅游团时必填） |
| tourOrderNumber | string | 否 | 旅游团订单编号（旅游团时必填） |
| personCount | number | 是 | 预约人数（≥1） |
| remarks | string | 否 | 备注信息 |

**请求示例**：
```json
{
  "wechatOpenId": "o123456789",
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
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "wechatOpenId": "o123456789",
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
    "status": "pending_payment",
    "createdAt": "2024-04-20T10:00:00.000Z",
    "updatedAt": "2024-04-20T10:00:00.000Z"
  }
}
```

**二次校验逻辑**：
- 检查是否允许预约（从系统配置中获取）
- 检查预约时间是否晚于当前时间
- 检查预约人数是否超过系统配置的限制
- 检查支付金额是否正确（从系统配置中获取）

**可能的错误响应**：
- 预约未开放：`{"success": false, "message": "当前时间段暂不开放预约，请稍后再试"}`
- 预约时间已过：`{"success": false, "message": "预约时间必须晚于当前时间"}`
- 预约人数超过限制：`{"success": false, "message": "该时间段预约人数已达上限，当前剩余名额：0"}`

#### 3.2 查询订单列表（分页）

**接口路径**：`GET /bookings`

**查询参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| page | number | 否 | 页码（默认1） |
| pageSize | number | 否 | 每页数量（默认10） |
| wechatOpenId | string | 否 | 微信用户OpenID |
| bookingDate | string | 否 | 预约日期（格式：YYYY-MM-DD） |
| timeSlot | string | 否 | 预约时间段（morning/afternoon） |
| status | string | 否 | 订单状态 |

**响应示例**：
```json
{
  "success": true,
  "data": [
    {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "wechatOpenId": "o123456789",
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
      "status": "pending",
      "createdAt": "2024-04-20T10:00:00.000Z",
      "updatedAt": "2024-04-20T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 1,
    "totalPages": 1
  }
}
```

#### 3.3 统计指定日期的预约人数

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
    "morning": 10,
    "afternoon": 15,
    "total": 25
  }
}
```

#### 3.4 根据订单ID查询订单详情

**接口路径**：`GET /bookings/:bookingId`

**响应示例**：
```json
{
  "success": true,
  "data": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "wechatOpenId": "o123456789",
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
    "status": "pending",
    "createdAt": "2024-04-20T10:00:00.000Z",
    "updatedAt": "2024-04-20T10:00:00.000Z"
  }
}
```

#### 3.5 更新预约订单

**接口路径**：`PUT /bookings/:bookingId`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| name | string | 否 | 联系人姓名 |
| phone | string | 否 | 联系人手机号 |
| idCard | string | 否 | 联系人身份证号 |
| bookingDate | string | 否 | 预约日期 |
| timeSlot | string | 否 | 预约时间段 |
| travelMode | string | 否 | 出行方式 |
| licensePlate | string | 否 | 车牌号 |
| vehicleType | string | 否 | 车辆类型 |
| tourGroupName | string | 否 | 旅游团名称 |
| tourOrderNumber | string | 否 | 旅游团订单编号 |
| personCount | number | 否 | 预约人数 |
| remarks | string | 否 | 备注信息 |
| status | string | 否 | 订单状态 |

**请求示例**：
```json
{
  "personCount": 3,
  "remarks": "带两个小孩"
}
```

**响应示例**：
```json
{
  "success": true,
  "message": "Booking updated successfully",
  "data": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "wechatOpenId": "o123456789",
    "name": "张三",
    "phone": "13800138000",
    "idCard": "110101199001011234",
    "bookingDate": "2024-05-01",
    "timeSlot": "morning",
    "travelMode": "selfDriving",
    "licensePlate": "京A12345",
    "vehicleType": "smallCar",
    "personCount": 3,
    "remarks": "带两个小孩",
    "status": "pending",
    "createdAt": "2024-04-20T10:00:00.000Z",
    "updatedAt": "2024-04-20T11:00:00.000Z"
  }
}
```

#### 3.6 删除预约订单

**接口路径**：`DELETE /bookings/:bookingId`

**响应示例**：
```json
{
  "success": true,
  "message": "Booking deleted successfully"
}
```

#### 3.7 发起支付

**接口路径**：`POST /bookings/:bookingId/pay`

**响应示例**：
```json
{
  "success": true,
  "message": "Payment initiated successfully",
  "data": {
    "outTradeNo": "BOOKING_TL12345678901_1618789200_abcdefgh",
    "prepayId": "wx1234567890123456",
    "timestamp": "1618789200",
    "nonceStr": "abcdefghijklmnopqrstuvwxyz"
  }
}
```

#### 3.8 查询支付状态

**接口路径**：`GET /bookings/:bookingId/pay-status`

**响应示例**：
```json
{
  "success": true,
  "data": {
    "status": "paid",
    "paidAt": "2024-04-20T10:30:00.000Z",
    "transactionId": "4200001234567890"
  }
}
```

#### 3.9 申请退款

**接口路径**：`POST /bookings/:bookingId/refund`

**响应示例**：
```json
{
  "success": true,
  "message": "Refund initiated successfully",
  "data": {
    "refund_id": "5000000000000000",
    "out_refund_no": "REFUND_TL12345678901_1618789200",
    "out_trade_no": "BOOKING_TL12345678901_1618789200_abcdefgh",
    "transaction_id": "4200001234567890",
    "refund_status": "PROCESSING"
  }
}
```

### 4. 系统配置模块

#### 4.1 获取系统配置

**接口路径**：`GET /system-config`

**响应示例**：
```json
{
  "success": true,
  "data": {
    "id": "1",
    "bookingEnabled": true,
    "bookingDisabledMessage": "当前时间段暂不开放预约，请稍后再试",
    "banners": [],
    "timeSlotLimit": {
      "morningMaxPeople": 100,
      "afternoonMaxPeople": 100
    },
    "paymentConfig": {
      "paymentAmount": 0
    },
    "createdAt": "2024-04-01T00:00:00.000Z",
    "updatedAt": "2024-04-01T00:00:00.000Z"
  }
}
```

#### 4.2 更新系统配置（管理员）

**接口路径**：`PUT /system-config`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| bookingEnabled | boolean | 否 | 是否允许预约 |
| bookingDisabledMessage | string | 否 | 禁止预约时的展示文案 |
| banners | array | 否 | 轮播图配置 |
| timeSlotLimit | object | 否 | 时间段预约人数限制 |
| paymentConfig | object | 否 | 支付配置 |

**请求示例**：
```json
{
  "bookingEnabled": true,
  "bookingDisabledMessage": "当前时间段暂不开放预约，请稍后再试",
  "timeSlotLimit": {
    "morningMaxPeople": 60,
    "afternoonMaxPeople": 60
  },
  "paymentConfig": {
    "paymentAmount": 50
  }
}
```

**响应示例**：
```json
{
  "success": true,
  "message": "系统配置更新成功",
  "data": {
    "id": "1",
    "bookingEnabled": true,
    "bookingDisabledMessage": "当前时间段暂不开放预约，请稍后再试",
    "banners": [],
    "timeSlotLimit": {
      "morningMaxPeople": 60,
      "afternoonMaxPeople": 60
    },
    "paymentConfig": {
      "paymentAmount": 50
    },
    "createdAt": "2024-04-01T00:00:00.000Z",
    "updatedAt": "2024-04-20T10:00:00.000Z"
  }
}
```

#### 4.3 获取是否允许预约

**接口路径**：`GET /system-config/booking-enabled`

**响应示例**：
```json
{
  "success": true,
  "data": {
    "bookingEnabled": true
  }
}
```

#### 4.4 获取时间段预约人数限制

**接口路径**：`GET /system-config/time-slot-limit`

**响应示例**：
```json
{
  "success": true,
  "data": {
    "morningMaxPeople": 100,
    "afternoonMaxPeople": 100
  }
}
```

#### 4.5 获取支付配置

**接口路径**：`GET /system-config/payment-config`

**响应示例**：
```json
{
  "success": true,
  "data": {
    "paymentAmount": 50
  }
}
```

#### 4.6 获取禁止预约时的展示文案

**接口路径**：`GET /system-config/booking-disabled-message`

**响应示例**：
```json
{
  "success": true,
  "data": {
    "bookingDisabledMessage": "当前时间段暂不开放预约，请稍后再试"
  }
}
```

### 5. 用户模块

#### 5.1 用户登录/注册

**接口路径**：`POST /users/login`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| wechatOpenId | string | 是 | 微信用户OpenID |
| wechatNickname | string | 是 | 微信昵称 |
| wechatAvatarUrl | string | 否 | 微信头像URL |

**请求示例**：
```json
{
  "wechatOpenId": "o123456789",
  "wechatNickname": "张三",
  "wechatAvatarUrl": "https://example.com/avatar.jpg"
}
```

**响应示例**：
```json
{
  "success": true,
  "message": "User created successfully",
  "data": {
    "id": "1",
    "wechatOpenId": "o123456789",
    "wechatNickname": "张三",
    "wechatAvatarUrl": "https://example.com/avatar.jpg",
    "createdAt": "2024-04-20T10:00:00.000Z",
    "updatedAt": "2024-04-20T10:00:00.000Z"
  }
}
```

#### 5.2 微信小程序登录

**接口路径**：`POST /users/wx-login`

**请求参数**：
| 参数名 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| code | string | 是 | 微信小程序登录码 |

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
    "openid": "o123456789",
    "session_key": "session_key123",
    "unionid": "unionid123"
  }
}
```

## 数据类型定义

### TimeSlot 枚举
- `morning` - 上午
- `afternoon` - 下午

### TravelMode 枚举
- `scenicBus` - 景区大巴
- `selfDriving` - 自驾
- `tourGroup` - 旅游团

### VehicleType 枚举
- `smallCar` - 小型车
- `mediumCar` - 中型车
- `largeCar` - 大型车

### BookingStatus 枚举
- `none` - 无状态
- `pending_payment` - 待支付
- `paying` - 支付中
- `paid` - 已支付
- `cancelled` - 已取消
- `completed` - 已完成
- `refunded` - 已退款

### PaymentStatus 枚举
- `unpaid` - 未支付
- `paying` - 支付中
- `paid` - 已支付
- `refunding` - 退款中
- `refunded` - 已退款

### RefundStatus 枚举
- `none` - 无
- `refunding` - 退款中
- `refunded` - 已退款
- `failed` - 退款失败

## 权限说明

- 管理员权限：需要在请求头中携带有效的 JWT token
- 普通用户权限：部分接口无需权限，部分接口需要微信登录
- 公开接口：无需任何权限

## 错误码说明

| 错误码 | 描述 |
| --- | --- |
| 400 | 请求参数错误 |
| 401 | 未授权 |
| 403 | 禁止访问 |
| 404 | 资源不存在 |
| 500 | 服务器内部错误 |

## 开发环境配置

1. 复制 `.env.example` 文件为 `.env`
2. 修改 `.env` 文件中的配置项
3. 运行 `npm install` 安装依赖
4. 运行 `npm run start:dev` 启动开发服务器

## 生产环境部署

1. 复制 `.env.example` 文件为 `.env.production`
2. 修改 `.env.production` 文件中的配置项
3. 运行 `npm install` 安装依赖
4. 运行 `npm run build:prod` 构建生产版本
5. 运行 `npm run start:prod` 启动生产服务器

## 微信支付配置

为了使用微信支付功能，需要在环境变量中配置以下参数：

| 配置项 | 说明 | 示例值 |
| --- | --- | --- |
| WX_APPID | 微信小程序的AppID | wx1234567890123456 |
| WX_MCHID | 微信支付商户号 | 1234567890 |
| WX_PRIVATE_KEY_PATH | 商户私钥文件路径 | cert/private_key.pem |
| WX_SERIAL_NO | 商户证书序列号 | 1234567890abcdef |
| WX_API_V3_KEY | 微信支付API v3密钥 | 1234567890abcdef1234567890abcdef |
| API_PROTOCOL | API协议（http或https） | https |
| API_HOST | API主机地址 | example.com |
| PORT | API端口 | 443 |

**注意**：
- 商户私钥文件需要放在项目根目录下的cert文件夹中
- 微信支付API v3密钥需要在微信支付商户平台设置
- 商户证书序列号可以在微信支付商户平台查看
