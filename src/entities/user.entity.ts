import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true })
export class User {
    @Prop({ required: true, unique: true })
    userId: string;

    @Prop({ required: true, unique: true })
    wechatOpenId: string;

    @Prop({ required: true })
    wechatNickname: string;

    @Prop()
    wechatAvatarUrl?: string;

    @Prop({ default: Date.now })
    createdAt: Date;

    @Prop()
    updatedAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
