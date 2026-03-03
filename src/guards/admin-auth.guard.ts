import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AdminService } from '../modules/admin/admin.service';

/**
 * 管理员认证守卫
 * 用于保护需要管理员权限的路由
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
    constructor(private readonly adminService: AdminService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const token = this.extractTokenFromHeader(request);

        if (!token) {
            throw new UnauthorizedException('未提供认证令牌');
        }

        const isValid = await this.adminService.validateToken(token);

        if (!isValid) {
            throw new UnauthorizedException('认证令牌无效或已过期');
        }

        return true;
    }

    /**
     * 从请求头中提取token
     * @param request 请求对象
     * @returns token字符串
     */
    private extractTokenFromHeader(request: any): string | undefined {
        const authorization = request.headers.authorization;
        if (!authorization) {
            return undefined;
        }

        // 支持 "Bearer token" 格式
        const [type, token] = authorization.split(' ');
        return type === 'Bearer' ? token : undefined;
    }
}
