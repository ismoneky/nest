import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { BookingStatus, TimeSlot } from '../../../entities/booking.entity';

export class GetBookingsAdminDto {
    @IsDateString()
    @IsOptional()
    bookingDate?: string;

    @IsEnum(TimeSlot)
    @IsOptional()
    timeSlot?: TimeSlot;

    @IsEnum(BookingStatus)
    @IsOptional()
    status?: BookingStatus;

    /** 关键字搜索（姓名 / 手机号 / 订单号） */
    @IsString()
    @IsOptional()
    keyword?: string;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    @IsOptional()
    page?: number = 1;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    @IsOptional()
    pageSize?: number = 10;
}
