import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { MemberRepository } from '../../repositories/member.repository';
import { Member } from '../../entities/member.entity';
import { CreateMemberDto, UpdateMemberDto, GetMembersDto } from './dto/member.dto';

/**
 * 月卡会员业务逻辑层
 */
@Injectable()
export class MemberService {
    constructor(
        private readonly memberRepository: MemberRepository,
    ) {}

    /**
     * 创建月卡会员
     * 不再绑定 openid：录入 姓名/身份证/手机号(展示)/车牌号(可多个)/有效期
     */
    async createMember(dto: CreateMemberDto): Promise<Member> {
        // 同一身份证只允许一条有效会员
        const hasActive = await this.memberRepository.hasActiveMemberByIdCard(dto.idCard);
        if (hasActive) {
            throw new BadRequestException('该身份证已有生效中的月卡会员，请勿重复录入');
        }

        // 校验日期
        const startDate = new Date(dto.startDate);
        const endDate = new Date(dto.endDate);
        endDate.setHours(23, 59, 59, 999);

        if (startDate > endDate) {
            throw new BadRequestException('开始日期不能晚于结束日期');
        }

        // 车牌号归一化（去空格、转大写）后用分号拼接存库
        const licensePlates = dto.licensePlates
            .map((p) => (p ?? '').toUpperCase().trim())
            .filter((p) => p.length > 0)
            .join(';');

        return await this.memberRepository.create({
            name: dto.name,
            phone: dto.phone,
            idCard: dto.idCard,
            licensePlates,
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
        if (dto.licensePlates !== undefined) {
            data.licensePlates = dto.licensePlates
                .map((p) => (p ?? '').toUpperCase().trim())
                .filter((p) => p.length > 0)
                .join(';');
        }

        // 若改了身份证，校验唯一性（排除自身）
        if (dto.idCard !== undefined) {
            const dup = await this.memberRepository.hasActiveMemberByIdCard(dto.idCard, memberId);
            if (dup) {
                throw new BadRequestException('该身份证已有生效中的月卡会员，请勿重复录入');
            }
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
     * 历史方法：会员判定已改为按身份证查，此方法仅作兼容保留
     */
    async getActiveMemberByOpenId(wechatOpenId: string): Promise<Member | null> {
        return await this.memberRepository.findActiveByOpenId(wechatOpenId);
    }

    /**
     * 根据身份证号查询有效会员
     * 供 BookingService 判定摩托车会员免费时调用
     */
    async getActiveMemberByIdCard(idCard: string): Promise<Member | null> {
        return await this.memberRepository.findActiveByIdCard(idCard);
    }
}
