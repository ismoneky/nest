# 系统配置与预约统计 - 快速使用指南

## 🚀 快速开始

### 1. 启动应用
```bash
npm run start:dev
```

### 2. 初始化系统配置 (可选)
```bash
npm run init-config
```

---

## 📱 小程序端使用

### 场景 1: 获取首页轮播图
```typescript
// pages/index/index.ts
Page({
  async onLoad() {
    // 获取系统配置
    const res = await wx.request({
      url: 'https://your-api.com/system-config',
      method: 'GET'
    });

    // 提取轮播图
    const banners = res.data.data.banners;

    // 按顺序排序
    this.setData({
      banners: banners.sort((a, b) => a.sortOrder - b.sortOrder)
    });
  }
});
```

### 场景 2: 预约前检查
```typescript
// pages/booking/booking.ts
Page({
  async submitBooking(date: string, timeSlot: 'morning' | 'afternoon', people: number) {
    // 1. 检查系统是否允许预约
    const enabledRes = await wx.request({
      url: 'https://your-api.com/system-config/booking-enabled'
    });

    if (!enabledRes.data.data.bookingEnabled) {
      wx.showToast({ title: '系统暂停预约', icon: 'none' });
      return;
    }

    // 2. 检查名额是否充足
    const limitRes = await wx.request({
      url: 'https://your-api.com/system-config/time-slot-limit'
    });
    const limit = limitRes.data.data;

    const statsRes = await wx.request({
      url: `https://your-api.com/bookings/stats/by-date?bookingDate=${date}`
    });
    const stats = statsRes.data.data;

    // 计算剩余名额
    const maxPeople = timeSlot === 'morning'
      ? limit.morningMaxPeople
      : limit.afternoonMaxPeople;

    const currentPeople = timeSlot === 'morning'
      ? stats.morning.totalPeople
      : stats.afternoon.totalPeople;

    const available = maxPeople - currentPeople;

    if (available < people) {
      wx.showToast({
        title: `名额不足，剩余${available}人`,
        icon: 'none'
      });
      return;
    }

    // 3. 提交预约
    await wx.request({
      url: 'https://your-api.com/bookings',
      method: 'POST',
      data: { date, timeSlot, numberOfPeople: people, /* ... */ }
    });

    wx.showToast({ title: '预约成功', icon: 'success' });
  }
});
```

### 场景 3: 显示剩余名额
```typescript
// pages/booking/booking.ts
Page({
  async loadAvailableSlots(date: string) {
    // 获取限制和统计
    const [limitRes, statsRes] = await Promise.all([
      wx.request({ url: 'https://your-api.com/system-config/time-slot-limit' }),
      wx.request({ url: `https://your-api.com/bookings/stats/by-date?bookingDate=${date}` })
    ]);

    const limit = limitRes.data.data;
    const stats = statsRes.data.data;

    // 计算剩余
    this.setData({
      morningAvailable: limit.morningMaxPeople - stats.morning.totalPeople,
      afternoonAvailable: limit.afternoonMaxPeople - stats.afternoon.totalPeople
    });
  }
});
```

---

## 🖥️ 管理后台使用

### 场景 1: 更新轮播图
```typescript
// 管理后台
async function updateBanners() {
  const newBanners = [
    {
      title: '春季特惠',
      imageUrl: 'https://cdn.example.com/spring-sale.jpg',
      linkUrl: 'https://example.com/promotion',
      sortOrder: 0
    },
    {
      title: '新品上市',
      imageUrl: 'https://cdn.example.com/new-products.jpg',
      sortOrder: 1
    }
  ];

  const response = await fetch('https://your-api.com/system-config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ banners: newBanners })
  });

  const result = await response.json();
  alert(result.message); // "系统配置更新成功"
}
```

### 场景 2: 临时关闭预约
```typescript
// 系统维护时暂停预约
async function disableBooking() {
  await fetch('https://your-api.com/system-config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      bookingEnabled: false
    })
  });

  alert('预约功能已关闭');
}

// 维护完成后重新开启
async function enableBooking() {
  await fetch('https://your-api.com/system-config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      bookingEnabled: true
    })
  });

  alert('预约功能已开启');
}
```

### 场景 3: 调整预约人数限制
```typescript
// 节假日增加名额
async function increaseLimit() {
  await fetch('https://your-api.com/system-config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      timeSlotLimit: {
        morningMaxPeople: 150,  // 从100增加到150
        afternoonMaxPeople: 150
      }
    })
  });

  alert('人数限制已更新');
}
```

### 场景 4: 查看今日预约统计
```typescript
// 管理后台 - 实时统计
async function getTodayStatistics() {
  const today = new Date().toISOString().split('T')[0];

  const [configRes, statsRes] = await Promise.all([
    fetch('https://your-api.com/system-config/time-slot-limit'),
    fetch(`https://your-api.com/bookings/stats/by-date?bookingDate=${today}`)
  ]);

  const limit = (await configRes.json()).data;
  const stats = (await statsRes.json()).data;

  // 显示统计信息
  console.log(`📊 今日预约统计 (${today})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌅 上午:`);
  console.log(`   已预约: ${stats.morning.totalPeople}/${limit.morningMaxPeople}人`);
  console.log(`   订单数: ${stats.morning.bookingCount}单`);
  console.log(`   剩余: ${limit.morningMaxPeople - stats.morning.totalPeople}人`);
  console.log('');
  console.log(`🌆 下午:`);
  console.log(`   已预约: ${stats.afternoon.totalPeople}/${limit.afternoonMaxPeople}人`);
  console.log(`   订单数: ${stats.afternoon.bookingCount}单`);
  console.log(`   剩余: ${limit.afternoonMaxPeople - stats.afternoon.totalPeople}人`);
}
```

---

## 🧪 测试 API

### 使用 curl 测试

```bash
# 1. 获取系统配置
curl http://localhost:3000/system-config

# 2. 更新配置
curl -X PUT http://localhost:3000/system-config \
  -H "Content-Type: application/json" \
  -d '{
    "bookingEnabled": true,
    "banners": [
      {
        "title": "测试轮播图",
        "imageUrl": "https://example.com/test.jpg",
        "sortOrder": 0
      }
    ],
    "timeSlotLimit": {
      "morningMaxPeople": 100,
      "afternoonMaxPeople": 100
    }
  }'

# 3. 查询今日预约统计
TODAY=$(date +%Y-%m-%d)
curl "http://localhost:3000/bookings/stats/by-date?bookingDate=$TODAY"

# 4. 检查预约开关
curl http://localhost:3000/system-config/booking-enabled

# 5. 获取人数限制
curl http://localhost:3000/system-config/time-slot-limit
```

### 使用 Postman 测试

#### 1. 获取配置
```
GET http://localhost:3000/system-config
```

#### 2. 更新配置
```
PUT http://localhost:3000/system-config
Content-Type: application/json

{
  "bookingEnabled": false,
  "timeSlotLimit": {
    "morningMaxPeople": 50,
    "afternoonMaxPeople": 50
  }
}
```

#### 3. 查询统计
```
GET http://localhost:3000/bookings/stats/by-date?bookingDate=2024-03-15
```

---

## 📊 数据示例

### 系统配置响应示例
```json
{
  "success": true,
  "data": {
    "configId": "system_config",
    "bookingEnabled": true,
    "banners": [
      {
        "title": "欢迎使用预约系统",
        "imageUrl": "https://example.com/banner1.jpg",
        "linkUrl": "https://example.com/welcome",
        "sortOrder": 0
      },
      {
        "title": "在线预约更便捷",
        "imageUrl": "https://example.com/banner2.jpg",
        "sortOrder": 1
      }
    ],
    "timeSlotLimit": {
      "morningMaxPeople": 100,
      "afternoonMaxPeople": 100
    },
    "createdAt": "2024-03-15T08:00:00.000Z",
    "updatedAt": "2024-03-15T10:30:00.000Z"
  }
}
```

### 预约统计响应示例
```json
{
  "success": true,
  "data": {
    "date": "2024-03-15",
    "morning": {
      "totalPeople": 85,
      "bookingCount": 12
    },
    "afternoon": {
      "totalPeople": 63,
      "bookingCount": 9
    }
  }
}
```

---

## ⚠️ 注意事项

1. **轮播图更新**: 更新 `banners` 时会完全替换，不是追加
2. **统计准确性**: 预约统计排除了 `status='cancelled'` 的订单
3. **日期格式**: 统计接口的日期格式必须是 `YYYY-MM-DD`
4. **权限控制**: 建议为管理员接口添加认证守卫
5. **并发安全**: 使用 MongoDB 的 `findOneAndUpdate` 确保原子性

---

## 🔗 相关链接

- [完整功能说明](./FEATURE_SUMMARY.md)
- [详细 API 文档](./SYSTEM_CONFIG_GUIDE.md)
- [内存优化说明](./MEMORY_LEAK_FIXES.md)

---

## 💡 常见场景速查

| 场景 | API | 方法 |
|------|-----|------|
| 获取轮播图 | `/system-config` | GET |
| 检查能否预约 | `/system-config/booking-enabled` | GET |
| 查看剩余名额 | `/bookings/stats/by-date?bookingDate=DATE` | GET |
| 关闭预约 | `/system-config` + `{"bookingEnabled": false}` | PUT |
| 更新轮播图 | `/system-config` + `{"banners": [...]}` | PUT |
| 调整人数限制 | `/system-config` + `{"timeSlotLimit": {...}}` | PUT |
| 查看今日统计 | `/bookings/stats/by-date?bookingDate=TODAY` | GET |

---

## 🆘 遇到问题？

1. **配置未生效**: 检查是否调用了 `PUT /system-config` 接口
2. **统计数据为0**: 确认日期格式是否正确 (`YYYY-MM-DD`)
3. **轮播图不显示**: 检查 `imageUrl` 是否可访问
4. **预约失败**: 检查 `bookingEnabled` 是否为 `true`
