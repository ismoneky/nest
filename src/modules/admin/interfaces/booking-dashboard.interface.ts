import { BookingStatus, TravelMode } from '../../../entities/booking.entity';

/**
 * 经营统计日期范围
 */
export interface BookingDashboardRange {
    startDate: string;
    endDate: string;
}

/**
 * 经营统计汇总指标
 * receivedAmount 单位：分
 */
export interface BookingDashboardSummary {
    validOrderCount: number;
    totalPeople: number;
    selfDrivingVehicleCount: number;
    receivedAmount: number;
    freePeople: number;
    paidPeople: number;
}

/**
 * 订单状态分布
 */
export interface BookingDashboardStatusItem {
    status: BookingStatus;
    orderCount: number;
}

/**
 * 出行方式分布
 */
export interface BookingDashboardTravelModeItem {
    travelMode: TravelMode;
    orderCount: number;
    peopleCount: number;
}

/**
 * 每日趋势
 * receivedAmount 单位：分
 */
export interface BookingDashboardDailyTrendItem {
    date: string;
    validOrderCount: number;
    peopleCount: number;
    selfDrivingVehicleCount: number;
    receivedAmount: number;
}

/**
 * 经营统计响应
 * 金额字段单位均为“分”，由管理后台在展示时转换为“元”。
 */
export interface BookingDashboardResponse {
    range: BookingDashboardRange;
    summary: BookingDashboardSummary;
    statusDistribution: BookingDashboardStatusItem[];
    travelModeDistribution: BookingDashboardTravelModeItem[];
    dailyTrend: BookingDashboardDailyTrendItem[];
}
