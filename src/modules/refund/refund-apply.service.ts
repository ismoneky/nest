import { Injectable, Logger } from '@nestjs/common';
import { RefundApplyRepository, RefundApplyQuery } from '../../repositories/refund-apply.repository';
import { SystemConfigService } from '../system-config/system-config.service';
import { MessageService } from '../message/message.service';
import { resolveApplyDeadlineMs } from './refund-deadline';
import { Booking, BookingStatus, PaymentStatus, RefundStatus } from '../../entities/booking.entity';
import { RefundApply, RefundApplyStatus } from '../../entities/refund-apply.entity';
import { RefundException, RefundErrorCode, RefundForbiddenException } from '../../common/refund-errors';
import { MessageType } from '../../entities/message.entity';
import {
    LatestRefundApplyBrief,
    RefundEntry,
    RefundEntryReason,
    RefundEntryReasonValue,
} from './interfaces/refund-entry.interface';

/**
 * 审核 SLA：pending 超过该时长即视为超时（后台标红；T4 在阶段 5 另行提醒）
 */
const AUDIT_SLA_MS = 48 * 60 * 60 * 1000;

/**
 * 退款申请/审核业务逻辑层
 *
 * ── 职责边界（这是全方案最重要的技术决策，§3.2）──────────────────────────────
 * 本服务**只管「申请 / 审核」单据**，一行资金状态都不碰。
 * 「钱怎么退」完全复用既有链路：`BookingService.initiateRefund` → `markRefundStarting`
 * 条件更新 → 微信 → 退款回调 / 15 分钟对账 → `markRefundSucceeded/Failed`。
 *
 * 本服务对资金结果只做一件事：**镜像**。既有链路把结果落到 `bookings.refundStatus` 后，
 * 调用 `syncSettledByOutRefundNo` 把同一个 `outRefundNo` 对应的申请单也置为终态。
 * 镜像失败不影响资金——这是单向的、可重放的写入，不是第二套状态机。
 *
 * ── 为什么单据状态用条件更新 ──────────────────────────────────────────────
 * 「审核通过」是资金出口，两个管理员同时点通过必须只有一个生效，
 * 否则会对同一笔订单发起两次退款。互斥由 `markApproved/markRejected` 的
 * `WHERE status='pending'` 保证（affected=0 即被抢先），本服务里的读-判-写**不是**并发保护。
 */
@Injectable()
export class RefundApplyService {
    private readonly logger = new Logger(RefundApplyService.name);

    /**
     * 刻意**不注入 BookingRepository**：订单一律由调用方（控制器）读好后传进来。
     *
     * 这不是风格洁癖，是模块图的要求：本服务由 `RefundModule` 提供，而 `RefundModule`
     * 会被 `BookingModule` / `WechatPayModule` / `AdminModule` 三个模块 import。
     * 一旦本服务依赖 `BookingRepository`，`RefundModule` 就必须 import `BookingModule`，
     * 与 `BookingModule → RefundModule` 立刻构成模块环。
     *
     * 调用方本来就是「先取订单做归属校验」的（见 `BookingController`），
     * 把订单传进来不增加任何一次查询。
     */
    /**
     * 站内信：本服务是「申请 / 审核」的四个发送点（受理、通过、驳回、到账）。
     *
     * `MessageModule` 是**叶子模块**（只依赖 `TypeOrmModule.forFeature([Message])`
     * 与 `UserModule`），`RefundModule → MessageModule` 不构成环——
     * 这正是当初把它设计成叶子的原因。
     */
    constructor(
        private readonly refundApplyRepository: RefundApplyRepository,
        private readonly systemConfigService: SystemConfigService,
        private readonly messageService: MessageService,
    ) {}

    // ─────────────────────────────────────────────────────────────────────────
    // 入口显隐（订单详情下发，前端唯一依据）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 计算订单的退款入口（§4.3.5）
     *
     * `visible=true` 当且仅当以下**全部**满足：
     *   1. `status === 'expired'`
     *   2. `paymentStatus === 'paid'` 且 `!isFree`
     *   3. `now <= expiredAt + 申请时限（默认 7 天）`
     *   4. 不存在 `status IN ('pending','approved')` 的申请单
     *   5. 已消耗申请次数 < 上限（默认 3）
     *
     * 逾期的 `visible` 由**后端**算而不是前端：`expiredAt` 是服务端写的、时限是服务端配的、
     * 次数在服务端表里，前端本地算必然漂移。
     *
     * ⚠️ `visible=false` 只是「不渲染按钮」，**不是安全边界**——真正的拦截在 `submitApply`。
     * 用户仍可能用旧版小程序或直接调接口提交。
     *
     * @param booking 调用方已读好的订单（订单详情接口本身就带这个对象）
     */
    async buildRefundEntry(booking: Booking): Promise<RefundEntry> {
        const maxApplyCount = this.systemConfigService.getRefundMaxApplyCount();

        // ⚡ 短路：非 `expired` 的订单必然不可申请（下面 resolveEntryReason 的第一条就是它），
        // 而这三个查询在那种情况下全是白付。订单详情是**热点接口**——小程序端在
        // `confirmation`/`pending` 状态下每 5 秒轮询一次详情（见 booking-detail 的 loopDetail），
        // 不短路等于每个打开着的详情页每分钟多 36 次查询，而本库是单连接 SQLite。
        // 注意：短路后 latestApply 恒为 null，前端只在 expired 分支读它，故无影响。
        if (booking.status !== BookingStatus.EXPIRED) {
            return {
                visible: false,
                applyDeadline: null,
                appliedCount: 0,
                maxApplyCount,
                latestApply: null,
                reason: RefundEntryReason.NOT_EXPIRED,
                contactPhone: this.systemConfigService.getRefundContactPhone(),
            };
        }

        const [appliedCount, openApply, rejectedApply, latestApply] = await Promise.all([
            this.refundApplyRepository.countConsumedApplies(booking.bookingId),
            this.refundApplyRepository.hasOpenApply(booking.bookingId),
            this.refundApplyRepository.hasRejectedApply(booking.bookingId),
            this.refundApplyRepository.findLatestByBookingId(booking.bookingId),
        ]);

        const applyDeadline = this.resolveApplyDeadline(booking);
        const reason = this.resolveEntryReason(booking, {
            appliedCount,
            maxApplyCount,
            hasOpenApply: openApply,
            hasRejectedApply: rejectedApply,
            applyDeadline,
        });

        return {
            visible: reason === null,
            applyDeadline,
            appliedCount,
            maxApplyCount,
            latestApply: latestApply ? toApplyBrief(latestApply) : null,
            reason,
            contactPhone: this.systemConfigService.getRefundContactPhone(),
        };
    }

    /**
     * 申请截止时刻（epoch ms）：`expiredAt + 时限天数`。
     *
     * 公式本体在 `refund-deadline.ts`——`BookingService` 的 T1 ② / T2 ②
     * 也要用它组装站内信文案，而那个模块不能注入本服务（见类头注释）。
     * 本方法只负责把配置喂进去，不做第二次实现。
     */
    private resolveApplyDeadline(booking: Booking): number | null {
        return resolveApplyDeadlineMs(
            booking.expiredAt,
            this.systemConfigService.getRefundApplyDeadlineDays(),
        );
    }

    /**
     * 入口不可见的原因码；返回 null 表示可见（可以申请）。
     *
     * 判定顺序即 §4.3.5 的五条 + 两条后加的终止条件，顺序有意义：
     * 先说「不是过期单」这种根因，再说与用户当下处境相关的理由。
     */
    private resolveEntryReason(
        booking: Booking,
        state: {
            appliedCount: number;
            maxApplyCount: number;
            hasOpenApply: boolean;
            hasRejectedApply: boolean;
            applyDeadline: number | null;
        },
    ): RefundEntryReasonValue | null {
        if (booking.status !== BookingStatus.EXPIRED) return RefundEntryReason.NOT_EXPIRED;
        if (booking.isFree) return RefundEntryReason.FREE_ORDER;
        // `!== PAID` 已覆盖 refunding/refunded/failed/unpaid 全部情况（退款终态时 paymentStatus 也变）
        if (booking.paymentStatus !== PaymentStatus.PAID) return RefundEntryReason.NOT_PAID;

        // 驳回是终态：不再开放入口（2026-09-13 决策）。
        // 放在时限/审核中之前——「这笔退款被驳回了」比「已超期」更贴近用户要处理的实事，
        // 文案会引导他联系管理员。
        if (state.hasRejectedApply) return RefundEntryReason.APPLY_REJECTED;

        // 时限无法判定（缺 expiredAt）→ fail-closed，不给入口。
        // 不能因为查不到基准就把窗口当成"无限"：那是把数据缺失翻译成"永久可退"。
        if (state.applyDeadline == null) return RefundEntryReason.DEADLINE_UNAVAILABLE;

        // 超期判定放在「审核中」之前：已超期且审核中的单，用户该看到的是进度而不是催促
        if (Date.now() > state.applyDeadline) {
            return RefundEntryReason.DEADLINE_EXCEEDED;
        }
        if (state.hasOpenApply) return RefundEntryReason.APPLY_IN_PROGRESS;
        if (state.appliedCount >= state.maxApplyCount) return RefundEntryReason.APPLY_LIMIT_REACHED;

        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 用户侧：提交申请 / 查询
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 提交退款申请（§4.3.1）
     *
     * 七条校验**顺序执行、全部在服务端**：
     *   1. 归属：`booking.wechatOpenId === openid`
     *   2. `status === 'expired'`
     *   3. `paymentStatus === 'paid'` 且 `!isFree`
     *   4. `expiredAt` 存在，且 `now <= expiredAt + 时限`（判不出时限则 fail-closed）
     *   5. 不存在 `rejected` 申请单（**驳回是终态**，2026-09-13 决策）
     *   6. 不存在 pending/approved 的申请单
     *   7. 已消耗次数 < 上限
     *
     * 插入申请单后**不修改 bookings 的任何状态字段**——「拒绝后不回退订单状态」在这里的另一半：
     * 申请也不推订单状态。订单全程保持 `expired`，用户可见的「审核中/已驳回」由
     * `refund_applies.status` 组合出来（§4.3.5）。
     *
     * @param booking 调用方已读好的订单（归属校验由调用方通过 `getBookingById(id, openid)` 完成；
     *        这里仍复核一次 `wechatOpenId`，作为不依赖调用方自觉的兜底）
     */
    async submitApply(
        booking: Booking,
        openid: string,
        reason: string,
    ): Promise<RefundApply> {
        const bookingId = booking.bookingId;

        // 1) 归属：兜底复核，不依赖调用方自觉
        if (!openid || booking.wechatOpenId !== openid) {
            throw new RefundForbiddenException(RefundErrorCode.ORDER_NOT_FOUND, '订单不存在');
        }

        const trimmedReason = (reason ?? '').trim();
        if (!trimmedReason) {
            throw new RefundException(RefundErrorCode.ORDER_NOT_EXPIRED, '请填写退款原因');
        }
        if (trimmedReason.length > 500) {
            throw new RefundException(RefundErrorCode.ORDER_NOT_EXPIRED, '退款原因不能超过 500 字');
        }

        await this.assertCanApply(booking);

        // 序号基于「历史最大序号 + 1」，不是「已消耗次数 + 1」：
        // 申请→驳回→再申请 时消耗次数不变，用后者会算出重复序号撞唯一索引。
        const maxApplyCount = this.systemConfigService.getRefundMaxApplyCount();
        const nextApplyCount = (await this.refundApplyRepository.maxApplyCount(bookingId)) + 1;

        // 并发重复提交的兜底：唯一索引 (bookingId, applyCount) 拒绝第二条同序号插入。
        // 捕获后重新判定，给用户一个能看懂的结论而不是 500。
        let apply: RefundApply;
        try {
            apply = await this.refundApplyRepository.createApply({
                bookingId,
                wechatOpenId: booking.wechatOpenId,
                applyCount: nextApplyCount,
                reason: trimmedReason,
                refundAmount: booking.amount ?? 0,
            });
        } catch (error) {
            if (await this.refundApplyRepository.hasOpenApply(bookingId)) {
                throw new RefundException(
                    RefundErrorCode.REFUND_APPLY_IN_PROGRESS,
                    '退款申请已提交，请勿重复提交',
                );
            }
            const consumed = await this.refundApplyRepository.countConsumedApplies(bookingId);
            if (consumed >= maxApplyCount) {
                throw new RefundException(
                    RefundErrorCode.REFUND_APPLY_LIMIT_REACHED,
                    `退款申请次数已达上限（${maxApplyCount} 次）`,
                );
            }
            throw error;
        }

        this.logger.log(`退款申请已受理: ${apply.applyNo}（订单 ${bookingId} 第 ${apply.applyCount} 次）`);

        // 受理回执。**站内信不套 A 规则**——它是对用户主动动作的应答，
        // 压 2 小时会变成「申请了退款却迟迟没回音」（§4.2.5）。
        await this.notifySafely(`REFUND_ACCEPTED ${apply.applyNo}`, () =>
            this.messageService.send(MessageType.REFUND_ACCEPTED, {
                userId: booking.wechatOpenId,
                bookingId,
                // dedupeKey 用申请单号而非订单号：同一订单第 2、3 次申请必须各发一条，
                // 用订单号会让第二条起被静默去重（v1 最严重的缺陷，见 message-templates）
                bizNo: apply.applyNo,
            }),
        );

        return apply;
    }

    /**
     * 七条校验的复用实现（提交前、入口显隐之外的**硬拦截**）
     *
     * 抛出的错误码与 `RefundEntryReason` 一一对应，但**不复用**后者：
     * 前者是给用户看的拒绝理由，后者是给前端做文案兜底的原因码，
     * 两者措辞不同、生命周期不同（错误码要稳定，原因码可增删），强行复用会互相绑架。
     */
    private async assertCanApply(booking: Booking): Promise<void> {
        // 2) 必须是已过期订单。未过期的单应走既有自助退款入口（confirmed 单）
        if (booking.status !== BookingStatus.EXPIRED) {
            throw new RefundException(
                RefundErrorCode.ORDER_NOT_EXPIRED,
                '订单未过期，无需提交退款申请',
            );
        }
        // 3) 必须有可退的款
        if (booking.isFree) {
            throw new RefundException(RefundErrorCode.ORDER_IS_FREE, '免费预约无需退款');
        }
        if (
            booking.paymentStatus === PaymentStatus.REFUNDED ||
            booking.refundStatus === RefundStatus.REFUNDED
        ) {
            throw new RefundException(RefundErrorCode.ORDER_NOT_PAID, '订单已退款');
        }
        if (booking.paymentStatus !== PaymentStatus.PAID) {
            throw new RefundException(RefundErrorCode.ORDER_NOT_PAID, '订单未支付，无法退款');
        }
        // 4) 申请时限（硬性上限，过期即永久关闭入口）
        const applyDeadline = this.resolveApplyDeadline(booking);
        if (applyDeadline == null) {
            // 判不出时限 → fail-closed。与入口显隐同源，两处都不能放行（§4.3.1：
            // 这六条既是退还入口的判定条件，也是提交时的硬拦截）
            throw new RefundException(
                RefundErrorCode.REFUND_DEADLINE_UNAVAILABLE,
                '退款申请入口未开放，如有疑问请联系管理员',
            );
        }
        if (Date.now() > applyDeadline) {
            throw new RefundException(
                RefundErrorCode.REFUND_DEADLINE_EXCEEDED,
                '退款申请已超期，如有疑问请联系管理员',
            );
        }
        // 驳回是终态：不允许再次申请（2026-09-13 决策）。
        // 放在「进行中」与次数判定之前——用户最该被告知的是「这笔已被驳回」，而不是
        // 「你还有几次机会」。前端在驳回态不渲染按钮，这一条是安全边界。
        if (await this.refundApplyRepository.hasRejectedApply(booking.bookingId)) {
            throw new RefundException(
                RefundErrorCode.REFUND_APPLY_REJECTED,
                '该订单的退款申请已被驳回，如有疑问请联系管理员',
            );
        }
        // 6) 防重复提交（放在次数判定之前：用户更该被告知「正在审核」而不是「次数用完了」）
        if (await this.refundApplyRepository.hasOpenApply(booking.bookingId)) {
            throw new RefundException(
                RefundErrorCode.REFUND_APPLY_IN_PROGRESS,
                '退款申请已提交，请勿重复提交',
            );
        }
        // 5) 次数上限
        const consumed = await this.refundApplyRepository.countConsumedApplies(booking.bookingId);
        const maxApplyCount = this.systemConfigService.getRefundMaxApplyCount();
        if (consumed >= maxApplyCount) {
            throw new RefundException(
                RefundErrorCode.REFUND_APPLY_LIMIT_REACHED,
                `退款申请次数已达上限（${maxApplyCount} 次），如有疑问请联系管理员`,
            );
        }
    }

    /**
     * 某订单的申请单 + 用户历史申请（订单详情、退款详情页共用）
     */
    async getAppliesForBooking(bookingId: string): Promise<RefundApply[]> {
        return this.refundApplyRepository.findAllByBookingId(bookingId);
    }

    /**
     * 我的申请单详情（**必须校验归属**）
     *
     * 越权访问返回 403 而不是 404：申请单号是随机串，能猜中的概率极低，
     * 此处返回 403 不会形成有效预言机，而 404 会让真正拼错单号的用户以为是系统故障。
     */
    async getMyApply(applyNo: string, openid: string): Promise<RefundApply> {
        const apply = await this.refundApplyRepository.getByApplyNo(applyNo);
        if (apply.wechatOpenId !== openid) {
            throw new RefundForbiddenException(RefundErrorCode.APPLY_NOT_FOUND, '无权访问该退款申请');
        }
        return apply;
    }

    /**
     * 我的退款申请列表（可按订单过滤）
     */
    async getMyApplies(openid: string, bookingId?: string): Promise<RefundApply[]> {
        return this.refundApplyRepository.findByOpenId(openid, bookingId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 管理端：审核
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 审核列表（分页；pending 超 48h 标 `isTimeout`）
     *
     * `isTimeout` 是**相对当下时刻**的派生值，刻意不落库：落库必然过期，
     * 而且 SLA 时长会变。前端据此标红，运营侧据此排优先级。
     */
    async getAuditList(query: RefundApplyQuery) {
        const result = await this.refundApplyRepository.getForAdmin(query);
        const now = Date.now();
        return {
            ...result,
            applies: result.applies.map((apply) => ({
                ...apply,
                isTimeout:
                    apply.status === RefundApplyStatus.PENDING &&
                    now - new Date(apply.createdAt).getTime() > AUDIT_SLA_MS,
            })),
        };
    }

    /**
     * 审核详情：申请单 + 订单快照 + 该订单的全部历史申请
     *
     * 一并返回历史申请是刻意设计（§4.1.1）：管理员需要看到用户此前被驳回了几次、
     * 每次的理由，才能判断这是「反复申请」还是「首次申诉」。
     * 这也是 Q2「不补核销」的配套——核销故障的申诉要有人能看出模式。
     *
     * @param bookingLoader 由调用方提供的订单读取函数（管理端走无归属校验的读法）。
     *        用回调而不是注入仓库，理由见类构造函数注释。
     */
    async getAuditDetail(applyNo: string, bookingLoader: (bookingId: string) => Promise<Booking>) {
        const apply = await this.refundApplyRepository.getByApplyNo(applyNo);
        const booking = await bookingLoader(apply.bookingId);
        const history = await this.refundApplyRepository.findAllByBookingId(apply.bookingId);
        return { apply, booking, history };
    }

    /**
     * 审核通过（第一段：单据流转 + 生成退款单号）
     *
     * **只做条件更新，不调微信**。返回 `outRefundNo` 供调用方（AdminService）接着调
     * `BookingService.initiateRefund`。这样拆开的理由有两个：
     *   1. `RefundApplyService` 不必依赖 `BookingService`——否则与
     *      `BookingService → RefundApplyRepository` 形成模块环；
     *   2. 微信 HTTP 必须留在写链之外（本库是 SQLite 单写者，外部请求绝不进事务），
     *      编排放在更外层天然满足这条。
     *
     * 顺序是「先落 approved，再调微信」而不是反过来：若先调微信成功、落库失败，
     * 单据会停在 pending 且钱已经退了，管理员会再点一次通过 → 重复退款。
     * 现在的顺序下，最坏情况是 approved + 微信没调起来，由既有对账链路收敛
     * （`initiateRefund` 内部失败不回滚 refundStatus，订单停在 refunding，
     * 15 分钟对账接管）——这与用户自助退款走的是同一套容错。
     */
    async prepareApproval(
        applyNo: string,
        admin: { adminId: number | null; adminName: string | null },
        remark?: string,
    ): Promise<{ apply: RefundApply; outRefundNo: string }> {
        const apply = await this.refundApplyRepository.getByApplyNo(applyNo);

        // 前置校验只为友好文案，真正的互斥由下方条件更新保证
        if (apply.status !== RefundApplyStatus.PENDING) {
            throw new RefundException(RefundErrorCode.APPLY_ALREADY_HANDLED, '该申请已被处理，请刷新后查看');
        }

        const outRefundNo = buildOutRefundNo(apply.bookingId, apply.applyCount);
        const affected = await this.refundApplyRepository.markApproved(applyNo, {
            outRefundNo,
            adminId: admin.adminId,
            adminName: admin.adminName,
            remark: remark?.trim() || null,
            at: Date.now(),
        });
        if (affected === 0) {
            // 并发被抢先（另一个管理员刚点了通过/拒绝）
            throw new RefundException(RefundErrorCode.APPLY_ALREADY_HANDLED, '该申请已被处理，请刷新后查看');
        }

        // 重新读一遍拿到 markApproved 写回的审核字段（初审读到的 apply 已过期）
        const approved = await this.refundApplyRepository.getByApplyNo(applyNo);

        // 审核结果通知放在**条件更新成功之后**：被抢先的一方 affected=0 已经抛错，
        // 不会走到这里，所以不存在「审核没生效却通知了用户」
        await this.notifySafely(`REFUND_APPROVED ${applyNo}`, () =>
            this.messageService.send(MessageType.REFUND_APPROVED, {
                userId: approved.wechatOpenId,
                bookingId: approved.bookingId,
                bizNo: approved.applyNo,
            }),
        );

        return { apply: approved, outRefundNo };
    }

    /**
     * 审核拒绝（pending → rejected，理由必填）
     *
     * **不改订单状态**：订单全程保持 `expired`，用户看到的「已驳回」是
     * `refund_applies.status` 组合出来的展示态（§4.3.5）。
     * 这是 v1 两次写死单竞态的消除点——数据库里只写一次，中途失败不会留下死单。
     */
    async rejectApply(
        applyNo: string,
        admin: { adminId: number | null; adminName: string | null },
        rejectReason: string,
        remark?: string,
    ): Promise<RefundApply> {
        const apply = await this.refundApplyRepository.getByApplyNo(applyNo);

        const trimmed = (rejectReason ?? '').trim();
        if (!trimmed) {
            throw new RefundException(RefundErrorCode.APPLY_ALREADY_HANDLED, '请填写拒绝理由');
        }
        if (apply.status !== RefundApplyStatus.PENDING) {
            throw new RefundException(RefundErrorCode.APPLY_ALREADY_HANDLED, '该申请已被处理，请刷新后查看');
        }

        const affected = await this.refundApplyRepository.markRejected(applyNo, {
            rejectReason: trimmed,
            adminId: admin.adminId,
            adminName: admin.adminName,
            remark: remark?.trim() || null,
            at: Date.now(),
        });
        if (affected === 0) {
            throw new RefundException(RefundErrorCode.APPLY_ALREADY_HANDLED, '该申请已被处理，请刷新后查看');
        }

        const rejected = await this.refundApplyRepository.getByApplyNo(applyNo);

        // 驳回理由**原样下发**，不截断不改写——它是用户唯一需要逐字读的信息
        await this.notifySafely(`REFUND_REJECTED ${applyNo}`, () =>
            this.messageService.send(MessageType.REFUND_REJECTED, {
                userId: rejected.wechatOpenId,
                bookingId: rejected.bookingId,
                bizNo: rejected.applyNo,
                rejectReason: trimmed,
            }),
        );

        return rejected;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 资金结果镜像（由既有退款链路在终态处调用）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 按微信退款单号把申请单镜像为终态（success / failed）
     *
     * 【调用点共四处，全部是既有链路「已经落完 bookings 终态」之后的一步】
     *   1. `WechatPayService.handleRefundCallback` —— 退款回调
     *   2. `BookingService.applyRefundReconcileResult` —— 15 分钟退款对账
     *   3. `BookingService.applyAnomalyAction`（refundSucceeded / refundFailed）—— 异常通道
     *
     * **幂等**：`markSettled` 只在 `status='approved'` 时生效，重复调用 affected=0 直接返回。
     * 这一条必须成立——回调与对账会同时收敛同一笔退款，重复是常态而非异常。
     *
     * **查不到 outRefundNo 对应的申请单是正常路径**：用户自助退款、管理员在订单页直接退款
     * 产生的退款单都没有申请单，回调照样会走到这里。此时静默返回，不写任何东西。
     *
     * 失败不抛给调用方：这是镜像，镜像写不进去不该让资金链路跟着失败。
     */
    async syncSettledByOutRefundNo(outRefundNo: string, success: boolean): Promise<void> {
        if (!outRefundNo) return;
        try {
            const apply = await this.refundApplyRepository.findByOutRefundNo(outRefundNo);
            if (!apply) return; // 非「申请→审核」路径产生的退款单
            const affected = await this.refundApplyRepository.markSettled(apply.applyNo, success);
            if (affected > 0) {
                this.logger.log(
                    `退款申请单收敛为${success ? '成功' : '失败'}: ${apply.applyNo}（退款单号 ${outRefundNo}）`,
                );

                // 只在**本次真的推动了状态**时发（`affected > 0`）：回调 / 15 分钟对账 /
                // 异常通道路径会同时收敛同一笔退款，只有先到的那个发得出去。
                // 该方法自身不抛异常（见其注释：抛出去会让微信回调变成失败并触发重推），
                // 故这里不需要再套一层 notifySafely。
                await this.messageService.notifyRefundSettled(apply, success);
            }
        } catch (error) {
            // 镜像失败只记日志：资金状态已由 bookings.refundStatus 落定，
            // 单据状态可由人工对齐，不能反过来影响退款主流程
            this.logger.error(
                `退款申请单镜像失败（不影响资金）: outRefundNo=${outRefundNo}, success=${success}`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 私有
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 发站内信，**任何失败都只记日志**
     *
     * 四个发送点全部嵌在业务主流程里（用户提交申请、管理员点审核、资金到账回调）。
     * 站内信是**通知**而不是业务结果：
     *   · 写不进去不该让用户看到「申请提交失败」——申请单其实已经落库了，
     *     用户重试反而会撞上「请勿重复提交」；
     *   · 更不该让管理员看到 500 而以为「审核没生效」，再点一次通过。
     *
     * 所以这里兜住一切异常（含数据库故障）：宁可丢一条通知（`MessageService.send`
     * 已有日志），也不能让通知链路反噬它本要通知的那件事。
     *
     * 注意与 `syncSettledByOutRefundNo` 自身 try/catch 的关系：那一层保护的是
     * **镜像**（写 `refund_applies`），这一层保护的是**通知**（写 `messages`），
     * 两者互不替代——镜像成功了而发消息失败是完全可能的。
     */
    private async notifySafely(action: string, fn: () => Promise<unknown>): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.logger.error(
                `站内信发送失败（不影响主流程）: ${action}`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }
}

/**
 * 把申请单实体转成订单详情下发的最新申请摘要
 */
function toApplyBrief(apply: RefundApply): LatestRefundApplyBrief {
    return {
        applyNo: apply.applyNo,
        status: apply.status,
        applyCount: apply.applyCount,
        refundAmount: apply.refundAmount,
        reason: apply.reason,
        rejectReason: apply.rejectReason,
        createdAt: new Date(apply.createdAt).getTime(),
    };
}

/**
 * 生成微信退款单号：`RF{bookingId}` / `RF{bookingId}-2` / `RF{bookingId}-3`
 *
 * 【为什么重新申请必须换号】微信对同一 `out_refund_no` 幂等：第一次退款被置为
 * `CLOSED` 后，用同一个单号重试**不会产生新的退款单**，只会返回那张已关闭的单。
 * 现有 `initiateRefund` 的 `booking.outRefundNo ?? 'RF'+bookingId` 正是这个问题——
 * 它保证「同一次退款重试不重复退」，但表达不了「第 2 次申请是一笔新退款」（§3.3）。
 *
 * 第 1 次保持 `RF{bookingId}` 不变，与历史数据/既有逻辑完全一致；
 * 第 2 次起加序号后缀。序号用 `applyCount` 而不是时间戳：重放同一申请时单号稳定，
 * 这正是「同一次退款重试不重复退」所需要的不变性。
 */
export function buildOutRefundNo(bookingId: string, applyCount: number): string {
    return applyCount <= 1 ? `RF${bookingId}` : `RF${bookingId}-${applyCount}`;
}
