# Schema 迁移方案

## 背景

当前后端使用 TypeORM，但生产环境 `synchronize=false`（见 `src/app.module.ts:32`），且没有 migration runner、`data-source.ts` 或 `migration:*` npm 脚本。这意味着生产环境的 schema 变更（加列、加索引、建表）不会自动生效，必须由明确的迁移机制执行。

支付可靠性设计在本期需要：

- 给 `bookings` 表加 5 个对账调度字段和 3 个复合索引。
- 新建 `booking_anomalies` 表。
- 为已有 `PAYING/REFUNDING` 订单补齐调度字段。

这些都不能依赖 `synchronize`，必须走 TypeORM migration runner。

## 目标

引入 TypeORM migration runner，负责所有 schema 变更，并永久关闭 `synchronize`。本期首次落地支付可靠性设计所需的全部变更；后续表结构变更一律走 migration，不再依赖自动同步。

## 决策

- 引入 `src/data-source.ts`，导出独立 `DataSource`，专供 CLI 迁移使用，不复用 Nest 运行时 DataSource。
- 在 `package.json` 增加 `migration:generate`、`migration:run`、`migration:revert`、`migration:show` 脚本。
- `src/migrations/` 目录用于存放迁移文件，由 `migration:generate` 生成、人工审阅后提交。
- 生产 `synchronize` 改为 `false`（开发环境可继续 `true` 以降低迭代摩擦，但提交前必须确认生成的迁移覆盖了所有 entity 变更）。
- `app.module.ts` 的 `TypeOrmModule.forRoot` 增加 `migrationsRun: true`，让进程启动时自动执行未应用的迁移；`migrations` 数组指向 `src/migrations/*.ts`。这样部署时无需单独执行 `migration:run`，但 CI 必须额外跑一次 `migration:run --dry-run` 校验无漂移。

## data-source.ts

```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { BookingAnomaly } from './entities/booking-anomaly.entity';
// 其余实体按现有 app.module.ts entities 列表导入

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: process.env.DATABASE_PATH || 'data/app.db',
  synchronize: false,
  migrationsRun: false,
  entities: [Booking, BookingAnomaly /* 其余实体 */],
  migrations: ['src/migrations/*.ts'],
});
```

要点：

- `synchronize: false`，CLI 永不自动改表。
- `migrationsRun: false`，CLI 显式执行才跑。
- 与 `app.module.ts` 的实体列表保持一致；新增实体必须同步加到两处。

## app.module.ts 改动

```ts
TypeOrmModule.forRoot({
  type: 'sqlite',
  database: process.env.DATABASE_PATH || 'data/app.db',
  synchronize: false,                       // 由原 NODE_ENV !== 'production' 改为固定 false
  migrationsRun: true,                      // 进程启动时执行未应用迁移
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  logging: process.env.DATABASE_LOGGING === 'true',
  entities: [User, UserProfile, Admin, Booking, Announcement, SystemConfig, AdminApplication, Feedback, Member, BookingAnomaly],
}),
```

要点：

- `synchronize` 固定 `false`，开发和生产一致，避免"开发靠 sync、生产靠迁移"两套行为。
- `migrationsRun: true` 让部署零额外步骤；但**首次部署前必须**在预发环境验证迁移可正确执行。
- `migrations` 用 `__dirname + '/migrations/*.{ts,js}'`，兼顾源码与编译产物。

## package.json 脚本

```json
{
  "scripts": {
    "migration:generate": "typeorm migration:generate -d src/data-source.ts",
    "migration:run": "typeorm migration:run -d src/data-source.ts",
    "migration:revert": "typeorm migration:revert -d src/data-source.ts",
    "migration:show": "typeorm migration:show -d src/data-source.ts"
  }
}
```

使用：

```bash
# 根据 entity 与当前 DB 差异生成迁移（必须先连一个干净的开发库）
npm run migration:generate -- src/migrations/AddReconcileFieldsAndAnomalyTable

# 审阅生成的 up/down，提交
# 上线前在预发库执行验证
npm run migration:run

# 回滚
npm run migration:revert

# 查看已应用迁移
npm run migration:show
```

## 首个迁移的内容

`AddReconcileFieldsAndAnomalyTable` 必须覆盖以下变更，由 `migration:generate` 生成后人工审阅：

### bookings 表新增列

| 列 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `reconcileKind` | varchar | NULL | `payment \| refund \| close \| null` |
| `reconcileNextAt` | integer | NULL | 下次对账时间（毫秒 epoch） |
| `reconcileAttempts` | integer | 0 | 连续失败次数 |
| `reconcileLastAt` | integer | NULL | 最近对账时间 |
| `reconcileLastErrorCode` | varchar | NULL | 稳定错误码 |

### bookings 新增索引

```text
idx_bookings_reconcile (reconcileKind, reconcileNextAt)
idx_bookings_payment_expired (paymentStatus, paymentExpiredAt)
idx_bookings_status_date (status, bookingDate)
```

### booking_anomalies 新表

字段与索引以 `payment-reliability-design.md`「异常订单记录」为准：唯一 `(bookingId, type)`，查询 `(status, nextRetryAt)`。详见设计文档表格。

### 已有订单补齐

迁移的 `up` 在建完列与索引后，执行一次性补齐：

```sql
UPDATE bookings
SET reconcileKind = 'payment',
    reconcileNextAt = :now
WHERE paymentStatus = 'paying'
  AND reconcileNextAt IS NULL;

UPDATE bookings
SET reconcileKind = 'refund',
    reconcileNextAt = :now
WHERE refundStatus = 'refunding'
  AND reconcileNextAt IS NULL;
```

`:now` 用迁移执行时的 epoch 毫秒。补齐只针对 `reconcileNextAt IS NULL`，不覆盖人工暂停的订单（设计文档要求保留 `NULL` 语义）。注意 `paymentStatus=refunding` 与 `refundStatus=refunding` 的区别：补齐退款走 `refundStatus` 字段，符合现有实体定义。

`down` 必须反向删除三组索引、五个列和 `booking_anomalies` 表。

## 验证

- 本地干净开发库执行 `migration:run`，`migration:show` 显示 `AddReconcileFieldsAndAnomalyTable` 已应用。
- `sqlite3 data/app.db ".schema bookings"` 确认五个新列与三个新索引存在。
- `sqlite3 data/app.db ".schema booking_anomalies"` 确认表与索引存在。
- 对一个测试 `PAYING` 订单执行迁移后，`reconcileKind='payment'` 且 `reconcileNextAt` 非空。
- `migration:revert` 能完整回滚到原 schema。
- 启动 Nest 进程，`migrationsRun: true` 下不重复执行已应用迁移，不报错。

## 上线顺序

1. 提交 `data-source.ts`、`package.json` 脚本、`migrations/` 目录与首个迁移文件。
2. 改 `app.module.ts`：`synchronize=false`、`migrationsRun=true`、`migrations` 路径、实体列表加 `BookingAnomaly`。
3. 预发库执行 `migration:run` 验证。
4. 生产部署；进程启动自动应用迁移。
5. 验证生产库 schema 与补齐结果。
