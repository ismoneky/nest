# 本地开发环境配置指南

## 快速开始 (推荐使用 Docker)

### 1. 安装 Docker Desktop

**macOS:**
1. 下载: https://www.docker.com/products/docker-desktop
2. 安装并启动 Docker Desktop
3. 验证安装: `docker --version`

**Windows:**
1. 下载: https://www.docker.com/products/docker-desktop
2. 安装并启动 Docker Desktop
3. 验证安装: `docker --version`

### 2. 启动 MongoDB 容器

```bash
docker run -d \
  --name mongodb \
  -p 27017:27017 \
  -e MONGO_INITDB_ROOT_USERNAME=admin \
  -e MONGO_INITDB_ROOT_PASSWORD=123456 \
  -v mongodb_data:/data/db \
  mongo:8.0
```

**参数说明:**
- `-d`: 后台运行
- `--name mongodb`: 容器名称
- `-p 27017:27017`: 端口映射
- `-e`: 设置环境变量 (用户名和密码)
- `-v`: 数据持久化
- `mongo:8.0`: 使用 MongoDB 8.0 镜像

### 3. 验证 MongoDB 是否启动

```bash
# 查看运行中的容器
docker ps

# 应该看到类似输出:
# CONTAINER ID   IMAGE       STATUS          PORTS
# abc123         mongo:8.0   Up 10 seconds   0.0.0.0:27017->27017/tcp
```

### 4. 配置项目环境变量

项目根目录已有 `.env` 文件,内容如下:

```env
# 服务器端口
PORT=3000

# 本地 MongoDB 配置 (Docker)
MONGO_USER=admin
MONGO_PASSWORD=123456
MONGO_HOST=localhost:27017
MONGO_DATABASE=booking_dev
```

### 5. 启动项目

```bash
# 安装依赖 (如果还没安装)
npm install

# 启动开发服务器
npm run start:dev
```

### 6. 验证连接

启动后应该看到:
```
[Nest] 12345  - 03/02/2024, 10:00:00 AM     LOG [NestApplication] Nest application successfully started
```

如果看到 MongoDB 连接错误,检查:
- Docker 容器是否在运行: `docker ps`
- `.env` 文件配置是否正确

---

## Docker 常用命令

### 容器管理

```bash
# 启动容器
docker start mongodb

# 停止容器
docker stop mongodb

# 重启容器
docker restart mongodb

# 删除容器 (会删除容器但保留数据卷)
docker rm mongodb

# 查看容器日志
docker logs mongodb

# 进入容器 shell
docker exec -it mongodb mongosh -u admin -p 123456
```

### 数据管理

```bash
# 查看数据卷
docker volume ls

# 删除数据卷 (会清空所有数据!)
docker volume rm mongodb_data

# 备份数据
docker exec mongodb mongodump -u admin -p 123456 --authenticationDatabase admin -o /dump
docker cp mongodb:/dump ./backup

# 恢复数据
docker cp ./backup mongodb:/dump
docker exec mongodb mongorestore -u admin -p 123456 --authenticationDatabase admin /dump
```

---

## 方案二: 直接安装 MongoDB (不推荐)

### macOS 安装

```bash
# 使用 Homebrew 安装
brew tap mongodb/brew
brew install mongodb-community@8.0

# 启动 MongoDB
brew services start mongodb-community@8.0

# 停止 MongoDB
brew services stop mongodb-community@8.0

# 查看状态
brew services list
```

**配置 .env:**
```env
PORT=3000

# 本地无认证 MongoDB
MONGO_USER=
MONGO_PASSWORD=
MONGO_HOST=localhost:27017
MONGO_DATABASE=booking_dev
```

### Windows 安装

1. 下载: https://www.mongodb.com/try/download/community
2. 安装时选择 "Complete" 安装
3. 勾选 "Install MongoDB as a Service"
4. 服务会自动启动

**配置 .env:**
```env
PORT=3000

# 本地无认证 MongoDB
MONGO_USER=
MONGO_PASSWORD=
MONGO_HOST=localhost:27017
MONGO_DATABASE=booking_dev
```

---

## 使用 MongoDB Compass (可视化工具)

### 1. 安装 MongoDB Compass

下载: https://www.mongodb.com/try/download/compass

### 2. 连接本地数据库

**Docker MongoDB (带认证):**
```
mongodb://admin:123456@localhost:27017
```

**本地 MongoDB (无认证):**
```
mongodb://localhost:27017
```

### 3. 查看数据

1. 连接成功后,选择数据库 `booking_dev`
2. 可以看到两个集合:
   - `users` - 用户数据
   - `bookings` - 预约订单数据

### 4. 手动创建索引 (可选)

在 Compass 中选择集合 → Indexes → Create Index:

**bookings 集合索引:**
```json
// 单字段索引
{ "bookingId": 1 }
{ "wechatOpenId": 1 }
{ "bookingDate": 1 }
{ "status": 1 }
{ "licensePlate": 1 }

// 复合索引
{ "wechatOpenId": 1, "status": 1 }
{ "bookingDate": 1, "timeSlot": 1 }
```

**users 集合索引:**
```json
{ "userId": 1 }
{ "wechatOpenId": 1 }
```

---

## 测试 API

### 1. 创建测试用户

```bash
curl -X POST http://localhost:3000/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "wechatOpenId": "test_user_001",
    "wechatNickname": "测试用户",
    "wechatAvatarUrl": "https://example.com/avatar.png"
  }'
```

### 2. 创建测试订单

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
    "remarks": "测试订单"
  }'
```

### 3. 查询订单

```bash
curl -X GET "http://localhost:3000/bookings?wechatOpenId=test_user_001&page=1&pageSize=10"
```

---

## 环境切换

### 开发环境 → 生产环境

**1. 修改 .env 文件:**

```env
PORT=3000

# 生产环境 (MongoDB Atlas)
MONGO_USER=your_atlas_username
MONGO_PASSWORD=your_atlas_password
MONGO_HOST=your-cluster.mongodb.net
MONGO_DATABASE=booking_prod
```

**2. 重启项目:**
```bash
npm run start:prod
```

### 使用不同的环境文件

```bash
# 开发环境
cp .env.example .env.development
# 编辑 .env.development

# 生产环境
cp .env.example .env.production
# 编辑 .env.production

# 使用指定环境文件启动
NODE_ENV=development npm run start:dev
NODE_ENV=production npm run start:prod
```

---

## 常见问题

### Q: MongoDB 容器启动失败?

**检查端口占用:**
```bash
# macOS/Linux
lsof -i :27017

# Windows (PowerShell)
netstat -ano | findstr :27017
```

**解决方案:**
- 停止占用端口的程序
- 或者修改 Docker 端口映射: `-p 27018:27017`

### Q: 连接 MongoDB 超时?

**检查 Docker 容器状态:**
```bash
docker ps -a
```

如果容器已停止:
```bash
docker start mongodb
```

### Q: 忘记 MongoDB 密码?

**重新创建容器:**
```bash
# 停止并删除旧容器
docker stop mongodb
docker rm mongodb

# 创建新容器
docker run -d \
  --name mongodb \
  -p 27017:27017 \
  -e MONGO_INITDB_ROOT_USERNAME=admin \
  -e MONGO_INITDB_ROOT_PASSWORD=new_password \
  mongo:8.0
```

### Q: 如何清空所有数据?

**方法一: 删除数据卷**
```bash
docker stop mongodb
docker rm mongodb
docker volume rm mongodb_data
# 重新创建容器
```

**方法二: 使用 Compass**
- 连接数据库
- 删除 `booking_dev` 数据库

**方法三: 使用命令行**
```bash
docker exec -it mongodb mongosh -u admin -p 123456
> use booking_dev
> db.dropDatabase()
```

### Q: 如何导入测试数据?

**创建测试数据脚本 (test-data.js):**
```javascript
// test-data.js
db = db.getSiblingDB('booking_dev');

// 插入测试用户
db.users.insertMany([
  {
    userId: "test-user-001",
    wechatOpenId: "test_openid_001",
    wechatNickname: "测试用户1",
    createdAt: new Date()
  },
  {
    userId: "test-user-002",
    wechatOpenId: "test_openid_002",
    wechatNickname: "测试用户2",
    createdAt: new Date()
  }
]);

// 插入测试订单
db.bookings.insertMany([
  {
    bookingId: "booking-001",
    wechatOpenId: "test_openid_001",
    contactName: "张三",
    contactGender: "male",
    contactPhone: "13800138000",
    contactIdCard: "110101199001011234",
    bookingDate: new Date("2024-03-15"),
    timeSlot: "morning",
    travelMode: "scenic_bus",
    numberOfPeople: 3,
    status: "pending",
    createdAt: new Date()
  }
]);
```

**导入数据:**
```bash
docker cp test-data.js mongodb:/test-data.js
docker exec -it mongodb mongosh -u admin -p 123456 --authenticationDatabase admin booking_dev /test-data.js
```

---

## 性能优化建议

### 1. 创建索引

项目启动后,索引会自动创建 (在 entity 中定义)。

验证索引:
```bash
docker exec -it mongodb mongosh -u admin -p 123456
> use booking_dev
> db.bookings.getIndexes()
```

### 2. 监控查询性能

```bash
# 启用 MongoDB 慢查询日志
docker exec -it mongodb mongosh -u admin -p 123456
> db.setProfilingLevel(1, { slowms: 100 })
> db.system.profile.find().limit(5).sort({ ts: -1 })
```

### 3. 查看数据库统计

```bash
> use booking_dev
> db.stats()
> db.bookings.stats()
```

---

## 备份和恢复

### 自动备份脚本

**backup.sh:**
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./backups/$DATE"

mkdir -p $BACKUP_DIR

docker exec mongodb mongodump \
  -u admin \
  -p 123456 \
  --authenticationDatabase admin \
  -d booking_dev \
  -o /dump

docker cp mongodb:/dump/booking_dev $BACKUP_DIR

echo "Backup completed: $BACKUP_DIR"
```

**使用:**
```bash
chmod +x backup.sh
./backup.sh
```

### 恢复数据

```bash
docker cp ./backups/20240302_100000/booking_dev mongodb:/dump/

docker exec mongodb mongorestore \
  -u admin \
  -p 123456 \
  --authenticationDatabase admin \
  -d booking_dev \
  /dump/booking_dev
```

---

## 下一步

1. ✅ 启动本地 MongoDB
2. ✅ 配置 .env 文件
3. ✅ 启动项目: `npm run start:dev`
4. ✅ 测试 API 接口
5. ✅ 使用 Compass 查看数据
6. 🚀 开始开发!

## 相关文档

- [快速开始指南](./QUICK_START.md)
- [API 文档](./BOOKING_API_GUIDE.md)
- [分页功能](./PAGINATION_GUIDE.md)
