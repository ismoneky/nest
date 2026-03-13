import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { CreateUserDto } from '../modules/user/dto/createUser.dto';
import { randomUUID } from 'crypto';

@Injectable()
export class UserRepository {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
    ) {}

    async findOrCreateUser(createUserDto: CreateUserDto): Promise<User> {
        try {
            // 先查询用户是否存在
            let user = await this.userRepository.findOne({
                where: { wechatOpenId: createUserDto.wechatOpenId },
            });

            // 如果用户不存在,创建新用户
            if (!user) {
                user = this.userRepository.create({
                    userId: randomUUID(),
                    wechatOpenId: createUserDto.wechatOpenId,
                    wechatNickname: createUserDto.wechatNickname,
                    wechatAvatarUrl: createUserDto.wechatAvatarUrl,
                });
                await this.userRepository.save(user);
            }

            return user;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find or create user');
        }
    }
}
