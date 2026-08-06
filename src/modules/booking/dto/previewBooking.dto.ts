import { ArrayMinSize, IsArray, IsDateString, IsNotEmpty, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PassengerDto } from './createBooking.dto';

/**
 * 预约费用预览 DTO
 * 进入预约页 / 修改乘客 / 修改日期时调用，后端返回完整的费用与免费判定预览
 * （后端为唯一事实来源，前端不做任何判定）
 */
export class PreviewBookingDto {
    /** 出行人员列表（与下单保持一致） */
    @IsArray()
    @ArrayMinSize(1, { message: '至少填写一名出行人员' })
    @ValidateNested({ each: true })
    @Type(() => PassengerDto)
    passengers: PassengerDto[];

    /** 预约日期 (YYYY-MM-DD) */
    @IsDateString()
    @IsNotEmpty()
    bookingDate: string;
}
