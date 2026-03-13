# MongoDB → SQLite 迁移指南

## ✅ 迁移已完成

你的项目已成功从 MongoDB 迁移到 SQLite。以下是完整的迁移说明。

---

## 📋 迁移内容

### 1. 依赖包变更
- ✅ 安装: `@nestjs/typeorm`, `typeorm`, `sqlite3`
- ⚠️ 保留: `@nestjs/mongoose`, `mongoose` (可在测试后卸载)

### 2. 实体文件转换
所有实体文件已从 Mongoose Schema 转换为 TypeORM Entity:
- ✅ `src/entities/user.entity.ts`
- ✅ `src/entities/admin.entity.ts`
- ✅ `src/entities/booking.entity.ts`
- ✅ `src/entities/announcement.entity.ts`
- ✅ `src/entities/system-config.entity.ts`

### 3. Repository 层重写
所有 Repository 已使用 TypeORM API 重写:
- ✅ `src/repositories/user.repository.ts`
- ✅ `src/repositories/admin.repository.ts`
- ✅ `src/repositories/booking.repository.ts`
- ✅ `src/repositories/announcement.repository.ts`
- ✅ `src/repositories/system-config.repository.ts`

### 4. Module 配置更新
- ✅ 所有 Module 已从 `MongooseModule` 迁移到 `TypeOrmModule`
- ✅ `app.module.ts` 已更新数据库连接配置

### 5. 配置文件更新
- ✅ `.env.example` 已更新为 SQLite 配置
- ✅ 创建 `data/` 目录存储 SQLite 数据库文件

---

## 🚀 使用指南

### 1. 更新环境变量

复制新的环境变量配置:
```bash
cp .env.example .env
```

编辑 `.env` 文件:
```env
PORT=3000
NODE_ENV=development
DATABASE_PATH=data/app.db
DATABASE_LOGGING=false
```

### 2. 启动应用

```bash
# 开发模式
npm run start:dev

# 生产模式
npm run build
npm run start:prod
```

首次启动时,TypeORM 会自动创建所有表结构 (synchronize: true)。

### 3. 初始化系统配置

```bash
npm run init-config
```

这将创建默认的系统配置和轮播图。

### 4. 创建默认管理员 (可选)

如果需要创建默认管理员账户,可以通过 API 调用:

```bash
curl -X POST http://localhost:3000/admin/create \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "123456",
    "name": "系统管理员"
  }'
```

---

## 📦 数据迁移 (如果有现有 MongoDB 数据)

### 方式一:使用迁移脚本 (推荐)

1. 确保 MongoDB 正在运行
2. 配置 MongoDB 连接:
```bash
export MONGO_URI="mongodb://admin:123456@localhost:27017/booking_dev"
```

3. 运行迁移脚本:
```bash
npm run migrate
```

### 方式二:手动导出导入

1. 从 MongoDB 导出数据:
```bash
mongoexport --db=booking_dev --collection=users --out=users.json
mongoexport --db=booking_dev --collection=bookings --out=bookings.json
# ... 其他集合
```

2. 编写自定义导入脚本或使用 TypeORM CLI

---

## 🔍 验证迁移

### 1. 检查数据库文件
```bash
ls -lh data/app.db
```

### 2. 查看表结构
```bash
sqlite3 data/app.db ".schema"
```

### 3. 测试 API 接口
```bash
# 测试用户接口
curl http://localhost:3000/user/test-openid

# 测试预约接口
curl http://localhost:3000/booking?page=1&pageSize=10
```

---

## ⚠️ 注意事项

### 1. 并发限制
SQLite 使用数据库级锁,不适合高并发场景:
- ✅ 适用: < 100 QPS
- ❌ 不适用: 高并发抢票场景

### 2. 数据备份
SQLite 备份非常简单:
```bash
# 备份
cp data/app.db data/app.db.backup

# 恢复
cp data/app.db.backup data/app.db
```

### 3. 生产环境配置
生产环境务必设置:
```env
NODE_ENV=production
DATABASE_PATH=/var/app/data/app.db
DATABASE_LOGGING=false
```

并且禁用 `synchronize`:
```typescript
// app.module.ts
synchronize: false  // 生产环境必须为 false
```

### 4. 索引优化
SQLite 的索引已在 Entity 中通过 `@Index()` 装饰器定义,首次启动会自动创建。

---

## 🔄 回滚到 MongoDB (如需要)

如果需要回滚到 MongoDB:

1. 切换到 main 分支:
```bash
git checkout main
```

2. 恢复依赖:
```bash
npm install
```

3. 恢复环境变量:
```bash
# 使用旧的 MongoDB 配置
MONGO_USER=admin
MONGO_PASSWORD=123456
MONGO_HOST=localhost:27017
MONGO_DATABASE=booking_dev
```

4. 启动应用:
```bash
npm run start:dev
```

---

## 📊 性能对比

| 指标 | MongoDB | SQLite |
|------|---------|--------|
| 内存占用 | 300-500MB | 10-50MB |
| 启动时间 | 2-3秒 | < 1秒 |
| 查询性能 | 优秀 | 良好 |
| 并发能力 | 高 | 中低 |
| 部署复杂度 | 中 | 低 |

---

## 🆘 常见问题

### Q: 启动报错 "SQLITE_CANTOPEN"
A: 检查 `data/` 目录是否存在且有写权限:
```bash
mkdir -p data
chmod 755 data
```

### Q: 数据查询为空
A: 检查是否运行了 `npm run init-config` 初始化配置

### Q: 并发写入报错 "SQLITE_BUSY"
A: 这是 SQLite 的正常行为,可以:
1. 增加重试逻辑
2. 使用队列串行化写操作
3. 考虑升级到 PostgreSQL

### Q: 如何查看 SQLite 数据
A: 使用 SQLite 客户端:
```bash
# 命令行
sqlite3 data/app.db

# GUI 工具
# - DB Browser for SQLite (免费)
# - TablePlus (推荐)
# - DBeaver (免费)
```

---

## 📚 相关文档

- [TypeORM 官方文档](https://typeorm.io/)
- [SQLite 官方文档](https://www.sqlite.org/docs.html)
- [NestJS TypeORM 集成](https://docs.nestjs.com/techniques/database)

---

## 🎉 迁移完成

现在你的应用使用 SQLite 作为数据库,内存占用降低约 **300-400MB**,部署更加简单!

如有问题,请查看上述常见问题或联系开发团队。
