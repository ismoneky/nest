# 预约订单 API 使用指南

## 概述
预约订单模块用于管理微信小程序用户的景区预约订单,支持创建、查询、编辑和删除操作。

## 数据结构

### Booking Entity (预约订单实体)
```typescript
{
  bookingId: string;              // 订单ID (UUID,系统自动生成)
  wechatOpenId: string;           // 微信OpenID (关联用户,有索引)
  contactName: string;            // 联系人姓名
  contactGender: Gender;          // 联系人性别 (male/female)
  contactPhone: string;           // 联系人手机号
  contactIdCard: string;          // 联系人身份证号
  bookingDate: Date;              // 预约日期 (有索引)
  timeSlot: TimeSlot;             // 时间段 (morning/afternoon)
  travelMode: TravelMode;         // 出行方式 (scenic_bus/self_driving/tour_group)

  // 自驾相关字段 (travelMode=self_driving 时必填)
  licensePlate?: string;          // 车牌号 (有索引)
  vehicleType?: VehicleType;      // 车辆类型 (two_wheel_motorcycle/three_wheel_motorcycle/small_car)

  // 旅游团相关字段 (travelMode=tour_group 时必填)
  tourGroupName?: string;         // 旅游团名称
  tourOrderNumber?: string;       // 旅游团订单编号

  numberOfPeople: number;         // 预约人数 (≥1)
  remarks?: string;               // 备注信息 (可选)
  status: BookingStatus;          // 订单状态 (有索引)
  createdAt: Date;                // 创建时间
  updatedAt?: Date;               // 更新时间
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
- `self_driving` - 自驾 (需要填写车牌号和车辆类型)
- `tour_group` - 观光团 (需要填写旅游团名称和订单编号)

**车辆类型 (VehicleType)** - 自驾时必填
- `two_wheel_motorcycle` - 二轮摩托
- `three_wheel_motorcycle` - 三轮摩托
- `small_car` - 小型客车

**订单状态 (BookingStatus)**
- `pending` - 待确认
- `confirmed` - 已确认
- `cancelled` - 已取消
- `completed` - 已完成

---

## API 接口

### 1. 创建预约订单
**POST** `/bookings`

创建新的预约订单。根据不同的出行方式,需要填写不同的必填字段。

#### 示例 1: 景区自营车预约

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

#### 示例 2: 自驾预约 (必须包含车牌号和车辆类型)

**请求体**
```json
{
  "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
  "contactName": "李四",
  "contactGender": "female",
  "contactPhone": "13900139000",
  "contactIdCard": "110101199101011234",
  "bookingDate": "2024-03-15",
  "timeSlot": "afternoon",
  "travelMode": "self_driving",
  "licensePlate": "京A12345",
  "vehicleType": "small_car",
  "numberOfPeople": 4,
  "remarks": "自驾前往"
}
```

**车牌号格式说明:**
- 必须符合中国车牌号格式
- 格式: 省份简称 + 字母 + 5位数字/字母
- 示例: `京A12345`, `沪B88888`, `粤C99999`

#### 示例 3: 旅游团预约 (必须包含旅游团名称和订单编号)

**请求体**
```json
{
  "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
  "contactName": "王五",
  "contactGender": "male",
  "contactPhone": "13700137000",
  "contactIdCard": "110101199201011234",
  "bookingDate": "2024-03-15",
  "timeSlot": "morning",
  "travelMode": "tour_group",
  "tourGroupName": "春游旅行团",
  "tourOrderNumber": "TG20240315001",
  "numberOfPeople": 30,
  "remarks": "团队预约"
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
    "contactName": "李四",
    "contactGender": "female",
    "contactPhone": "13900139000",
    "contactIdCard": "110101199101011234",
    "bookingDate": "2024-03-15T00:00:00.000Z",
    "timeSlot": "afternoon",
    "travelMode": "self_driving",
    "licensePlate": "京A12345",
    "vehicleType": "small_car",
    "numberOfPeople": 4,
    "remarks": "自驾前往",
    "status": "pending",
    "createdAt": "2024-03-02T08:00:00.000Z",
    "updatedAt": "2024-03-02T08:00:00.000Z"
  }
}
```

**字段验证规则**
- `contactPhone`: 必须是1开头的11位大陆手机号
- `contactIdCard`: 必须是有效的18位身份证号
- `numberOfPeople`: 必须 ≥ 1
- `licensePlate`: 自驾时必填,必须符合中国车牌格式
- `vehicleType`: 自驾时必填,必须是 `two_wheel_motorcycle`/`three_wheel_motorcycle`/`small_car` 之一
- `tourGroupName`: 旅游团时必填
- `tourOrderNumber`: 旅游团时必填

**错误示例 - 自驾时缺少车牌号**
```json
{
  "statusCode": 400,
  "message": [
    "License plate is required for self-driving mode",
    "Vehicle type is required for self-driving mode"
  ],
  "error": "Bad Request"
}
```

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

组合查询 - 查询某用户的已确认订单:
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
      "contactName": "李四",
      "contactGender": "female",
      "contactPhone": "13900139000",
      "contactIdCard": "110101199101011234",
      "bookingDate": "2024-03-15T00:00:00.000Z",
      "timeSlot": "afternoon",
      "travelMode": "self_driving",
      "licensePlate": "京A12345",
      "vehicleType": "small_car",
      "numberOfPeople": 4,
      "remarks": "自驾前往",
      "status": "confirmed",
      "createdAt": "2024-03-02T08:00:00.000Z",
      "updatedAt": "2024-03-02T09:00:00.000Z"
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
    "contactName": "李四",
    "contactGender": "female",
    "contactPhone": "13900139000",
    "contactIdCard": "110101199101011234",
    "bookingDate": "2024-03-15T00:00:00.000Z",
    "timeSlot": "afternoon",
    "travelMode": "self_driving",
    "licensePlate": "京A12345",
    "vehicleType": "small_car",
    "numberOfPeople": 4,
    "remarks": "自驾前往",
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

更新人数和状态:
```json
{
  "numberOfPeople": 5,
  "status": "confirmed"
}
```

更新车牌号:
```json
{
  "licensePlate": "京B88888",
  "vehicleType": "small_car"
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
    "contactGender": "female",
    "contactPhone": "13900139000",
    "contactIdCard": "110101199101011234",
    "bookingDate": "2024-03-15T00:00:00.000Z",
    "timeSlot": "afternoon",
    "travelMode": "self_driving",
    "licensePlate": "京B88888",
    "vehicleType": "small_car",
    "numberOfPeople": 5,
    "remarks": "自驾前往",
    "status": "confirmed",
    "createdAt": "2024-03-02T08:00:00.000Z",
    "updatedAt": "2024-03-02T10:00:00.000Z"
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

## 数据库索引

系统已自动创建以下索引以优化查询性能:

```javascript
// 单字段索引
db.bookings.createIndex({ "bookingId": 1 }, { unique: true }); // 订单ID (唯一)
db.bookings.createIndex({ "wechatOpenId": 1 });                // 微信OpenID
db.bookings.createIndex({ "bookingDate": 1 });                 // 预约日期
db.bookings.createIndex({ "status": 1 });                      // 订单状态
db.bookings.createIndex({ "licensePlate": 1 });                // 车牌号

// 复合索引
db.bookings.createIndex({ "wechatOpenId": 1, "status": 1 });   // 用户+状态
db.bookings.createIndex({ "bookingDate": 1, "timeSlot": 1 });  // 日期+时间段
```

---

## 测试接口

### 使用 curl 测试

**创建景区自营车订单**
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

**创建自驾订单**
```bash
curl -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "wechatOpenId": "test_openid_123",
    "contactName": "李四",
    "contactGender": "female",
    "contactPhone": "13900139000",
    "contactIdCard": "110101199101011234",
    "bookingDate": "2024-03-15",
    "timeSlot": "afternoon",
    "travelMode": "self_driving",
    "licensePlate": "京A12345",
    "vehicleType": "small_car",
    "numberOfPeople": 4,
    "remarks": "自驾前往"
  }'
```

**创建旅游团订单**
```bash
curl -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "wechatOpenId": "test_openid_123",
    "contactName": "王五",
    "contactGender": "male",
    "contactPhone": "13700137000",
    "contactIdCard": "110101199201011234",
    "bookingDate": "2024-03-15",
    "timeSlot": "morning",
    "travelMode": "tour_group",
    "tourGroupName": "春游旅行团",
    "tourOrderNumber": "TG20240315001",
    "numberOfPeople": 30,
    "remarks": "团队预约"
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

## 小程序端集成示例

### 创建自驾预约
```javascript
wx.request({
  url: 'https://your-api.com/bookings',
  method: 'POST',
  data: {
    wechatOpenId: wx.getStorageSync('openid'),
    contactName: formData.name,
    contactGender: formData.gender,
    contactPhone: formData.phone,
    contactIdCard: formData.idCard,
    bookingDate: formData.date,
    timeSlot: formData.timeSlot,
    travelMode: 'self_driving',
    licensePlate: formData.licensePlate,      // 车牌号
    vehicleType: formData.vehicleType,        // 车辆类型
    numberOfPeople: formData.numberOfPeople,
    remarks: formData.remarks
  },
  success: (res) => {
    if (res.data.success) {
      wx.showToast({ title: '预约成功', icon: 'success' });
      wx.setStorageSync('bookingId', res.data.data.bookingId);
    }
  },
  fail: (err) => {
    wx.showToast({ title: '预约失败', icon: 'error' });
  }
});
```

### 表单验证示例
```javascript
// 车牌号验证
function validateLicensePlate(plate) {
  const pattern = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]$/;
  return pattern.test(plate);
}

// 提交前验证
onSubmit(formData) {
  if (formData.travelMode === 'self_driving') {
    if (!formData.licensePlate) {
      wx.showToast({ title: '请输入车牌号', icon: 'none' });
      return;
    }
    if (!validateLicensePlate(formData.licensePlate)) {
      wx.showToast({ title: '车牌号格式不正确', icon: 'none' });
      return;
    }
    if (!formData.vehicleType) {
      wx.showToast({ title: '请选择车辆类型', icon: 'none' });
      return;
    }
  }

  if (formData.travelMode === 'tour_group') {
    if (!formData.tourGroupName) {
      wx.showToast({ title: '请输入旅游团名称', icon: 'none' });
      return;
    }
    if (!formData.tourOrderNumber) {
      wx.showToast({ title: '请输入订单编号', icon: 'none' });
      return;
    }
  }

  // 提交订单
  this.createBooking(formData);
}
```

---

## 注意事项

1. **出行方式必填字段**
   - `scenic_bus`: 无额外必填字段
   - `self_driving`: 必须填写 `licensePlate` 和 `vehicleType`
   - `tour_group`: 必须填写 `tourGroupName` 和 `tourOrderNumber`

2. **车牌号格式**
   - 必须符合中国车牌号标准格式
   - 支持普通车牌、新能源车牌等
   - 示例: `京A12345`, `沪B88888D`, `粤C99999`

3. **车辆类型**
   - `two_wheel_motorcycle` - 二轮摩托
   - `three_wheel_motorcycle` - 三轮摩托
   - `small_car` - 小型客车

4. **索引优化**
   - `wechatOpenId` 有索引,按用户查询很快
   - `bookingDate` 有索引,按日期查询很快
   - `licensePlate` 有索引,按车牌号查询很快
   - 复合索引支持组合查询优化

5. **数据验证**
   - 所有必填字段都会在后端进行严格验证
   - 建议前端也做相应验证,提升用户体验

---

## 常见问题

### Q: 自驾预约时忘记填车牌号会怎样?
A: 后端会返回 400 错误,提示 "License plate is required for self-driving mode"

### Q: 车牌号格式不正确会怎样?
A: 后端会返回 400 错误,提示 "Invalid license plate format"

### Q: 可以查询某个车牌号的所有订单吗?
A: 目前查询接口不支持按车牌号筛选,但可以在后端添加此功能

### Q: 旅游团订单编号有格式要求吗?
A: 目前没有格式限制,只要求非空字符串

### Q: 创建订单后可以修改出行方式吗?
A: 可以,但建议谨慎修改,因为不同出行方式的必填字段不同

---

## 后续扩展建议

- 添加按车牌号查询订单的接口
- 添加订单统计功能 (按出行方式统计)
- 添加车辆类型容量限制
- 添加旅游团订单批量导入功能
- 添加车牌号黑名单功能
