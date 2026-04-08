import { BadRequestException, Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { Response } from 'express';
import { UserService } from './user.service';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';

@Controller('users')
export class UserController {
    constructor(
        private readonly userService: UserService,
        private readonly httpService: HttpService,
        private readonly jwtService: JwtService,
        private readonly adminApplicationRepository: AdminApplicationRepository,
    ) {}

    /**
     * 微信小程序登录
     * 前端传 code，后端换取 openid，完成注册/登录，返回 JWT
     * POST /users/wx-login
     */
    @Post('wx-login')
    async loginByWxCode(@Body('code') code: string, @Res() res: Response) {
        if (!code) {
            throw new BadRequestException('code is required');
        }

        const appid = process.env.WX_APPID || '';
        const secret = process.env.WX_SECRET || '';

        if (!appid || !secret) {
            throw new BadRequestException('微信小程序配置不完整');
        }

        const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;

        let openid: string;
        try {
            const response = await firstValueFrom(this.httpService.get(url));
            const { openid: wxOpenid, errcode, errmsg } = response.data;
            if (errcode) {
                return res.status(HttpStatus.BAD_REQUEST).send({ success: false, message: errmsg, errcode });
            }
            openid = wxOpenid;
        } catch (error) {
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ success: false, message: '微信登录失败' });
        }

        // 注册或登录用户
        const user = await this.userService.findOrCreateUser({ wechatOpenId: openid });

        // 签发 JWT，payload 中携带 openid 和 userId
        const token = this.jwtService.sign({ openid: user.wechatOpenId, userId: user.userId });

        // 检查是否为已审批的管理员
        const approvedApp = await this.adminApplicationRepository.findApprovedByOpenid(openid);

        return res.status(HttpStatus.OK).send({
            success: true,
            data: { token, admin: !!approvedApp },
        });
    }
}
