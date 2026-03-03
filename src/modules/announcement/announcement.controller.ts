import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Put, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminAuthGuard } from '../../guards/admin-auth.guard';
import { AnnouncementService } from './announcement.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';

@Controller('announcements')
export class AnnouncementController {
    constructor(private readonly service: AnnouncementService) {}

    /**
     * 创建公告 (需要管理员权限)
     */
    @Post()
    @UseGuards(AdminAuthGuard)
    async create(@Body() dto: CreateAnnouncementDto, @Res() res: Response) {
        const announcement = await this.service.create(dto);
        return res.status(HttpStatus.CREATED).send({
            success: true,
            message: '创建成功',
            data: announcement,
        });
    }

    /**
     * 查询所有公告 (需要管理员权限)
     */
    @Get('admin/all')
    @UseGuards(AdminAuthGuard)
    async findAll(@Res() res: Response) {
        const announcements = await this.service.findAll();
        return res.status(HttpStatus.OK).send({
            success: true,
            data: announcements,
        });
    }

    /**
     * 查询启用的公告 (小程序端,无需权限)
     */
    @Get()
    async findActive(@Res() res: Response) {
        const announcements = await this.service.findActive();
        return res.status(HttpStatus.OK).send({
            success: true,
            data: announcements,
        });
    }

    /**
     * 更新公告 (需要管理员权限)
     */
    @Put(':id')
    @UseGuards(AdminAuthGuard)
    async update(@Param('id') id: string, @Body() dto: UpdateAnnouncementDto, @Res() res: Response) {
        const announcement = await this.service.update(id, dto);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '更新成功',
            data: announcement,
        });
    }

    /**
     * 删除公告 (需要管理员权限)
     */
    @Delete(':id')
    @UseGuards(AdminAuthGuard)
    async delete(@Param('id') id: string, @Res() res: Response) {
        await this.service.delete(id);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '删除成功',
        });
    }
}
