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
}

/**
 * 订单状态枚举（描述预约本身的生命周期，与支付无关）
 */
export enum BookingStatus {
    PENDING = 'pending',       // 待确认（已创建，等待支付完成激活）
    CONFIRMED = 'confirmed',   // 已确认（支付完成，预约生效）
    COMPLETED = 'completed',   // 已完成（游览日期已过）
    CANCELLED = 'cancelled',   // 已取消（支付超时或主动取消）
    REFUNDED = 'refunded',     // 已退款
}

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

    /** 联系人姓名 */
    @Column()
    name: string;

    /** 联系人手机号 */
    @Column()
    phone: string;

    /** 联系人身份证号 */
    @Column()
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

    /** 支付超时时间 */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    paymentExpiredAt: Date;

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
