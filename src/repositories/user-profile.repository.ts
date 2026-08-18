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

    /**
     * 批量保存常用联系人（去重：同一用户下身份证号相同则跳过）
     * 在用户下单时自动将乘客信息保存为常用联系人
     * @param wechatOpenId 微信用户的 OpenID
     * @param passengers 乘客信息列表
     */
    async upsertProfiles(wechatOpenId: string, passengers: { name: string; phone: string; idCard: string }[]): Promise<void> {
        if (!passengers || passengers.length === 0) return;

        // 身份证归一化（统一大写）
        const normalized = passengers.map((p) => ({
            ...p,
            idCard: p.idCard?.toUpperCase().trim() ?? '',
            phone: p.phone?.trim() ?? '',
            name: p.name?.trim() ?? '',
        }));

        // 查询该用户已存在的所有常用联系人，取出身份证号集合用于去重
        const existing = await this.repo.find({
            where: { wechatOpenId },
            select: ['idCard'],
        });
        const existingIdCards = new Set(existing.map((p) => p.idCard?.toUpperCase().trim()));

        // 过滤出新乘客（身份证号不在已存在列表中的）
        const newProfiles = normalized.filter((p) => p.idCard && !existingIdCards.has(p.idCard));

        if (newProfiles.length === 0) return;

        // 批量创建新联系人
        const entities = newProfiles.map((p) =>
            this.repo.create({
                profileId: randomUUID(),
                wechatOpenId,
                name: p.name,
                phone: p.phone,
                idCard: p.idCard,
            }),
        );

        await this.repo.save(entities);
    }
}
