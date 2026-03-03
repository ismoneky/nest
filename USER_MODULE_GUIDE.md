# User 模块使用指南

## 概述
User 模块已改造为适配微信小程序的用户系统,提供简单的登录/注册功能。

## 数据结构

### User Entity (用户实体)
```typescript
{
  userId: string;           // 系统生成的唯一用户ID (UUID)
  wechatOpenId: string;     // 微信OpenID (唯一)
  wechatNickname: string;   // 微信昵称
  wechatAvatarUrl?: string; // 微信头像URL (可选)
  createdAt: Date;          // 创建时间
  updatedAt?: Date;         // 更新时间
}
```

## API 接口

### POST /users/login
用户登录或注册接口 - 首次进入小程序时调用

**请求体 (Request Body)**
```json
{
  "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
  "wechatNickname": "微信用户",
  "wechatAvatarUrl": "https://xxx.com/avatar.png"
}
```

**响应 (Response)**

首次创建用户:
```json
{
  "success": true,
  "message": "User created successfully",
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
    "wechatNickname": "微信用户",
    "wechatAvatarUrl": "https://xxx.com/avatar.png",
    "createdAt": "2024-03-02T08:00:00.000Z",
    "updatedAt": "2024-03-02T08:00:00.000Z"
  }
}
```

用户已存在(返回现有用户):
```json
{
  "success": true,
  "message": "User logged in successfully",
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
    "wechatNickname": "微信用户",
    "wechatAvatarUrl": "https://xxx.com/avatar.png",
    "createdAt": "2024-03-01T08:00:00.000Z",
    "updatedAt": "2024-03-01T08:00:00.000Z"
  }
}
```

## 工作流程

1. **小程序端获取微信用户信息**
   ```javascript
   // 小程序端代码示例
   wx.getUserProfile({
     desc: '用于完善用户资料',
     success: (res) => {
       const userInfo = res.userInfo;
       // 调用后端接口
       wx.request({
         url: 'https://your-api.com/users/login',
         method: 'POST',
         data: {
           wechatOpenId: wx.getStorageSync('openid'), // 需要先通过 wx.login 获取
           wechatNickname: userInfo.nickName,
           wechatAvatarUrl: userInfo.avatarUrl
         },
         success: (res) => {
           // 保存用户信息到本地
           wx.setStorageSync('userId', res.data.data.userId);
           wx.setStorageSync('userInfo', res.data.data);
         }
       });
     }
   });
   ```

2. **后端处理逻辑**
   - 接收微信用户信息
   - 根据 `wechatOpenId` 查询数据库
   - 如果用户不存在,创建新用户并生成 `userId`
   - 如果用户存在,直接返回用户信息

## 核心特性

✅ **自动查询或创建** - 一个接口完成登录和注册
✅ **幂等性** - 多次调用同一 wechatOpenId 不会创建重复用户
✅ **唯一标识** - 系统生成的 userId 作为业务主键
✅ **微信关联** - 保存微信 OpenID、昵称和头像

## 数据库索引

建议在 MongoDB 中创建以下索引:
```javascript
db.users.createIndex({ "wechatOpenId": 1 }, { unique: true });
db.users.createIndex({ "userId": 1 }, { unique: true });
```

## 环境配置

确保 `.env` 文件配置正确:
```env
PORT=3000
MONGO_USER=your_username
MONGO_PASSWORD=your_password
MONGO_HOST=your_cluster.mongodb.net
MONGO_DATABASE=your_database
```

## 测试接口

使用 curl 测试:
```bash
curl -X POST http://localhost:3000/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "wechatOpenId": "test_openid_123",
    "wechatNickname": "测试用户",
    "wechatAvatarUrl": "https://example.com/avatar.png"
  }'
```

使用 Postman 测试:
1. Method: POST
2. URL: `http://localhost:3000/users/login`
3. Headers: `Content-Type: application/json`
4. Body (raw JSON):
```json
{
  "wechatOpenId": "test_openid_123",
  "wechatNickname": "测试用户",
  "wechatAvatarUrl": "https://example.com/avatar.png"
}
```

## 注意事项

1. **wechatOpenId 必须唯一** - 这是识别用户的关键字段
2. **首次调用会创建用户** - 确保传入正确的微信信息
3. **userId 自动生成** - 使用 UUID v4 格式,无需前端传入
4. **无需事务** - 已移除 MongoDB 事务,简化代码逻辑
5. **头像可选** - wechatAvatarUrl 可以不传

## 后续扩展建议

如果需要更多功能,可以考虑添加:
- 用户信息更新接口
- 用户列表查询接口
- 用户详情查询接口
- 用户注销接口
