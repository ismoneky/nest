import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

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

    /** 轮播图配置 (JSON 存储) */
    @Column({ type: 'text', default: '[]' })
    bannersJson: string;

    /** 时间段预约人数限制 (JSON 存储) */
    @Column({
        type: 'text',
        default: '{"morningMaxPeople":100,"afternoonMaxPeople":100}',
    })
    timeSlotLimitJson: string;

    /** 创建时间 */
    @CreateDateColumn()
    createdAt: Date;

    /** 更新时间 */
    @UpdateDateColumn()
    updatedAt: Date;

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
}
