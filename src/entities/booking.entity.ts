import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BookingDocument = HydratedDocument<Booking>;


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
    // PENDING = 'pending', // 待确认
    // CONFIRMED = 'confirmed', // 已确认
    NONE = 'none', // 无状态 (默认值)
    CANCELLED = 'cancelled', // 已取消
    COMPLETED = 'completed', // 已完成
}

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

    /** 联系人姓名 */
    @Prop({ required: true })
    name: string;

    /** 联系人手机号 */
    @Prop({ required: true })
    phone: string;

    /** 联系人身份证号 */
    @Prop({ required: true })
    idCard: string;

    /** 预约日期 */
    @Prop({ required: true, index: true })
    bookingDate: Date;

    /** 预约时间段 (上午/下午) */
    @Prop({ required: true, enum: TimeSlot })
    timeSlot: TimeSlot;

    /** 出行方式 */
    @Prop({ required: true, enum: TravelMode })
    travelMode: TravelMode;

    /** 车牌号 (自驾时必填) */
    @Prop({ index: true })
    licensePlate?: string;

    /** 车辆类型 (自驾时必填) */
    @Prop({ enum: VehicleType })
    vehicleType?: VehicleType;

    /** 旅游团名称 (旅游团时必填) */
    @Prop()
    tourGroupName?: string;

    /** 旅游团订单编号 (旅游团时必填) */
    @Prop()
    tourOrderNumber?: string;

    /** 预约人数 */
    @Prop({ required: true, min: 1 })
    personCount: number;

    /** 备注信息 */
    @Prop({ default: '' })
    remarks?: string;

    /** 订单状态 */
    @Prop({ default: "none", enum: BookingStatus, index: true })
    status: BookingStatus;

    /** 创建时间 */
    @Prop({ default: Date.now })
    createdAt: Date;

    /** 更新时间 */
    @Prop()
    updatedAt?: Date;
}

export const BookingSchema = SchemaFactory.createForClass(Booking);

// 创建复合索引以优化常见查询
BookingSchema.index({ wechatOpenId: 1, status: 1 }); // 按用户和状态查询
BookingSchema.index({ bookingDate: 1, timeSlot: 1 }); // 按日期和时间段查询
BookingSchema.index({ licensePlate: 1 }); // 按车牌号查询
