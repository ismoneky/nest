import { IsDateString } from 'class-validator';

/**
 * 经营统计日期范围 DTO
 * 所有统计以预约游玩日期 bookingDate 为筛选条件，起止日期均包含（YYYY-MM-DD）。
 * 范围合法性（startDate <= endDate、最长 366 天）在 Service 进入查询前校验。
 */
export class GetBookingDashboardDto {
    @IsDateString()
    startDate: string;

    @IsDateString()
    endDate: string;
}
