# 微信小程序预约系统后端 API

基于 NestJS + MongoDB 的微信小程序景区预约系统后端服务。

## 技术栈

- **框架**: NestJS 10.x
- **数据库**: MongoDB 8.x (Mongoose ODM)
- **语言**: TypeScript 5.x
- **Node.js**: 18.20.0+
- **验证**: class-validator
- **UUID**: uuid v13

## 功能模块

### 1. 用户模块 (User)
- 微信小程序用户登录/注册
- 自动创建或返回现有用户
- 基于微信 OpenID 的用户识别

### 2. 预约订单模块 (Booking)
- 创建预约订单
- 查询订单列表 (支持多条件筛选)
- 查询订单详情
- 更新订单信息
- 删除订单

## 项目结构

```
src/
├── config/                 # 配置模块
│   ├── config.module.ts
│   └── config.service.ts
├── entities/              # 数据实体
│   ├── user.entity.ts
│   └── booking.entity.ts
├── modules/               # 业务模块
│   ├── user/
│   │   ├── dto/
│   │   ├── user.controller.ts
│   │   ├── user.service.ts
│   │   └── user.module.ts
│   └── booking/
│       ├── dto/
│       ├── booking.controller.ts
│       ├── booking.service.ts
│       └── booking.module.ts
├── repositories/          # 数据访问层
│   ├── user.repository.ts
│   └── booking.repository.ts
├── app.module.ts
└── main.ts
```

## 快速开始

### 环境要求

- Node.js >= 18.20.0
- MongoDB 数据库
- npm >= 9.0.0

### 安装依赖

```bash
npm install
```

### 环境配置

创建 `.env` 文件:

```env
PORT=3000
MONGO_USER=your_username
MONGO_PASSWORD=your_password
MONGO_HOST=your_cluster.mongodb.net
MONGO_DATABASE=your_database
```

### 运行项目

```bash
# 开发模式
npm run start:dev

# 生产构建
npm run build
npm run start:prod

# 代码检查
npm run lint

# 格式化代码
npm run format
```

## API 文档

### 用户接口

详见 [USER_MODULE_GUIDE.md](./USER_MODULE_GUIDE.md)

**POST** `/users/login` - 用户登录/注册

### 预约订单接口

详见 [BOOKING_API_GUIDE.md](./BOOKING_API_GUIDE.md)

- **POST** `/bookings` - 创建预约订单
- **GET** `/bookings` - 查询订单列表
- **GET** `/bookings/:bookingId` - 查询订单详情
- **PUT** `/bookings/:bookingId` - 更新订单
- **DELETE** `/bookings/:bookingId` - 删除订单

## 数据模型

### User (用户)
```typescript
{
  userId: string;              // 系统用户ID (UUID)
  wechatOpenId: string;        // 微信OpenID
  wechatNickname: string;      // 微信昵称
  wechatAvatarUrl?: string;    // 微信头像
  createdAt: Date;             // 创建时间
  updatedAt?: Date;            // 更新时间
}
```

### Booking (预约订单)
```typescript
{
  bookingId: string;           // 订单ID (UUID)
  wechatOpenId: string;        // 微信OpenID
  contactName: string;         // 联系人姓名
  contactGender: Gender;       // 性别 (male/female)
  contactPhone: string;        // 手机号
  contactIdCard: string;       // 身份证号
  bookingDate: Date;           // 预约日期
  timeSlot: TimeSlot;          // 时间段 (morning/afternoon)
  travelMode: TravelMode;      // 出行方式
  numberOfPeople: number;      // 人数
  remarks?: string;            // 备注
  status: BookingStatus;       // 状态
  createdAt: Date;             // 创建时间
  updatedAt?: Date;            // 更新时间
}
```

## 数据库索引

```javascript
// Users collection
db.users.createIndex({ "wechatOpenId": 1 }, { unique: true });
db.users.createIndex({ "userId": 1 }, { unique: true });

// Bookings collection
db.bookings.createIndex({ "bookingId": 1 }, { unique: true });
db.bookings.createIndex({ "wechatOpenId": 1 });
db.bookings.createIndex({ "bookingDate": 1 });
db.bookings.createIndex({ "status": 1 });
db.bookings.createIndex({ "wechatOpenId": 1, "status": 1 });
db.bookings.createIndex({ "bookingDate": 1, "timeSlot": 1 });
```

## 测试

```bash
# 单元测试
npm run test

# E2E 测试
npm run test:e2e

# 测试覆盖率
npm run test:cov
```

## 部署

### 使用 Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/main"]
```

### 构建和运行

```bash
docker build -t booking-api .
docker run -p 3000:3000 --env-file .env booking-api
```

## 开发指南

### 代码规范

- 使用 ESLint 进行代码检查
- 使用 Prettier 进行代码格式化
- 遵循 NestJS 最佳实践

### Git 提交规范

```
feat: 新功能
fix: 修复bug
docs: 文档更新
style: 代码格式调整
refactor: 重构
test: 测试相关
chore: 构建/工具链相关
```

## 版本历史

### v2.0.0 (2024-03-02)
- ✅ 升级到 Node.js 18.20.0
- ✅ 升级 NestJS 到 10.x
- ✅ 升级 Mongoose 到 8.x
- ✅ 升级 TypeScript 到 5.x
- ✅ 重构用户模块适配微信小程序
- ✅ 新增预约订单模块
- ✅ 移除无用的 client/product/sale 模块

### v1.0.0
- 初始版本

## 相关文档

- [升级总结](./UPGRADE_SUMMARY.md) - 项目升级详情
- [用户模块指南](./USER_MODULE_GUIDE.md) - 用户模块使用说明
- [预约订单API指南](./BOOKING_API_GUIDE.md) - 预约订单完整文档

## 许可证

MIT

## 联系方式

如有问题或建议,请提交 Issue。
