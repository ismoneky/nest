import { Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { mkdirSync, unlinkSync, existsSync } from 'fs';
import { AdminRepository } from '../../repositories/admin.repository';
import { LoginDto } from './dto/login.dto';

const execFileAsync = promisify(execFile);

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

    /**
     * 导出全量订单为 Excel 文件，返回文件路径
     */
    async exportBookingsToExcel(): Promise<string> {
        const dbPath = join(process.cwd(), process.env.DATABASE_PATH || 'data/app.db');
        const tmpDir = join(process.cwd(), 'tmp');
        if (!existsSync(tmpDir)) {
            mkdirSync(tmpDir, { recursive: true });
        }

        const outputPath = join(tmpDir, `bookings_${Date.now()}.xlsx`);
        const scriptPath = join(process.cwd(), 'scripts', 'export_bookings.py');

        try {
            await execFileAsync('python3', [scriptPath, dbPath, outputPath]);
        } catch (error) {
            throw new InternalServerErrorException('导出失败: ' + (error as Error).message);
        }

        return outputPath;
    }

    cleanupFile(filePath: string) {
        try {
            unlinkSync(filePath);
        } catch {}
    }
}
