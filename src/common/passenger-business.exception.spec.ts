import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { PassengerBusinessException, PassengerErrorCode } from './passenger-business.exception';

/**
 * 乘客业务异常响应结构测试。
 *
 * 错误响应必须同时包含 statusCode=400、稳定 code 和中文 message，
 * 且任何序列化结果都不得包含身份证原值。
 */
describe('PassengerBusinessException', () => {
    it('getResponse 包含 400、稳定 code 和中文 message', () => {
        const ex = new PassengerBusinessException(PassengerErrorCode.ID_CARD_INVALID, '身份证号格式不正确');

        expect(ex.getStatus()).toBe(400);
        const body = ex.getResponse() as Record<string, unknown>;
        expect(body.statusCode).toBe(400);
        expect(body.code).toBe('PASSENGER_ID_CARD_INVALID');
        expect(body.message).toBe('身份证号格式不正确');
    });

    it('错误码枚举包含契约要求的全部 7 个值', () => {
        expect(PassengerErrorCode.ID_CARD_REQUIRED).toBe('PASSENGER_ID_CARD_REQUIRED');
        expect(PassengerErrorCode.ID_CARD_INVALID).toBe('PASSENGER_ID_CARD_INVALID');
        expect(PassengerErrorCode.TYPE_AGE_MISMATCH).toBe('PASSENGER_TYPE_AGE_MISMATCH');
        expect(PassengerErrorCode.COUNT_MISMATCH).toBe('PASSENGER_COUNT_MISMATCH');
        expect(PassengerErrorCode.LIMIT_EXCEEDED).toBe('PASSENGER_LIMIT_EXCEEDED');
        expect(PassengerErrorCode.CONTACT_INVALID).toBe('PASSENGER_CONTACT_INVALID');
        expect(PassengerErrorCode.UNAVAILABLE_NOT_ALLOWED).toBe('PASSENGER_ID_CARD_UNAVAILABLE_NOT_ALLOWED');
    });

    it('响应与异常序列化均不包含身份证原值', () => {
        const idCard = '110101199001011237';
        const ex = new PassengerBusinessException(PassengerErrorCode.ID_CARD_INVALID, '身份证号格式不正确');

        expect(JSON.stringify(ex.getResponse())).not.toContain(idCard);
        expect(JSON.stringify(ex)).not.toContain(idCard);
    });

    it('HttpExceptionFilter 统一 JSON 透传 code 字段', () => {
        const filter = new HttpExceptionFilter();
        const json = jest.fn();
        const status = jest.fn().mockReturnValue({ json });
        const host = {
            switchToHttp: () => ({
                getResponse: () => ({ status }),
                getRequest: () => ({ url: '/api/booking/preview' }),
            }),
        } as unknown as ArgumentsHost;

        filter.catch(
            new PassengerBusinessException(PassengerErrorCode.COUNT_MISMATCH, '预约人数与人员列表不一致'),
            host,
        );

        const body = json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.statusCode).toBe(400);
        expect(body.code).toBe('PASSENGER_COUNT_MISMATCH');
        expect(body.message).toBe('预约人数与人员列表不一致');
        expect(body.error).toBe('Bad Request');
        expect(body.path).toBe('/api/booking/preview');
    });

    it('非乘客 BadRequestException 响应不新增 code 字段', () => {
        const filter = new HttpExceptionFilter();
        const json = jest.fn();
        const status = jest.fn().mockReturnValue({ json });
        const host = {
            switchToHttp: () => ({
                getResponse: () => ({ status }),
                getRequest: () => ({ url: '/api/booking/create' }),
            }),
        } as unknown as ArgumentsHost;

        filter.catch(new BadRequestException('普通校验失败'), host);

        const body = json.mock.calls[0][0];
        expect(body.statusCode).toBe(400);
        expect(body.message).toBe('普通校验失败');
        expect(body.code).toBeUndefined();
    });
});
