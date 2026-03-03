import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SystemConfig, SystemConfigDocument } from '../entities/system-config.entity';

/**
 * 系统配置数据访问层
 */
@Injectable()
export class SystemConfigRepository {
    constructor(@InjectModel(SystemConfig.name) private readonly configModel: Model<SystemConfigDocument>) {}

    /**
     * 获取系统配置 (单例模式)
     * 如果不存在则创建默认配置
     */
    async getConfig() {
        try {
            let config = await this.configModel.findOne({ configId: 'system_config' }).lean().exec();

            // 如果配置不存在,创建默认配置
            if (!config) {
                const defaultConfig = new this.configModel({
                    configId: 'system_config',
                    bookingEnabled: true,
                    banners: [],
                    timeSlotLimit: {
                        morningMaxPeople: 1000,
                        afternoonMaxPeople: 1000,
                    },
                });
                const saved = await defaultConfig.save();
                config = saved.toObject();
            }

            return config;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get system config');
        }
    }

    /**
     * 更新系统配置
     */
    async updateConfig(updateData: Partial<SystemConfig>) {
        try {
            const config = await this.configModel
                .findOneAndUpdate({ configId: 'system_config' }, updateData, { new: true, upsert: true })
                .lean()
                .exec();

            return config;
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
}
