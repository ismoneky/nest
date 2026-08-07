import { ArrayMinSize, IsArray, IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PassengerDto } from './createBooking.dto';
import { TravelMode, VehicleType } from '../../../entities/booking.entity';

/** 车牌号正则（与 createBooking.dto 一致） */
const LICENSE_PLATE_PATTERN = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]$/;

/**
 * 预约费用预览 DTO
 * 进入预约页 / 修改乘客 / 修改日期 / 选择出行方式车型车牌时调用，后端返回完整的费用与免费判定预览
 * （后端为唯一事实来源，前端不做任何判定）
 */
export class PreviewBookingDto {
    /** 出行人员列表（与下单保持一致） */
    @IsArray()
    @ArrayMinSize(1, { message: '至少填写一名出行人员' })
    @ValidateNested({ each: true })
    @Type(() => PassengerDto)
    passengers: PassengerDto[];

    /** 预约日期 (YYYY-MM-DD) */
    @IsDateString()
    @IsNotEmpty()
    bookingDate: string;

    /** 出行方式（会员免费仅自驾+摩托车命中，前端选了才传） */
    @IsEnum(TravelMode)
    @IsOptional()
    travelMode?: TravelMode;

    /** 车辆类型（wheelMotorcycle 才查会员） */
    @IsEnum(VehicleType)
    @IsOptional()
    vehicleType?: VehicleType;

    /** 车牌号（自驾时必填，命中会员登记车牌其一） */
    @IsString()
    @IsOptional()
    @Matches(LICENSE_PLATE_PATTERN, { message: 'Invalid license plate format' })
    licensePlate?: string;
}
