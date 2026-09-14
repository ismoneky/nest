import { IsNotEmpty, IsString, IsMobilePhone, MaxLength } from 'class-validator';

export class CreateFeedbackDto {
    @IsNotEmpty({ message: '手机号不能为空' })
    @IsMobilePhone('zh-CN', {}, { message: '手机号格式不正确' })
    phone: string;

    @IsNotEmpty({ message: '反馈内容不能为空' })
    @IsString()
    @MaxLength(1000, { message: '反馈内容不能超过1000字' })
    content: string;
}
