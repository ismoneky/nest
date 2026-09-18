import { RefundApplyStatus } from '../../../entities/refund-apply.entity';

/**
 * 退款入口不可见的原因码（`refundEntry.visible=false` 时下发）。
 *
 * 前端不据此计算显隐（显隐只认 `visible`），只用于文案兜底：
 * 接口异常时至少能说清「为什么不能退」，而不是给一个空白的操作区。
 */
export const RefundEntryReason = {
    /** 订单不是「已过期」——可能还没过期、已核销、已退款等 */
    NOT_EXPIRED: 'NOT_EXPIRED',
    /** 免费预约，没有可退款项 */
    FREE_ORDER: 'FREE_ORDER',
    /** 未支付成功（理论上过期单必定已支付，属防御性分支） */
    NOT_PAID: 'NOT_PAID',
    /** 已超过申请时限 */
    DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
    /**
     * 订单已过期但缺少 `expiredAt`，**无法判定时限**。
     *
     * fail-closed：判不出来就不给入口，而不是当作"没有时限"永久开放。
     * 触发条件只有手工 SQL（`markExpired` 必写 `expiredAt`），属防御性分支。
     */
    DEADLINE_UNAVAILABLE: 'DEADLINE_UNAVAILABLE',
    /**
     * 该订单的退款申请**已被驳回**——驳回是终态，不允许再次申请（2026-09-13 决策）。
     * 用户该做的是联系管理员，而不是反复提交。
     */
    APPLY_REJECTED: 'APPLY_REJECTED',
    /** 已有进行中的申请（待审核 / 审核通过退款中） */
    APPLY_IN_PROGRESS: 'APPLY_IN_PROGRESS',
    /** 申请次数已达上限 */
    APPLY_LIMIT_REACHED: 'APPLY_LIMIT_REACHED',
} as const;

export type RefundEntryReasonValue = (typeof RefundEntryReason)[keyof typeof RefundEntryReason];

/**
 * 最新一条申请单的摘要（订单详情与列表的展示态都只看最新一条，§4.3.5）
 */
export interface LatestRefundApplyBrief {
    applyNo: string;
    status: RefundApplyStatus;
    applyCount: number;
    /** 申请退款金额（分） */
    refundAmount: number;
    reason: string;
    /** 拒绝理由（仅 rejected 有值，前端在「已驳回」态必须展示它） */
    rejectReason: string | null;
    createdAt: number;
}

/**
 * 退款入口（订单详情接口 `/bookings/:bookingId` 的派生字段）
 *
 * 【为什么必须在后端算】`expiredAt` 是服务端写的、7 天是服务端配的、申请次数在服务端表里，
 * 前端本地算必然与服务端漂移（时间不同步、缓存过期、配置变更）。
 * **前端一律只读 `visible`**，规则改动零前端发版。
 */
export interface RefundEntry {
    /** 前端唯一依据：true 才渲染「申请退款」按钮 */
    visible: boolean;
    /** 申请截止时刻（epoch ms），用于展示「申请截止：{deadline}」 */
    applyDeadline: number | null;
    /** 已消耗的申请次数（不含被驳回） */
    appliedCount: number;
    /** 上限（配置化，默认 3） */
    maxApplyCount: number;
    /** 最新一条申请，无则为 null */
    latestApply: LatestRefundApplyBrief | null;
    /** visible=false 时的原因码，用于文案兜底 */
    reason: RefundEntryReasonValue | null;
    /**
     * 客服电话，未配置时为空串。
     *
     * 随入口一起下发而不是让前端另调 `/system-config/*`：需要它的三个文案
     * （已驳回 / 退款失败 / 申请超期）全都由 `refundEntry` 触发，
     * 拆开会出现「状态显示了、电话还没到」的中间态，且多一次请求。
     * 空串时前端整行隐藏——宁可不显示，也不编一个打不通的号码。
     */
    contactPhone: string;
}
