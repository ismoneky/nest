import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

/**
 * 公告实体
 */
@Entity('announcements')
@Index(['isActive', 'sortOrder']) // 复合索引
export class Announcement {
    @PrimaryGeneratedColumn()
    id: number;

    /** 公告ID (UUID) */
    @Column({ unique: true })
    @Index()
    announcementId: string;

    /** 公告标题 */
    @Column()
    title: string;

    /** 公告内容 */
    @Column('text')
    content: string;

    /** 是否启用 */
    @Column({ default: true })
    @Index()
    isActive: boolean;

    /** 排序顺序 (数字越小越靠前) */
    @Column({ default: 0 })
    @Index()
    sortOrder: number;

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
}
