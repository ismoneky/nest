import { Injectable } from '@nestjs/common';
import { SystemConfigRepository } from '../../repositories/system-config.repository';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';

/**
 * 退款申请时限（天）：从 `expiredAt` 起算，默认 7 天。
 *
 * 【为什么用环境变量而不是加一列车 config 表】方案 §11 待确认 16 只要求「窗口天数配置化，
 * 两处必须同源」——同源由本模块保证，不必为它引入一次 schema 变更（本库是 SQLite 单写者，
 * 每次加列都是稀缺的写预算）。运营侧要调值时改 `.env` 重启，比后台点一次更慢但更可控。
 */
export const REFUND_APPLY_DEADLINE_DAYS_DEFAULT = 7;

/** 单个订单的申请次数上限，默认 3（被驳回不消耗次数，见 RefundApplyRepository.countConsumedApplies） */
export const REFUND_MAX_APPLY_COUNT_DEFAULT = 3;

/**
 * 系统配置业务逻辑层
 */
@Injectable()
export class SystemConfigService {
    constructor(private readonly configRepository: SystemConfigRepository) {}

    /**
     * 获取系统配置
     */
    async getConfig() {
        return await this.configRepository.getConfig();
    }

    /**
     * 更新系统配置
     */
    async updateConfig(updateDto: UpdateSystemConfigDto) {
        return await this.configRepository.updateConfig(updateDto);
    }

    /**
     * 获取是否允许预约
     */
    async isBookingEnabled(): Promise<boolean> {
        return await this.configRepository.isBookingEnabled();
    }

    /**
     * 获取时间段预约人数限制
     */
    async getTimeSlotLimit() {
        return await this.configRepository.getTimeSlotLimit();
    }

    /**
     * 获取支付配置
     */
    async getPaymentConfig() {
        return await this.configRepository.getPaymentConfig();
    }

    /**
     * 获取禁止预约时的展示文案
     */
    async getBookingDisabledMessage() {
        return await this.configRepository.getBookingDisabledMessage();
    }

    /**
     * 获取温馨提示配置
     */
    async getNoticeConfig() {
        return await this.configRepository.getNoticeConfig();
    }

    /**
     * 退款申请时限（天）
     *
     * ⚠️ 调用方：`RefundApplyService.buildRefundEntry`（算 applyDeadline）、
     * `RefundApplyService.submitApply`（硬性拦截）、T2 的「近 7 天已过期未申请退款」扫描
     * （阶段 4）。**三处必须都走这里**，各读各的环境变量必然漂移。
     */
    getRefundApplyDeadlineDays(): number {
        return parsePositiveInt(process.env.REFUND_APPLY_DEADLINE_DAYS, REFUND_APPLY_DEADLINE_DAYS_DEFAULT);
    }

    /**
     * 申请次数上限
     */
    getRefundMaxApplyCount(): number {
        return parsePositiveInt(process.env.REFUND_MAX_APPLY_COUNT, REFUND_MAX_APPLY_COUNT_DEFAULT);
    }

    /**
     * 客服电话（驳回与超期两处文案的落点，§4.3.5）
     *
     * 默认空串：**宁可让文案里少一句电话，也不要编一个打不通的号码**。
     * 未配置时前端按下发的空值隐藏该行。
     */
    getRefundContactPhone(): string {
        return (process.env.REFUND_CONTACT_PHONE ?? '').trim();
    }
}

/**
 * 解析正整数环境变量：缺省、非数字、<=0 一律回落到默认值。
 * 不做「非法值就抛错」——配置写错不应让退款入口在线上直接 500。
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (raw == null || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
