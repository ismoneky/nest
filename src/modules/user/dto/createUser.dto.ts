import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateUserDto {
    @IsString()
    @IsNotEmpty()
    wechatOpenId: string;

    @IsString()
    @IsNotEmpty()
    wechatNickname: string;

    @IsString()
    @IsOptional()
    wechatAvatarUrl?: string;
}
