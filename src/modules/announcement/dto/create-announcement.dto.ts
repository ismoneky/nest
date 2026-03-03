import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

/**
 * 创建公告 DTO
 */
export class CreateAnnouncementDto {
    /** 公告标题 */
    @IsString()
    @IsNotEmpty()
    title: string;

    /** 公告内容 */
    @IsString()
    @IsNotEmpty()
    content: string;

    /** 是否启用 (默认true) */
    @IsBoolean()
    @IsOptional()
    isActive?: boolean = true;

    /** 排序顺序 (默认0) */
    @IsInt()
    @Min(0)
    @IsOptional()
    sortOrder?: number = 0;
}
