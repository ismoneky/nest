# 管理后台使用指南

## 概述

管理后台提供以下功能:
- ✅ **管理员登录** - 简单的用户名密码认证
- ✅ **公告管理** - 创建、编辑、删除小程序公告
- 🚧 **轮播图管理** - 管理首页轮播图 (待完成)
- 🚧 **系统配置** - 控制预约开关等配置 (待完成)

## 已实现功能

### 1. 管理员认证

#### 管理员登录
**POST** `/admin/login`

```bash
curl -X POST http://localhost:3000/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "admin123"
  }'
```

**响应:**
```json
{
  "success": true,
  "message": "登录成功",
  "data": {
    "username": "admin",
    "name": "管理员",
    "token": "YWRtaW46MTcwOTM2ODgwMDAwMA=="
  }
}
```

**Token说明:**
- Token有效期: 24小时
- 格式: Base64编码的 `username:timestamp`
- 使用方式: 在请求头中添加 `Authorization: Bearer {token}`

### 2. 公告管理

#### 创建公告 (需要管理员权限)
**POST** `/announcements`

```bash
curl -X POST http://localhost:3000/announcements \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YWRtaW46MTcwOTM2ODgwMDAwMA==" \
  -d '{
    "title": "景区开放通知",
    "content": "本景区将于3月15日正式开放,欢迎预约参观!",
    "isActive": true,
    "sortOrder": 1
  }'
```

**响应:**
```json
{
  "success": true,
  "message": "创建成功",
  "data": {
    "announcementId": "550e8400-...",
    "title": "景区开放通知",
    "content": "本景区将于3月15日正式开放,欢迎预约参观!",
    "isActive": true,
    "sortOrder": 1,
    "createdAt": "2024-03-02T08:00:00.000Z"
  }
}
```

#### 查询所有公告 (管理端,需要管理员权限)
**GET** `/announcements/admin/all`

```bash
curl -X GET http://localhost:3000/announcements/admin/all \
  -H "Authorization: Bearer YWRtaW46MTcwOTM2ODgwMDAwMA=="
```

#### 查询启用的公告 (小程序端,无需权限)
**GET** `/announcements`

```bash
curl -X GET http://localhost:3000/announcements
```

**响应:**
```json
{
  "success": true,
  "data": [
    {
      "announcementId": "550e8400-...",
      "title": "景区开放通知",
      "content": "本景区将于3月15日正式开放,欢迎预约参观!",
      "isActive": true,
      "sortOrder": 1,
      "createdAt": "2024-03-02T08:00:00.000Z"
    }
  ]
}
```

#### 更新公告 (需要管理员权限)
**PUT** `/announcements/:id`

```bash
curl -X PUT http://localhost:3000/announcements/550e8400-... \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YWRtaW46MTcwOTM2ODgwMDAwMA==" \
  -d '{
    "title": "景区开放通知(已更新)",
    "isActive": false
  }'
```

#### 删除公告 (需要管理员权限)
**DELETE** `/announcements/:id`

```bash
curl -X DELETE http://localhost:3000/announcements/550e8400-... \
  -H "Authorization: Bearer YWRtaW46MTcwOTM2ODgwMDAwMA=="
```

## 初始化管理员账号

### 方法一: 使用 MongoDB Compass

1. 连接到数据库
2. 选择 `booking_dev` 数据库
3. 选择 `admins` 集合
4. 插入文档:

```javascript
{
  username: "admin",
  password: "$2b$10$rBV2/8XZJvD8Y.KqWxKmLeN5R8BqZ8JxQxBZxqZ8JxQxBZxqZ8Jx",  // admin123
  name: "管理员",
  createdAt: new Date()
}
```

### 方法二: 使用 Node.js 脚本

创建 `init-admin.js`:

```javascript
const bcrypt = require('bcrypt');
const { MongoClient } = require('mongodb');

async function initAdmin() {
  const uri = 'mongodb://admin:123456@localhost:27017';
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('booking_dev');
    const admins = db.collection('admins');

    // 检查是否已存在
    const existing = await admins.findOne({ username: 'admin' });
    if (existing) {
      console.log('管理员已存在');
      return;
    }

    // 创建管理员
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await admins.insertOne({
      username: 'admin',
      password: hashedPassword,
      name: '管理员',
      createdAt: new Date()
    });

    console.log('管理员创建成功!');
    console.log('用户名: admin');
    console.log('密码: admin123');
  } finally {
    await client.close();
  }
}

initAdmin();
```

运行:
```bash
node init-admin.js
```

### 方法三: 使用 mongosh

```bash
docker exec -it mongodb mongosh -u admin -p 123456

> use booking_dev

> db.admins.insertOne({
  username: "admin",
  password: "$2b$10$K7L1OJ45/4Y2nIvhRqDNeOGgxRvVCJ3lpFG8fmg.y85wooSGnDq4W",
  name: "管理员",
  createdAt: new Date()
})
```

**默认密码:** `admin123`

## 认证流程

### 1. 登录获取Token

```javascript
// 管理后台前端代码
async function login(username, password) {
  const res = await fetch('http://localhost:3000/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if (data.success) {
    // 保存token到localStorage
    localStorage.setItem('admin_token', data.data.token);
    localStorage.setItem('admin_name', data.data.name);
  }
}
```

### 2. 使用Token访问受保护的接口

```javascript
async function createAnnouncement(announcementData) {
  const token = localStorage.getItem('admin_token');

  const res = await fetch('http://localhost:3000/announcements', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(announcementData)
  });

  return await res.json();
}
```

### 3. 处理Token过期

```javascript
// 拦截器示例
async function fetchWithAuth(url, options = {}) {
  const token = localStorage.getItem('admin_token');

  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  });

  if (res.status === 401) {
    // Token过期,跳转到登录页
    localStorage.removeItem('admin_token');
    window.location.href = '/admin/login';
    return;
  }

  return await res.json();
}
```

## 错误处理

### 未提供Token
```json
{
  "statusCode": 401,
  "message": "未提供认证令牌",
  "error": "Unauthorized"
}
```

### Token无效或过期
```json
{
  "statusCode": 401,
  "message": "认证令牌无效或已过期",
  "error": "Unauthorized"
}
```

### 用户名或密码错误
```json
{
  "statusCode": 401,
  "message": "用户名或密码错误",
  "error": "Unauthorized"
}
```

## 待完成功能

### 轮播图管理 (Banner)

需要实现的接口:
- `POST /banners` - 创建轮播图
- `GET /banners` - 查询启用的轮播图 (小程序端)
- `GET /banners/admin/all` - 查询所有轮播图 (管理端)
- `PUT /banners/:id` - 更新轮播图
- `DELETE /banners/:id` - 删除轮播图

数据结构:
```typescript
{
  bannerId: string;
  title: string;
  imageUrl: string;
  linkUrl?: string;
  isActive: boolean;
  sortOrder: number;
}
```

### 系统配置 (SystemConfig)

需要实现的接口:
- `GET /system-config` - 查询所有配置
- `PUT /system-config/:key` - 更新配置

配置项:
- `booking_enabled` - 是否开放预约 (true/false)
- `booking_notice` - 预约须知
- `contact_phone` - 联系电话
- `business_hours` - 营业时间

## 管理后台前端建议

### 技术栈推荐
- **Vue 3 + Element Plus** - 简单快速
- **React + Ant Design** - 功能丰富
- **纯HTML+JS** - 最简单

### 页面结构

```
admin/
├── login.html          # 登录页
├── index.html          # 管理首页
├── announcements.html  # 公告管理
├── banners.html        # 轮播图管理
├── bookings.html       # 订单管理
└── settings.html       # 系统设置
```

### 简单示例 (纯HTML)

```html
<!DOCTYPE html>
<html>
<head>
  <title>公告管理</title>
</head>
<body>
  <h1>公告管理</h1>

  <button onclick="createAnnouncement()">新建公告</button>

  <div id="announcements"></div>

  <script>
    const API_URL = 'http://localhost:3000';
    const token = localStorage.getItem('admin_token');

    // 加载公告列表
    async function loadAnnouncements() {
      const res = await fetch(`${API_URL}/announcements/admin/all`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();

      const html = data.data.map(item => `
        <div>
          <h3>${item.title}</h3>
          <p>${item.content}</p>
          <button onclick="deleteAnnouncement('${item.announcementId}')">删除</button>
        </div>
      `).join('');

      document.getElementById('announcements').innerHTML = html;
    }

    // 删除公告
    async function deleteAnnouncement(id) {
      if (!confirm('确定删除?')) return;

      await fetch(`${API_URL}/announcements/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      loadAnnouncements();
    }

    loadAnnouncements();
  </script>
</body>
</html>
```

## 安全建议

1. **生产环境修改默认密码**
2. **使用HTTPS**
3. **限制管理后台访问IP**
4. **定期更换Token**
5. **记录操作日志**

## 相关文档

- [API 文档](./BOOKING_API_GUIDE.md)
- [本地开发指南](./LOCAL_DEVELOPMENT.md)
