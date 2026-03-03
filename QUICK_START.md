# 快速开始指南

## 1. 启动项目

```bash
# 安装依赖 (如果还没安装)
npm install

# 启动开发服务器
npm run start:dev
```

服务器将在 `http://localhost:3000` 启动。

## 2. 测试用户接口

### 创建/登录用户

```bash
curl -X POST http://localhost:3000/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "wechatOpenId": "test_user_001",
    "wechatNickname": "测试用户",
    "wechatAvatarUrl": "https://example.com/avatar.png"
  }'
```

**响应示例:**
```json
{
  "success": true,
  "message": "User created successfully",
  "data": {
    "_id": "...",
    "userId": "550e8400-...",
    "wechatOpenId": "test_user_001",
    "wechatNickname": "测试用户",
    "wechatAvatarUrl": "https://example.com/avatar.png",
    "createdAt": "2024-03-02T08:00:00.000Z",
    "updatedAt": "2024-03-02T08:00:00.000Z"
  }
}
```

## 3. 测试预约订单接口

### 创建预约订单

```bash
curl -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "wechatOpenId": "test_user_001",
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

**响应示例:**
```json
{
  "success": true,
  "message": "Booking created successfully",
  "data": {
    "_id": "...",
    "bookingId": "a1b2c3d4-...",
    "wechatOpenId": "test_user_001",
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

### 查询用户的所有订单

```bash
curl -X GET "http://localhost:3000/bookings?wechatOpenId=test_user_001"
```

### 查询单个订单详情

```bash
# 使用上面返回的 bookingId
curl -X GET http://localhost:3000/bookings/a1b2c3d4-...
```

### 更新订单

```bash
curl -X PUT http://localhost:3000/bookings/a1b2c3d4-... \
  -H "Content-Type: application/json" \
  -d '{
    "numberOfPeople": 5,
    "remarks": "改为需要2个儿童座椅",
    "status": "confirmed"
  }'
```

### 删除订单

```bash
curl -X DELETE http://localhost:3000/bookings/a1b2c3d4-...
```

## 4. 使用 Postman 测试

### 导入到 Postman

1. 打开 Postman
2. 创建新的 Collection: "Booking API"
3. 添加以下请求:

#### 用户登录
- Method: POST
- URL: `http://localhost:3000/users/login`
- Body (raw JSON):
```json
{
  "wechatOpenId": "test_user_001",
  "wechatNickname": "测试用户",
  "wechatAvatarUrl": "https://example.com/avatar.png"
}
```

#### 创建预约
- Method: POST
- URL: `http://localhost:3000/bookings`
- Body (raw JSON):
```json
{
  "wechatOpenId": "test_user_001",
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

#### 查询订单列表
- Method: GET
- URL: `http://localhost:3000/bookings?wechatOpenId=test_user_001`

## 5. 数据验证规则

### 手机号格式
- 必须是1开头的11位数字
- 示例: `13800138000`, `18912345678`

### 身份证号格式
- 必须是18位有效身份证号
- 示例: `110101199001011234`

### 性别
- `male` 或 `female`

### 时间段
- `morning` (上午) 或 `afternoon` (下午)

### 出行方式
- `scenic_bus` (景区自营车)
- `self_driving` (自驾)
- `tour_group` (观光团)

### 订单状态
- `pending` (待确认)
- `confirmed` (已确认)
- `cancelled` (已取消)
- `completed` (已完成)

## 6. 常见问题

### Q: 如何修改端口?
A: 在 `.env` 文件中修改 `PORT=3000`

### Q: 如何查看所有订单?
A: `GET /bookings` (不带任何查询参数)

### Q: 如何按日期查询订单?
A: `GET /bookings?bookingDate=2024-03-15`

### Q: 如何按状态查询订单?
A: `GET /bookings?status=confirmed`

### Q: 可以组合多个查询条件吗?
A: 可以! 例如: `GET /bookings?wechatOpenId=xxx&status=pending&bookingDate=2024-03-15`

## 7. 下一步

- 查看 [BOOKING_API_GUIDE.md](./BOOKING_API_GUIDE.md) 了解完整的 API 文档
- 查看 [USER_MODULE_GUIDE.md](./USER_MODULE_GUIDE.md) 了解用户模块详情
- 开始集成到你的微信小程序!

## 8. 小程序端示例代码

```javascript
// 用户登录
wx.request({
  url: 'https://your-domain.com/users/login',
  method: 'POST',
  data: {
    wechatOpenId: wx.getStorageSync('openid'),
    wechatNickname: userInfo.nickName,
    wechatAvatarUrl: userInfo.avatarUrl
  },
  success: (res) => {
    console.log('登录成功', res.data);
    wx.setStorageSync('userId', res.data.data.userId);
  }
});

// 创建预约
wx.request({
  url: 'https://your-domain.com/bookings',
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
    console.log('预约成功', res.data);
    wx.showToast({ title: '预约成功', icon: 'success' });
  }
});

// 查询我的订单
wx.request({
  url: 'https://your-domain.com/bookings',
  method: 'GET',
  data: {
    wechatOpenId: wx.getStorageSync('openid')
  },
  success: (res) => {
    console.log('订单列表', res.data);
    this.setData({ bookings: res.data.data });
  }
});
```

## 9. 开发建议

1. **先在本地测试所有接口**,确保功能正常
2. **部署到服务器后**,使用真实的微信 OpenID 测试
3. **配置 HTTPS**,微信小程序要求使用 HTTPS
4. **添加错误处理**,在小程序端处理网络错误
5. **添加加载提示**,提升用户体验

祝开发顺利! 🎉
