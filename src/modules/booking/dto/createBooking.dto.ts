import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min, ValidateIf } from 'class-validator';
import { Gender, TimeSlot, TravelMode, VehicleType } from '../../../entities/booking.entity';

/**
 * 创建预约订单 DTO
 */
export class CreateBookingDto {
    /** 微信用户OpenID */
    @IsString()
    @IsNotEmpty()
    wechatOpenId: string;

    /** 联系人姓名 */
    @IsString()
    @IsNotEmpty()
    contactName: string;

    /** 联系人性别 */
    @IsEnum(Gender)
    @IsNotEmpty()
    contactGender: Gender;

    /** 联系人手机号 (格式: 1开头的11位数字) */
    @IsString()
    @IsNotEmpty()
    @Matches(/^1[3-9]\d{9}$/, { message: 'Invalid phone number format' })
    contactPhone: string;

    /** 联系人身份证号 (18位) */
    @IsString()
    @IsNotEmpty()
    @Matches(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/, { message: 'Invalid ID card format' })
    contactIdCard: string;

    /** 预约日期 (格式: YYYY-MM-DD) */
    @IsDateString()
    @IsNotEmpty()
    bookingDate: string;

    /** 预约时间段 (morning/afternoon) */
    @IsEnum(TimeSlot)
    @IsNotEmpty()
    timeSlot: TimeSlot;

    /** 出行方式 (scenic_bus/self_driving/tour_group) */
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
    numberOfPeople: number;

    /** 备注信息 (可选) */
    @IsString()
    @IsOptional()
    remarks?: string;
}
