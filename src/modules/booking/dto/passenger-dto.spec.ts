import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PassengerErrorCode } from '../../../common/passenger-business.exception';
import { PassengerType, validatePassengerBusinessRules } from '../passenger-pricing';
import { CreateBookingDto, PassengerDto } from './createBooking.dto';
import { PreviewBookingDto } from './previewBooking.dto';

/**
 * 按 MOD 11-2 生成虚构合法 18 位身份证号，不含任何真实用户身份证。
 */
function makeIdCard(birth: string, seq = '001'): string {
    const prefix = '110101' + birth + seq;
    const factors = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let sum = 0;
    for (let i = 0; i < 17; i++) {
        sum += parseInt(prefix[i], 10) * factors[i];
    }
    return prefix + checkCodes[sum % 11];
}

function flattenErrors(errors: any[], path = ''): { path: string; messages: string[] }[] {
    const out: { path: string; messages: string[] }[] = [];
    for (const err of errors) {
        const p = path ? `${path}.${err.property}` : err.property;
        if (err.constraints) {
            out.push({ path: p, messages: Object.values(err.constraints) });
        }
        if (err.children?.length) {
            out.push(...flattenErrors(err.children, p));
        }
    }
    return out;
}

const ADULT_CARD = makeIdCard('19900101');
const BOOKING_DATE = '2026-08-13';
const BOOKING_BASE = { bookingDate: BOOKING_DATE, travelMode: 'scenicBus', personCount: 2 };

describe('PassengerDto 结构校验（preview 与 create 共用）', () => {
    it('preview 与 create 复用同一 PassengerDto', () => {
        const payload = { name: '张三', phone: '13800000001', idCard: ADULT_CARD };
        const create = plainToInstance(CreateBookingDto, { ...BOOKING_BASE, passengers: [payload] });
        const preview = plainToInstance(PreviewBookingDto, { bookingDate: BOOKING_DATE, passengers: [payload] });
        expect(create.passengers[0]).toBeInstanceOf(PassengerDto);
        expect(preview.passengers[0]).toBeInstanceOf(PassengerDto);
    });

    it('无身份证儿童能通过结构校验（preview 与 create 一致）', () => {
        const passengers = [
            { name: '张三', phone: '13800000001', idCard: ADULT_CARD },
            { name: '儿童', phone: '13800000002', idCard: '', passengerType: 'child', idCardUnavailable: true },
        ];
        const create = plainToInstance(CreateBookingDto, { ...BOOKING_BASE, passengers });
        expect(validateSync(create)).toHaveLength(0);

        const preview = plainToInstance(PreviewBookingDto, { bookingDate: BOOKING_DATE, passengers });
        expect(validateSync(preview)).toHaveLength(0);
    });

    it('旧客户端缺失 passengerType/idCardUnavailable 时归一化为 adult/false', () => {
        const instance = plainToInstance(CreateBookingDto, {
            ...BOOKING_BASE,
            passengers: [{ name: '张三', phone: '13800000001', idCard: ADULT_CARD }],
        });
        expect(instance.passengers[0].passengerType).toBe(PassengerType.ADULT);
        expect(instance.passengers[0].idCardUnavailable).toBe(false);
        expect(validateSync(instance)).toHaveLength(0);
    });

    it('字符串 true 不被当作 idCardUnavailable（隐式转换防护）', () => {
        const instance = plainToInstance(CreateBookingDto, {
            ...BOOKING_BASE,
            passengers: [{ name: '张三', phone: '13800000001', idCard: ADULT_CARD, idCardUnavailable: 'true' }],
        });
        expect(instance.passengers[0].idCardUnavailable).toBe(false);
    });

    it('传入非空但格式错误的身份证在 DTO 层被拒绝', () => {
        const instance = plainToInstance(CreateBookingDto, {
            ...BOOKING_BASE,
            passengers: [
                { name: '张三', phone: '13800000001', idCard: ADULT_CARD },
                { name: '儿童', phone: '13800000002', idCard: '123456', passengerType: 'child' },
            ],
        });
        const flat = flattenErrors(validateSync(instance));
        const idCardErr = flat.find((e) => e.path === 'passengers.1.idCard');
        expect(idCardErr?.messages).toContain('身份证号格式不正确');
    });

    it('unavailable=true 且身份证非空：DTO 跳过格式校验，业务抛 UNAVAILABLE_NOT_ALLOWED', () => {
        const instance = plainToInstance(CreateBookingDto, {
            ...BOOKING_BASE,
            passengers: [
                { name: '张三', phone: '13800000001', idCard: ADULT_CARD },
                { name: '儿童', phone: '13800000002', idCard: makeIdCard('20190101'), passengerType: 'child', idCardUnavailable: true },
            ],
        });
        expect(validateSync(instance)).toHaveLength(0);
        expect(() => validatePassengerBusinessRules(instance.passengers, BOOKING_DATE)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.UNAVAILABLE_NOT_ALLOWED }),
        );
    });

    it('无身份证成人结构校验通过，但业务校验抛 ID_CARD_REQUIRED', () => {
        const instance = plainToInstance(CreateBookingDto, {
            ...BOOKING_BASE,
            passengers: [
                { name: '张三', phone: '13800000001', idCard: makeIdCard('19880101') },
                { name: '李四', phone: '13800000002', idCard: '' },
            ],
        });
        expect(validateSync(instance)).toHaveLength(0);
        expect(() => validatePassengerBusinessRules(instance.passengers, BOOKING_DATE)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.ID_CARD_REQUIRED }),
        );
    });

    it('年龄不符的儿童结构校验通过，但业务校验抛 TYPE_AGE_MISMATCH', () => {
        const instance = plainToInstance(CreateBookingDto, {
            ...BOOKING_BASE,
            passengers: [
                { name: '张三', phone: '13800000001', idCard: ADULT_CARD },
                { name: '儿童', phone: '13800000002', idCard: makeIdCard('20180101'), passengerType: 'child' },
            ],
        });
        expect(validateSync(instance)).toHaveLength(0);
        expect(() => validatePassengerBusinessRules(instance.passengers, BOOKING_DATE)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.TYPE_AGE_MISMATCH }),
        );
    });
});
