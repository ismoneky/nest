# 预约订单 API 使用指南

## 概述
预约订单模块用于管理微信小程序用户的景区预约订单,支持创建、查询、编辑和删除操作。

## 数据结构

### Booking Entity (预约订单实体)
```typescript
{
  bookingId: string;           // 订单ID (UUID,系统自动生成)
  wechatOpenId: string;        // 微信OpenID (关联用户)
  contactName: string;         // 联系人姓名
  contactGender: Gender;       // 联系人性别 (male/female)
  contactPhone: string;        // 联系人手机号
  contactIdCard: string;       // 联系人身份证号
  bookingDate: Date;           // 预约日期
  timeSlot: TimeSlot;          // 时间段 (morning/afternoon)
  travelMode: TravelMode;      // 出行方式 (scenic_bus/self_driving/tour_group)
  numberOfPeople: number;      // 预约人数 (≥1)
  remarks?: string;            // 备注信息 (可选)
  status: BookingStatus;       // 订单状态 (pending/confirmed/cancelled/completed)
  createdAt: Date;             // 创建时间
  updatedAt?: Date;            // 更新时间
}
```

### 枚举类型

**性别 (Gender)**
- `male` - 男
- `female` - 女

**时间段 (TimeSlot)**
- `morning` - 上午
- `afternoon` - 下午

**出行方式 (TravelMode)**
- `scenic_bus` - 景区自营车
- `self_driving` - 自驾
- `tour_group` - 观光团

**订单状态 (BookingStatus)**
- `pending` - 待确认
- `confirmed` - 已确认
- `cancelled` - 已取消
- `completed` - 已完成

## API 接口

### 1. 创建预约订单
**POST** `/bookings`

创建新的预约订单。

**请求体**
```json
{
  "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
  "contactName": "张三",
  "contactGender": "male",
  "contactPhone": "13800138000",
  "contactIdCard": "110101199001011234",
  "bookingDate": "2024-03-15",
  "timeSlot": "morning",
  "travelMode": "scenic_bus",
  "numberOfPeople": 3,
  "remarks": "需要儿童座椅"
}
```

**响应**
```json
{
  "success": true,
  "message": "Booking created successfully",
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "bookingId": "550e8400-e29b-41d4-a716-446655440000",
    "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
    "contactName": "张三",
    "contactGender": "male",
    "contactPhone": "13800138000",
    "contactIdCard": "110101199001011234",
    "bookingDate": "2024-03-15T00:00:00.000Z",
    "timeSlot": "morning",
    "travelMode": "scenic_bus",
    "numberOfPeople": 3,
    "remarks": "需要儿童座椅",
    "status": "pending",
    "createdAt": "2024-03-02T08:00:00.000Z",
    "updatedAt": "2024-03-02T08:00:00.000Z"
  }
}
```

**字段验证**
- `contactPhone`: 必须是有效的中国大陆手机号 (1开头,11位数字)
- `contactIdCard`: 必须是有效的18位身份证号
- `numberOfPeople`: 必须 ≥ 1

---

### 2. 查询预约订单列表
**GET** `/bookings`

查询预约订单,支持多种筛选条件。

**查询参数 (可选)**
- `wechatOpenId` - 按微信OpenID筛选
- `bookingDate` - 按预约日期筛选 (格式: YYYY-MM-DD)
- `timeSlot` - 按时间段筛选 (morning/afternoon)
- `status` - 按订单状态筛选 (pending/confirmed/cancelled/completed)

**示例**

查询所有订单:
```
GET /bookings
```

查询某用户的所有订单:
```
GET /bookings?wechatOpenId=oxxxxxxxxxxxxxxxxxxxxxx
```

查询某日上午的订单:
```
GET /bookings?bookingDate=2024-03-15&timeSlot=morning
```

查询待确认的订单:
```
GET /bookings?status=pending
```

组合查询:
```
GET /bookings?wechatOpenId=oxxxxxxxxxxxxxxxxxxxxxx&status=confirmed
```

**响应**
```json
{
  "success": true,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "bookingId": "550e8400-e29b-41d4-a716-446655440000",
      "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
      "contactName": "张三",
      "contactGender": "male",
      "contactPhone": "13800138000",
      "contactIdCard": "110101199001011234",
      "bookingDate": "2024-03-15T00:00:00.000Z",
      "timeSlot": "morning",
      "travelMode": "scenic_bus",
      "numberOfPeople": 3,
      "remarks": "需要儿童座椅",
      "status": "pending",
      "createdAt": "2024-03-02T08:00:00.000Z",
      "updatedAt": "2024-03-02T08:00:00.000Z"
    }
  ],
  "total": 1
}
```

---

### 3. 查询单个预约订单
**GET** `/bookings/:bookingId`

根据订单ID查询单个订单详情。

**路径参数**
- `bookingId` - 订单ID (UUID)

**示例**
```
GET /bookings/550e8400-e29b-41d4-a716-446655440000
```

**响应**
```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "bookingId": "550e8400-e29b-41d4-a716-446655440000",
    "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
    "contactName": "张三",
    "contactGender": "male",
    "contactPhone": "13800138000",
    "contactIdCard": "110101199001011234",
    "bookingDate": "2024-03-15T00:00:00.000Z",
    "timeSlot": "morning",
    "travelMode": "scenic_bus",
    "numberOfPeople": 3,
    "remarks": "需要儿童座椅",
    "status": "pending",
    "createdAt": "2024-03-02T08:00:00.000Z",
    "updatedAt": "2024-03-02T08:00:00.000Z"
  }
}
```

---

### 4. 更新预约订单
**PUT** `/bookings/:bookingId`

更新预约订单信息,支持部分更新。

**路径参数**
- `bookingId` - 订单ID (UUID)

**请求体 (所有字段可选)**
```json
{
  "contactName": "李四",
  "contactPhone": "13900139000",
  "numberOfPeople": 5,
  "remarks": "改为需要2个儿童座椅",
  "status": "confirmed"
}
```

**响应**
```json
{
  "success": true,
  "message": "Booking updated successfully",
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "bookingId": "550e8400-e29b-41d4-a716-446655440000",
    "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
    "contactName": "李四",
    "contactGender": "male",
    "contactPhone": "13900139000",
    "contactIdCard": "110101199001011234",
    "bookingDate": "2024-03-15T00:00:00.000Z",
    "timeSlot": "morning",
    "travelMode": "scenic_bus",
    "numberOfPeople": 5,
    "remarks": "改为需要2个儿童座椅",
    "status": "confirmed",
    "createdAt": "2024-03-02T08:00:00.000Z",
    "updatedAt": "2024-03-02T09:00:00.000Z"
  }
}
```

---

### 5. 删除预约订单
**DELETE** `/bookings/:bookingId`

删除预约订单。

**路径参数**
- `bookingId` - 订单ID (UUID)

**示例**
```
DELETE /bookings/550e8400-e29b-41d4-a716-446655440000
```

**响应**
```json
{
  "success": true,
  "message": "Booking deleted successfully"
}
```

---

## 小程序端集成示例

### 创建预约订单
```javascript
// 小程序端代码
wx.request({
  url: 'https://your-api.com/bookings',
  method: 'POST',
  data: {
    wechatOpenId: wx.getStorageSync('openid'),
    contactName: '张三',
    contactGender: 'male',
    contactPhone: '13800138000',
    contactIdCard: '110101199001011234',
    bookingDate: '2024-03-15',
    timeSlot: 'morning',
    travelMode: 'scenic_bus',
    numberOfPeople: 3,
    remarks: '需要儿童座椅'
  },
  success: (res) => {
    if (res.data.success) {
      wx.showToast({
        title: '预约成功',
        icon: 'success'
      });
      // 保存订单ID
      wx.setStorageSync('bookingId', res.data.data.bookingId);
    }
  }
});
```

### 查询我的订单
```javascript
wx.request({
  url: 'https://your-api.com/bookings',
  method: 'GET',
  data: {
    wechatOpenId: wx.getStorageSync('openid')
  },
  success: (res) => {
    if (res.data.success) {
      // 显示订单列表
      this.setData({
        bookings: res.data.data
      });
    }
  }
});
```

### 更新订单
```javascript
wx.request({
  url: `https://your-api.com/bookings/${bookingId}`,
  method: 'PUT',
  data: {
    numberOfPeople: 5,
    remarks: '改为需要2个儿童座椅'
  },
  success: (res) => {
    if (res.data.success) {
      wx.showToast({
        title: '修改成功',
        icon: 'success'
      });
    }
  }
});
```

### 取消订单
```javascript
wx.showModal({
  title: '确认取消',
  content: '确定要取消这个预约吗?',
  success: (res) => {
    if (res.confirm) {
      wx.request({
        url: `https://your-api.com/bookings/${bookingId}`,
        method: 'DELETE',
        success: (res) => {
          if (res.data.success) {
            wx.showToast({
              title: '已取消',
              icon: 'success'
            });
          }
        }
      });
    }
  }
});
```

---

## 测试接口

### 使用 curl 测试

**创建订单**
```bash
curl -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "wechatOpenId": "test_openid_123",
    "contactName": "张三",
    "contactGender": "male",
    "contactPhone": "13800138000",
    "contactIdCard": "110101199001011234",
    "bookingDate": "2024-03-15",
    "timeSlot": "morning",
    "travelMode": "scenic_bus",
    "numberOfPeople": 3,
    "remarks": "需要儿童座椅"
  }'
```

**查询订单**
```bash
curl -X GET "http://localhost:3000/bookings?wechatOpenId=test_openid_123"
```

**更新订单**
```bash
curl -X PUT http://localhost:3000/bookings/550e8400-e29b-41d4-a716-446655440000 \
  -H "Content-Type: application/json" \
  -d '{
    "numberOfPeople": 5,
    "status": "confirmed"
  }'
```

**删除订单**
```bash
curl -X DELETE http://localhost:3000/bookings/550e8400-e29b-41d4-a716-446655440000
```

---

## 数据库索引建议

为了提高查询性能,建议在 MongoDB 中创建以下索引:

```javascript
// 按微信OpenID查询
db.bookings.createIndex({ "wechatOpenId": 1 });

// 按订单ID查询 (唯一索引)
db.bookings.createIndex({ "bookingId": 1 }, { unique: true });

// 按预约日期查询
db.bookings.createIndex({ "bookingDate": 1 });

// 按状态查询
db.bookings.createIndex({ "status": 1 });

// 组合索引: 用户+状态
db.bookings.createIndex({ "wechatOpenId": 1, "status": 1 });

// 组合索引: 日期+时间段
db.bookings.createIndex({ "bookingDate": 1, "timeSlot": 1 });
```

---

## 错误处理

### 常见错误响应

**订单不存在 (404)**
```json
{
  "statusCode": 404,
  "message": "Booking with ID xxx not found",
  "error": "Not Found"
}
```

**验证失败 (400)**
```json
{
  "statusCode": 400,
  "message": [
    "Invalid phone number format",
    "contactName should not be empty"
  ],
  "error": "Bad Request"
}
```

**服务器错误 (500)**
```json
{
  "statusCode": 500,
  "message": "Internal server error",
  "error": "Internal Server Error"
}
```

---

## 业务流程建议

### 1. 用户预约流程
1. 用户选择预约日期和时间段
2. 填写联系人信息
3. 选择出行方式和人数
4. 提交预约 → 状态为 `pending`
5. 管理员审核 → 状态改为 `confirmed`
6. 预约当天 → 状态改为 `completed`

### 2. 取消预约流程
1. 用户查看订单列表
2. 选择要取消的订单
3. 确认取消 → 调用更新接口,状态改为 `cancelled`
   或直接调用删除接口

### 3. 管理后台流程
1. 查询所有待确认订单: `GET /bookings?status=pending`
2. 查看订单详情: `GET /bookings/:bookingId`
3. 确认订单: `PUT /bookings/:bookingId` (status: confirmed)
4. 查询某日订单统计: `GET /bookings?bookingDate=2024-03-15`

---

## 注意事项

1. **身份证号验证** - 系统会验证18位身份证号格式
2. **手机号验证** - 必须是1开头的11位大陆手机号
3. **预约人数** - 必须至少为1人
4. **订单ID唯一** - bookingId 由系统自动生成,不可重复
5. **软删除建议** - 生产环境建议使用状态标记而非物理删除
6. **时区处理** - 日期时间统一使用UTC,前端需要转换为本地时间

---

## 后续扩展建议

- 添加预约容量限制 (每个时间段最多预约人数)
- 添加预约时间限制 (提前多久可以预约)
- 添加取消时间限制 (提前多久可以取消)
- 添加订单支付功能
- 添加订单通知功能 (短信/模板消息)
- 添加订单统计报表
- 添加订单导出功能
