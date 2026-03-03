import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AnnouncementDocument = HydratedDocument<Announcement>;

/**
 * 公告实体
 */
@Schema({ timestamps: true })
export class Announcement {
    /** 公告ID (UUID) */
    @Prop({ required: true, unique: true, index: true })
    announcementId: string;

    /** 公告标题 */
    @Prop({ required: true })
    title: string;

    /** 公告内容 */
    @Prop({ required: true })
    content: string;

    /** 是否启用 */
    @Prop({ default: true, index: true })
    isActive: boolean;

    /** 排序顺序 (数字越小越靠前) */
    @Prop({ default: 0, index: true })
    sortOrder: number;

    /** 创建时间 */
    @Prop({ default: Date.now })
    createdAt: Date;

    /** 更新时间 */
    @Prop()
    updatedAt?: Date;
}

export const AnnouncementSchema = SchemaFactory.createForClass(Announcement);

// 创建复合索引
AnnouncementSchema.index({ isActive: 1, sortOrder: 1 });
