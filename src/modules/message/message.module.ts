import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../../entities/message.entity';
import { MessageRepository } from '../../repositories/message.repository';
import { MessageService } from './message.service';
import { MessageController } from './message.controller';
import { UserModule } from '../user/user.module';

/**
 * 站内信模块（阶段 4）
 *
 * ── 叶子模块：不 import 任何业务模块 ──────────────────────────────────────
 * 与 `RefundModule` 同款设计。本模块只认 `Message` 一张表，
 * 发消息需要的一切业务数据（订单号、申请单号、金额、驳回理由……）
 * 都由**调用方**读好后作为参数传进来。
 *
 * 这一点不是洁癖，是硬约束：`MessageService` 会被
 *   BookingModule（T1 过期扫描 / T2 提醒）、
 *   RefundModule（受理 / 通过 / 驳回）、
 *   WechatPayModule（到账回调）、
 *   AdminModule（手动发消息）、
 *   FeedbackModule（阶段 5 回复通知）
 * 同时导入。只要本模块反过来依赖其中任何一个，就会立刻成环
 * （`AdminModule → MessageModule → BookingModule → ...`）。
 *
 * ── 只导出 Service，不导出 Repository ─────────────────────────────────────
 * 仓库层的 `markRead` / `markAllRead` 带 `userId` 条件，是归属校验的落点。
 * 把它暴露给别的模块，等于给「绕过归属校验直接写 messages 表」开了一扇门。
 * 治理类操作（T3 的置已读 / 删除）已由 Service 包一层转发。
 *
 * ── 为什么 import UserModule ──────────────────────────────────────────────
 * `MessageController` 挂了 `JwtAuthGuard`，而守卫**是在宿主模块的注入上下文里
 * 实例化的**——它注入 JwtService，所以谁能提供 JwtService 必须由本模块自己保证，
 * 不能指望别的模块传递。UserModule 导出 JwtModule，与 LoggingModule / MemberModule
 * 的取用方式一致。
 *
 * ⚠️ 这一条是**启动期**错误，`tsc` 与单元测试都发现不了：漏了它的表现是
 * `Nest can't resolve dependencies of the JwtAuthGuard`，应用直接起不来。
 * 阶段 3 就因为在共享守卫里加了 JwtService 注入、却只改了 AdminModule，
 * 让 AdminModule 与 MemberModule 双双起不来（见 implementation-todo.md 实现说明）。
 */
@Module({
    imports: [TypeOrmModule.forFeature([Message]), UserModule],
    controllers: [MessageController],
    providers: [MessageService, MessageRepository],
    exports: [MessageService],
})
export class MessageModule {}
