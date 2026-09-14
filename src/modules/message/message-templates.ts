import { MessageType, MessageBizType, MessageSenderType } from '../../entities/message.entity';

/**
 * 一条待发送消息的渲染结果
 */
export interface RenderedMessage {
    title: string;
    content: string;
    /** 去重键；`null` = 允许多条（仅 ADMIN_NOTICE） */
    dedupeKey: string | null;
    bizType: string | null;
    bizId: string | null;
    /** 点击卡片跳转的小程序路径 */
    jumpPath: string | null;
}

/**
 * 订单详情页路径（消息卡片的统一落点）
 *
 * `focus=refund` 让详情页定位到退款进度区——用户点「退款审核通过」的消息进来，
 * 想看的是退款进度，不是订单号。详情页对未知 query 参数必须容错（旧版本小程序
 * 拿到这个参数会忽略它，页面照常打开）。
 */
export function bookingDetailPath(bookingId: string): string {
    return `/pages/booking-detail/booking-detail?bookingId=${encodeURIComponent(bookingId)}`;
}

const REFUND_FOCUS_PATH = (bookingId: string) => `${bookingDetailPath(bookingId)}&focus=refund`;

/**
 * 消息模板（纯函数，无 IO）
 *
 * ── 为什么模板单独成文件 ──────────────────────────────────────────────────
 * 这 8 种消息的文案是**产品口径**，会被反复调整；把它们从发送逻辑里拆出来，
 * 改文案的 diff 就只落在这个文件里，评审时一眼能看全，也不会碰到幂等/配额那段代码。
 *
 * ── dedupeKey 的规则（§4.4，v2 修正 v1 的严重缺陷）────────────────────────
 *   · 订单类：`{msgType}:{bookingId}`——一个订单只会过期一次、只提醒一次；
 *   · 退款类：`{msgType}:{申请单号}`——**必须带申请单号，不能带订单号**。
 *     v1 用订单号，同一订单第 2、3 次申请时 key 完全相同，第二条起全被静默去重，
 *     用户再也收不到审核结果。这是 v1 最严重的一个缺陷，见方案 §4.4 的表注。
 *
 *     注意区分本文件里的两个字段：`bizId` 是「这条消息指向哪个业务对象」（退款类
 *     统一指向 applyNo，便于按业务反查）；`dedupeKey` 才是防重键。二者在退款类
 *     消息上取值相同，但职责不同——`FEEDBACK_REPLIED` 将来若要换成「一条反馈只提醒
 *     一次」而不随回复条数增加，只需改 dedupeKey，不必动 bizId。
 */
export function renderMessage(
    msgType: MessageType,
    ctx: {
        userId: string;
        bookingId?: string;
        /**
         * 业务单号：退款类是申请单号 applyNo，反馈类是回复 ID。
         * 退款类与反馈类消息**必传**——dedupeKey 用它而非订单号（原因见上方 dedupeKey 规则）。
         */
        bizNo?: string;
        /** 驳回理由（REFUND_REJECTED 必传，原样下发） */
        rejectReason?: string;
        /** 退款金额（分，REFUND_SUCCESS 必传） */
        refundAmount?: number;
        /** 申请截止日 YYYY-MM-DD（退款类消息附带，提醒用户时限） */
        applyDeadline?: string;
    },
): RenderedMessage {
    const bookingId = ctx.bookingId ?? '';
    switch (msgType) {
        case MessageType.ORDER_EXPIRE_REMINDER:
            return {
                title: '订单即将过期',
                content: '您今日的预约尚未核销，如已到场请尽快出示核验码。',
                dedupeKey: `${MessageType.ORDER_EXPIRE_REMINDER}:${bookingId}`,
                bizType: MessageBizType.BOOKING,
                bizId: bookingId,
                jumpPath: bookingDetailPath(bookingId),
            };

        case MessageType.ORDER_EXPIRED:
            return {
                title: '订单已过期，可申请退款',
                content: '您的预约已过期且未核销，可在订单详情页申请退款。'
                    + (ctx.applyDeadline ? `申请截止：${ctx.applyDeadline}。` : ''),
                dedupeKey: `${MessageType.ORDER_EXPIRED}:${bookingId}`,
                bizType: MessageBizType.BOOKING,
                bizId: bookingId,
                jumpPath: REFUND_FOCUS_PATH(bookingId),
            };

        case MessageType.REFUND_ACCEPTED:
            return {
                title: '退款申请已受理',
                content: '退款申请已提交，审核将在 2 个工作日内完成。',
                dedupeKey: `${MessageType.REFUND_ACCEPTED}:${ctx.bizNo}`,
                bizType: MessageBizType.REFUND_APPLY,
                bizId: ctx.bizNo ?? null,
                jumpPath: REFUND_FOCUS_PATH(bookingId),
            };

        case MessageType.REFUND_APPROVED:
            return {
                title: '退款审核通过，将原路退回',
                content: '审核已通过，款项将在 1–3 个工作日内原路退回。',
                dedupeKey: `${MessageType.REFUND_APPROVED}:${ctx.bizNo}`,
                bizType: MessageBizType.REFUND_APPLY,
                bizId: ctx.bizNo ?? null,
                jumpPath: REFUND_FOCUS_PATH(bookingId),
            };

        case MessageType.REFUND_REJECTED:
            return {
                title: `退款未通过：${ctx.rejectReason ?? ''}`,
                // 驳回理由是用户唯一需要逐字读的信息，放在正文开头，不做任何截断或改写
                content: `您的退款申请未通过：${ctx.rejectReason ?? '未通过审核'}。如有疑问请联系景区管理员。`,
                dedupeKey: `${MessageType.REFUND_REJECTED}:${ctx.bizNo}`,
                bizType: MessageBizType.REFUND_APPLY,
                bizId: ctx.bizNo ?? null,
                jumpPath: REFUND_FOCUS_PATH(bookingId),
            };

        case MessageType.REFUND_SUCCESS:
            return {
                title: `退款已到账 ¥${formatYuan(ctx.refundAmount ?? 0)}`,
                content: `退款 ¥${formatYuan(ctx.refundAmount ?? 0)} 已原路退回，请留意微信账户到账通知。`,
                dedupeKey: `${MessageType.REFUND_SUCCESS}:${ctx.bizNo}`,
                bizType: MessageBizType.REFUND_APPLY,
                bizId: ctx.bizNo ?? null,
                jumpPath: REFUND_FOCUS_PATH(bookingId),
            };

        case MessageType.FEEDBACK_REPLIED:
            return {
                title: '您的反馈已回复',
                content: '管理员已回复您的反馈，点击查看回复内容。',
                dedupeKey: `${MessageType.FEEDBACK_REPLIED}:${ctx.bizNo}`,
                bizType: MessageBizType.FEEDBACK,
                bizId: ctx.bizNo ?? null,
                // 反馈详情页属阶段 5，届时补上真实路径；现在给 null 而不是编一个不存在的路径
                jumpPath: null,
            };

        case MessageType.ADMIN_NOTICE:
        default:
            // ADMIN_NOTICE 的内容由管理员填写，不走模板（见 MessageService.sendAdminNotice）
            throw new Error(`renderMessage 不支持的消息类型：${msgType}`);
    }
}

/** 分 → 元（两位小数） */
export function formatYuan(cents: number): string {
    return ((cents ?? 0) / 100).toFixed(2);
}

/** 管理员手动消息的固定 senderType（导出给 AdminService 用，避免各处硬编码字符串） */
export const ADMIN_MESSAGE_SENDER = MessageSenderType.ADMIN;

export { MessageType, MessageBizType };
