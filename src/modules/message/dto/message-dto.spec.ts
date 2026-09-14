import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { GetMessagesDto } from './get-messages.dto';
import { ReadMessagesDto } from './read-messages.dto';
import { MessageType } from '../../../entities/message.entity';

/**
 * 消息接口入参的结构校验。
 *
 * 这两条 DTO 的正确性直接决定两件事，故单独锁定：
 *   1. **筛选值必须命中枚举**——不卡的话非法值会一路走到 `IN (:...msgTypes)`，
 *      结果是「查得到、但永远空」，前端拿到空列表会以为「没有消息」而不是「参数写错了」；
 *   2. **「全部已读」必须显式**——若允许「ids 为空即全标」，一个空 body
 *      就会静默清空用户全部未读。DTO 层的职责是保证这个歧义**到不了控制器**。
 *
 * 夹具均为虚构数据。
 */
describe('消息接口 DTO', () => {
    describe('GetMessagesDto', () => {
        it('逗号分隔的 msgType 转为数组（小程序端唯一行为一致的写法）', () => {
            const dto = plainToInstance(GetMessagesDto, {
                msgType: 'REFUND_ACCEPTED,REFUND_APPROVED',
            });
            expect(validateSync(dto)).toHaveLength(0);
            expect(dto.msgType).toEqual(['REFUND_ACCEPTED', 'REFUND_APPROVED']);
        });

        it('容忍逗号周围的空格与尾随逗号', () => {
            const dto = plainToInstance(GetMessagesDto, {
                msgType: 'REFUND_ACCEPTED , REFUND_SUCCESS,',
            });
            expect(validateSync(dto)).toHaveLength(0);
            expect(dto.msgType).toEqual(['REFUND_ACCEPTED', 'REFUND_SUCCESS']);
        });

        it('空串 = 不筛选（前端清空筛选时的正常请求，不该 400）', () => {
            const dto = plainToInstance(GetMessagesDto, { msgType: '' });
            expect(validateSync(dto)).toHaveLength(0);
            expect(dto.msgType).toBeUndefined();
        });

        it('非枚举取值被拒（挡住「查得到但永远空」的静默失败）', () => {
            const dto = plainToInstance(GetMessagesDto, { msgType: 'NOT_A_TYPE' });
            expect(validateSync(dto).length).toBeGreaterThan(0);
        });

        it('数组里混入非法值也被拒（@IsEnum each）', () => {
            const dto = plainToInstance(GetMessagesDto, {
                msgType: `${MessageType.REFUND_ACCEPTED},NOT_A_TYPE`,
            });
            expect(validateSync(dto).length).toBeGreaterThan(0);
        });

        it('分页默认值与上限', () => {
            const dto = plainToInstance(GetMessagesDto, {});
            expect(dto.page).toBe(1);
            expect(dto.pageSize).toBe(20);

            const tooBig = plainToInstance(GetMessagesDto, { pageSize: '999' });
            expect(validateSync(tooBig).length).toBeGreaterThan(0);
        });

        it('query 字符串形式的页码被转成数字', () => {
            const dto = plainToInstance(GetMessagesDto, { page: '3', pageSize: '10' });
            expect(validateSync(dto)).toHaveLength(0);
            expect(dto.page).toBe(3);
            expect(dto.pageSize).toBe(10);
        });
    });

    describe('ReadMessagesDto', () => {
        it('ids 支持 JSON 数组与逗号分隔字符串两种写法', () => {
            const asArray = plainToInstance(ReadMessagesDto, { ids: [1, 2, 3] });
            expect(validateSync(asArray)).toHaveLength(0);
            expect(asArray.ids).toEqual([1, 2, 3]);

            const asString = plainToInstance(ReadMessagesDto, { ids: '1,2,3' });
            expect(validateSync(asString)).toHaveLength(0);
            expect(asString.ids).toEqual([1, 2, 3]);
        });

        it('ids 含非数字 / 非正数被拒', () => {
            expect(validateSync(plainToInstance(ReadMessagesDto, { ids: ['abc'] })).length).toBeGreaterThan(0);
            expect(validateSync(plainToInstance(ReadMessagesDto, { ids: [0] })).length).toBeGreaterThan(0);
            expect(validateSync(plainToInstance(ReadMessagesDto, { ids: [-1] })).length).toBeGreaterThan(0);
        });

        it('ids 超过 200 条被拒（防止畸形请求拼出超长 IN 子句）', () => {
            const ids = Array.from({ length: 201 }, (_, i) => i + 1);
            expect(validateSync(plainToInstance(ReadMessagesDto, { ids })).length).toBeGreaterThan(0);
            expect(
                validateSync(plainToInstance(ReadMessagesDto, { ids: ids.slice(0, 200) })),
            ).toHaveLength(0);
        });

        it('all 只接受布尔值', () => {
            expect(validateSync(plainToInstance(ReadMessagesDto, { all: true }))).toHaveLength(0);
            expect(validateSync(plainToInstance(ReadMessagesDto, { all: 'yes' })).length).toBeGreaterThan(0);
        });

        it('两个参数可以都不给——**校验层不报错**，由控制器显式返回 400', () => {
            // 这是刻意的分工：DTO 层没有「必须有一个」的校验器能同时表达
            // 「两者互斥、且至少一个」而不引入跨字段自定义校验；把它放在控制器里
            // 反而更直白：那行 if 就是「不许猜用户想干什么」的执行点。
            const dto = plainToInstance(ReadMessagesDto, {});
            expect(validateSync(dto)).toHaveLength(0);
            expect(dto.ids).toBeUndefined();
            expect(dto.all).toBeUndefined();
        });
    });
});
