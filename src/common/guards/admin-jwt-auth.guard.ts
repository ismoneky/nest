import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class AdminAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const apiKey = request.headers['x-admin-key'];
        const expectedKey = process.env.ADMIN_API_KEY;

        if (!expectedKey) {
            throw new UnauthorizedException('服务端未配置 ADMIN_API_KEY');
        }

        if (apiKey !== expectedKey) {
            throw new UnauthorizedException('无效的管理员密钥');
        }

        return true;
    }
}
