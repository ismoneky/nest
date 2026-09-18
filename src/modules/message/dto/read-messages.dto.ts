import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/**
 * 标记已读
 *
 * ── 为什么必须是 `ids` 与 `all` 二选一的**显式**协议 ───────────────────────
 * 如果定义成「`ids` 为空 = 全部已读」，那么一个空 body `{}`、
 * 一次拼错的请求、一个被序列化成 `null` 的数组，都会**静默清空用户全部未读**。
 * 这种接口一旦被误用，用户是察觉不到的（角标先没了，消息还躺在列表里）。
 * 所以「全部已读」必须是一个用户明确点出来的动作：`all: true`。
 * 两者都没给 → 控制器返回 400，而不是悄悄当成其中一种。
 *
 * `ids` 上限 200：不是性能问题（SQLite IN 可以更长），是**防护**——
 * 没有上限时，一个畸形请求可以带 10 万个 id 让服务端拼一条巨长的 SQL。
 * 用户正常点选不可能超过一屏（20 条），200 已经非常宽松。
 */
export class ReadMessagesDto {
    /** 要标记的消息 ID；与 `all` 二选一 */
    @Transform(({ value }) => {
        // 兼容 JSON body 里传字符串 "1,2,3" 的写法（小程序端拼表单时的常见退化）
        if (typeof value === 'string') {
            return value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s !== '')
                .map((s) => Number(s));
        }
        return value;
    })
    @IsArray()
    @ArrayMaxSize(200)
    @IsInt({ each: true })
    @Min(1, { each: true })
    @IsOptional()
    ids?: number[];

    /** true = 全部标记已读（用户显式动作，不靠「ids 为空」推断） */
    @IsBoolean()
    @IsOptional()
    all?: boolean;
}
