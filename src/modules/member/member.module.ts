import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Member } from '../../entities/member.entity';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { MemberRepository } from '../../repositories/member.repository';
import { UserModule } from '../user/user.module';

/**
 * `UserModule` 提供 JwtModule：MemberController 挂了 `AdminAuthGuard`
 * （`common/guards/admin-jwt-auth.guard.ts`），该守卫注入 JwtService 验 `x-admin-token`。
 *
 * ⚠️ 守卫是在**宿主模块**的注入上下文里实例化的，所以「谁能提供 JwtService」
 * 必须由本模块自己保证。它与 UserModule 之间无环（UserModule 不 import 本模块）。
 */
@Module({
    imports: [TypeOrmModule.forFeature([Member]), UserModule],
    controllers: [MemberController],
    providers: [MemberService, MemberRepository],
    exports: [MemberService, MemberRepository],
})
export class MemberModule {}
