import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SystemConfigDocument = HydratedDocument<SystemConfig>;

/**
 * 轮播图配置项
 */
export interface BannerItem {
    /** 图片标题 */
    title: string;
    /** 图片URL */
    imageUrl: string;
    /** 跳转链接 (可选) */
    linkUrl?: string;
    /** 排序顺序 */
    sortOrder: number;
}

/**
 * 时间段预约限制配置
 */
export interface TimeSlotLimit {
    /** 上午最大预约人数 */
    morningMaxPeople: number;
    /** 下午最大预约人数 */
    afternoonMaxPeople: number;
}

/**
 * 系统配置实体
 * 使用单文档模式存储所有系统配置
 */
@Schema({ timestamps: true })
export class SystemConfig {
    /** 配置ID (固定为 'system_config') */
    @Prop({ required: true, unique: true, default: 'system_config' })
    configId: string;

    /** 是否允许预约 */
    @Prop({ required: true, default: true })
    bookingEnabled: boolean;

    /** 轮播图配置 */
    @Prop({ type: Array, default: [] })
    banners: BannerItem[];

    /** 时间段预约人数限制 */
    @Prop({
        type: Object,
        default: {
            morningMaxPeople: 100,
            afternoonMaxPeople: 100,
        },
    })
    timeSlotLimit: TimeSlotLimit;

    /** 创建时间 */
    @Prop({ default: Date.now })
    createdAt: Date;

    /** 更新时间 */
    @Prop()
    updatedAt?: Date;
}

export const SystemConfigSchema = SchemaFactory.createForClass(SystemConfig);
