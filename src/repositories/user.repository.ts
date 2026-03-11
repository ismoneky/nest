import { InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../entities/user.entity';
import { CreateUserDto } from '../modules/user/dto/createUser.dto';
import { randomUUID } from 'crypto';


export class UserRepository {
    constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

    async findOrCreateUser(createUserDto: CreateUserDto) {
        try {
            // 先查询用户是否存在,使用 lean() 减少内存占用
            let user = await this.userModel.findOne({ wechatOpenId: createUserDto.wechatOpenId }).lean().exec();

            // 如果用户不存在,创建新用户
            if (!user) {
                const newUser = new this.userModel({
                    userId: randomUUID(),
                    wechatOpenId: createUserDto.wechatOpenId,
                    wechatNickname: createUserDto.wechatNickname,
                    wechatAvatarUrl: createUserDto.wechatAvatarUrl,
                });
                const savedUser = await newUser.save();
                // 转换为纯对象返回
                return savedUser.toObject();
            }

            return user;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find or create user');
        }
    }
}
