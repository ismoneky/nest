import { PassengerBusinessException, PassengerErrorCode } from '../../common/passenger-business.exception';
import { TravelMode, VehicleType } from '../../entities/booking.entity';

/**
 * 人员类型、年龄计算与人员级定价纯函数。
 *
 * 年龄值固定为 `预约游玩年份 - 身份证出生年份`，按年份粗略计算（边界允许生日误差）。
 * 本模块不涉及任何数据库/事务，preview 与 createBooking 共用同一套规则；
 * 所有业务规则失败均抛带稳定错误码的 PassengerBusinessException。
 */

export enum PassengerType {
    ADULT = 'adult',
    CHILD = 'child',
    SENIOR = 'senior',
}

export type PassengerPricingReason =
    | 'member_order_free'
    | 'daily_quota_order_free'
    | 'child_age_free'
    | 'senior_age_free'
    | 'id_card_unavailable'
    | 'regular';

/** 校验/计价所需的最小人员结构（Task 2 扩展后的 PassengerDto 结构兼容本类型） */
export interface PassengerPricingInput {
    name?: string;
    phone?: string;
    idCard?: string | null;
    passengerType?: PassengerType | string | null;
    idCardUnavailable?: boolean | null;
}

/** 订单 passengers JSON 中保存的人员计费快照（见实施计划 2.2） */
export interface StoredPassenger {
    name: string;
    phone: string;
    idCard: string;
    passengerType: PassengerType;
    idCardUnavailable: boolean;
    ageValue: number | null;
    ageFree: boolean;
    finalCharged: boolean;
    pricingReason: PassengerPricingReason;
}

export interface PassengerPricingResult {
    index: number;
    passengerType: PassengerType;
    ageValue: number | null;
    ageFree: boolean;
    finalCharged: boolean;
    pricingReason: PassengerPricingReason;
}

export interface AgePricingSummary {
    /** 年龄免费人数 */
    ageFreePeople: number;
    /** 正常收费人数（含无身份证人员） */
    chargedPeople: number;
    passengerPricing: PassengerPricingResult[];
}

/** 儿童年龄免费边界：年龄值 <= 7 */
export const CHILD_MAX_AGE = 7;
/** 老人年龄免费边界：年龄值 >= 70 */
export const SENIOR_MIN_AGE = 70;

const ID_CARD_18_PATTERN = /^\d{17}[\dXx]$/;
const ID_CARD_CHECK_FACTORS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/**
 * 归一化人员类型：旧客户端缺失/非法值按 adult 处理。
 */
export function normalizePassengerType(value: unknown): PassengerType {
    if (value === PassengerType.ADULT || value === PassengerType.CHILD || value === PassengerType.SENIOR) {
        return value;
    }
    return PassengerType.ADULT;
}

/**
 * 判断出生日期是否为真实存在的公历日期（构造后反查年月日，拒绝 2/30、13 月等）。
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * 严格验证 18 位身份证：格式 → 真实公历出生日期 → MOD 11-2 校验码。
 * 全部通过才算合法；前端校验结果不被信任，后端独立验证。
 */
export function validateChineseIdCard(idCard: string): boolean {
    if (typeof idCard !== 'string' || !ID_CARD_18_PATTERN.test(idCard)) {
        return false;
    }
    const year = parseInt(idCard.slice(6, 10), 10);
    const month = parseInt(idCard.slice(10, 12), 10);
    const day = parseInt(idCard.slice(12, 14), 10);
    if (!isRealCalendarDate(year, month, day)) {
        return false;
    }
    let sum = 0;
    for (let i = 0; i < 17; i++) {
        sum += parseInt(idCard[i], 10) * ID_CARD_CHECK_FACTORS[i];
    }
    return idCard[17].toUpperCase() === ID_CARD_CHECK_CODES[sum % 11];
}

/**
 * 读取身份证出生年份；身份证不合法时返回 null。
 */
export function extractBirthYear(idCard: string): number | null {
    if (!validateChineseIdCard(idCard)) {
        return null;
    }
    return parseInt(idCard.slice(6, 10), 10);
}

/**
 * 年龄值 = 预约游玩年份 - 身份证出生年份。
 * 预约日期无有效年份前缀或身份证非法时返回 null。
 */
export function calculateYearAge(idCard: string, bookingDate: string): number | null {
    const birthYear = extractBirthYear(idCard);
    const match = typeof bookingDate === 'string' ? bookingDate.match(/^(\d{4})-/) : null;
    if (birthYear === null || !match) {
        return null;
    }
    return parseInt(match[1], 10) - birthYear;
}

/**
 * 车型人数上限口径：自驾摩托 2 人、自驾小型客车 7 人、非机动车/摆渡车及其他出行方式 10 人。
 * 与前端 fctl/utils/passenger-pricing.js 的 getPassengerLimit 保持完全一致；
 * 前端只用于交互提示，后端才是安全边界。
 */
export function getPassengerLimit(
    travelMode?: TravelMode | string | null,
    vehicleType?: VehicleType | string | null,
): number {
    if (travelMode === TravelMode.SELF_DRIVING && vehicleType === VehicleType.WHEEL_MOTORCYCLE) {
        return 2;
    }
    if (travelMode === TravelMode.SELF_DRIVING && vehicleType === VehicleType.SMALL_CAR) {
        return 7;
    }
    return 10;
}

/**
 * 车型人数上限校验：一律按 passengers.length 判断，不信任 personCount。
 * 超限抛带稳定错误码的 PassengerBusinessException。
 */
export function validatePassengerLimit(
    passengers: PassengerPricingInput[],
    travelMode?: TravelMode | string | null,
    vehicleType?: VehicleType | string | null,
): void {
    const limit = getPassengerLimit(travelMode, vehicleType);
    const count = Array.isArray(passengers) ? passengers.length : 0;
    if (count > limit) {
        throw new PassengerBusinessException(
            PassengerErrorCode.LIMIT_EXCEEDED,
            `当前出行方式最多可预约 ${limit} 人`,
        );
    }
}

/**
 * 人员业务规则校验（preview 与 create 共用，先于任何数据库查询执行）。
 * 校验顺序：联系人 → 暂时无法提供与身份证互斥 → 成人必填身份证 → 儿童/老人二选一 →
 * 身份证严格校验 → 儿童/老人年龄与类型一致。
 */
export function validatePassengerBusinessRules(passengers: PassengerPricingInput[], bookingDate: string): void {
    if (!Array.isArray(passengers) || passengers.length === 0) {
        throw new PassengerBusinessException(PassengerErrorCode.CONTACT_INVALID, '至少填写一名出行人员');
    }

    for (let i = 0; i < passengers.length; i++) {
        const p = passengers[i] ?? {};
        const passengerType = normalizePassengerType(p.passengerType);
        const idCardUnavailable = p.idCardUnavailable === true;
        // 字段已提供但不是字符串（DTO 不再拦截类型）：统一返回稳定错误码
        if (p.idCard != null && typeof p.idCard !== 'string') {
            throw new PassengerBusinessException(PassengerErrorCode.ID_CARD_INVALID, '身份证号格式不正确');
        }
        const rawIdCard = typeof p.idCard === 'string' ? p.idCard.trim() : '';
        const hasIdCard = rawIdCard.length > 0;
        const idCard = rawIdCard.toUpperCase();

        // 联系人固定为第一人：必须 adult、有身份证且未勾选暂时无法提供
        if (i === 0 && (passengerType !== PassengerType.ADULT || idCardUnavailable || !hasIdCard)) {
            throw new PassengerBusinessException(PassengerErrorCode.CONTACT_INVALID, '联系人必须为成年人并填写身份证号');
        }

        // 勾选暂时无法提供时不允许同时传身份证
        if (idCardUnavailable && hasIdCard) {
            throw new PassengerBusinessException(
                PassengerErrorCode.UNAVAILABLE_NOT_ALLOWED,
                '勾选暂时无法提供身份证号时不能同时填写身份证号',
            );
        }

        if (passengerType === PassengerType.ADULT) {
            // 成人不允许免填身份证
            if (idCardUnavailable) {
                throw new PassengerBusinessException(PassengerErrorCode.UNAVAILABLE_NOT_ALLOWED, '普通出行人必须填写身份证号');
            }
            if (!hasIdCard) {
                throw new PassengerBusinessException(PassengerErrorCode.ID_CARD_REQUIRED, '请填写身份证号');
            }
        } else if (!idCardUnavailable && !hasIdCard) {
            // 儿童/老人：身份证与「暂时无法提供」二选一
            throw new PassengerBusinessException(
                PassengerErrorCode.ID_CARD_REQUIRED,
                '请填写身份证号或勾选暂时无法提供身份证号',
            );
        }

        // 只要填写了身份证（含成人）就必须通过严格校验，不能只靠正则
        if (hasIdCard && !validateChineseIdCard(idCard)) {
            throw new PassengerBusinessException(PassengerErrorCode.ID_CARD_INVALID, '身份证号格式不正确');
        }

        // 儿童/老人类型与年龄必须一致；不一致不得静默改为普通收费。
        // 年龄值为负（出生年份晚于预约年份）属于无效身份/类型组合，必须拒绝
        if (hasIdCard && (passengerType === PassengerType.CHILD || passengerType === PassengerType.SENIOR)) {
            const age = calculateYearAge(idCard, bookingDate);
            const isChild = passengerType === PassengerType.CHILD;
            const label = isChild ? '7岁及以下儿童' : '70岁及以上老人';
            const ageOk = age !== null && age >= 0 && (isChild ? age <= CHILD_MAX_AGE : age >= SENIOR_MIN_AGE);
            if (!ageOk) {
                throw new PassengerBusinessException(PassengerErrorCode.TYPE_AGE_MISMATCH, `身份证年龄不符合${label}条件`);
            }
        }
    }
}

/**
 * 人员级年龄定价（不含会员/每日免费整单优惠，由 booking.service 统一叠加）。
 * 输入应已通过 validatePassengerBusinessRules；本函数为纯函数，不抛业务异常，
 * 即使漏校验也只会保守收费，不会错误放行年龄免费。
 */
export function calculateAgePricing(passengers: PassengerPricingInput[], bookingDate: string): AgePricingSummary {
    const passengerPricing: PassengerPricingResult[] = passengers.map((p, index) => {
        const passengerType = normalizePassengerType(p?.passengerType);
        const idCardUnavailable = p?.idCardUnavailable === true;
        const rawIdCard = typeof p?.idCard === 'string' ? p.idCard.trim() : '';
        const idCard = rawIdCard.toUpperCase();
        const isSpecial = passengerType === PassengerType.CHILD || passengerType === PassengerType.SENIOR;

        let ageValue: number | null = null;
        let ageFree = false;
        let pricingReason: PassengerPricingReason = 'regular';

        if (isSpecial && idCardUnavailable) {
            // 无身份证儿童/老人：正常收费，且与「有身份证但收费」的 regular 区分
            pricingReason = 'id_card_unavailable';
        } else if (isSpecial && validateChineseIdCard(idCard)) {
            const age = calculateYearAge(idCard, bookingDate);
            ageValue = age;
            // 年龄值必须 >= 0：未来出生年份即使漏过前置校验也不得获得年龄免费
            if (age !== null && age >= 0 && (passengerType === PassengerType.CHILD ? age <= CHILD_MAX_AGE : age >= SENIOR_MIN_AGE)) {
                ageFree = true;
                pricingReason = passengerType === PassengerType.CHILD ? 'child_age_free' : 'senior_age_free';
            }
        }

        return {
            index,
            passengerType,
            ageValue,
            ageFree,
            finalCharged: !ageFree,
            pricingReason,
        };
    });

    const ageFreePeople = passengerPricing.filter((p) => p.ageFree).length;
    return {
        ageFreePeople,
        chargedPeople: passengerPricing.length - ageFreePeople,
        passengerPricing,
    };
}
