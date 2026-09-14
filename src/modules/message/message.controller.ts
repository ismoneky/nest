import { Body, Controller, Get, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { MessageService } from './message.service';
import { GetMessagesDto } from './dto/get-messages.dto';
import { ReadMessagesDto } from './dto/read-messages.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Message } from '../../entities/message.entity';

/**
 * 从实体里挑出「用户该看到的字段」
 *
 * 站内信实体同时承担两种角色：**给用户看的通知** 和 **服务号的发送台账**。
 * `oaSendStatus / oaAttempts / oaLastError / dedupeKey / userId / adminId`
 * 全属后者，直接 `res.send(message)` 会把它们一起送出去：
 *   · `dedupeKey` 泄漏的是**别人的**订单号/申请单号规则（可被枚举）；
 *   · `oaLastError` 里可能带微信接口的原始报错文本；
 *   · `userId` 是 openid——虽然就是用户自己，但没有下发给前端的理由。
 * 所以这里白名单式地逐字段挑，而不是 `delete` 几个字段。
 * 将来给实体加列，默认**不会**出现在响应里，这个方向才是安全的。
 */
function toUserMessage(msg: Message) {
    return {
        id: msg.id,
        msgType: msg.msgType,
        title: msg.title,
        content: msg.content,
        bizType: msg.bizType,
        bizId: msg.bizId,
        jumpPath: msg.jumpPath,
        senderType: msg.senderType,
        isRead: msg.isRead === 1,
        readAt: msg.readAt,
        createdAt: msg.createdAt,
    };
}

/**
 * 站内信控制器（用户端，§6）
 *
 * 三条路由全部要登录，且**全部只操作 `req.user.openid` 名下的数据**：
 * 用户身份从 token 取，接口不接收任何 userId 入参——
 * 一旦某个接口出现 `?userId=` 参数，它迟早会被人填上别人的 openid。
 */
@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessageController {
    constructor(private readonly messageService: MessageService) {}

    /**
     * 我的消息列表（分页）
     * GET /messages?msgType=REFUND_ACCEPTED,REFUND_APPROVED&page=1&pageSize=20
     */
    @Get()
    async getMessages(@Query() query: GetMessagesDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const result = await this.messageService.getMyMessages(openid, query);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: result.messages.map(toUserMessage),
            pagination: {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                totalPages: result.totalPages,
            },
        });
    }

    /**
     * 未读数（角标）
     * GET /messages/unread-count
     *
     * 单独成一个接口而不是塞进列表响应：角标在**每个 tab 的 onShow** 都要刷新，
     * 那时候并不需要列表正文。合并的话每次刷新角标都要拉 20 条消息正文。
     */
    @Get('unread-count')
    async getUnreadCount(@Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const count = await this.messageService.getUnreadCount(openid);
        return res.status(HttpStatus.OK).send({ success: true, data: { count } });
    }

    /**
     * 标记已读
     * POST /messages/read  body: { ids: [1,2,3] } 或 { all: true }
     *
     * 归属校验在 SQL 的 WHERE 里（见 MessageService.markRead），
     * 传别人的 id 不会越权，只是那几条不计入 affected。
     */
    @Post('read')
    async markRead(@Body() dto: ReadMessagesDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };

        if (dto.all === true) {
            const updated = await this.messageService.markAllRead(openid);
            return res.status(HttpStatus.OK).send({ success: true, data: { updated } });
        }

        if (!dto.ids || dto.ids.length === 0) {
            // 两个参数都没给：明确报错，不猜。见 ReadMessagesDto 顶部说明——
            // 这里「宽容处理」成全部已读会静默清空用户的未读角标。
            return res.status(HttpStatus.BAD_REQUEST).send({
                success: false,
                message: '请指定要标记的消息',
                error: 'ids 与 all 至少提供一个',
            });
        }

        const updated = await this.messageService.markRead(openid, dto.ids);
        return res.status(HttpStatus.OK).send({ success: true, data: { updated } });
    }
}
