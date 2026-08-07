import { ArrayMinSize, IsArray, IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { MemberStatus } from '../../../entities/member.entity';

/** 车牌号正则（与 createBooking.dto 一致，含挂学警港澳） */
const LICENSE_PLATE_PATTERN = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]$/;

/**
 * 创建月卡会员 DTO
 * 管理后台录入：姓名/身份证/手机号(仅展示)/车牌号(可多个)/有效期
 * 不再绑定 openid，下单时按身份证+车牌号双匹配判定
 */
export class CreateMemberDto {
    /** 会员手机号（仅作联系电话展示，不参与命中校验） */
    @IsString()
    @IsNotEmpty({ message: '手机号不能为空' })
    @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
    phone: string;

    /** 会员姓名 */
    @IsString()
    @IsNotEmpty({ message: '姓名不能为空' })
    name: string;

    /** 会员身份证号（命中钥匙之一；同身份证只允许一条有效会员） */
    @IsString()
    @IsNotEmpty({ message: '身份证号不能为空' })
    @Matches(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/, { message: '身份证号格式不正确' })
    idCard: string;

    /** 车牌号列表（命中钥匙之二：下单车牌命中其一即匹配） */
    @IsArray()
    @ArrayMinSize(1, { message: '至少填写一个车牌号' })
    @IsString({ each: true })
    @Matches(LICENSE_PLATE_PATTERN, { each: true, message: '车牌号格式不正确' })
    licensePlates: string[];

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

    /** 车牌号列表（可选更新） */
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1, { message: '至少填写一个车牌号' })
    @IsString({ each: true })
    @Matches(LICENSE_PLATE_PATTERN, { each: true, message: '车牌号格式不正确' })
    licensePlates?: string[];

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
