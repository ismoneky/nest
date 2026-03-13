import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

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
 * 订单状态枚举
 */
export enum BookingStatus {
    NONE = 'none', // 无状态 (默认值)
    CANCELLED = 'cancelled', // 已取消
    COMPLETED = 'completed', // 已完成
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
    @Column({ type: 'varchar', default: 'none' })
    @Index()
    status: BookingStatus;

    /** 创建时间 */
    @CreateDateColumn()
    createdAt: Date;

    /** 更新时间 */
    @UpdateDateColumn()
    updatedAt: Date;
}
