import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * 校验乘客身份是否匹配会员 DTO
 */
export class VerifyMemberDto {
    /** 乘客身份证号 */
    @IsString()
    @IsNotEmpty({ message: '身份证号不能为空' })
    @Matches(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/, { message: '身份证号格式不正确' })
    idCard: string;
}
