import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * 提交退款申请
 *
 * `reason` **必填**（需求 #2：「用户提交申请（原因必填）」）。长度上限与服务端
 * 二次校验、`refund_applies.reason` 的列宽保持一致（500）。
 *
 * 开头的 `Transform` 做 trim 后再校验：只输入空格不应通过 `@IsNotEmpty`。
 */
export class SubmitRefundApplyDto {
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString({ message: '退款原因必须是字符串' })
    @IsNotEmpty({ message: '请填写退款原因' })
    @MaxLength(500, { message: '退款原因不能超过 500 字' })
    reason: string;
}
