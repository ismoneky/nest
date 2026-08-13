import { BadRequestException, HttpStatus } from '@nestjs/common';

/**
 * 乘客业务稳定错误码。
 * 小程序通过 request.js 原样 reject 的 err.data.code 读取并按码映射中文提示
 * （见 fctl/utils/passenger-error-messages.js），因此码值变更属于接口契约变更。
 */
export enum PassengerErrorCode {
    ID_CARD_REQUIRED = 'PASSENGER_ID_CARD_REQUIRED',
    ID_CARD_INVALID = 'PASSENGER_ID_CARD_INVALID',
    TYPE_AGE_MISMATCH = 'PASSENGER_TYPE_AGE_MISMATCH',
    COUNT_MISMATCH = 'PASSENGER_COUNT_MISMATCH',
    LIMIT_EXCEEDED = 'PASSENGER_LIMIT_EXCEEDED',
    CONTACT_INVALID = 'PASSENGER_CONTACT_INVALID',
    UNAVAILABLE_NOT_ALLOWED = 'PASSENGER_ID_CARD_UNAVAILABLE_NOT_ALLOWED',
}

/**
 * 带稳定错误码的乘客业务异常（HTTP 400）。
 * 经 HttpExceptionFilter 统一 JSON 化时透传 code 字段；
 * message 只允许业务文案，不得拼接身份证号等身份证明文。
 */
export class PassengerBusinessException extends BadRequestException {
    constructor(
        public readonly code: PassengerErrorCode,
        message: string,
    ) {
        super({ statusCode: HttpStatus.BAD_REQUEST, message, error: 'Bad Request', code });
        this.name = 'PassengerBusinessException';
    }
}
