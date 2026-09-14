import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * 管理端 token 载荷（§4.3.4）
 *
 * `type: 'admin'` 是与用户 token 的**唯一硬区分**：两者用同一个 `JWT_SECRET` 签发，
 * 用户 token 的载荷是 `{ openid, userId }`。若只看「验签通过」，一个普通用户的
 * token 就能通过本守卫——虽然它的载荷里没有 adminId，取出来是 undefined，
 * 但那样「验签通过」就不再等于「这是管理员」，是必须从根上堵掉的口子。
 * 签发端 `AdminService.login` 写入该字段，校验端在这里比对。
 */
export interface AdminTokenPayload {
    adminId: number;
    username: string;
    name: string;
    type: 'admin';
}

/**
 * 管理端鉴权守卫（阶段 3 起）
 *
 * 两种凭据，token 优先：
 *   1. `x-admin-token`（登录时下发，12h）→ 验签通过则 `req.admin = { adminId, adminName }`，
 *      管理端据此记录**操作人**（`refund_applies.auditAdminId/auditAdminName`）；
 *   2. `x-admin-key`（`ADMIN_API_KEY` 静态密钥，原有机制）→ 放行但 `req.admin = null`，
 *      审核照常可用，只是审计字段记 null。
 *
 * ── 为什么 token 校验失败时**不**回退到 key ────────────────────────────────
 * 方案原文写的是「x-admin-token 存在且验签通过 → 用 token；否则回退 key」。
 * 实现改为严格模式：token 存在但无效 → 401，不回退。理由是回退会掩盖真实的
 * 失效状态——管理端 token 是 12h 过期的，过期后若静默降级到 key，管理员会在
 * **毫不知情**的情况下继续操作，而所有审核记录的 operator 悄悄变成 null，
 * 等发现时已经攒了一批无法追责的审核。401 会让前端弹重新登录，问题当场暴露。
 *
 * 无 token 时仍走静态 key，保持向后兼容（老版本管理端、脚本调用不受影响）。
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
    constructor(private readonly jwtService: JwtService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const token = request.headers['x-admin-token'];
        const tokenValue = Array.isArray(token) ? token[0] : token;

        if (tokenValue) {
            try {
                const payload = this.jwtService.verify<AdminTokenPayload>(tokenValue, {
                    secret: process.env.JWT_SECRET || 'default_jwt_secret_change_in_production',
                });
                if (payload.type !== 'admin') {
                    throw new Error('not an admin token');
                }
                request['admin'] = { adminId: payload.adminId, adminName: payload.name };
                return true;
            } catch {
                throw new UnauthorizedException('管理员登录已失效，请重新登录');
            }
        }

        const apiKey = request.headers['x-admin-key'];
        const expectedKey = process.env.ADMIN_API_KEY;

        if (!expectedKey) {
            throw new UnauthorizedException('服务端未配置 ADMIN_API_KEY');
        }

        if (apiKey !== expectedKey) {
            throw new UnauthorizedException('无效的管理员密钥');
        }

        // 无 token：放行但标记「操作人未知」，审核接口据此写 operatorUnknown
        request['admin'] = null;
        return true;
    }
}
