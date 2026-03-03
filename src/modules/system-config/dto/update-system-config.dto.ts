import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUrl, Min, ValidateNested } from 'class-validator';

/**
 * 轮播图配置项 DTO
 */
export class BannerItemDto {
    @IsString()
    title: string;

    @IsUrl()
    imageUrl: string;

    @IsOptional()
    @IsUrl()
    linkUrl?: string;

    @IsInt()
    @Min(0)
    sortOrder: number;
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
 * 更新系统配置 DTO
 */
export class UpdateSystemConfigDto {
    /** 是否允许预约 */
    @IsOptional()
    @IsBoolean()
    bookingEnabled?: boolean;

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
}
