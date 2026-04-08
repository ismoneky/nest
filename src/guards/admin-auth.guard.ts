import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * 管理员认证守卫
 * 通过请求头 x-admin-key 与环境变量 ADMIN_API_KEY 比对
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();
        const apiKey = request.headers['x-admin-key'];

        if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
            throw new UnauthorizedException('无效的管理员 API Key');
        }

        return true;
    }
}
