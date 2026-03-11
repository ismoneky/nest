import { BadRequestException, Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Response } from 'express';
import { CreateUserDto } from './dto/createUser.dto';
import { UserService } from './user.service';

@Controller('users')
export class UserController {
    constructor(private userService: UserService, private readonly httpService: HttpService) {}

    @Post('login')
    async loginOrRegister(@Body() createUserDto: CreateUserDto, @Res() res: Response) {
        try {
            const user = await this.userService.findOrCreateUser(createUserDto);
            return res.status(HttpStatus.OK).send({
                success: true,
                message: user.createdAt.getTime() === user.updatedAt?.getTime() ? 'User created successfully' : 'User logged in successfully',
                data: user,
            });
        } catch (error) {
            throw new BadRequestException(error);
        }
    }

    /**
     * 微信小程序登录，前端传 code，后端调用微信 API 获取 openid 和 session_key
     */
    @Post('wx-login')
    async loginByWxCode(@Body('code') code: string, @Res() res: Response) {
        if (!code) {
            throw new BadRequestException('code is required');
        }
        // TODO: 替换为你的微信小程序 appid 和 secret
        const appid = process.env.WX_APPID || 'wxdaecd30407f65635';
        const secret = process.env.WX_SECRET || '812421f289fd016b6bd64bfd5d028a6d';
        const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;
        try {
            const response = await firstValueFrom(this.httpService.get(url));
            const { openid, session_key, unionid, errcode, errmsg } = response.data;
            if (errcode) {
                return res.status(HttpStatus.BAD_REQUEST).send({ success: false, message: errmsg, errcode });
            }
            // 可在此处进行用户注册/登录逻辑
            return res.status(HttpStatus.OK).send({ success: true, data: { openid, session_key, unionid } });
        } catch (error) {
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ success: false, message: '微信登录失败', error });
        }
    }
}
