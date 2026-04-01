import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemConfig } from '../entities/system-config.entity';

/**
 * 系统配置数据访问层
 */
@Injectable()
export class SystemConfigRepository {
    constructor(
        @InjectRepository(SystemConfig)
        private readonly configRepository: Repository<SystemConfig>,
    ) {}

    /**
     * 获取系统配置 (单例模式)
     * 如果不存在则创建默认配置
     */
    async getConfig(): Promise<SystemConfig> {
        try {
            let config = await this.configRepository.findOne({
                where: { configId: 'system_config' },
            });

            // 如果配置不存在,创建默认配置
            if (!config) {
                config = this.configRepository.create({
                    configId: 'system_config',
                    bookingEnabled: true,
                    bookingDisabledMessage: '当前时间段暂不开放预约，请稍后再试',
                    bannersJson: '[]',
                    timeSlotLimitJson: '{"morningMaxPeople":1000,"afternoonMaxPeople":1000}',
                    paymentConfigJson: '{"paymentAmount":0}',
                });
                await this.configRepository.save(config);
            }

            return config;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get system config');
        }
    }

    /**
     * 更新系统配置
     */
    async updateConfig(updateData: Partial<SystemConfig>): Promise<SystemConfig> {
        try {
            let config = await this.configRepository.findOne({
                where: { configId: 'system_config' },
            });

            if (!config) {
                // 如果不存在则创建
                config = this.configRepository.create({
                    configId: 'system_config',
                    ...updateData,
                });
            } else {
                // 更新现有配置
                Object.assign(config, updateData);
            }

            return await this.configRepository.save(config);
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update system config');
        }
    }

    /**
     * 获取是否允许预约
     */
    async isBookingEnabled(): Promise<boolean> {
        try {
            const config = await this.getConfig();
            return config.bookingEnabled;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to check booking status');
        }
    }

    /**
     * 获取时间段预约人数限制
     */
    async getTimeSlotLimit() {
        try {
            const config = await this.getConfig();
            return config.timeSlotLimit;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get time slot limit');
        }
    }

    /**
     * 获取支付配置
     */
    async getPaymentConfig() {
        try {
            const config = await this.getConfig();
            return config.paymentConfig;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get payment config');
        }
    }

    /**
     * 获取禁止预约时的展示文案
     */
    async getBookingDisabledMessage() {
        try {
            const config = await this.getConfig();
            return config.bookingDisabledMessage;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get booking disabled message');
        }
    }
}
