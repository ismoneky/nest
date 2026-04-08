import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AdminRepository } from '../../repositories/admin.repository';
import { LoginDto } from './dto/login.dto';

/**
 * 管理员业务逻辑层
 */
@Injectable()
export class AdminService {
    constructor(private readonly adminRepository: AdminRepository) {}

    /**
     * 管理员登录（验证用户名密码，返回管理员信息）
     * 接口本身由 AdminAuthGuard 通过 ADMIN_API_KEY 保护
     */
    async login(loginDto: LoginDto) {
        const admin = await this.adminRepository.findByUsername(loginDto.username);

        if (!admin) {
            throw new UnauthorizedException('用户名或密码错误');
        }

        const isPasswordValid = await this.adminRepository.comparePassword(loginDto.password, admin.password);

        if (!isPasswordValid) {
            throw new UnauthorizedException('用户名或密码错误');
        }

        await this.adminRepository.updateLastLogin(loginDto.username);

        return {
            username: admin.username,
            name: admin.name,
            apiKey: process.env.ADMIN_API_KEY,
        };
    }
}
