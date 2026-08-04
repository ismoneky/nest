import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';
import { MemberStatus } from '../../../entities/member.entity';

/**
 * 创建月卡会员 DTO
 * 管理后台录入：输入手机号，系统通过 UserProfile 反查 wechatOpenId
 */
export class CreateMemberDto {
    /** 会员手机号（用于查找已注册用户） */
    @IsString()
    @IsNotEmpty({ message: '手机号不能为空' })
    @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
    phone: string;

    /** 会员姓名 */
    @IsString()
    @IsNotEmpty({ message: '姓名不能为空' })
    name: string;

    /** 会员身份证号 */
    @IsString()
    @IsNotEmpty({ message: '身份证号不能为空' })
    @Matches(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/, { message: '身份证号格式不正确' })
    idCard: string;

    /** 会员有效期开始日期 (YYYY-MM-DD) */
    @IsDateString()
    @IsNotEmpty({ message: '开始日期不能为空' })
    startDate: string;

    /** 会员有效期结束日期 (YYYY-MM-DD) */
    @IsDateString()
    @IsNotEmpty({ message: '结束日期不能为空' })
    endDate: string;

    /** 备注 (可选) */
    @IsString()
    @IsOptional()
    remarks?: string;
}

/**
 * 更新月卡会员 DTO
 */
export class UpdateMemberDto {
    /** 会员姓名 */
    @IsString()
    @IsOptional()
    name?: string;

    /** 会员手机号 */
    @IsString()
    @IsOptional()
    @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
    phone?: string;

    /** 会员身份证号 */
    @IsString()
    @IsOptional()
    @Matches(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/, { message: '身份证号格式不正确' })
    idCard?: string;

    /** 会员有效期开始日期 (YYYY-MM-DD) */
    @IsDateString()
    @IsOptional()
    startDate?: string;

    /** 会员有效期结束日期 (YYYY-MM-DD) */
    @IsDateString()
    @IsOptional()
    endDate?: string;

    /** 会员状态 */
    @IsEnum(MemberStatus)
    @IsOptional()
    status?: MemberStatus;

    /** 备注 */
    @IsString()
    @IsOptional()
    remarks?: string;
}

/**
 * 查询会员列表 DTO
 */
export class GetMembersDto {
    /** 关键字搜索（姓名/手机号/身份证号） */
    @IsString()
    @IsOptional()
    keyword?: string;

    /** 会员状态筛选 */
    @IsEnum(MemberStatus)
    @IsOptional()
    status?: MemberStatus;

    /** 页码 (默认1) */
    @IsOptional()
    page?: number;

    /** 每页条数 (默认10) */
    @IsOptional()
    pageSize?: number;
}
