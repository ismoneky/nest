import { PassengerPricingResult } from '../passenger-pricing';

/**
 * 每日免费名额快照（唯一口径来源）
 *
 * preview / createBooking / 今日名额接口三处共用，由
 * BookingService.buildDailyFreeQuotaInfo 统一产出，禁止任何地方再内联一份统计：
 * 口径一旦分叉就会出现「页面显示还能免费、下单却收费」这类承诺违约。
 */
export interface DailyFreeQuotaInfo {
    /** 免费活动是否开启 */
    enabled: boolean;
    /** 每日免费名额上限 */
    limit: number;
    /** 今日已用免费名额（去重用户数，仅计 freeReason='dailyQuota'） */
    used: number;
    /** 今日剩余免费名额，下限钳到 0 */
    remaining: number;
    /** 用户选择的预约日期是否为今天（仅当天才参与每日免费） */
    bookingIsToday: boolean;
    /** 传入 openid 时才有意义：该用户今日是否已享过每日免费 */
    userHasFreeBooking: boolean;
}

/**
 * 免费资格判定结果
 * preview 全量返回（供前端展示），createBooking 取核心字段（isFree/freeReason/amount）落库
 *
 * 注意：本接口**不返回当天已预约人数**。历史上曾有 bookingRank 字段（= SUM(personCount)
 * WHERE bookingDate=所选日期 AND status IN pending/confirmed），那正是「当天已约人数」本身，
 * 而单价公开，故 已约人数 × 单价 ≈ 每日营收。任何登录用户传任意日期调一次 preview 即可拿到，
 * 属营收泄漏面，已于 2026-09 移除（连同其查询一并删除，零消费方）。**请勿再加回。**
 */
export interface FreeEligibilityResult {
    /** 是否免费 */
    isFree: boolean;
    /** 免费来源：会员免费 | 每日名额 | 年龄免费 | 无（收费） */
    freeReason: 'member' | 'dailyQuota' | 'age' | null;
    /**
     * 不能免费的原因码（仅 isFree=false 时有值，互斥于 freeReason）
     * no_free_activity / not_member 两者前端不展示文案：
     * 前者是免费活动未开启（活动对用户隐藏），后者是用户本就不是会员（会员免费不适用）
     */
    reason: 'no_free_activity' | 'not_member' | 'member_plate_not_matched'
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
    freeQuotaInfo: DailyFreeQuotaInfo | null;
}
