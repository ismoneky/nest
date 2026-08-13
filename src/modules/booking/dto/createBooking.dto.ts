import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsBoolean, Matches, Min, ValidateIf, ValidateNested, ArrayMinSize, IsArray } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { TimeSlot, TravelMode, VehicleType } from '../../../entities/booking.entity';
import { PassengerType } from '../passenger-pricing';

export class PassengerDto {
    @IsString()
    @IsNotEmpty({ message: '姓名不能为空' })
    name: string;

    @IsString()
    @IsNotEmpty({ message: '手机号不能为空' })
    @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
    phone: string;

    /**
     * 身份证：DTO 只保留字段白名单（@IsOptional 使其通过 whitelist 保留）；
     * 必填、成人/联系人免填限制、格式/真实日期/校验码与年龄类型一致
     * 全部由 passenger-pricing 业务函数处理并统一返回稳定错误码，
     * 避免 DTO 层抢先生成无 code 的普通 400。
     */
    @IsOptional()
    idCard?: string;

    /** 人员类型：旧客户端缺失或为 null 时按 adult 处理 */
    @Transform(({ value }) => value ?? PassengerType.ADULT)
    @IsEnum(PassengerType)
    passengerType: PassengerType = PassengerType.ADULT;

    /** 暂时无法提供身份证（仅儿童/老人允许为 true，业务函数校验）；只认字面量 true */
    @Transform(({ value }) => value === true)
    @IsBoolean()
    @IsOptional()
    idCardUnavailable = false;
}

/**
 * 创建预约订单 DTO
 */
export class CreateBookingDto {
    /** 出行人员列表，数量须与 personCount 一致 */
    @IsArray()
    @ArrayMinSize(1, { message: '至少填写一名出行人员' })
    @ValidateNested({ each: true })
    @Type(() => PassengerDto)
    passengers: PassengerDto[];

    /** 预约日期 (格式: YYYY-MM-DD) */
    @IsDateString()
    @IsNotEmpty()
    bookingDate: string;

    /** 预约时间段 (morning/afternoon) — 已不再区分上下午，不传时后端默认 morning */
    @IsEnum(TimeSlot)
    @IsOptional()
    timeSlot?: TimeSlot;

    /** 出行方式 (scenicBus/selfDriving/tourGroup) */
    @IsEnum(TravelMode)
    @IsNotEmpty()
    travelMode: TravelMode;

    /** 车牌号 (自驾+机动车时必填，非机动车不需要) */
    @ValidateIf((o) => o.travelMode === TravelMode.SELF_DRIVING && o.vehicleType !== VehicleType.NON_MOTORIZED)
    @IsString()
    @IsNotEmpty({ message: 'License plate is required for self-driving mode' })
    @Matches(/^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]$/, {
        message: 'Invalid license plate format',
    })
    licensePlate?: string;

    /** 车辆类型 (自驾时必填) */
    @ValidateIf((o) => o.travelMode === TravelMode.SELF_DRIVING)
    @IsEnum(VehicleType)
    @IsNotEmpty({ message: 'Vehicle type is required for self-driving mode' })
    vehicleType?: VehicleType;

    /** 旅游团名称 (旅游团时必填) */
    @ValidateIf((o) => o.travelMode === TravelMode.TOUR_GROUP)
    @IsString()
    @IsNotEmpty({ message: 'Tour group name is required for tour group mode' })
    tourGroupName?: string;

    /** 旅游团订单编号 (旅游团时必填) */
    @ValidateIf((o) => o.travelMode === TravelMode.TOUR_GROUP)
    @IsString()
    @IsNotEmpty({ message: 'Tour order number is required for tour group mode' })
    tourOrderNumber?: string;

    /** 预约人数 (≥1) */
    @IsInt()
    @Min(1)
    @IsNotEmpty()
    personCount: number;

    /** 备注信息 (可选) */
    @IsString()
    @IsOptional()
    remarks?: string;

    /** 是否管理员（前端传入，true 时跳过「预约开关」关闭检查） */
    @IsBoolean()
    @IsOptional()
    isAdmin?: boolean;
}
