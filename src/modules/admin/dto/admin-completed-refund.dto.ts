import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 管理员对已完成订单退款时提交的独立二级密码。 */
export class AdminCompletedRefundDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(128)
    secondaryPassword: string;
}
