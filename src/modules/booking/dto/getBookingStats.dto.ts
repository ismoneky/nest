import { IsDateString } from 'class-validator';

/**
 * 查询预约统计 DTO
 */
export class GetBookingStatsDto {
    /** 预约日期 (YYYY-MM-DD) */
    @IsDateString()
    bookingDate: string;
}
