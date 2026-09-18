import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * 退款申请稳定错误码。
 *
 * 响应结构保持兼容（HTTP 400 + success/message/error），另附 `code` 字段供前端按码分支。
 *
 * 【为什么必须给稳定码而不是只给中文文案】§4.3.5 的前端一律只读后端下发的
 * `refundEntry.visible` 决定是否渲染退款按钮，但**隐藏只是体验，拦截才是安全边界**：
 * 用户仍可能通过旧版本小程序、直接调接口、或在入口显隐的竞态里提交。
 * 这些拒绝必须能被前端区分开——「已超期」要引导联系管理员，「已在审核中」要提示耐心等待，
 * 靠匹配中文文案做不到。
 */
export const RefundErrorCode = {
    /** 订单不存在或不属于当前用户 */
    ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
    /** 订单当前状态不是「已过期」，没有可申请的退款 */
    ORDER_NOT_EXPIRED: 'ORDER_NOT_EXPIRED',
    /** 订单未支付成功 */
    ORDER_NOT_PAID: 'ORDER_NOT_PAID',
    /** 免费预约无需退款 */
    ORDER_IS_FREE: 'ORDER_IS_FREE',
    /** 已超过退款申请时限（expiredAt + 配置天数） */
    REFUND_DEADLINE_EXCEEDED: 'REFUND_DEADLINE_EXCEEDED',
    /** 订单已过期但缺 `expiredAt`，时限无法判定 → fail-closed 拒绝（防御性分支） */
    REFUND_DEADLINE_UNAVAILABLE: 'REFUND_DEADLINE_UNAVAILABLE',
    /**
     * 该订单的申请已被驳回，**驳回是终态**，不允许再次申请（2026-09-13 决策）。
     * 用户该联系管理员，而不是反复提交。
     */
    REFUND_APPLY_REJECTED: 'REFUND_APPLY_REJECTED',
    /** 存在进行中的申请（pending / approved），防重复提交 */
    REFUND_APPLY_IN_PROGRESS: 'REFUND_APPLY_IN_PROGRESS',
    /** 申请次数已达上限 */
    REFUND_APPLY_LIMIT_REACHED: 'REFUND_APPLY_LIMIT_REACHED',
    /** 申请单不存在 */
    APPLY_NOT_FOUND: 'APPLY_NOT_FOUND',
    /** 申请单不是「待审核」，已被处理 */
    APPLY_ALREADY_HANDLED: 'APPLY_ALREADY_HANDLED',
} as const;

export type RefundErrorCodeValue = (typeof RefundErrorCode)[keyof typeof RefundErrorCode];

/**
 * 带稳定错误码的退款业务异常。
 *
 * ⚠️ 与 booking-errors.ts / payment-errors.ts 的写法**刻意不同**：那两个类只
 * `super(message)`，Nest 构造的响应体是 `{ statusCode, message, error }`，
 * 没有 `code` 字段——`HttpExceptionFilter` 里的 `responseObj.code` 因此恒为 undefined，
 * 码实际上传不到前端。这里重写 `getResponse()` 把码放进响应体，让同一条链路真正闭环。
 */
export class RefundException extends BadRequestException {
    constructor(
        public readonly code: RefundErrorCodeValue,
        message: string,
    ) {
        super(message);
        this.name = 'RefundException';
    }

    getResponse(): Record<string, unknown> {
        const base = super.getResponse();
        return typeof base === 'object' && base !== null
            ? { ...(base as Record<string, unknown>), code: this.code }
            : { statusCode: this.getStatus(), message: String(base), code: this.code };
    }
}

/**
 * 归属校验失败（越权访问他人申请单/订单）。
 *
 * 单独用 403 而不是并入上面的 400 族：这不是「业务规则不允许」，
 * 而是「你根本不该看到这条数据」，与 booking.service 的归属校验同为 Forbidden 语义。
 * 注意 message 刻意不透露目标是否存在，避免成为遍历探测的预言机。
 */
export class RefundForbiddenException extends ForbiddenException {
    constructor(public readonly code: RefundErrorCodeValue, message: string) {
        super(message);
        this.name = 'RefundForbiddenException';
    }

    getResponse(): Record<string, unknown> {
        const base = super.getResponse();
        return typeof base === 'object' && base !== null
            ? { ...(base as Record<string, unknown>), code: this.code }
            : { statusCode: this.getStatus(), message: String(base), code: this.code };
    }
}
