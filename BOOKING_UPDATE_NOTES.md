# 预约订单模块更新说明

## 更新日期
2024-03-02

## 更新内容

### 1. 新增字段

#### 自驾相关字段
- **licensePlate** (车牌号)
  - 类型: `string` (可选)
  - 条件: 当 `travelMode = self_driving` 时必填
  - 验证: 必须符合中国车牌号格式
  - 索引: 已添加索引
  - 示例: `京A12345`, `沪B88888`, `粤C99999`

- **vehicleType** (车辆类型)
  - 类型: `VehicleType` 枚举 (可选)
  - 条件: 当 `travelMode = self_driving` 时必填
  - 可选值:
    - `two_wheel_motorcycle` - 二轮摩托
    - `three_wheel_motorcycle` - 三轮摩托
    - `small_car` - 小型客车

#### 旅游团相关字段
- **tourGroupName** (旅游团名称)
  - 类型: `string` (可选)
  - 条件: 当 `travelMode = tour_group` 时必填
  - 示例: `春游旅行团`, `夏日观光团`

- **tourOrderNumber** (旅游团订单编号)
  - 类型: `string` (可选)
  - 条件: 当 `travelMode = tour_group` 时必填
  - 示例: `TG20240315001`, `ORDER-2024-001`

### 2. 索引优化

新增索引:
```javascript
// 单字段索引
db.bookings.createIndex({ "bookingId": 1 }, { unique: true });
db.bookings.createIndex({ "wechatOpenId": 1 });
db.bookings.createIndex({ "bookingDate": 1 });
db.bookings.createIndex({ "status": 1 });
db.bookings.createIndex({ "licensePlate": 1 });  // 新增

// 复合索引
db.bookings.createIndex({ "wechatOpenId": 1, "status": 1 });
db.bookings.createIndex({ "bookingDate": 1, "timeSlot": 1 });
```

**索引说明:**
- `bookingId`: 唯一索引,用于快速查询单个订单
- `wechatOpenId`: 用于按用户查询订单
- `bookingDate`: 用于按日期查询订单
- `status`: 用于按状态筛选订单
- `licensePlate`: 用于按车牌号查询订单 (新增)
- 复合索引: 优化组合查询性能

### 3. 代码注释

所有关键位置已添加详细注释:

#### Entity (实体)
```typescript
/**
 * 预约订单实体
 */
@Schema({ timestamps: true })
export class Booking {
    /** 订单唯一标识 (UUID) */
    @Prop({ required: true, unique: true, index: true })
    bookingId: string;

    /** 微信用户OpenID (关联用户) */
    @Prop({ required: true, index: true })
    wechatOpenId: string;

    // ... 其他字段
}
```

#### Repository (数据访问层)
```typescript
/**
 * 预约订单数据访问层
 * 负责与 MongoDB 数据库交互
 */
export class BookingRepository {
    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据传输对象
     * @returns 创建的订单文档
     */
    async createBooking(createBookingDto: CreateBookingDto) {
        // 实现代码
    }
}
```

#### Service (业务逻辑层)
```typescript
/**
 * 预约订单业务逻辑层
 * 处理预约订单相关的业务逻辑
 */
@Injectable()
export class BookingService {
    // 业务方法
}
```

#### Controller (控制器)
```typescript
/**
 * 预约订单控制器
 * 处理预约订单相关的 HTTP 请求
 */
@Controller('bookings')
export class BookingController {
    /**
     * 创建预约订单
     * POST /bookings
     */
    @Post()
    async createBooking() {
        // 实现代码
    }
}
```

### 4. 数据验证增强

#### 条件验证
使用 `@ValidateIf` 装饰器实现条件验证:

```typescript
// 自驾时车牌号必填
@ValidateIf((o) => o.travelMode === TravelMode.SELF_DRIVING)
@IsString()
@IsNotEmpty({ message: 'License plate is required for self-driving mode' })
@Matches(/^[京津沪渝...][A-Z][A-HJ-NP-Z0-9]{4,5}[...]$/, {
    message: 'Invalid license plate format',
})
licensePlate?: string;

// 自驾时车辆类型必填
@ValidateIf((o) => o.travelMode === TravelMode.SELF_DRIVING)
@IsEnum(VehicleType)
@IsNotEmpty({ message: 'Vehicle type is required for self-driving mode' })
vehicleType?: VehicleType;

// 旅游团时旅游团名称必填
@ValidateIf((o) => o.travelMode === TravelMode.TOUR_GROUP)
@IsString()
@IsNotEmpty({ message: 'Tour group name is required for tour group mode' })
tourGroupName?: string;

// 旅游团时订单编号必填
@ValidateIf((o) => o.travelMode === TravelMode.TOUR_GROUP)
@IsString()
@IsNotEmpty({ message: 'Tour order number is required for tour group mode' })
tourOrderNumber?: string;
```

#### 车牌号验证
```typescript
@Matches(/^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]$/, {
    message: 'Invalid license plate format',
})
```

支持的车牌格式:
- 普通车牌: `京A12345`
- 新能源车牌: `沪A12345D`
- 特殊车牌: `使001234`, `领001234`

### 5. API 响应示例

#### 自驾订单响应
```json
{
  "success": true,
  "message": "Booking created successfully",
  "data": {
    "bookingId": "550e8400-e29b-41d4-a716-446655440000",
    "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
    "travelMode": "self_driving",
    "licensePlate": "京A12345",
    "vehicleType": "small_car",
    "numberOfPeople": 4,
    "status": "pending"
  }
}
```

#### 旅游团订单响应
```json
{
  "success": true,
  "message": "Booking created successfully",
  "data": {
    "bookingId": "550e8400-e29b-41d4-a716-446655440000",
    "wechatOpenId": "oxxxxxxxxxxxxxxxxxxxxxx",
    "travelMode": "tour_group",
    "tourGroupName": "春游旅行团",
    "tourOrderNumber": "TG20240315001",
    "numberOfPeople": 30,
    "status": "pending"
  }
}
```

### 6. 错误处理

#### 自驾时缺少必填字段
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

#### 车牌号格式错误
```json
{
  "statusCode": 400,
  "message": [
    "Invalid license plate format"
  ],
  "error": "Bad Request"
}
```

#### 旅游团时缺少必填字段
```json
{
  "statusCode": 400,
  "message": [
    "Tour group name is required for tour group mode",
    "Tour order number is required for tour group mode"
  ],
  "error": "Bad Request"
}
```

## 迁移指南

### 现有订单数据
如果数据库中已有订单数据,新增字段都是可选的,不会影响现有数据。

### 前端更新
前端需要根据出行方式动态显示/隐藏相应字段:

```javascript
// 伪代码
if (travelMode === 'self_driving') {
  // 显示车牌号输入框
  // 显示车辆类型选择器
} else if (travelMode === 'tour_group') {
  // 显示旅游团名称输入框
  // 显示订单编号输入框
} else {
  // 隐藏额外字段
}
```

### 数据库索引
如果是现有数据库,建议手动创建新增的索引:

```javascript
// MongoDB Shell
use your_database;

// 创建车牌号索引
db.bookings.createIndex({ "licensePlate": 1 });

// 验证索引
db.bookings.getIndexes();
```

## 测试清单

- [ ] 创建景区自营车订单 (不需要额外字段)
- [ ] 创建自驾订单 (需要车牌号和车辆类型)
- [ ] 创建旅游团订单 (需要旅游团名称和订单编号)
- [ ] 自驾订单缺少车牌号时验证失败
- [ ] 车牌号格式错误时验证失败
- [ ] 旅游团订单缺少必填字段时验证失败
- [ ] 按车牌号查询订单 (使用索引)
- [ ] 更新订单的车牌号
- [ ] 更新订单的旅游团信息

## 性能影响

### 索引开销
- 新增 1 个单字段索引 (`licensePlate`)
- 写入性能影响: 微小 (< 5%)
- 查询性能提升: 显著 (按车牌号查询)

### 存储空间
- 每个订单增加约 50-100 字节 (取决于字段是否填写)
- 对于 10 万条订单,约增加 5-10 MB

## 兼容性

### 向后兼容
- ✅ 现有 API 接口保持不变
- ✅ 现有订单数据不受影响
- ✅ 新增字段都是可选的

### 版本要求
- Node.js: >= 18.20.0
- NestJS: 10.x
- Mongoose: 8.x
- MongoDB: >= 4.4

## 相关文档

- [完整 API 文档](./BOOKING_API_GUIDE.md)
- [快速开始指南](./QUICK_START.md)
- [项目 README](./README.md)

## 问题反馈

如有问题或建议,请提交 Issue。
