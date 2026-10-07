import { Body, Controller, Get, Post, Put, UseGuards, Header } from '@nestjs/common';
import { AdminAuthGuard } from '../../guards/admin-auth.guard';
import { ScenicGuideService } from './scenic-guide.service';
import { GuideUploadService } from './guide-upload.service';

@Controller('scenic-guide')
export class ScenicGuideController {
    constructor(private readonly guide: ScenicGuideService, private readonly uploadService: GuideUploadService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    async read() { return { success: true, data: await this.guide.read() }; }

    @Get('admin')
    @Header('Cache-Control', 'no-store')
    @UseGuards(AdminAuthGuard)
    async readAdmin() { return { success: true, data: await this.guide.read(true) }; }

    @Put('admin')
    @UseGuards(AdminAuthGuard)
    async save(@Body() body: unknown) { return { success: true, data: await this.guide.save(body) }; }

    @Post('upload-policy')
    @Header('Cache-Control', 'no-store')
    @UseGuards(AdminAuthGuard)
    upload(@Body() body: unknown) { return { success: true, data: this.uploadService.createPolicy(body) }; }
}
