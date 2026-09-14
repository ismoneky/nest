import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

/**
 * 退款申请单状态（**审核单据的状态，不是资金执行状态**）
 *
 * 与 `bookings.refundStatus`（资金态）职责分离，这是 v2 方案的核心决策之一（§3.2）：
 *   - 本枚举回答「谁在什么时候申请、管理员批没批、批了几次」——申请是 1:N，必须独立表；
 *   - 资金怎么走由既有的 `refundStatus` 链路回答（markRefundStarting → 微信 → 回调/对账），
 *     本表**不参与**任何资金状态机，只做结果镜像。
 *
 * `failed` 与 `rejected` 刻意分开：
 *   - `failed`   = 审核通过了，但**资金执行失败**（refundStatus=failed，微信终态 CLOSED/ABNORMAL）
 *   - `rejected` = 审核不通过
 * 两者都允许重新申请，但运营口径完全不同（前者要查微信侧，后者只是驳回）。
 */
export enum RefundApplyStatus {
    PENDING = 'pending',   // 待审核
    APPROVED = 'approved', // 审核通过（退款执行中，镜像 booking.refundStatus=refunding）
    REJECTED = 'rejected', // 审核拒绝
    SUCCESS = 'success',   // 退款成功
    FAILED = 'failed',     // 退款失败（微信终态失败）
}

/**
 * 已成功申请次数是否消耗额度：pending / approved / success / failed 都计入，
 * rejected 不计入（被驳回不算用户「用掉」一次机会，见 §11 待确认 13 的当前口径）。
 *
 * ⚠️ 口径变更点：这个定义同时被两处使用——`countConsumedApplies` 与 applyCount 分配，
 * 两者必须同源，否则会出现「界面说还能申请、接口却拒绝」。
 */
export const REFUND_APPLY_CONSUMED_STATUSES: RefundApplyStatus[] = [
    RefundApplyStatus.PENDING,
    RefundApplyStatus.APPROVED,
    RefundApplyStatus.SUCCESS,
    RefundApplyStatus.FAILED,
];

/**
 * 退款申请单
 *
 * 一张单 = 用户的一次申请。`(bookingId, applyCount)` 唯一，保证同一订单的序号不重复，
 * 并发重复提交由该唯一索引兜底（affected/约束冲突都收敛为「请刷新后重试」）。
 *
 * `bookingId` 存的是 `bookings.bookingId`（业务单号 varchar），不是 integer 主键——
 * 与 refund_applies 之外的所有业务表一致（feedbacks.wechatOpenId 同理）。
 */
/**
 * 索引全部**显式命名**，与 `docs/implementation-todo.md` 的生产手工 SQL 逐字一致。
 *
 * 不用 `@Column` 上的裸 `@Index()`：那会生成 `IDX_<hash>` 形式的自动名，
 * 开发库（synchronize=true）与生产库（手工 SQL）的索引名由此分叉，
 * 后续任何一次对照 `EXPLAIN QUERY PLAN` 排查都会对不上号。
 *
 * `applyNo` / `outRefundNo` 的单列索引与 `(bookingId, applyCount)` 唯一索引在表级声明，
 * 因为唯一约束必须由 schema 保证——并发重复提交最终由它兜底（见下方注释）。
 */
@Entity('refund_applies')
@Index('IDX_refund_applies_applyNo', ['applyNo'], { unique: true })
@Index('IDX_refund_applies_booking_count', ['bookingId', 'applyCount'], { unique: true })
@Index('IDX_refund_applies_status_created', ['status', 'createdAt'])
@Index('IDX_refund_applies_user', ['wechatOpenId', 'createdAt'])
@Index('IDX_refund_applies_out_refund_no', ['outRefundNo'])
export class RefundApply {
    @PrimaryGeneratedColumn()
    id: number;

    /** 申请单号（业务主键，用户端与审核端都用它定位） */
    @Column()
    applyNo: string;

    /** 关联订单号 bookings.bookingId */
    @Column()
    bookingId: string;

    /** 申请人 openid（归属校验用，与 bookings.wechatOpenId 对应） */
    @Column()
    wechatOpenId: string;

    /**
     * 该订单的第几次申请（从 1 开始）。
     * 与 bookingId 组成唯一索引，避免并发重复提交产生同序号的两张单。
     */
    @Column({ type: 'integer', default: 1 })
    applyCount: number;

    /** 申请原因（用户必填，≤500） */
    @Column({ type: 'varchar', length: 500 })
    reason: string;

    @Column({ type: 'varchar', default: RefundApplyStatus.PENDING })
    status: RefundApplyStatus;

    /** 申请退款金额（**分**，与 bookings.amount 同单位；过期订单为全额退款） */
    @Column({ type: 'integer' })
    refundAmount: number;

    /**
     * 本次申请使用的微信退款单号。
     * 审核通过时生成并同时写入 `bookings.outRefundNo`——重新申请必须换号，
     * 因为微信对同一 out_refund_no 幂等，第一次被置 CLOSED 后用同号重试不会产生新退款单（§3.3）。
     */
    @Column({ type: 'varchar', nullable: true })
    outRefundNo: string | null;

    /** 审核管理员 ID（阶段 3 的最小操作人身份，取不到时为 null） */
    @Column({ type: 'integer', nullable: true })
    auditAdminId: number | null;

    /** 审核管理员用户名（冗余留痕，管理员账号改名后仍可追溯当时是谁） */
    @Column({ type: 'varchar', nullable: true })
    auditAdminName: string | null;

    /** 审核时刻 */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    auditAt: Date | null;

    /** 审核备注（通过时可选） */
    @Column({ type: 'varchar', length: 500, nullable: true })
    auditRemark: string | null;

    /** 拒绝理由（**拒绝必填**，会随站内信下发给用户） */
    @Column({ type: 'varchar', length: 500, nullable: true })
    rejectReason: string | null;

    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    createdAt: Date;

    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    updatedAt: Date;

    @BeforeInsert()
    setCreatedAt() {
        const now = new Date();
        if (!this.createdAt) this.createdAt = now;
        this.updatedAt = now;
    }

    @BeforeUpdate()
    setUpdatedAt() {
        this.updatedAt = new Date();
    }
}
