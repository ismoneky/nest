import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { randomUUID } from 'crypto';
import { serialTransaction } from '../common/transaction-runner';

@Injectable()
export class UserRepository {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
    ) {}

    async findOrCreateUser(params: { wechatOpenId: string; wechatUnionId?: string }): Promise<User> {
        try {
            return await serialTransaction(this.userRepository.manager.connection, async em => {
                const repo = em.getRepository(User);
                let user = await repo.findOne({ where: { wechatOpenId: params.wechatOpenId } });
                if (!user) {
                    user = repo.create({ userId: randomUUID(), wechatOpenId: params.wechatOpenId,
                        wechatUnionId: null, wechatIdentityConflict: 0 });
                }
                const unionId = typeof params.wechatUnionId === 'string' ? params.wechatUnionId.trim() : '';
                if (unionId) {
                    const owner = await repo.findOne({ where: { wechatUnionId: unionId } });
                    if ((user.wechatUnionId && user.wechatUnionId !== unionId)
                        || (owner && owner.wechatOpenId !== user.wechatOpenId)) {
                        user.wechatIdentityConflict = 1;
                        if (owner && owner.wechatOpenId !== user.wechatOpenId) {
                            await repo.update(owner.id, { wechatIdentityConflict: 1, updatedAt: new Date() });
                        }
                    } else if (!user.wechatIdentityConflict) {
                        user.wechatUnionId = unionId;
                    }
                }
                return await repo.save(user);
            });
        } catch (error) {
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to find or create user',
            );
        }
    }
}
