import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdminService } from './admin.service';
import { LoginDto } from './dto/login.dto';

/**
 * 管理员控制器
 */
@Controller('admin')
export class AdminController {
    constructor(private readonly adminService: AdminService) {}

    /**
     * 管理员登录
     * POST /admin/login
     * @param loginDto 登录信息
     * @param res Express 响应对象
     */
    @Post('login')
    async login(@Body() loginDto: LoginDto, @Res() res: Response) {
        const result = await this.adminService.login(loginDto);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '登录成功',
            data: result,
        });
    }
}
