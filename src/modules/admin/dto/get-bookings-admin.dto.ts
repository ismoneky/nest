import { Transform, Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { BookingStatus } from '../../../entities/booking.entity';

export class GetBookingsAdminDto {
    @IsDateString()
    @IsOptional()
    bookingDate?: string;

    /** 创建日期范围：起始（含），格式 YYYY-MM-DD */
    @IsDateString()
    @IsOptional()
    createdStart?: string;

    /** 创建日期范围：结束（含），格式 YYYY-MM-DD */
    @IsDateString()
    @IsOptional()
    createdEnd?: string;

    @Transform(({ value }) => (Array.isArray(value) ? value : value ? [value] : undefined))
    @IsEnum(BookingStatus, { each: true })
    @IsOptional()
    status?: BookingStatus[];

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
