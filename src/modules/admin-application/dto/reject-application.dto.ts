import { IsOptional, IsString } from 'class-validator';

export class RejectApplicationDto {
    @IsString()
    @IsOptional()
    rejectionReason?: string;
}
