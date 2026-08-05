import { Body, Controller, Get, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { MemberService } from './member.service';
import { VerifyMemberDto } from './dto/member-user.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

/**
 * 会员用户端控制器
 * 提供给小程序前端查询会员状态、校验会员身份
 */
@Controller('member')
export class MemberUserController {
    constructor(private readonly memberService: MemberService) {}

    /**
     * 查询当前用户的会员状态
     * GET /member/status
     */
    @Get('status')
    @UseGuards(JwtAuthGuard)
    async getStatus(@Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const status = await this.memberService.getMemberStatus(openid);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: status,
        });
    }

    /**
     * 校验乘客身份证是否匹配会员身份
     * POST /member/verify
     */
    @Post('verify')
    @UseGuards(JwtAuthGuard)
    async verifyIdentity(@Body() dto: VerifyMemberDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const result = await this.memberService.verifyMemberIdentity(openid, dto.idCard);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: result,
        });
    }
}
