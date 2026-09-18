import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * 审核通过
 *
 * `remark` 选填，纯留痕（写 `refund_applies.auditRemark` 与 PAYMENT 分类日志），
 * 不透传微信——与 admin-refund-design.md 的退款原因口径一致。
 */
export class ApproveRefundApplyDto {
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(500, { message: '审核备注不能超过 500 字' })
    remark?: string;
}

/**
 * 审核拒绝
 *
 * `rejectReason` **必填**：它会随站内信原样下发给用户（「退款未通过：{理由}」），
 * 空理由等于让用户收到一条没有信息量的驳回通知，必然转为客诉。
 */
export class RejectRefundApplyDto {
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString({ message: '拒绝理由必须是字符串' })
    @IsNotEmpty({ message: '请填写拒绝理由' })
    @MaxLength(500, { message: '拒绝理由不能超过 500 字' })
    rejectReason: string;

    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(500, { message: '审核备注不能超过 500 字' })
    remark?: string;
}
