import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfile } from '../../entities/user-profile.entity';
import { MemberRepository } from '../../repositories/member.repository';
import { Member, MemberStatus } from '../../entities/member.entity';
import { CreateMemberDto, UpdateMemberDto, GetMembersDto } from './dto/member.dto';

/**
 * 月卡会员业务逻辑层
 */
@Injectable()
export class MemberService {
    constructor(
        private readonly memberRepository: MemberRepository,
        @InjectRepository(UserProfile)
        private readonly userProfileRepository: Repository<UserProfile>,
    ) {}

    /**
     * 创建月卡会员
     * 通过手机号从 UserProfile 反查 wechatOpenId
     */
    async createMember(dto: CreateMemberDto): Promise<Member> {
        // 通过手机号查找已注册用户的 wechatOpenId
        const profile = await this.userProfileRepository.findOne({
            where: { phone: dto.phone },
            order: { createdAt: 'DESC' },
        });

        if (!profile) {
            throw new BadRequestException(`手机号 ${dto.phone} 尚未在小程序注册，无法录入会员。请该用户先使用小程序后再录入。`);
        }

        // 检查该 openid 是否已有有效会员
        const hasActive = await this.memberRepository.hasActiveMember(profile.wechatOpenId);
        if (hasActive) {
            throw new BadRequestException('该用户已有生效中的月卡会员，请勿重复录入');
        }

        // 校验日期
        const startDate = new Date(dto.startDate);
        const endDate = new Date(dto.endDate);
        endDate.setHours(23, 59, 59, 999);

        if (startDate > endDate) {
            throw new BadRequestException('开始日期不能晚于结束日期');
        }

        return await this.memberRepository.create({
            wechatOpenId: profile.wechatOpenId,
            name: dto.name,
            phone: dto.phone,
            idCard: dto.idCard,
            startDate,
            endDate,
            remarks: dto.remarks,
        });
    }

    /**
     * 更新会员信息
     */
    async updateMember(memberId: string, dto: UpdateMemberDto): Promise<Member> {
        const data: any = {};
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.phone !== undefined) data.phone = dto.phone;
        if (dto.idCard !== undefined) data.idCard = dto.idCard;
        if (dto.status !== undefined) data.status = dto.status;
        if (dto.remarks !== undefined) data.remarks = dto.remarks;
        if (dto.startDate !== undefined) data.startDate = new Date(dto.startDate);
        if (dto.endDate !== undefined) {
            data.endDate = new Date(dto.endDate);
            data.endDate.setHours(23, 59, 59, 999);
        }

        if (data.startDate && data.endDate && data.startDate > data.endDate) {
            throw new BadRequestException('开始日期不能晚于结束日期');
        }

        return await this.memberRepository.update(memberId, data);
    }

    /**
     * 删除会员
     */
    async deleteMember(memberId: string): Promise<void> {
        await this.memberRepository.delete(memberId);
    }

    /**
     * 查询会员列表（分页）
     */
    async getMembers(query: GetMembersDto) {
        return await this.memberRepository.findAll(query);
    }

    /**
     * 根据 memberId 查询会员详情
     */
    async getMemberById(memberId: string): Promise<Member> {
        const member = await this.memberRepository.findByMemberId(memberId);
        if (!member) {
            throw new NotFoundException(`会员 ${memberId} 不存在`);
        }
        return member;
    }

    /**
     * 根据 wechatOpenId 查询是否为有效会员
     * 供 BookingService 调用
     */
    async getActiveMemberByOpenId(wechatOpenId: string): Promise<Member | null> {
        return await this.memberRepository.findActiveByOpenId(wechatOpenId);
    }
}
