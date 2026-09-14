import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
    MessageRepository,
    MESSAGE_AUTO_READ_MS,
    MESSAGE_RETENTION_MS,
} from '../../repositories/message.repository';
import { Message, MessageType, MessageSenderType, OaSendStatus } from '../../entities/message.entity';
import { renderMessage } from './message-templates';

/**
 * 单用户每日系统消息上限（§4.4「防打扰」）
 *
 * `ADMIN_NOTICE` 不计入：那是人对人的沟通，被系统配额挡住会出现
 * 「管理员想解释却发不出去」的荒谬情形。
 *
 * 默认 5，可用 `MESSAGE_DAILY_LIMIT` 覆盖。**超限不是错误**——发送方拿到的
 * `{ sent: false, reason: 'DAILY_LIMIT' }` 与「已去重」是同一种处理：
 * 不写「已通知」标记位，留给下一轮补发。
 */
const DEFAULT_DAILY_LIMIT = 5;

/**
 * 发送结果
 *
 * 刻意**不用抛异常**表达失败：调用方几乎全是定时任务与回调，
 * 它们绝不能因为「用户今天消息收满了」而整批中断。
 * 唯一会抛的是数据库真故障——那种情况下让任务失败、下轮重跑才是对的。
 */
export interface SendResult {
    /** 消息在库里（本次插入 或 之前已存在）；false 表示本轮没发出去 */
    sent: boolean;
    /** 已存在同 dedupeKey 的消息（任务重跑、回调重放的正常路径） */
    duplicated: boolean;
    /** 未发送的原因，仅 sent=false 时有值 */
    reason?: 'DAILY_LIMIT';
    message: Message | null;
}

/**
 * 站内信服务（方案 §3.4 的通知架构）
 *
 * ── 渠道解耦：站内信是记录层，服务号是触达层 ──────────────────────────────
 * `send()` 只负责**落库**（100% 成功或明确告知为什么没落），
 * 服务号模板消息是它的第 3、4 步，由 `OA_ENABLED` 控制：
 *   · `OA_ENABLED=false`（默认）→ 第 3、4 步整体跳过，`oaSendStatus` 记 SKIPPED；
 *   · 服务号分支（独立分支 `feat/oa-template-message`）落地时只需实现
 *     `trySendOa()`，**不需要动本类的其余部分，也不需要动任何调用方**。
 * 这就是「上线主流程不需要任何微信侧前置条件」的实现方式（§4.6）。
 *
 * ── 本模块不依赖任何业务模块 ──────────────────────────────────────────────
 * 与 `RefundModule` 同款：`MessageModule` 只依赖 `TypeOrmModule.forFeature([Message])`，
 * 业务实体一律由调用方读好后传进来。这样 Booking / Refund / WechatPay / Admin / Feedback
 * 五个模块都能安全 import 它，不会与任何一个成环。
 */
@Injectable()
export class MessageService {
    private readonly logger = new Logger(MessageService.name);

    /** 治理任务的重入保护（与 BookingService 的 taskRunning 同款，本类只有一个任务故用裸布尔） */
    private governanceRunning = false;

    constructor(private readonly messageRepository: MessageRepository) {}

    // ─────────────────────────────────────────────────────────────────────────
    // 系统消息
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 发送一条系统消息（模板渲染 + 去重 + 每日配额）
     *
     * 顺序与理由：
     *   1. **先查重**——命中就直接返回。这一步是必要的，因为配额统计是「今天已经有几条」，
     *      若先去重再统计，任务重跑时会把同一条消息重复计数，把配额提前吃满；
     *   2. **再查配额**——超限返回 `DAILY_LIMIT`，调用方不写标记位，下轮补发；
     *   3. **最后插入**——靠唯一索引兜住第 1 步到第 3 步之间的并发窗口。
     */
    async send(
        msgType: MessageType,
        ctx: Parameters<typeof renderMessage>[1],
        now: Date = new Date(),
    ): Promise<SendResult> {
        const rendered = renderMessage(msgType, ctx);

        if (rendered.dedupeKey) {
            const existing = await this.messageRepository.findByDedupeKey(rendered.dedupeKey);
            if (existing) return { sent: true, duplicated: true, message: existing };
        }

        const limit = this.getDailyLimit();
        if (limit > 0) {
            const todayCount = await this.messageRepository.countTodaySystemMessages(ctx.userId, now);
            if (todayCount >= limit) {
                this.logger.warn(
                    `站内信每日上限已达（${todayCount}/${limit}），跳过 ${msgType}（用户 ${ctx.userId}）`,
                );
                return { sent: false, duplicated: false, reason: 'DAILY_LIMIT', message: null };
            }
        }

        const { message, created } = await this.messageRepository.createOnce({
            userId: ctx.userId,
            msgType,
            title: rendered.title,
            content: rendered.content,
            dedupeKey: rendered.dedupeKey,
            bizType: rendered.bizType,
            bizId: rendered.bizId,
            jumpPath: rendered.jumpPath,
            senderType: MessageSenderType.SYSTEM,
            oaSendStatus: this.oaStatusWhenDisabled(),
        });

        // 走到 `!created` 只有一种可能：预检之后、插入之前有另一个调用方插了同一个
        // dedupeKey（定时任务重入 / 回调重放）。此时**不能再发一遍服务号推送**——
        // 那正是去重要防的事。站内信那条已经在库里了，对用户而言没有任何损失。
        if (!created) return { sent: true, duplicated: true, message };

        if (message) await this.trySendOa(message);
        return { sent: true, duplicated: false, message };
    }

    /**
     * 发送「订单已过期，可申请退款」——T1 步骤②/T2 ② 的共用出口
     *
     * 单独包一层是因为这条消息的**调用方要拿它决定是否写标记位**
     * （`expireNotifiedAt`）：只有真正发出去了才写，被配额挡住就不写，下轮补发。
     * 让调用方去读 `SendResult.reason` 判断太隐晦，这里直接给出布尔语义。
     *
     * @returns true = 已发出或早已存在（两种情况都该写标记位，否则会反复重扫）
     */
    async sendOrderExpired(
        booking: { bookingId: string; wechatOpenId: string },
        applyDeadline: string | null,
        now: Date = new Date(),
    ): Promise<boolean> {
        const result = await this.send(
            MessageType.ORDER_EXPIRED,
            {
                userId: booking.wechatOpenId,
                bookingId: booking.bookingId,
                applyDeadline: applyDeadline ?? undefined,
            },
            now,
        );
        return result.sent;
    }

    /**
     * 通知用户「退款已到账」——**三个资金收敛路径共用的唯一出口**
     *
     * 【为什么是「共用出口」而不是让三个调用方各发各的】
     * 同一笔退款会被三条路径收敛：微信回调（`WechatPayService.handleRefundCallback`）、
     * 15 分钟退款对账（`BookingService.applyRefundReconcileResult`）、异常通道重试
     * （`BookingService.applyAnomalyAction`）。三处都有一个私有 `mirrorRefundSettlement`
     * 把申请单镜像成终态，但它们**直接调 `markSettled` 而不经过 `RefundApplyService`**
     * （那是为了避免模块环，见 wechat-pay.module.ts 的注释）。若把「发消息」写在
     * `RefundApplyService.syncSettledByOutRefundNo` 里，**真实回调路径上这条通知永远不会发出**。
     * 所以通知必须落在三条路径都能到达的地方——就是这个方法。
     *
     * 「只发一次」由调用方的 `affected > 0` 保证（三条路径并发时只有先到的那个拿到 1），
     * 即便漏了，`dedupeKey = REFUND_SUCCESS:{applyNo}` 也会兜住。
     *
     * 【为什么永不抛异常】
     * 调用点在**微信回调**里。这里抛出去会让回调返回失败 → 微信重推 → 整条回调路径重放。
     * 而站内信是通知不是业务结果：写不进去不该让一次已经成功的退款回调变成失败。
     * 这与 `send()` 的抛错策略（数据库真故障应当让定时任务失败并重跑）**刻意不同**——
     * 差别在调用方能否安全重试。
     *
     * 金额取**申请单上的快照**（`refund_applies.refundAmount`）而不是订单当前金额：
     * 退的钱就是申请时那笔，订单金额后续若变，这条消息不能跟着变。
     *
     * @param success 资金是否到账。**失败不发**：`refundStatus=failed` 需要人工介入，
     *        让管理员去沟通，而不是推一条用户看不懂的「退款失败」。
     */
    async notifyRefundSettled(
        apply: { applyNo: string; bookingId: string; wechatOpenId: string; refundAmount: number },
        success: boolean,
        now: Date = new Date(),
    ): Promise<void> {
        if (!success) return;
        try {
            await this.send(
                MessageType.REFUND_SUCCESS,
                {
                    userId: apply.wechatOpenId,
                    bookingId: apply.bookingId,
                    bizNo: apply.applyNo,
                    refundAmount: apply.refundAmount,
                },
                now,
            );
        } catch (error) {
            this.logger.error(
                `退款到账通知发送失败（不影响资金）: applyNo=${apply.applyNo}`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 管理员手动消息
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 管理员手动发送（§6 `/admin/messages/send`）
     *
     * `dedupeKey` 为 null → 走唯一索引「多个 NULL 互不冲突」的特性，
     * 同一个人可以收到任意多条手动消息；也**不计入每日系统消息上限**。
     */
    async sendAdminNotice(params: {
        openid: string;
        title: string;
        content: string;
        adminId: number | null;
        jumpPath?: string | null;
    }): Promise<Message | null> {
        // dedupeKey 为 null 时不存在「已存在」分支，created 恒为 true，
        // 所以这里只取 message——但保留解构形式，将来给手动消息加去重规则时不必改调用点
        const { message } = await this.messageRepository.createOnce({
            userId: params.openid,
            msgType: MessageType.ADMIN_NOTICE,
            title: params.title,
            content: params.content,
            dedupeKey: null,
            bizType: null,
            bizId: null,
            jumpPath: params.jumpPath ?? null,
            senderType: MessageSenderType.ADMIN,
            adminId: params.adminId,
            oaSendStatus: this.oaStatusWhenDisabled(),
        });
        return message;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 用户端读接口的直接实现（薄转发，归属校验在各处显式带上）
    // ─────────────────────────────────────────────────────────────────────────

    async getMyMessages(userId: string, query: { msgType?: string[]; page?: number; pageSize?: number }) {
        return await this.messageRepository.findUserMessages(userId, query);
    }

    async getUnreadCount(userId: string): Promise<number> {
        return await this.messageRepository.countUnread(userId);
    }

    /**
     * 标记指定消息为已读
     *
     * **归属校验在仓库层的 WHERE 里**（`userId = :userId`），不是先查后判——
     * 先查后判存在「查完到更新之间」的窗口，而且多一次查询；
     * 条件更新天然把「别人的消息」过滤成 affected=0：
     * 传了别人的 id 不会报错，也**不会改到别人的数据**，只是这行没被更新。
     *
     * @returns 实际更新行数；小于入参长度说明其中一部分不是本人的（或本来就已读）
     */
    async markRead(userId: string, ids: number[], now: Date = new Date()): Promise<number> {
        if (ids.length === 0) return 0;
        return await this.messageRepository.markRead(userId, ids, now);
    }

    /**
     * 全部标记已读
     *
     * 与 `markRead` 分成两个方法（而不是「ids 为空就全标」）是刻意的：
     * 后者会让一个空 body 静默清空用户的全部未读，而调用方无从分辨。
     * 「全部已读」是一个需要被显式表达的用户动作，见 ReadMessagesDto 的说明。
     */
    async markAllRead(userId: string, now: Date = new Date()): Promise<number> {
        return await this.messageRepository.markAllRead(userId, now);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // T3 治理（定时任务调用）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * T3 每日 03:24 治理（§4.4）
     *
     * 两件事一起做，因为它们的失败模式完全相同（都是「跑晚一点没关系」）：
     *   · 30 天未读 → 置为已读：未读数是**唯一**会被用户主动清理的计数器，
     *     长期不清理会让「消息中心」永远挂着几十个红点，用户直接无视它——
     *     那等于整个通知渠道失效。置已读时 `readAt` 记**治理时刻**而不是 30 天前，
     *     否则将来排查「用户到底看没看过」会拿到一个假答案。
     *   · 90 天前的消息 → 删除：SQLite 单库，messages 是唯一只增不减的表。
     *
     * 03:24 的选择：避开 03:21（日志清理）与 03:00-03:20 的整点窗口，
     * 且在所有对账任务（最晚 22:00）之后、次日业务开始之前。
     *
     * **两个方法都不抛异常给调度器**：治理失败不该产生告警噪音，下一天照跑。
     */
    @Cron('0 24 3 * * *', { timeZone: 'Asia/Shanghai' })
    async runDailyGovernance() {
        if (this.governanceRunning) return;
        this.governanceRunning = true;
        try {
            const now = new Date();
            const autoRead = await this.markStaleUnreadAsRead(now);
            const deleted = await this.deleteExpired(now);
            this.logger.log(`站内信治理完成: 置已读 ${autoRead} 条, 删除 ${deleted} 条`);
        } catch (error) {
            this.logger.error('站内信治理任务失败', error instanceof Error ? error.stack : String(error));
        } finally {
            this.governanceRunning = false;
        }
    }

    /**
     * 把超过 `MESSAGE_AUTO_READ_MS`（30 天）的未读置为已读
     *
     * 按**全局**扫描，不区分用户——这是全站治理，不是某个用户的操作。
     */
    async markStaleUnreadAsRead(now: Date = new Date()): Promise<number> {
        const cutoff = new Date(now.getTime() - MESSAGE_AUTO_READ_MS);
        return await this.messageRepository.markStaleUnreadAsRead(cutoff, now);
    }

    /** 删除超过 `MESSAGE_RETENTION_MS`（90 天）的消息 */
    async deleteExpired(now: Date = new Date()): Promise<number> {
        const cutoff = new Date(now.getTime() - MESSAGE_RETENTION_MS);
        return await this.messageRepository.deleteOlderThan(cutoff);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 私有
    // ─────────────────────────────────────────────────────────────────────────

    private getDailyLimit(): number {
        const raw = process.env.MESSAGE_DAILY_LIMIT;
        if (raw == null || raw.trim() === '') return DEFAULT_DAILY_LIMIT;
        const n = Number(raw);
        // 非数字/负数一律回落到默认值：配置写错不该让整条通知链路停摆。
        // 显式配 0 表示「不限」，这是一个有意义的取值，故不当作非法值处理。
        return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_LIMIT;
    }

    /** OA 未启用时落库的初始状态（启用时应为 PENDING，留给服务号分支改） */
    private oaStatusWhenDisabled(): number {
        return this.isOaEnabled() ? OaSendStatus.PENDING : OaSendStatus.SKIPPED;
    }

    private isOaEnabled(): boolean {
        return process.env.OA_ENABLED === 'true';
    }

    /**
     * 服务号模板消息（**独立分支 `feat/oa-template-message`，本阶段不实现**）
     *
     * 这里刻意保留一个空的、带明确边界的方法，而不是把调用点散在 send() 里：
     * 分支落地时只需要实现这个方法体 + `user_wx_oa` 表，
     * 主流程的代码一行都不用动（`OA_ENABLED=false` 时它根本不会被调用到有副作用的分支）。
     *
     * 失败处理的原则（§4.6）：**发失败不影响站内信**——站内信此时已经落库了。
     */
    private async trySendOa(message: Message): Promise<void> {
        if (!this.isOaEnabled()) return;
        // 未实现：服务号属独立分支，主流程不上线它。
        // 明确记一条日志而不是静默 return —— 若线上误开了 OA_ENABLED，
        // 这里必须留下痕迹，而不是让「消息发出去了但用户没收到推送」无从查起。
        this.logger.warn(`OA_ENABLED=true 但服务号通道尚未实现，消息 ${message.id} 仅落站内信`);
    }
}
