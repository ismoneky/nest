import { PartialType } from '@nestjs/mapped-types';
import { CreateAnnouncementDto } from './create-announcement.dto';

/**
 * 更新公告 DTO
 */
export class UpdateAnnouncementDto extends PartialType(CreateAnnouncementDto) {}
