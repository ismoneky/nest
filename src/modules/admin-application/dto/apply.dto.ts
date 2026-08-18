import { IsNotEmpty, IsString } from 'class-validator';

export class ApplyDto {
    @IsString()
    @IsNotEmpty()
    phone: string;

    @IsString()
    @IsNotEmpty()
    name: string;
}
