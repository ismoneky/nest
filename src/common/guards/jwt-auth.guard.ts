import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(private readonly jwtService: JwtService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const token = this.extractToken(request);

        if (!token) {
            throw new UnauthorizedException('缺少认证 token');
        }

        try {
            const payload = this.jwtService.verify<{ openid: string; userId: string }>(token, {
                secret: process.env.JWT_SECRET || 'default_jwt_secret_change_in_production',
            });
            request['user'] = payload;
        } catch {
            throw new UnauthorizedException('token 无效或已过期');
        }

        return true;
    }

    private extractToken(request: Request): string | null {
        const auth = request.headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ')) {
            return null;
        }
        return auth.slice(7);
    }
}
