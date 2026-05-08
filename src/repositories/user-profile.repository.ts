import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { UserProfile } from '../entities/user-profile.entity';

@Injectable()
export class UserProfileRepository {
    constructor(
        @InjectRepository(UserProfile)
        private readonly repo: Repository<UserProfile>,
    ) {}

    async findByOpenId(wechatOpenId: string): Promise<UserProfile[]> {
        return this.repo.find({ where: { wechatOpenId }, order: { createdAt: 'DESC' } });
    }

    async create(wechatOpenId: string, data: { name: string; phone: string; idCard: string }): Promise<UserProfile> {
        const profile = this.repo.create({
            profileId: randomUUID(),
            wechatOpenId,
            ...data,
        });
        return this.repo.save(profile);
    }

    async update(profileId: string, wechatOpenId: string, data: Partial<{ name: string; phone: string; idCard: string }>): Promise<UserProfile> {
        const profile = await this.repo.findOne({ where: { profileId, wechatOpenId } });
        if (!profile) throw new NotFoundException('常用人员不存在');
        Object.assign(profile, data);
        return this.repo.save(profile);
    }

    async delete(profileId: string, wechatOpenId: string): Promise<void> {
        const profile = await this.repo.findOne({ where: { profileId, wechatOpenId } });
        if (!profile) throw new NotFoundException('常用人员不存在');
        await this.repo.remove(profile);
    }
}
