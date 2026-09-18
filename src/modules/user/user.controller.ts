import { BadRequestException, Body, Controller, Delete, Get, HttpStatus, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { Response, Request } from 'express';
import { UserService } from './user.service';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { UserProfileRepository } from '../../repositories/user-profile.repository';
import { CreateUserProfileDto, UpdateUserProfileDto } from './dto/user-profile.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('users')
export class UserController {
    constructor(
        private readonly userService: UserService,
        private readonly httpService: HttpService,
        private readonly jwtService: JwtService,
        private readonly adminApplicationRepository: AdminApplicationRepository,
        private readonly userProfileRepository: UserProfileRepository,
    ) {}

    /**
     * 微信小程序登录
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

        const user = await this.userService.findOrCreateUser({ wechatOpenId: openid });
        const token = this.jwtService.sign({ openid: user.wechatOpenId, userId: user.userId });
        const approvedApp = await this.adminApplicationRepository.findApprovedByOpenid(openid);

        return res.status(HttpStatus.OK).send({
            success: true,
            data: { token, admin: !!approvedApp },
        });
    }

    /**
     * 获取当前用户的常用人员列表
     * GET /users/profiles
     */
    @Get('profiles')
    @UseGuards(JwtAuthGuard)
    async getProfiles(@Req() req: Request & { user: { openid: string } }) {
        const profiles = await this.userProfileRepository.findByOpenId(req.user.openid);
        return { success: true, data: profiles };
    }

    /**
     * 新增常用人员
     * POST /users/profiles
     */
    @Post('profiles')
    @UseGuards(JwtAuthGuard)
    async createProfile(
        @Req() req: Request & { user: { openid: string } },
        @Body() dto: CreateUserProfileDto,
    ) {
        const profile = await this.userProfileRepository.create(req.user.openid, dto);
        return { success: true, data: profile };
    }

    /**
     * 更新常用人员
     * PUT /users/profiles/:profileId
     */
    @Put('profiles/:profileId')
    @UseGuards(JwtAuthGuard)
    async updateProfile(
        @Req() req: Request & { user: { openid: string } },
        @Param('profileId') profileId: string,
        @Body() dto: UpdateUserProfileDto,
    ) {
        const profile = await this.userProfileRepository.update(profileId, req.user.openid, dto);
        return { success: true, data: profile };
    }

    /**
     * 删除常用人员
     * DELETE /users/profiles/:profileId
     */
    @Delete('profiles/:profileId')
    @UseGuards(JwtAuthGuard)
    async deleteProfile(
        @Req() req: Request & { user: { openid: string } },
        @Param('profileId') profileId: string,
    ) {
        await this.userProfileRepository.delete(profileId, req.user.openid);
        return { success: true };
    }
}
