import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * 异常类型（稳定异常类型码，见支付可靠性设计「首批异常类型」）
 */
export enum AnomalyType {
    PAYMENT_QUERY_REPEATED_FAILURE = 'PAYMENT_QUERY_REPEATED_FAILURE',
    REFUND_QUERY_REPEATED_FAILURE = 'REFUND_QUERY_REPEATED_FAILURE',
    CLOSE_ORDER_REPEATED_FAILURE = 'CLOSE_ORDER_REPEATED_FAILURE',
    PAYING_WITHOUT_OUT_TRADE_NO = 'PAYING_WITHOUT_OUT_TRADE_NO',
    REMOTE_ORDER_NOT_FOUND = 'REMOTE_ORDER_NOT_FOUND',
    LOCAL_REMOTE_STATUS_MISMATCH = 'LOCAL_REMOTE_STATUS_MISMATCH',
    PAYMENT_CREATED_LOCAL_SAVE_FAILED = 'PAYMENT_CREATED_LOCAL_SAVE_FAILED',
}

/**
 * 异常状态
 */
export enum AnomalyStatus {
    OPEN = 'OPEN', // 待处理
    RESOLVED = 'RESOLVED', // 已解决
    IGNORED = 'IGNORED', // 人工忽略
}

/**
 * 异常订单记录
 * 订单表仍是预约、支付和退款状态的唯一事实来源；本表只记录持续异常和需要人工关注的订单，
 * 充当低频工作清单，不反向充当第二套订单状态机。
 */
@Entity('booking_anomalies')
@Index(['bookingId', 'type'], { unique: true })
@Index(['status', 'nextRetryAt'])
export class BookingAnomaly {
    @PrimaryGeneratedColumn()
    id: number;

    /** 关联订单编号 */
    @Column({ type: 'varchar' })
    bookingId: string;

    /** 稳定异常类型 */
    @Column({ type: 'varchar' })
    type: AnomalyType;

    /** 状态：OPEN / RESOLVED / IGNORED */
    @Column({ type: 'varchar', default: AnomalyStatus.OPEN })
    status: AnomalyStatus;

    /** 首次发现时间（毫秒 epoch） */
    @Column({ type: 'integer' })
    firstSeenAt: number;

    /** 最近发生时间（毫秒 epoch） */
    @Column({ type: 'integer' })
    lastSeenAt: number;

    /** 累计发生次数 */
    @Column({ type: 'integer', default: 1 })
    occurrenceCount: number;

    /** 过滤后的稳定错误码 */
    @Column({ type: 'varchar', nullable: true })
    lastErrorCode: string;

    /** 不含敏感数据的错误摘要 */
    @Column({ type: 'varchar', nullable: true })
    lastErrorSummary: string;

    /** 异常通道的低频重试时间（毫秒 epoch） */
    @Column({ type: 'integer', nullable: true })
    nextRetryAt: number;

    /** 解决时间（毫秒 epoch） */
    @Column({ type: 'integer', nullable: true })
    resolvedAt: number;

    /** 自动恢复或人工处理说明 */
    @Column({ type: 'varchar', nullable: true })
    resolution: string;
}
