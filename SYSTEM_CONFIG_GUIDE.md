# 系统配置模块使用指南

## 概述

系统配置模块采用**单文档模式**存储所有系统配置，包括：
- 轮播图配置
- 预约开关
- 时间段预约人数限制

## 数据结构

### 系统配置对象
```typescript
{
  configId: 'system_config',          // 固定ID
  bookingEnabled: true,                // 是否允许预约
  banners: [                           // 轮播图数组
    {
      title: '轮播图标题',
      imageUrl: 'https://example.com/banner1.jpg',
      linkUrl: 'https://example.com',  // 可选
      sortOrder: 0
    }
  ],
  timeSlotLimit: {                     // 时间段人数限制
    morningMaxPeople: 100,             // 上午最大人数
    afternoonMaxPeople: 100            // 下午最大人数
  },
  createdAt: Date,
  updatedAt: Date
}
```

---

## API 接口

### 1. 获取系统配置
```http
GET /system-config
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "configId": "system_config",
    "bookingEnabled": true,
    "banners": [
      {
        "title": "春季活动",
        "imageUrl": "https://example.com/banner1.jpg",
        "linkUrl": "https://example.com/spring",
        "sortOrder": 0
      },
      {
        "title": "优惠活动",
        "imageUrl": "https://example.com/banner2.jpg",
        "sortOrder": 1
      }
    ],
    "timeSlotLimit": {
      "morningMaxPeople": 100,
      "afternoonMaxPeople": 80
    },
    "createdAt": "2024-03-15T08:00:00.000Z",
    "updatedAt": "2024-03-15T10:30:00.000Z"
  }
}
```

---

### 2. 更新系统配置 (管理员)
```http
PUT /system-config
Content-Type: application/json
```

**请求体**:
```json
{
  "bookingEnabled": false,
  "banners": [
    {
      "title": "新春特惠",
      "imageUrl": "https://example.com/new-banner.jpg",
      "linkUrl": "https://example.com/promotion",
      "sortOrder": 0
    }
  ],
  "timeSlotLimit": {
    "morningMaxPeople": 150,
    "afternoonMaxPeople": 120
  }
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "系统配置更新成功",
  "data": {
    "configId": "system_config",
    "bookingEnabled": false,
    "banners": [...],
    "timeSlotLimit": {...}
  }
}
```

**注意**:
- 所有字段都是可选的，只更新提供的字段
- `banners` 数组会完全替换，不是追加

---

### 3. 获取预约开关状态
```http
GET /system-config/booking-enabled
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "bookingEnabled": true
  }
}
```

---

### 4. 获取时间段人数限制
```http
GET /system-config/time-slot-limit
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "morningMaxPeople": 100,
    "afternoonMaxPeople": 80
  }
}
```

---

## 预约统计接口

### 统计指定日期的预约人数
```http
GET /bookings/stats/by-date?bookingDate=2024-03-15
```

**查询参数**:
- `bookingDate`: 预约日期 (YYYY-MM-DD 格式)

**响应示例**:
```json
{
  "success": true,
  "data": {
    "date": "2024-03-15",
    "morning": {
      "totalPeople": 85,      // 上午总预约人数
      "bookingCount": 12      // 上午订单数
    },
    "afternoon": {
      "totalPeople": 63,      // 下午总预约人数
      "bookingCount": 9       // 下午订单数
    }
  }
}
```

**说明**:
- 只统计未取消的订单 (`status != 'cancelled'`)
- 按 `timeSlot` (上午/下午) 分组统计
- `totalPeople` 是所有订单的 `numberOfPeople` 总和

---

## 使用场景

### 场景 1: 小程序端获取轮播图
```typescript
// 前端代码示例
async function getBanners() {
  const response = await fetch('/system-config');
  const { data } = await response.json();
  return data.banners.sort((a, b) => a.sortOrder - b.sortOrder);
}
```

### 场景 2: 检查是否可以预约
```typescript
async function canBook() {
  const response = await fetch('/system-config/booking-enabled');
  const { data } = await response.json();

  if (!data.bookingEnabled) {
    alert('当前暂停预约，请稍后再试');
    return false;
  }
  return true;
}
```

### 场景 3: 检查预约人数是否超限
```typescript
async function checkAvailability(date: string, timeSlot: 'morning' | 'afternoon') {
  // 获取限制
  const limitRes = await fetch('/system-config/time-slot-limit');
  const { data: limit } = await limitRes.json();

  // 获取当前预约人数
  const statsRes = await fetch(`/bookings/stats/by-date?bookingDate=${date}`);
  const { data: stats } = await statsRes.json();

  const maxPeople = timeSlot === 'morning'
    ? limit.morningMaxPeople
    : limit.afternoonMaxPeople;

  const currentPeople = timeSlot === 'morning'
    ? stats.morning.totalPeople
    : stats.afternoon.totalPeople;

  if (currentPeople >= maxPeople) {
    alert('该时间段预约人数已满');
    return false;
  }

  return true;
}
```

### 场景 4: 管理员更新轮播图
```typescript
async function updateBanners(newBanners) {
  const response = await fetch('/system-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ banners: newBanners })
  });

  const result = await response.json();
  console.log('更新成功:', result.message);
}
```

---

## 数据验证规则

### 轮播图配置
- `title`: 必填，字符串
- `imageUrl`: 必填，有效的 URL
- `linkUrl`: 可选，有效的 URL
- `sortOrder`: 必填，整数，最小值 0

### 时间段限制
- `morningMaxPeople`: 必填，整数，最小值 1
- `afternoonMaxPeople`: 必填，整数，最小值 1

### 预约开关
- `bookingEnabled`: 布尔值

---

## 迁移指南

### 从旧的 Banner 模块迁移

如果之前使用独立的 Banner 表，可以通过以下脚本迁移：

```typescript
// 迁移脚本示例
async function migrateBanners() {
  // 1. 查询旧的 Banner 数据
  const oldBanners = await BannerModel.find({ isActive: true })
    .sort({ sortOrder: 1 })
    .lean();

  // 2. 转换为新格式
  const newBanners = oldBanners.map(banner => ({
    title: banner.title,
    imageUrl: banner.imageUrl,
    linkUrl: banner.linkUrl,
    sortOrder: banner.sortOrder
  }));

  // 3. 更新到系统配置
  await SystemConfigModel.findOneAndUpdate(
    { configId: 'system_config' },
    { banners: newBanners },
    { upsert: true }
  );

  console.log('迁移完成');
}
```

---

## 注意事项

1. **单文档模式**: 系统配置使用单文档存储，`configId` 固定为 `system_config`
2. **首次访问**: 如果配置不存在，会自动创建默认配置
3. **并发更新**: 使用 `findOneAndUpdate` 确保原子性操作
4. **轮播图替换**: 更新 `banners` 时会完全替换，不是追加
5. **统计准确性**: 预约统计排除了已取消的订单
6. **性能优化**: 使用 MongoDB 聚合管道统计，性能较好

---

## 测试用例

### 测试 1: 获取默认配置
```bash
curl http://localhost:3000/system-config
```

### 测试 2: 更新预约开关
```bash
curl -X PUT http://localhost:3000/system-config \
  -H "Content-Type: application/json" \
  -d '{"bookingEnabled": false}'
```

### 测试 3: 更新轮播图
```bash
curl -X PUT http://localhost:3000/system-config \
  -H "Content-Type: application/json" \
  -d '{
    "banners": [
      {
        "title": "测试轮播图",
        "imageUrl": "https://example.com/test.jpg",
        "sortOrder": 0
      }
    ]
  }'
```

### 测试 4: 查询预约统计
```bash
curl "http://localhost:3000/bookings/stats/by-date?bookingDate=2024-03-15"
```

---

## 常见问题

### Q1: 如何添加新的系统配置项？
**A**: 修改 `SystemConfig` entity，添加新字段，然后更新 DTO 和 Service。

### Q2: 轮播图数量有限制吗？
**A**: 没有硬性限制，但建议不超过 10 个，避免加载过慢。

### Q3: 预约统计是实时的吗？
**A**: 是的，每次调用都会实时统计数据库中的数据。

### Q4: 如何备份系统配置？
**A**:
```bash
# 导出配置
mongoexport --db=booking_dev --collection=systemconfigs --out=config-backup.json

# 恢复配置
mongoimport --db=booking_dev --collection=systemconfigs --file=config-backup.json
```

---

## 后续优化建议

1. **添加配置历史记录**: 记录每次配置变更
2. **添加配置版本控制**: 支持回滚到历史版本
3. **添加配置缓存**: 使用 Redis 缓存配置，减少数据库查询
4. **添加配置校验**: 更新前校验配置的合理性
5. **添加配置审计日志**: 记录谁在什么时候修改了什么配置
