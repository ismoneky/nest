import { Injectable, NotFoundException, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Member, MemberStatus } from '../entities/member.entity';

/**
 * 月卡会员数据访问层
 */
@Injectable()
export class MemberRepository {
    constructor(
        @InjectRepository(Member)
        private readonly memberRepository: Repository<Member>,
    ) {}

    /**
     * 创建会员
     */
    async create(data: {
        wechatOpenId: string;
        name: string;
        phone: string;
        idCard: string;
        startDate: Date;
        endDate: Date;
        remarks?: string;
    }): Promise<Member> {
        try {
            const member = this.memberRepository.create({
                memberId: randomUUID(),
                ...data,
                status: MemberStatus.ACTIVE,
            });
            return await this.memberRepository.save(member);
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to create member');
        }
    }

    /**
     * 根据 memberId 查询会员
     */
    async findByMemberId(memberId: string): Promise<Member | null> {
        try {
            return await this.memberRepository.findOne({ where: { memberId } });
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find member');
        }
    }

    /**
     * 根据 wechatOpenId 查询有效会员（status=active 且在有效期内）
     */
    async findActiveByOpenId(wechatOpenId: string): Promise<Member | null> {
        try {
            const now = new Date();
            return await this.memberRepository
                .createQueryBuilder('member')
                .where('member.wechatOpenId = :wechatOpenId', { wechatOpenId })
                .andWhere('member.status = :status', { status: MemberStatus.ACTIVE })
                .andWhere('member.startDate <= :now', { now: now.getTime() })
                .andWhere('member.endDate >= :now', { now: now.getTime() })
                .getOne();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find active member');
        }
    }

    /**
     * 根据手机号查询会员（用于后台录入时查找用户）
     */
    async findByPhone(phone: string): Promise<Member[]> {
        try {
            return await this.memberRepository.find({ where: { phone } });
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find member by phone');
        }
    }

    /**
     * 分页查询会员列表
     */
    async findAll(query: {
        keyword?: string;
        status?: MemberStatus;
        page?: number;
        pageSize?: number;
    }) {
        try {
            const page = query.page || 1;
            const pageSize = query.pageSize || 10;
            const skip = (page - 1) * pageSize;

            const qb = this.memberRepository
                .createQueryBuilder('member')
                .orderBy('member.createdAt', 'DESC')
                .skip(skip)
                .take(pageSize);

            if (query.status) {
                qb.andWhere('member.status = :status', { status: query.status });
            }

            if (query.keyword) {
                qb.andWhere(
                    '(member.name LIKE :kw OR member.phone LIKE :kw OR member.idCard LIKE :kw)',
                    { kw: `%${query.keyword}%` },
                );
            }

            const [members, total] = await qb.getManyAndCount();

            return {
                members,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(total / pageSize),
            };
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get members');
        }
    }

    /**
     * 更新会员信息
     */
    async update(memberId: string, data: Partial<{
        name: string;
        phone: string;
        idCard: string;
        startDate: Date;
        endDate: Date;
        status: MemberStatus;
        remarks: string;
    }>): Promise<Member> {
        try {
            const member = await this.findByMemberId(memberId);
            if (!member) {
                throw new NotFoundException(`会员 ${memberId} 不存在`);
            }
            Object.assign(member, data);
            return await this.memberRepository.save(member);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update member');
        }
    }

    /**
     * 删除会员
     */
    async delete(memberId: string): Promise<void> {
        try {
            const member = await this.findByMemberId(memberId);
            if (!member) {
                throw new NotFoundException(`会员 ${memberId} 不存在`);
            }
            await this.memberRepository.remove(member);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to delete member');
        }
    }

    /**
     * 检查 openid 是否已有有效会员（防止重复录入）
     */
    async hasActiveMember(wechatOpenId: string): Promise<boolean> {
        const member = await this.findActiveByOpenId(wechatOpenId);
        return member !== null;
    }
}
