import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefundApply } from '../../entities/refund-apply.entity';
import { RefundApplyRepository } from '../../repositories/refund-apply.repository';
import { RefundApplyService } from './refund-apply.service';
import { SystemConfigModule } from '../system-config/system-config.module';
import { MessageModule } from '../message/message.module';

/**
 * 退款申请/审核模块（阶段 3）
 *
 * 本模块**不含控制器**：对外的三个入口分别落在既有的控制器上——
 *   - `POST /bookings/:bookingId/refund-apply`、订单详情里的 `refundEntry`
 *     → `BookingController`（与订单详情同路由同鉴权，拆成两个控制器反而要在
 *       两个地方维护同一套用户身份校验）
 *   - `GET /admin/refund-applies`、`POST /admin/refund-applies/:applyNo/approve|reject`
 *     → `AdminController`（复用管理端鉴权与 AdminService）
 *
 * 本模块只导出服务与仓库，**不反向依赖 BookingModule**（审核通过要调
 * `BookingService.initiateRefund`，那一步由 AdminService 编排）——这样
 * BookingModule / WechatPayModule / AdminModule 都能安全地 import 本模块，
 * 不会形成模块循环。
 *
 * ── 为什么 import MessageModule ───────────────────────────────────────────
 * `RefundApplyService` 是退款类站内信的四个发送点（受理/通过/驳回/到账）。
 * `MessageModule` 是叶子模块（只依赖 `TypeOrmModule.forFeature([Message])` 与
 * `UserModule`），**不反向依赖任何业务模块**——这正是它能被
 * Booking / Refund / WechatPay / Admin / Feedback 同时 import 而不成环的原因。
 */
@Module({
    imports: [TypeOrmModule.forFeature([RefundApply]), SystemConfigModule, MessageModule],
    providers: [RefundApplyService, RefundApplyRepository],
    exports: [RefundApplyService, RefundApplyRepository],
})
export class RefundModule {}
