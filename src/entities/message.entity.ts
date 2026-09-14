import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

/**
 * 站内信类型（方案 §4.4「消息类型」表）
 *
 * 前 7 种是系统消息，靠 `dedupeKey` 唯一索引防重（任务重跑、回调重放都不轰炸用户）；
 * `ADMIN_NOTICE` 是管理员手动发送，`dedupeKey` 为 NULL——SQLite 与 MySQL 一样，
 * 唯一索引下的多个 NULL 互不冲突，所以手动消息可以无限多条。
 */
export enum MessageType {
    /** T2：订单即将过期（当天仍未核销的提醒） */
    ORDER_EXPIRE_REMINDER = 'ORDER_EXPIRE_REMINDER',
    /** T1：订单已过期，可申请退款 */
    ORDER_EXPIRED = 'ORDER_EXPIRED',
    /** 用户提交退款申请后 */
    REFUND_ACCEPTED = 'REFUND_ACCEPTED',
    /** 管理员审核通过 */
    REFUND_APPROVED = 'REFUND_APPROVED',
    /** 管理员审核拒绝（驳回理由随正文下发） */
    REFUND_REJECTED = 'REFUND_REJECTED',
    /** 退款到账（回调或对账确认） */
    REFUND_SUCCESS = 'REFUND_SUCCESS',
    /** 管理员回复反馈（阶段 5 使用） */
    FEEDBACK_REPLIED = 'FEEDBACK_REPLIED',
    /** 管理员手动发送 */
    ADMIN_NOTICE = 'ADMIN_NOTICE',
}

/** 发送方类型：系统消息与管理员手动消息在列表里要能区分 */
export enum MessageSenderType {
    SYSTEM = 'SYSTEM',
    ADMIN = 'ADMIN',
}

/** 业务对象类型（决定 `bizId` 的含义，便于按业务反查） */
export enum MessageBizType {
    BOOKING = 'booking',
    REFUND_APPLY = 'refund_apply',
    FEEDBACK = 'feedback',
}

/**
 * 服务号（OA）模板消息发送状态
 *
 * 主流程 `OA_ENABLED=false`（默认）时恒为 `SKIPPED`——**站内信是记录层，服务号是触达层**，
 * 这一列的存在只是为了让服务号分支（独立分支 `feat/oa-template-message`）接进来时
 * 不必再改一次表结构（§4.6「主流程的保证」）。
 */
export enum OaSendStatus {
    /** 未处理（OA_ENABLED=true 时下轮重试会取到） */
    PENDING = 0,
    /** 已送达 */
    SENT = 1,
    /** 发送失败（`oaAttempts` 达上限后不再重试） */
    FAILED = 2,
    /** 已跳过（OA 未启用 / 用户未关注服务号） */
    SKIPPED = 3,
}

/**
 * 站内信
 *
 * ── 为什么 `userId` 存 wechatOpenId 而不是 users.id ─────────────────────────
 * 现有三张业务表（`bookings` / `feedbacks` / `members`）一律以 `wechatOpenId` 为业务主键，
 * `users.id` 只在登录环节用。跟随现状可以避免每发一条消息都反查一次 users 表，
 * 也让「按订单找消息」这类排查少一次 join（§5.4）。
 *
 * ── 索引为什么全部显式命名 ────────────────────────────────────────────────
 * 与 `refund_applies` 同款理由：裸 `@Index()` 生成的是 `IDX_<table>_<hash>` 自动名，
 * 与 `docs/implementation-todo.md` 里手写的生产 SQL 对不上号，
 * 之后任何一次 `EXPLAIN QUERY PLAN` 对照都会因为「名字不同」而怀疑是不是漏建了。
 *
 * ⚠️ **索引名大小写与方案 §5.4 的 SQL 完全一致**（`IDX_messages_*`），
 * 本仓其它表有小写 `idx_` 开头的既有索引（如 `idx_bookings_status_date`），
 * 那是历史遗留，新表一律用 `IDX_` 前缀，不要再引入第二种风格。
 */
@Entity('messages')
@Index('IDX_messages_dedupe', ['dedupeKey'], { unique: true })
@Index('IDX_messages_user_read', ['userId', 'isRead', 'id'])
@Index('IDX_messages_user_type', ['userId', 'msgType', 'createdAt'])
@Index('IDX_messages_oa_retry', ['oaSendStatus', 'oaAttempts'])
export class Message {
    @PrimaryGeneratedColumn()
    id: number;

    /** 接收人 openid（= bookings.wechatOpenId，见类注释） */
    @Column()
    userId: string;

    @Column()
    msgType: string;

    /** 卡片标题 */
    @Column()
    title: string;

    /** 正文（≤500，含驳回理由这类用户必须逐字读的信息） */
    @Column({ type: 'varchar', length: 500 })
    content: string;

    /** 业务对象类型（见 MessageBizType），无关联业务时为 null */
    @Column({ type: 'varchar', nullable: true })
    bizType: string | null;

    /** 业务对象 ID（bookingId / applyNo / feedbackId），与 bizType 成对出现 */
    @Column({ type: 'varchar', nullable: true })
    bizId: string | null;

    /**
     * 点击跳转路径（如 `/pages/booking-detail/booking-detail?bookingId=TL-xxx`）。
     *
     * ⚠️ 这是**历史消息里存下来的字符串**：页面改名后旧消息的跳转会指向上一个版本。
     * 小程序端跳转前必须做路径白名单校验（见 `fctl/utils/message-center.js` 的
     * `resolveJumpPath`，有单元测试守着），失败时降级为「不跳转」而不是崩在 `navigateTo` 上。
     * **新增可跳转页面时两端要同步改**：这里改文案路径、那边加白名单项。
     */
    @Column({ type: 'varchar', nullable: true })
    jumpPath: string | null;

    @Column({ type: 'varchar', default: MessageSenderType.SYSTEM })
    senderType: string;

    /** 管理员手动消息的发送者 ID（系统消息为 null） */
    @Column({ type: 'integer', nullable: true })
    adminId: number | null;

    /**
     * 去重键：`{msgType}:{业务ID}`（§4.4 表）。
     *
     * **`REFUND_*` 一律带 `applyId` 而不是 `bookingId`**——这是 v2 修正 v1 的严重缺陷：
     * v1 用 `{msg_type}:{biz_id}`，同一订单第 2、3 次申请时 key 完全相同，
     * 于是第二条起全部被静默去重，用户再也收不到审核结果。
     *
     * 手动消息为 NULL（唯一索引允许多个 NULL，故可无限多条）。
     */
    @Column({ type: 'varchar', nullable: true })
    dedupeKey: string | null;

    /** 服务号发送状态（OA 未启用时恒为 SKIPPED，见 OaSendStatus） */
    @Column({ type: 'integer', default: OaSendStatus.SKIPPED })
    oaSendStatus: number;

    @Column({ type: 'integer', default: 0 })
    oaAttempts: number;

    @Column({ type: 'varchar', nullable: true })
    oaLastError: string | null;

    /** 已读标记（SQLite 无 boolean，0/1） */
    @Column({ type: 'integer', default: 0 })
    isRead: number;

    /** 已读时刻（未读为 null） */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    readAt: Date | null;

    @Column({ type: 'integer', transformer: timestampTransformer })
    createdAt: Date;

    @Column({ type: 'integer', transformer: timestampTransformer })
    updatedAt: Date;

    @BeforeInsert()
    setTimestamps() {
        const now = new Date();
        if (!this.createdAt) this.createdAt = now;
        this.updatedAt = now;
    }

    @BeforeUpdate()
    setUpdatedAt() {
        this.updatedAt = new Date();
    }
}
