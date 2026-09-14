import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

/**
 * 时间段枚举
 */
export enum TimeSlot {
    MORNING = 'morning', // 上午
    AFTERNOON = 'afternoon', // 下午
}

/**
 * 出行方式枚举
 */
export enum TravelMode {
    SCENIC_BUS = 'scenicBus', // 景区自营车
    SELF_DRIVING = 'selfDriving', // 自驾
    TOUR_GROUP = 'tourGroup', // 观光团
}

/**
 * 车辆类型枚举 (自驾时必填)
 */
export enum VehicleType {
    WHEEL_MOTORCYCLE = 'wheelMotorcycle', // 摩托
    SMALL_CAR = 'smallCar', // 小型客车
    NON_MOTORIZED = 'nonMotorized', // 非机动车
}

/**
 * 订单状态枚举（描述预约本身的生命周期，与支付无关）
 */
export enum BookingStatus {
    PENDING = 'pending',       // 待确认（已创建，等待支付完成激活）
    CONFIRMED = 'confirmed',   // 已确认（支付完成，预约生效）
    COMPLETED = 'completed',   // 已完成（**已核销**，即闸机实际核销过；语义已收窄，见下）
    CANCELLED = 'cancelled',   // 已取消（支付超时或主动取消）
    REFUNDED = 'refunded',     // 已退款
    EXPIRED = 'expired',       // 已过期（预约日已过且未核销）
}

/**
 * `completed` 语义说明（2026-09-13 起）
 *
 * 改动前 `completed` 有两个写入方，含义是混合的、事后无法区分：
 *   ① verifyBooking —— 游客在闸机扫码核销
 *   ② runHistoricalBookingUpdate（每小时 :13）—— 预约日一过就**无条件**刷成 completed
 * 所以历史上「真来过」和「根本没来」都是 `completed`。
 *
 * 改动后定时任务不再写 `completed`（改由 T1 写 `expired`），
 * **`completed` 严格等价于「已核销」**，唯一写入方是 `markVerified`。
 * 这是 `verifiedAt` / `verifiedBy` 两个字段有意义的前提。
 */

/**
 * 支付状态枚举（描述这笔钱的状态）
 */
export enum PaymentStatus {
    UNPAID = 'unpaid',       // 未支付
    PAYING = 'paying',       // 支付中（已调起微信支付，等待回调）
    PAID = 'paid',           // 已支付
    REFUNDING = 'refunding', // 退款中
    REFUNDED = 'refunded',   // 已退款
    FAILED = 'failed',       // 退款失败
}

/**
 * 退款状态枚举
 */
export enum RefundStatus {
    NONE = 'none', // 无
    REFUNDING = 'refunding', // 退款中
    REFUNDED = 'refunded', // 已退款
    FAILED = 'failed', // 退款失败
}

/**
 * 预约订单实体
 */
@Entity('bookings')
@Index(['wechatOpenId', 'status']) // 复合索引
@Index(['bookingDate', 'timeSlot']) // 复合索引
export class Booking {
    @PrimaryGeneratedColumn()
    id: number;

    /** 订单唯一标识 (UUID) */
    @Column({ unique: true })
    @Index()
    bookingId: string;

    /** 微信用户OpenID (关联用户) */
    @Column()
    @Index()
    wechatOpenId: string;

    /** 出行人员列表（JSON数组，每项含 name/phone/idCard） */
    @Column({ type: 'text', nullable: true })
    passengers: string;

    /** 联系人姓名（兼容字段，同步自 passengers[0].name） */
    @Column({ nullable: true })
    name: string;

    /** 联系人手机号（兼容字段，同步自 passengers[0].phone） */
    @Column({ nullable: true })
    phone: string;

    /** 联系人身份证号（兼容字段，同步自 passengers[0].idCard） */
    @Column({ nullable: true })
    idCard: string;

    /** 预约日期 */
    @Column({ type: 'date' })
    @Index()
    bookingDate: Date;

    /** 预约时间段 (上午/下午) */
    @Column({ type: 'varchar' })
    timeSlot: TimeSlot;

    /** 出行方式 */
    @Column({ type: 'varchar' })
    travelMode: TravelMode;

    /** 车牌号 (自驾时必填) */
    @Column({ nullable: true })
    @Index()
    licensePlate?: string;

    /** 车辆类型 (自驾时必填) */
    @Column({ type: 'varchar', nullable: true })
    vehicleType?: VehicleType;

    /** 旅游团名称 (旅游团时必填) */
    @Column({ nullable: true })
    tourGroupName?: string;

    /** 旅游团订单编号 (旅游团时必填) */
    @Column({ nullable: true })
    tourOrderNumber?: string;

    /** 预约人数 */
    @Column()
    personCount: number;

    /** 备注信息 */
    @Column({ default: '' })
    remarks: string;

    /** 是否为免费预约（每日前N名免费活动或月卡会员） */
    @Column({ default: false })
    isFree: boolean;

    /** 免费来源：dailyQuota=每日免费名额，member=月卡会员 */
    @Column({ type: 'varchar', nullable: true })
    freeReason?: string;

    /** 订单状态 */
    @Column({ type: 'varchar', default: 'pending' })
    @Index()
    status: BookingStatus;

    /** 支付状态 */
    @Column({ type: 'varchar', default: 'unpaid' })
    @Index()
    paymentStatus: PaymentStatus;

    /** 退款状态 */
    @Column({ type: 'varchar', default: 'none' })
    @Index()
    refundStatus: RefundStatus;

    /** 支付金额 (单位: 分) */
    @Column({ type: 'int', nullable: true })
    amount: number;

    /** 微信支付订单号 */
    @Column({ nullable: true })
    @Index()
    transactionId: string;

    /** 商户订单号 (微信支付) */
    @Column({ nullable: true })
    @Index()
    outTradeNo: string;

    /** 商户退款单号 (微信支付) */
    @Column({ nullable: true })
    outRefundNo: string;

    /** 支付时间 */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    paidAt: Date;

    /** 退款时间 */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    refundedAt: Date;

    /** 被 T1 翻转为 expired 的时刻。**退款申请时限（7 天）的计算基准** */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    expiredAt: Date;

    /** 「已过期」通知已发出的时刻。防漏发的标记位（NULL = 尚未通知，下轮继续扫到） */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    expireNotifiedAt: Date;

    /** 核销时刻。核销留痕（改动前核销不留任何记录，与定时任务刷出来的 completed 无法区分） */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    verifiedAt: Date;

    /** 核销人 openid（改动前日志 context 里不含核销人） */
    @Column({ type: 'varchar', nullable: true })
    verifiedBy: string;

    /** 支付超时时间 */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    paymentExpiredAt: Date;

    /** 对账任务类型（payment | refund | close，null 表示无待处理对账） */
    @Column({ type: 'varchar', nullable: true })
    reconcileKind: string;

    /** 下次对账时间（毫秒 epoch；null 表示未排期，不当作到期） */
    @Column({ type: 'integer', nullable: true })
    reconcileNextAt: number;

    /** 连续对账失败次数 */
    @Column({ type: 'integer', default: 0 })
    reconcileAttempts: number;

    /** 最近对账时间（毫秒 epoch） */
    @Column({ type: 'integer', nullable: true })
    reconcileLastAt: number;

    /** 最近对账稳定错误码 */
    @Column({ type: 'varchar', nullable: true })
    reconcileLastErrorCode: string;

    /** 创建时间 */
    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    createdAt: Date;

    /** 更新时间 */
    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    updatedAt: Date;

    @BeforeInsert()
    setCreatedAt() {
        const now = new Date();
        if (!this.createdAt) this.createdAt = now;
        this.updatedAt = now;
    }

    @BeforeUpdate()
    setUpdatedAt() {
        this.updatedAt = new Date();
    }
}
