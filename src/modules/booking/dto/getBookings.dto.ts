import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { BookingStatus, TimeSlot } from '../../../entities/booking.entity';

/**
 * 查询订单列表 DTO
 * 支持分页和多条件筛选
 */
export class GetBookingsDto {
    /** 微信用户OpenID (筛选条件) */
    @IsString()
    @IsOptional()
    wechatOpenId?: string;

    /** 预约日期 (筛选条件) */
    @IsDateString()
    @IsOptional()
    bookingDate?: string;

    /** 预约时间段 (筛选条件) */
    @IsEnum(TimeSlot)
    @IsOptional()
    timeSlot?: TimeSlot;

    /** 订单状态 (筛选条件) */
    @IsEnum(BookingStatus)
    @IsOptional()
    status?: BookingStatus;

    /** 当前页码 (从1开始,默认为1) */
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @IsOptional()
    page?: number = 1;

    /** 每页数量 (默认10条,最大100条) */
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    @IsOptional()
    pageSize?: number = 10;
}
