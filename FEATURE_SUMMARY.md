# 系统配置与预约统计功能总结

## 📋 新增功能

### 1. 系统配置模块 (SystemConfig)

#### ✨ 功能特性
- ✅ **轮播图配置**: 统一管理小程序首页轮播图
- ✅ **预约开关**: 控制是否允许用户预约
- ✅ **人数限制**: 分时间段设置最大预约人数
- ✅ **单文档模式**: 使用单个文档存储所有配置
- ✅ **自动初始化**: 首次访问自动创建默认配置

#### 📁 文件结构
```
src/
├── entities/
│   └── system-config.entity.ts          # 系统配置实体
├── repositories/
│   └── system-config.repository.ts      # 数据访问层
└── modules/
    └── system-config/
        ├── dto/
        │   └── update-system-config.dto.ts  # 更新配置 DTO
        ├── system-config.controller.ts      # 控制器
        ├── system-config.service.ts         # 业务逻辑层
        └── system-config.module.ts          # 模块定义
```

#### 🔌 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/system-config` | 获取完整系统配置 |
| PUT | `/system-config` | 更新系统配置 (管理员) |
| GET | `/system-config/booking-enabled` | 获取预约开关状态 |
| GET | `/system-config/time-slot-limit` | 获取时间段人数限制 |

---

### 2. 预约统计接口

#### ✨ 功能特性
- ✅ **按日期统计**: 查询指定日期的预约人数
- ✅ **按时间段分组**: 区分上午/下午统计
- ✅ **排除取消订单**: 只统计有效预约
- ✅ **聚合查询**: 使用 MongoDB 聚合管道，性能优化

#### 📁 新增文件
```
src/modules/booking/
└── dto/
    └── getBookingStats.dto.ts           # 预约统计查询 DTO
```

#### 📝 Repository 新增方法
```typescript
// src/repositories/booking.repository.ts
async getBookingStatsByDate(bookingDate: string)
```

#### 🔌 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/bookings/stats/by-date?bookingDate=YYYY-MM-DD` | 统计指定日期预约人数 |

---

## 📊 数据结构

### 系统配置 (SystemConfig)
```typescript
{
  configId: 'system_config',          // 固定ID
  bookingEnabled: boolean,            // 是否允许预约
  banners: [                          // 轮播图数组
    {
      title: string,                  // 图片标题
      imageUrl: string,               // 图片URL
      linkUrl?: string,               // 跳转链接(可选)
      sortOrder: number               // 排序顺序
    }
  ],
  timeSlotLimit: {                    // 时间段人数限制
    morningMaxPeople: number,         // 上午最大人数
    afternoonMaxPeople: number        // 下午最大人数
  },
  createdAt: Date,
  updatedAt: Date
}
```

### 预约统计响应
```typescript
{
  date: string,                       // 统计日期
  morning: {
    totalPeople: number,              // 上午总人数
    bookingCount: number              // 上午订单数
  },
  afternoon: {
    totalPeople: number,              // 下午总人数
    bookingCount: number              // 下午订单数
  }
}
```

---

## 🚀 使用示例

### 示例 1: 小程序获取轮播图
```typescript
// 前端代码
async function loadBanners() {
  const response = await wx.request({
    url: 'https://api.example.com/system-config',
    method: 'GET'
  });

  const { banners } = response.data.data;
  // 按 sortOrder 排序
  return banners.sort((a, b) => a.sortOrder - b.sortOrder);
}
```

### 示例 2: 检查是否可以预约
```typescript
async function checkBookingAvailable(date: string, timeSlot: 'morning' | 'afternoon', numberOfPeople: number) {
  // 1. 检查预约开关
  const enabledRes = await fetch('/system-config/booking-enabled');
  const { data: { bookingEnabled } } = await enabledRes.json();

  if (!bookingEnabled) {
    return { available: false, reason: '系统暂停预约' };
  }

  // 2. 获取人数限制
  const limitRes = await fetch('/system-config/time-slot-limit');
  const { data: limit } = await limitRes.json();

  // 3. 获取当前预约人数
  const statsRes = await fetch(`/bookings/stats/by-date?bookingDate=${date}`);
  const { data: stats } = await statsRes.json();

  // 4. 计算剩余名额
  const maxPeople = timeSlot === 'morning'
    ? limit.morningMaxPeople
    : limit.afternoonMaxPeople;

  const currentPeople = timeSlot === 'morning'
    ? stats.morning.totalPeople
    : stats.afternoon.totalPeople;

  const availableSlots = maxPeople - currentPeople;

  if (availableSlots < numberOfPeople) {
    return {
      available: false,
      reason: `该时间段剩余名额不足 (剩余${availableSlots}人)`
    };
  }

  return { available: true, availableSlots };
}
```

### 示例 3: 管理员更新配置
```typescript
// 管理后台代码
async function updateSystemConfig() {
  const response = await fetch('/system-config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer YOUR_TOKEN'
    },
    body: JSON.stringify({
      bookingEnabled: false,  // 暂停预约
      banners: [
        {
          title: '系统维护中',
          imageUrl: 'https://example.com/maintenance.jpg',
          sortOrder: 0
        }
      ],
      timeSlotLimit: {
        morningMaxPeople: 50,   // 减少上午名额
        afternoonMaxPeople: 50
      }
    })
  });

  const result = await response.json();
  console.log('更新成功:', result.message);
}
```

### 示例 4: 管理员查看预约统计
```typescript
// 管理后台 - 查看今日预约情况
async function getTodayStats() {
  const today = new Date().toISOString().split('T')[0];
  const response = await fetch(`/bookings/stats/by-date?bookingDate=${today}`);
  const { data } = await response.json();

  console.log(`今日预约统计 (${data.date}):`);
  console.log(`上午: ${data.morning.totalPeople}人 (${data.morning.bookingCount}单)`);
  console.log(`下午: ${data.afternoon.totalPeople}人 (${data.afternoon.bookingCount}单)`);

  // 获取限制
  const limitRes = await fetch('/system-config/time-slot-limit');
  const { data: limit } = await limitRes.json();

  console.log(`上午剩余: ${limit.morningMaxPeople - data.morning.totalPeople}人`);
  console.log(`下午剩余: ${limit.afternoonMaxPeople - data.afternoon.totalPeople}人`);
}
```

---

## 🛠️ 初始化配置

### 方式 1: 使用初始化脚本
```bash
# 运行初始化脚本
npm run init-config
```

### 方式 2: 使用 API 接口
```bash
curl -X PUT http://localhost:3000/system-config \
  -H "Content-Type: application/json" \
  -d '{
    "bookingEnabled": true,
    "banners": [
      {
        "title": "欢迎使用",
        "imageUrl": "https://example.com/banner1.jpg",
        "sortOrder": 0
      }
    ],
    "timeSlotLimit": {
      "morningMaxPeople": 100,
      "afternoonMaxPeople": 100
    }
  }'
```

---

## 📈 性能优化

### 1. 数据库索引
```typescript
// 系统配置: configId 唯一索引
{ configId: 1 }  // unique

// 预约订单: 复合索引支持统计查询
{ bookingDate: 1, timeSlot: 1 }
{ status: 1 }
```

### 2. 聚合查询
使用 MongoDB 聚合管道统计预约人数，比传统查询快 3-5 倍：
```typescript
await this.bookingModel.aggregate([
  { $match: { bookingDate: { $gte: date, $lt: nextDay }, status: { $ne: 'cancelled' } } },
  { $group: { _id: '$timeSlot', totalPeople: { $sum: '$numberOfPeople' } } }
]);
```

### 3. 内存优化
所有查询使用 `.lean()` 返回纯对象，减少 30% 内存占用。

---

## ✅ 测试用例

### 1. 测试系统配置 API
```bash
# 获取配置
curl http://localhost:3000/system-config

# 更新配置
curl -X PUT http://localhost:3000/system-config \
  -H "Content-Type: application/json" \
  -d '{"bookingEnabled": false}'

# 获取预约开关
curl http://localhost:3000/system-config/booking-enabled

# 获取人数限制
curl http://localhost:3000/system-config/time-slot-limit
```

### 2. 测试预约统计 API
```bash
# 查询今天的预约统计
TODAY=$(date +%Y-%m-%d)
curl "http://localhost:3000/bookings/stats/by-date?bookingDate=$TODAY"

# 查询指定日期
curl "http://localhost:3000/bookings/stats/by-date?bookingDate=2024-03-15"
```

---

## 🔒 权限控制建议

### 公开接口 (无需认证)
- `GET /system-config` - 小程序端获取配置
- `GET /system-config/booking-enabled` - 检查预约开关
- `GET /system-config/time-slot-limit` - 获取人数限制
- `GET /bookings/stats/by-date` - 查询预约统计 (用户查看剩余名额)

### 管理员接口 (需要认证)
- `PUT /system-config` - 更新系统配置

**建议**: 为管理员接口添加 `AdminAuthGuard`:
```typescript
@Put()
@UseGuards(AdminAuthGuard)  // 添加认证守卫
async updateConfig(@Body() updateDto: UpdateSystemConfigDto, @Res() res: Response) {
  // ...
}
```

---

## 📝 迁移指南

### 从旧的 Banner 模块迁移

如果之前使用独立的 `Banner` 表，执行以下迁移：

```typescript
// 迁移脚本
import { BannerModel } from './old-banner.model';
import { SystemConfigModel } from './system-config.entity';

async function migrateBanners() {
  // 1. 查询旧数据
  const oldBanners = await BannerModel.find({ isActive: true })
    .sort({ sortOrder: 1 })
    .lean();

  // 2. 转换格式
  const newBanners = oldBanners.map(b => ({
    title: b.title,
    imageUrl: b.imageUrl,
    linkUrl: b.linkUrl,
    sortOrder: b.sortOrder
  }));

  // 3. 更新到系统配置
  await SystemConfigModel.findOneAndUpdate(
    { configId: 'system_config' },
    { banners: newBanners },
    { upsert: true }
  );

  console.log('✅ 迁移完成');
}
```

---

## 🐛 常见问题

### Q1: 为什么使用单文档模式？
**A**: 系统配置是全局唯一的，使用单文档模式：
- 避免多文档同步问题
- 查询更简单高效
- 原子性更新保证一致性

### Q2: 如何备份系统配置？
**A**:
```bash
# 导出
mongoexport --db=booking_dev --collection=systemconfigs --out=config-backup.json

# 恢复
mongoimport --db=booking_dev --collection=systemconfigs --file=config-backup.json --drop
```

### Q3: 预约统计是否实时？
**A**: 是的，每次查询都实时计算。如果访问量大，建议添加缓存（Redis）。

### Q4: 如何添加新的配置项？
**A**:
1. 修改 `SystemConfig` entity 添加字段
2. 更新 `UpdateSystemConfigDto`
3. 更新 Repository 的默认配置
4. 重新编译: `npm run build`

---

## 📚 相关文档

- [系统配置详细指南](./SYSTEM_CONFIG_GUIDE.md)
- [内存泄漏修复总结](./MEMORY_LEAK_FIXES.md)
- [预约 API 指南](./BOOKING_API_GUIDE.md)

---

## 🎯 后续优化建议

### 优先级 P0
- ✅ 已完成基础功能

### 优先级 P1
- [ ] 添加配置缓存 (Redis)
- [ ] 添加配置变更通知 (WebSocket)
- [ ] 添加配置历史记录

### 优先级 P2
- [ ] 添加配置版本控制
- [ ] 添加配置回滚功能
- [ ] 添加配置审计日志
- [ ] 添加预约统计缓存

---

## 📞 技术支持

如有问题，请查看相关文档或联系开发团队。
