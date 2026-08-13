import { PassengerPricingResult } from '../passenger-pricing';

/**
 * 免费资格判定结果
 * preview 全量返回（供前端展示），createBooking 取核心字段（isFree/freeReason/amount）落库
 */
export interface FreeEligibilityResult {
    /** 是否免费 */
    isFree: boolean;
    /** 免费来源：会员免费 | 每日名额 | 年龄免费 | 无（收费） */
    freeReason: 'member' | 'dailyQuota' | 'age' | null;
    /** 不能免费的原因码（仅 isFree=false 时有值，互斥于 freeReason） */
    reason: 'no_free_activity' | 'member_idcard_not_matched' | 'member_plate_not_matched'
          | 'daily_quota_full' | 'daily_quota_used' | 'not_today' | null;
    /** 总金额（分），isFree 时为 0 */
    amount: number;
    /** 单人金额（分），= paymentConfig.paymentAmount */
    unitPrice: number;
    /** 出行人数，= passengers.length */
    personCount: number;
    /** 年龄免费人数 */
    ageFreePeople: number;
    /** 收费人数（整单免费时为 0） */
    chargedPeople: number;
    /** 每位人员的年龄与计费结果（与 passengers 下标一致） */
    passengerPricing: PassengerPricingResult[];
    /** 会员信息（供前端展示） */
    memberInfo: { isMember: boolean; name?: string; daysRemaining?: number } | null;
    /** 每日免费名额信息（供前端展示） */
    freeQuotaInfo: {
        enabled: boolean;
        limit: number;
        used: number;
        remaining: number;
        bookingIsToday: boolean;
        userHasFreeBooking: boolean;
    } | null;
    /** 当天已预约人数（pending + confirmed 状态），用户预约的话是第 bookingRank + 1 位 */
    bookingRank: number;
}
