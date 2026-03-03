import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 管理员登录 DTO
 */
export class LoginDto {
    /** 用户名 */
    @IsString()
    @IsNotEmpty()
    username: string;

    /** 密码 */
    @IsString()
    @IsNotEmpty()
    password: string;
}
