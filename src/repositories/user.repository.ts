import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { randomUUID } from 'crypto';
import { serialSave } from '../common/transaction-runner';

@Injectable()
export class UserRepository {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
    ) {}

    async findOrCreateUser(params: { wechatOpenId: string }): Promise<User> {
        try {
            let user = await this.userRepository.findOne({
                where: { wechatOpenId: params.wechatOpenId },
            });

            if (!user) {
                user = this.userRepository.create({
                    userId: randomUUID(),
                    wechatOpenId: params.wechatOpenId,
                });
                await serialSave(this.userRepository, user);
            }

            return user;
        } catch (error) {
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to find or create user',
            );
        }
    }
}
