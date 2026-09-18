import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MessageType } from '../../../entities/message.entity';

/**
 * 用户端消息列表查询
 *
 * ── 为什么 `msgType` 收的是逗号分隔字符串，而不是数组 ──────────────────────
 * 小程序端 `uni.request` 拼 query 时数组会退化成 `msgType[]=A&msgType[]=B`
 * 或 `msgType=A&msgType=B`（视版本而定），后端解析结果不确定。
 * 逗号分隔是唯一在 uni-app / axios / curl 三处行为一致的写法。
 *
 * ── 为什么筛选值要在 DTO 层用 `@IsEnum` 卡住 ──────────────────────────────
 * 不做的话非法值会一路走到 `IN (:...msgTypes)`，结果是「查得到、但永远空」——
 * 前端拿到空列表会以为「没有消息」，而不是「参数写错了」。挡在这里能直接 400。
 * 白名单同时保证 `msgType` 无法被用来注入：值必须逐字命中枚举。
 *
 * 分组（「全部 / 退款 / 订单」）由**前端**决定发哪几个枚举值，
 * 后端不认识「退款组」这种概念——分组是产品口径，会随运营调整，
 * 放在后端意味着每次调 tab 都要发版。
 */
export class GetMessagesDto {
    /** 逗号分隔的消息类型，如 `REFUND_ACCEPTED,REFUND_APPROVED`；不传 = 全部 */
    @Transform(({ value }) => {
        if (typeof value !== 'string') return undefined;
        const parts = value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '');
        return parts.length > 0 ? parts : undefined;
    })
    @IsEnum(MessageType, { each: true })
    @IsOptional()
    msgType?: MessageType[];

    @Type(() => Number)
    @IsInt()
    @Min(1)
    @IsOptional()
    page?: number = 1;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    @IsOptional()
    pageSize?: number = 20;
}
