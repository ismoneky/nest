import { Entity, Column, PrimaryGeneratedColumn, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

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
 * 支付配置
 */
export interface PaymentConfig {
    /** 支付金额 */
    paymentAmount: number;
}

/**
 * 系统配置实体
 * 使用单文档模式存储所有系统配置
 */
@Entity('system_configs')
export class SystemConfig {
    @PrimaryGeneratedColumn()
    id: number;

    /** 配置ID (固定为 'system_config') */
    @Column({ unique: true, default: 'system_config' })
    configId: string;

    /** 是否允许预约 */
    @Column({ default: true })
    bookingEnabled: boolean;

    /** 禁止预约时的展示文案 */
    @Column({ type: 'text', default: '当前时间段暂不开放预约，请稍后再试' })
    bookingDisabledMessage: string;

    /** 轮播图配置 (JSON 存储) */
    @Column({ type: 'text', default: '[]' })
    bannersJson: string;

    /** 时间段预约人数限制 (JSON 存储) */
    @Column({
        type: 'text',
        default: '{"morningMaxPeople":100,"afternoonMaxPeople":100}',
    })
    timeSlotLimitJson: string;

    /** 支付配置 (JSON 存储) */
    @Column({
        type: 'text',
        default: '{"paymentAmount":0}',
    })
    paymentConfigJson: string;

    /** 创建时间 */
    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    createdAt: Date;

    /** 更新时间 */
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

    // 虚拟属性 getter/setter
    get banners(): BannerItem[] {
        try {
            return JSON.parse(this.bannersJson || '[]');
        } catch {
            return [];
        }
    }

    set banners(value: BannerItem[]) {
        this.bannersJson = JSON.stringify(value || []);
    }

    get timeSlotLimit(): TimeSlotLimit {
        try {
            return JSON.parse(this.timeSlotLimitJson || '{"morningMaxPeople":100,"afternoonMaxPeople":100}');
        } catch {
            return { morningMaxPeople: 100, afternoonMaxPeople: 100 };
        }
    }

    set timeSlotLimit(value: TimeSlotLimit) {
        this.timeSlotLimitJson = JSON.stringify(value);
    }

    get paymentConfig(): PaymentConfig {
        try {
            return JSON.parse(this.paymentConfigJson || '{"paymentAmount":0}');
        } catch {
            return { paymentAmount: 0 };
        }
    }

    set paymentConfig(value: PaymentConfig) {
        this.paymentConfigJson = JSON.stringify(value);
    }
}
