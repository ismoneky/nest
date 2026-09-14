import { AnomalyType } from '../../entities/booking-anomaly.entity';

/**
 * 异常恢复策略：auto=异常任务低频自动重试；manual=暂停自动请求，等待人工处理。
 * 设计文档未逐一列出各类型的策略（待确认问题 3），PAYING_WITHOUT_OUT_TRADE_NO 明确为人工，
 * 其余按「连续失败/明确异常」语义默认 auto，需设计确认后调整。
 */
export type AnomalyRecoveryPolicy = 'auto' | 'manual';

export const ANOMALY_RECOVERY_POLICY: Record<AnomalyType, AnomalyRecoveryPolicy> = {
    PAYMENT_QUERY_REPEATED_FAILURE: 'auto',
    REFUND_QUERY_REPEATED_FAILURE: 'auto',
    CLOSE_ORDER_REPEATED_FAILURE: 'auto',
    PAYING_WITHOUT_OUT_TRADE_NO: 'manual', // 历史数据兜底，由校验脚本或人工结合支付平台记录处理
    REMOTE_ORDER_NOT_FOUND: 'auto',
    LOCAL_REMOTE_STATUS_MISMATCH: 'auto',
    PAYMENT_CREATED_LOCAL_SAVE_FAILED: 'auto',
};

/**
 * 判断异常类型是否可自动恢复
 */
export function isAutoRecoverable(type: AnomalyType): boolean {
    return ANOMALY_RECOVERY_POLICY[type] === 'auto';
}

/**
 * 异常通道退避：30 分钟起步，每次翻倍，最长 2 小时
 */
export function nextAnomalyRetryAt(occurrenceCount: number, now: number): number {
    const base = 30 * 60 * 1000; // 30 分钟
    const max = 2 * 60 * 60 * 1000; // 2 小时
    const delay = Math.min(base * Math.pow(2, Math.max(0, occurrenceCount - 1)), max);
    return now + delay;
}
