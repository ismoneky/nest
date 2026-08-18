import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Admin } from '../entities/admin.entity';
import * as bcrypt from 'bcrypt';

/**
 * 管理员数据访问层
 */
@Injectable()
export class AdminRepository {
    constructor(
        @InjectRepository(Admin)
        private readonly adminRepository: Repository<Admin>,
    ) {}

    /**
     * 根据用户名查找管理员
     * @param username 用户名
     * @returns 管理员实体
     */
    async findByUsername(username: string): Promise<Admin | null> {
        try {
            return await this.adminRepository.findOne({ where: { username } });
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find admin');
        }
    }

    /**
     * 验证密码
     * @param plainPassword 明文密码
     * @param hashedPassword 加密密码
     * @returns 是否匹配
     */
    async comparePassword(plainPassword: string, hashedPassword: string): Promise<boolean> {
        try {
            return await bcrypt.compare(plainPassword, hashedPassword);
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to compare password');
        }
    }

    /**
     * 更新最后登录时间
     * @param username 用户名
     */
    async updateLastLogin(username: string): Promise<void> {
        try {
            await this.adminRepository.update({ username }, { lastLoginAt: new Date() });
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update last login');
        }
    }

    /**
     * 创建管理员 (仅用于初始化)
     * @param username 用户名
     * @param password 密码
     * @param name 姓名
     */
    async createAdmin(username: string, password: string, name: string): Promise<Admin> {
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const admin = this.adminRepository.create({
                username,
                password: hashedPassword,
                name,
            });
            return await this.adminRepository.save(admin);
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to create admin');
        }
    }
}
