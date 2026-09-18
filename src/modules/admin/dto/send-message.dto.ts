import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 管理员手动发消息（§6 `/admin/messages/send`）
 *
 * ── 为什么收件人用 `openid` 而不是手机号 / 订单号 ───────────────────────────
 * `messages.userId` 存的就是 openid（见 `Message` 实体注释：与 bookings/feedbacks/members
 * 一致，以 openid 为业务主键）。若这里改收手机号，服务端就必须反查
 * `user_profiles`，而 `user_profiles.phone` **不唯一**（换绑、家人共用同一手机号），
 * 一条消息发给谁是不确定的。让管理员从订单/反馈详情页拿到 openid 再发，
 * 比在这里猜一个人更安全。
 *
 * ── `sendOa` 是**预留字段**，本期不产生投递 ────────────────────────────────
 * 服务号是独立分支（`feat/oa-template-message`，见方案 §3.4 / §4.6），
 * 主流程 `OA_ENABLED=false`。传 `true` 时消息仍会**如实落库**并记录
 * `oaSendStatus=SKIPPED`，不会有任何推送发出——这是刻意的：
 * 字段先占位，分支落地时不必再改一次接口契约（前端不用跟着改）。
 * **不要在响应里对管理员谎称「已推送服务号」。**
 */
export class SendMessageDto {
    /** 接收人 openid */
    @IsString()
    @IsNotEmpty({ message: '请指定接收人' })
    @MaxLength(64)
    openid: string;

    /** 卡片标题（≤50，与消息中心的单行展示宽度对齐） */
    @IsString()
    @IsNotEmpty({ message: '请填写标题' })
    @MaxLength(50, { message: '标题不能超过 50 字' })
    title: string;

    /**
     * 正文（≤500）
     *
     * 上限与 `messages.content` 的列宽一致（`varchar(500)`）：
     * 校验层放行、数据库截断的话，管理员会以为发全了，
     * 而用户看到的正文末尾被砍——这类静默截断比直接 400 难查得多。
     */
    @IsString()
    @IsNotEmpty({ message: '请填写内容' })
    @MaxLength(500, { message: '内容不能超过 500 字' })
    content: string;

    /** 预留：请求服务号推送（本期不投递，见类注释） */
    @IsOptional()
    @IsBoolean()
    sendOa?: boolean;
}
