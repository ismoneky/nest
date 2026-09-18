import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { MemberService } from './member.service';
import { CreateMemberDto, UpdateMemberDto, GetMembersDto } from './dto/member.dto';
import { AdminAuthGuard } from '../../common/guards/admin-jwt-auth.guard';

/**
 * 月卡会员管理控制器
 * 所有接口需要管理员权限
 */
@Controller('admin/members')
@UseGuards(AdminAuthGuard)
export class MemberController {
    constructor(private readonly memberService: MemberService) {}

    /**
     * 创建月卡会员
     * POST /admin/members
     */
    @Post()
    async create(@Body() dto: CreateMemberDto, @Res() res: Response) {
        const member = await this.memberService.createMember(dto);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '月卡会员创建成功',
            data: member,
        });
    }

    /**
     * 查询会员列表（分页）
     * GET /admin/members
     */
    @Get()
    async findAll(@Query() query: GetMembersDto, @Res() res: Response) {
        const result = await this.memberService.getMembers(query);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: result.members,
            pagination: {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                totalPages: result.totalPages,
            },
        });
    }

    /**
     * 查询会员详情
     * GET /admin/members/:memberId
     */
    @Get(':memberId')
    async findOne(@Param('memberId') memberId: string, @Res() res: Response) {
        const member = await this.memberService.getMemberById(memberId);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: member,
        });
    }

    /**
     * 更新会员信息
     * PUT /admin/members/:memberId
     */
    @Put(':memberId')
    async update(@Param('memberId') memberId: string, @Body() dto: UpdateMemberDto, @Res() res: Response) {
        const member = await this.memberService.updateMember(memberId, dto);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '会员信息更新成功',
            data: member,
        });
    }

    /**
     * 删除会员
     * DELETE /admin/members/:memberId
     */
    @Delete(':memberId')
    async remove(@Param('memberId') memberId: string, @Res() res: Response) {
        await this.memberService.deleteMember(memberId);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '会员删除成功',
        });
    }
}
