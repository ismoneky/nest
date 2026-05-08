import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CreateUserProfileDto {
    @IsString()
    @IsNotEmpty({ message: '姓名不能为空' })
    name: string;

    @IsString()
    @IsNotEmpty({ message: '手机号不能为空' })
    @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
    phone: string;

    @IsString()
    @IsNotEmpty({ message: '身份证号不能为空' })
    @Matches(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/, { message: '身份证号格式不正确' })
    idCard: string;
}

export class UpdateUserProfileDto {
    @IsString()
    @IsNotEmpty({ message: '姓名不能为空' })
    name: string;

    @IsString()
    @IsNotEmpty({ message: '手机号不能为空' })
    @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
    phone: string;

    @IsString()
    @IsNotEmpty({ message: '身份证号不能为空' })
    @Matches(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/, { message: '身份证号格式不正确' })
    idCard: string;
}
