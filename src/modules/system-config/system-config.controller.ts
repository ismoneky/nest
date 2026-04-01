import { Body, Controller, Get, HttpStatus, Put, Res } from '@nestjs/common';
import { Response } from 'express';
import { SystemConfigService } from './system-config.service';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';

/**
 * 系统配置控制器
 */
@Controller('system-config')
export class SystemConfigController {
    constructor(private readonly configService: SystemConfigService) {}

    /**
     * 获取系统配置
     * GET /system-config
     */
    @Get()
    async getConfig(@Res() res: Response) {
        const config = await this.configService.getConfig();
        return res.status(HttpStatus.OK).send({
            success: true,
            data: config,
        });
    }

    /**
     * 更新系统配置 (管理员)
     * PUT /system-config
     */
    @Put()
    async updateConfig(@Body() updateDto: UpdateSystemConfigDto, @Res() res: Response) {
        const config = await this.configService.updateConfig(updateDto);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '系统配置更新成功',
            data: config,
        });
    }

    /**
     * 获取是否允许预约
     * GET /system-config/booking-enabled
     */
    @Get('booking-enabled')
    async isBookingEnabled(@Res() res: Response) {
        const enabled = await this.configService.isBookingEnabled();
        return res.status(HttpStatus.OK).send({
            success: true,
            data: { bookingEnabled: enabled },
        });
    }

    /**
     * 获取时间段预约人数限制
     * GET /system-config/time-slot-limit
     */
    @Get('time-slot-limit')
    async getTimeSlotLimit(@Res() res: Response) {
        const limit = await this.configService.getTimeSlotLimit();
        return res.status(HttpStatus.OK).send({
            success: true,
            data: limit,
        });
    }

    /**
     * 获取支付配置
     * GET /system-config/payment-config
     */
    @Get('payment-config')
    async getPaymentConfig(@Res() res: Response) {
        const paymentConfig = await this.configService.getPaymentConfig();
        return res.status(HttpStatus.OK).send({
            success: true,
            data: paymentConfig,
        });
    }

    /**
     * 获取禁止预约时的展示文案
     * GET /system-config/booking-disabled-message
     */
    @Get('booking-disabled-message')
    async getBookingDisabledMessage(@Res() res: Response) {
        const message = await this.configService.getBookingDisabledMessage();
        return res.status(HttpStatus.OK).send({
            success: true,
            data: { bookingDisabledMessage: message },
        });
    }
}
