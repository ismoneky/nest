import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsBoolean, Matches, Min, ValidateIf, ValidateNested, ArrayMinSize, IsArray } from 'class-validator';
import { Type } from 'class-transformer';
import { TimeSlot, TravelMode, VehicleType } from '../../../entities/booking.entity';

export class PassengerDto {
    @IsString()
    @IsNotEmpty({ message: '姓名不能为空' })
    name: string;

    @IsString()
    @IsNotEmpty({ message: '手机号不能为空' })
    @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
    phone: string;

    @IsString()
    @IsNotEmpty({ message: '身份证号不能为空' })
    @Matches(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/, { message: '身份证号格式不正确' })
    idCard: string;
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

    /** 车牌号 (自驾时必填) */
    @ValidateIf((o) => o.travelMode === TravelMode.SELF_DRIVING)
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
