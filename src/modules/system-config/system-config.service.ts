import { Injectable } from '@nestjs/common';
import { SystemConfigRepository } from '../../repositories/system-config.repository';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';

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
}
