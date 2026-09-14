import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, MessageType } from '../entities/message.entity';
import { serialWrite } from '../common/transaction-runner';
import { beijingDayStartMs } from '../common/date-utils';

/**
 * 用户端消息列表查询
 *
 * `msgType` 用**数组**而不是单值：消息中心要做「全部 / 退款 / 订单」这类分组筛选，
 * 而「退款」组 = REFUND_ACCEPTED + REFUND_APPROVED + REFUND_REJECTED + REFUND_SUCCESS。
 * 单值筛选做不到，且前端不该为了一个 tab 发四次请求。
 */
export interface MessageQuery {
    /** 不传 = 全部 */
    msgType?: string[];
    page?: number;
    pageSize?: number;
}

/** 未读消息自动置已读的阈值（T3）：30 天 */
export const MESSAGE_AUTO_READ_MS = 30 * 24 * 60 * 60 * 1000;
/** 消息保留时长（T3）：90 天 */
export const MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * 站内信数据访问层
 *
 * ── 转换协议与其他仓库一致 ────────────────────────────────────────────────
 * 只提供「带期望条件的原子更新 + 返回 affected rows」的原语，不决定业务转换。
 * 消息本身没有状态机，所以这里的条件更新只用在一处：**标记已读**——
 * 它必须带 `userId` 条件，否则就是「任何人可标记任何人的消息」的越权面（§6 开头）。
 *
 * ── 去重的最终裁决权在唯一索引，不在 SELECT ──────────────────────────────
 * `createOnce` 靠 `IDX_messages_dedupe` 兜底，而不是只靠先查后插：
 * 定时任务重入、回调重放、用户连点两次提交都会并发走到同一个 `dedupeKey`，
 * 先查后插在这个窗口里两个调用方都能查到「不存在」，然后其中一条插入失败——
 * 而那个失败会被上层当成「发送失败」，可实际上消息已经发出去了。
 * 具体做法（为什么不用 `orIgnore`）见 `createOnce` 的方法注释。
 */
@Injectable()
export class MessageRepository {
    constructor(
        @InjectRepository(Message)
        private readonly messageRepository: Repository<Message>,
    ) {}

    // ─────────────────────────────────────────────────────────────────────────
    // 写入
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 幂等插入：`dedupeKey` 已存在时不再插入，返回**既有那一行**。
     *
     * 被去重**不是错误**，是正常路径：定时任务重跑、支付回调重放、用户连点两次提交
     * 都会走到这里，调用方拿到的语义统一为「这条消息在库里」。
     *
     * ── 为什么不用 `.orIgnore()` ──────────────────────────────────────────────
     * `INSERT OR IGNORE` 撞索引时**不说话**：TypeORM 在 sqlite 下不回传「本次有没有
     * 真插进去」（`raw` / `identifiers` 的语义与 mysql/postgres 不一致——这也是本仓
     * `logging.service.ts` 用 orIgnore 时干脆丢弃返回值的原因）。而本方法必须回答
     * 「是不是我插的」：调用方要靠它决定**要不要发一遍服务号推送**（§4.6），
     * 报错了就等于给用户重复推送。所以这里用**普通 INSERT + 接住唯一约束错误**——
     * 抛错和没抛错本身就是最可靠的判据，不必猜驱动的返回值。
     * `serialWrite` 不开事务，插入失败不会留下任何未提交状态。
     */
    async createOnce(data: {
        userId: string;
        msgType: MessageType;
        title: string;
        content: string;
        dedupeKey: string | null;
        bizType?: string | null;
        bizId?: string | null;
        jumpPath?: string | null;
        senderType?: string;
        adminId?: number | null;
        oaSendStatus?: number;
    }): Promise<{ message: Message | null; created: boolean }> {
        const now = new Date();
        try {
            // ⚠️ 走 QueryBuilder 而不是 `repository.save()`：save 会自己再开一个事务
            // （见 transaction-runner 的 serialSave 说明）。代价是 `@BeforeInsert` 不触发，
            // 所以 createdAt/updatedAt 必须在这里**显式写**。
            const result = await serialWrite(this.messageRepository.manager.connection, () =>
                this.messageRepository
                    .createQueryBuilder()
                    .insert()
                    .into(Message)
                    .values({
                        userId: data.userId,
                        msgType: data.msgType,
                        title: data.title,
                        content: data.content,
                        dedupeKey: data.dedupeKey,
                        bizType: data.bizType ?? null,
                        bizId: data.bizId ?? null,
                        jumpPath: data.jumpPath ?? null,
                        senderType: data.senderType,
                        adminId: data.adminId ?? null,
                        oaSendStatus: data.oaSendStatus,
                        oaAttempts: 0,
                        isRead: 0,
                        createdAt: now,
                        updatedAt: now,
                    })
                    .execute(),
            );

            const id = result.identifiers?.[0]?.id as number | undefined;
            const inserted = id != null ? await this.messageRepository.findOne({ where: { id } }) : null;
            // `identifiers` 兜底：正常路径 sqlite 一定会回传 lastID，取不到时按 dedupeKey 回查。
            // 这里**不吞异常**——插入确实成功了却取不回行，属于必须被看见的问题
            if (inserted) return { message: inserted, created: true };
            if (data.dedupeKey) {
                return {
                    message: await this.messageRepository.findOne({ where: { dedupeKey: data.dedupeKey } }),
                    created: true,
                };
            }
            return { message: null, created: true };
        } catch (error) {
            if (!isUniqueConstraintError(error)) {
                throw new InternalServerErrorException(
                    error instanceof Error ? error.message : 'Failed to create message',
                );
            }
            // 撞 `IDX_messages_dedupe`：消息早就发过了。把既有那行取回来，
            // 让调用方仍然能拿到「这条消息在库里」的完整语义
            const existing = data.dedupeKey
                ? await this.messageRepository.findOne({ where: { dedupeKey: data.dedupeKey } })
                : null;
            return { message: existing, created: false };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 查询
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 按去重键取一条（发送前的预检）
     *
     * 与 `createOnce` 的 `orIgnore` 是两道互补的闸门，不是重复劳动：
     *   · 这里挡掉**绝大多数**重复（任务重跑、回调重放），代价是一次索引命中；
     *   · 唯一索引挡掉「预检到插入之间」的并发窗口。
     * 只有预检是不够的（并发下两条都会查到「没有」），只有唯一索引也是不够的——
     * 那样每次都要走一遍插入失败，而且**配额计数会先被算错**
     * （见 `MessageService.send` 里对顺序的说明）。
     */
    async findByDedupeKey(dedupeKey: string): Promise<Message | null> {
        return await this.messageRepository.findOne({ where: { dedupeKey } });
    }

    async findUserMessages(userId: string, query: MessageQuery) {
        const page = query.page && query.page > 0 ? query.page : 1;
        const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : 20;
        const skip = (page - 1) * pageSize;

        const qb = this.messageRepository
            .createQueryBuilder('msg')
            .where('msg.userId = :userId', { userId })
            // id 兜底排序：同一毫秒内多条消息（批量发送）顺序才不会跳
            .orderBy('msg.createdAt', 'DESC')
            .addOrderBy('msg.id', 'DESC')
            .skip(skip)
            .take(pageSize);

        if (query.msgType && query.msgType.length > 0) {
            qb.andWhere('msg.msgType IN (:...msgTypes)', { msgTypes: query.msgType });
        }

        const [messages, total] = await qb.getManyAndCount();
        return {
            messages,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }

    /** 未读数（`(userId, isRead, id)` 索引直接覆盖，§4.4「本期不引入冗余计数器」） */
    async countUnread(userId: string): Promise<number> {
        return await this.messageRepository.count({ where: { userId, isRead: 0 } });
    }

    /**
     * 今日已发送的**系统**消息条数（每日防打扰上限用，§4.4）
     *
     * `ADMIN_NOTICE` 不计入：管理员手动发送是人对人的沟通，
     * 被系统配额挡住会出现「管理员想解释却发不出去」。
     * 按**北京日**切分（`beijingDayStartMs`），否则服务器跑 UTC 时会在每天 08:00 重置额度。
     */
    async countTodaySystemMessages(userId: string, now: Date = new Date()): Promise<number> {
        return await this.messageRepository
            .createQueryBuilder('msg')
            .where('msg.userId = :userId', { userId })
            .andWhere('msg.msgType != :notice', { notice: MessageType.ADMIN_NOTICE })
            .andWhere('msg.createdAt >= :dayStart', { dayStart: beijingDayStartMs(now) })
            .getCount();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 条件更新原语
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 标记已读（**必须带 userId 条件**——这是归属校验，不是可选参数）
     *
     * @param ids 具体消息 id；为空数组时视为「不指定」由调用方决定调用 markAllRead
     * @returns 实际被更新的行数
     */
    async markRead(userId: string, ids: number[], now: Date = new Date()): Promise<number> {
        if (ids.length === 0) return 0;
        const result = await this.messageRepository
            .createQueryBuilder()
            .update(Message)
            .set({ isRead: 1, readAt: now, updatedAt: now })
            .where('userId = :userId', { userId })
            .andWhere('id IN (:...ids)', { ids })
            .andWhere('isRead = 0')
            .execute();
        return result.affected ?? 0;
    }

    /** 全部标为已读（同一把 userId 条件） */
    async markAllRead(userId: string, now: Date = new Date()): Promise<number> {
        const result = await this.messageRepository
            .createQueryBuilder()
            .update(Message)
            .set({ isRead: 1, readAt: now, updatedAt: now })
            .where('userId = :userId', { userId })
            .andWhere('isRead = 0')
            .execute();
        return result.affected ?? 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // T3 站内信治理
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 30 天前的未读消息置为已读。
     *
     * 为什么不是直接删：用户可能很久没打开小程序，回来时看到一堆「未读」会被淹没，
     * 但**消息本身还在**（退款凭证、驳回理由都要能回查），只是不再计入角标。
     *
     * `readAt` 记的是**本次治理的时刻**（`now`），不是 `cutoff`：这两者相差 30 天，
     * 写 cutoff 等于声称「用户 30 天前读过」，是假的。将来若要看「用户实际活跃度」，
     * 这份数据不能被伪造的时间戳污染。
     */
    async markStaleUnreadAsRead(cutoff: Date, now: Date = new Date()): Promise<number> {
        const result = await this.messageRepository
            .createQueryBuilder()
            .update(Message)
            .set({ isRead: 1, readAt: now, updatedAt: now })
            .where('isRead = 0')
            .andWhere('createdAt <= :cutoff', { cutoff: cutoff.getTime() })
            .execute();
        return result.affected ?? 0;
    }

    /** 删除 90 天前的消息（含已读与未读，硬删除） */
    async deleteOlderThan(cutoff: Date): Promise<number> {
        const result = await this.messageRepository
            .createQueryBuilder()
            .delete()
            .from(Message)
            .where('createdAt <= :cutoff', { cutoff: cutoff.getTime() })
            .execute();
        return result.affected ?? 0;
    }
}

/**
 * 判断是否为唯一约束冲突
 *
 * SQLite 驱动抛出的错误信息形如
 * `SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.dedupeKey`，
 * 没有稳定的 error code 字段可用（不同驱动版本措辞略有差异），故按关键字匹配。
 * 匹配不到时按普通错误抛出——**宁可让调用方看到失败，也不要把真实故障吞成「已去重」**。
 */
function isUniqueConstraintError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /UNIQUE constraint failed/i.test(msg);
}
