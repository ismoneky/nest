import { BadRequestException } from '@nestjs/common';

/**
 * 订单业务动作稳定错误码。
 *
 * 与 payment-errors.ts 同构：响应结构保持兼容（HTTP 400 + success/message/error），
 * 另附 errorCode 字段供前端按码分支，避免前端只能靠中文文案做判断。
 */
export const BookingErrorCode = {
    /** 订单当前状态不允许取消（已支付/已完成/已退款/已过期等，或已被其他流程推进） */
    ORDER_CANNOT_CANCEL: 'ORDER_CANNOT_CANCEL',
    /** 支付处理中：可能已在微信侧建单，需等超时关单对账收敛后再试 */
    ORDER_PAYMENT_IN_PROGRESS: 'ORDER_PAYMENT_IN_PROGRESS',
} as const;

export type BookingErrorCodeValue = (typeof BookingErrorCode)[keyof typeof BookingErrorCode];

/**
 * 带稳定错误码的订单业务异常。
 */
export class BookingException extends BadRequestException {
    constructor(
        public readonly code: BookingErrorCodeValue,
        message: string,
    ) {
        super(message);
        this.name = 'BookingException';
    }
}
