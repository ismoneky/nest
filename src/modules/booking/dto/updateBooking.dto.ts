import { IsIn, IsOptional } from 'class-validator';

/**
 * `PUT /bookings/:bookingId` 的兼容 DTO —— **已废弃，仅保留取消语义**。
 *
 * 历史问题（本次修复）：旧实现 `extends PartialType(CreateBookingDto)`，
 * 意味着以下字段全部可由请求方任意改写，且该端点当时**没有任何 Guard**：
 *   - `status`     → 未登录即可把任意订单改成 confirmed（伪造核销码）或 expired（伪造退款入口）
 *   - `bookingDate`/`personCount`/`passengers` → 可改动已支付订单的日期、人数、出行人，
 *     而配额不重算、金额不重新计价、已生成的核销码不失效
 *   - `isAdmin`    → 本是创建时跳过「预约开关」检查的后门，出现在更新 DTO 里属于连带暴露
 *
 * 现在只接受 `status: 'cancelled'` 一种载荷，且服务端统一走 `cancelBooking` 的条件更新原语。
 * 保留该端点的唯一原因是**小程序灰度**：旧版本客户端的取消预约仍在打这个接口，
 * 直接删会让未更新版本的用户取消失败。待小程序全量更新后整个端点连同本文件一并删除。
 */
export class UpdateBookingDto {
    /** 唯一被接受的取值：取消。其他状态流转一律走各自的专用端点 */
    @IsOptional()
    @IsIn(['cancelled'], { message: '该接口仅支持取消订单，请使用 POST /bookings/:bookingId/cancel' })
    status?: 'cancelled';
}
