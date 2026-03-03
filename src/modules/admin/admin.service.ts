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
     * 管理员登录
     * @param loginDto 登录信息
     * @returns 登录成功的管理员信息和token
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

        // 更新最后登录时间
        await this.adminRepository.updateLastLogin(loginDto.username);

        // 生成简单的token (用户名+时间戳的base64)
        const token = Buffer.from(`${admin.username}:${Date.now()}`).toString('base64');

        return {
            username: admin.username,
            name: admin.name,
            token,
        };
    }

    /**
     * 验证token
     * @param token token字符串
     * @returns 是否有效
     */
    async validateToken(token: string): Promise<boolean> {
        try {
            const decoded = Buffer.from(token, 'base64').toString('utf-8');
            const [username, timestamp] = decoded.split(':');

            // 检查用户是否存在
            const admin = await this.adminRepository.findByUsername(username);
            if (!admin) {
                return false;
            }

            // 检查token是否过期 (24小时)
            const tokenTime = parseInt(timestamp);
            const now = Date.now();
            const twentyFourHours = 24 * 60 * 60 * 1000;

            return now - tokenTime < twentyFourHours;
        } catch (error) {
            return false;
        }
    }
}
