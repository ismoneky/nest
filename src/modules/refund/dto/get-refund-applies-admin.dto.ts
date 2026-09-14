import { Type, Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { RefundApplyStatus } from '../../../entities/refund-apply.entity';

/**
 * 管理端退款审核列表查询
 *
 * `createdStart/createdEnd` 用 `YYYY-MM-DD`（与订单列表同款），在仓库层转成
 * 当天 00:00:00.000 / 23:59:59.999 的毫秒边界——查询参数是「日期」，
 * 不该要求调用方自己拼时间部分。
 */
export class GetRefundAppliesAdminDto {
    @IsEnum(RefundApplyStatus)
    @IsOptional()
    status?: RefundApplyStatus;

    /** 申请日期范围：起始（含），格式 YYYY-MM-DD */
    @IsDateString()
    @IsOptional()
    createdStart?: string;

    /** 申请日期范围：结束（含），格式 YYYY-MM-DD */
    @IsDateString()
    @IsOptional()
    createdEnd?: string;

    /** 关键字搜索（申请单号 / 订单号） */
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @IsOptional()
    keyword?: string;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    @IsOptional()
    page?: number = 1;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    @IsOptional()
    pageSize?: number = 10;
}
