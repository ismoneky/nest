import { BadRequestException } from '@nestjs/common';

/**
 * 支付流程稳定错误码。
 * 接口文档「错误码」一节给出部分列表；ORDER_ALREADY_PAID 为设计步骤 2「已支付返回稳定结果」
 * 所需的补充码（错误码契约待设计确认，见 implementation-todo.md 待确认问题 6）。
 */
export const PaymentErrorCode = {
    ORDER_ALREADY_PAID: 'ORDER_ALREADY_PAID',
    PAYMENT_PREPARATION_TIMEOUT: 'PAYMENT_PREPARATION_TIMEOUT',
    PAYMENT_RESULT_UNKNOWN: 'PAYMENT_RESULT_UNKNOWN',
    PAYMENT_START_REJECTED: 'PAYMENT_START_REJECTED',
    CLOSE_ORDER_UNKNOWN: 'CLOSE_ORDER_UNKNOWN',
    CLOSE_ORDER_ALREADY_PAID: 'CLOSE_ORDER_ALREADY_PAID',
    QUERY_ORDER_UNKNOWN: 'QUERY_ORDER_UNKNOWN',
    QUERY_REFUND_UNKNOWN: 'QUERY_REFUND_UNKNOWN',
} as const;

export type PaymentErrorCodeValue = (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];

/**
 * 带稳定错误码的支付异常。
 * 响应结构保持兼容（HTTP 400 + success/message/error），另附 errorCode 字段供前端按码分支。
 */
export class PaymentException extends BadRequestException {
    constructor(
        public readonly code: PaymentErrorCodeValue,
        message: string,
    ) {
        super(message);
        this.name = 'PaymentException';
    }
}
