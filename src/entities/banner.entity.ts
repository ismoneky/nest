import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BannerDocument = HydratedDocument<Banner>;

/**
 * 轮播图实体
 */
@Schema({ timestamps: true })
export class Banner {
    /** 轮播图ID (UUID) */
    @Prop({ required: true, unique: true, index: true })
    bannerId: string;

    /** 图片标题 */
    @Prop({ required: true })
    title: string;

    /** 图片URL */
    @Prop({ required: true })
    imageUrl: string;

    /** 跳转链接 (可选) */
    @Prop()
    linkUrl?: string;

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

export const BannerSchema = SchemaFactory.createForClass(Banner);

// 创建复合索引
BannerSchema.index({ isActive: 1, sortOrder: 1 });
