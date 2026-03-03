import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AdminDocument = HydratedDocument<Admin>;

/**
 * 管理员实体
 */
@Schema({ timestamps: true })
export class Admin {
    /** 管理员用户名 (唯一) */
    @Prop({ required: true, unique: true, index: true })
    username: string;

    /** 密码 (加密存储) */
    @Prop({ required: true })
    password: string;

    /** 管理员姓名 */
    @Prop({ required: true })
    name: string;

    /** 最后登录时间 */
    @Prop()
    lastLoginAt?: Date;

    /** 创建时间 */
    @Prop({ default: Date.now })
    createdAt: Date;

    /** 更新时间 */
    @Prop()
    updatedAt?: Date;
}

export const AdminSchema = SchemaFactory.createForClass(Admin);
