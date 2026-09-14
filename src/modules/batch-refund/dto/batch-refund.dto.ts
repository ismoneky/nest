import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 批量退款预览 DTO（选择性批量退款：订单 ID 列表，1-1000 个）
 */
export class BatchRefundPreviewDto {
    /** 勾选的订单 ID 列表（来自订单列表勾选/全选筛选结果） */
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(1000)
    @IsString({ each: true })
    bookingIds!: string[];
}

/**
 * 批量退款执行 DTO
 */
export class ExecuteBatchRefundDto {
    /** 勾选的订单 ID 列表 */
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(1000)
    @IsString({ each: true })
    bookingIds!: string[];

    /** 退款原因（2-80 字，透传微信退款申请） */
    @IsString()
    @Length(2, 80)
    reason!: string;
}

/**
 * 历史任务列表查询 DTO
 */
export class ListBatchRefundTasksDto {
    /** 返回条数（默认 20） */
    @Type(() => Number)
    @IsOptional()
    @Min(1)
    @Max(50)
    limit?: number = 20;
}
