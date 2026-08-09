import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUrl, Min, ValidateNested } from 'class-validator';

/**
 * 轮播图配置项 DTO
 */
export class BannerItemDto {
    @IsString()
    @IsUrl({}, { message: '请输入有效的图片链接' })
    imageUrl: string;
}

/**
 * 时间段预约限制 DTO
 */
export class TimeSlotLimitDto {
    @IsInt()
    @Min(1)
    morningMaxPeople: number;

    @IsInt()
    @Min(1)
    afternoonMaxPeople: number;
}

/**
 * 支付配置 DTO
 */
export class PaymentConfigDto {
    @IsInt()
    @Min(0)
    paymentAmount: number;

    /** 每日前N名用户免费：是否开启 */
    @IsOptional()
    @IsBoolean()
    freeQuotaEnabled?: boolean;

    /** 每日前N名用户免费：免费名额上限（去重用户数，按日重置） */
    @IsOptional()
    @IsInt()
    @Min(1)
    freeQuotaLimit?: number;
}

/**
 * 温馨提示配置 DTO
 */
export class NoticeConfigDto {
    /** 是否开启温馨提示弹窗 */
    @IsBoolean()
    enabled: boolean;

    /** 提示内容 */
    @IsString()
    content: string;
}

/**
 * 更新系统配置 DTO
 */
export class UpdateSystemConfigDto {
    /** 是否允许预约 */
    @IsOptional()
    @IsBoolean()
    bookingEnabled?: boolean;

    /** 禁止预约时的展示文案 */
    @IsOptional()
    @IsString()
    bookingDisabledMessage?: string;

    /** 轮播图配置 */
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BannerItemDto)
    banners?: BannerItemDto[];

    /** 时间段预约人数限制 */
    @IsOptional()
    @IsObject()
    @ValidateNested()
    @Type(() => TimeSlotLimitDto)
    timeSlotLimit?: TimeSlotLimitDto;

    /** 支付配置 */
    @IsOptional()
    @IsObject()
    @ValidateNested()
    @Type(() => PaymentConfigDto)
    paymentConfig?: PaymentConfigDto;

    /** 温馨提示配置 */
    @IsOptional()
    @IsObject()
    @ValidateNested()
    @Type(() => NoticeConfigDto)
    noticeConfig?: NoticeConfigDto;
}
