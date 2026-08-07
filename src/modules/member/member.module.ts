import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Member } from '../../entities/member.entity';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { MemberRepository } from '../../repositories/member.repository';

@Module({
    imports: [TypeOrmModule.forFeature([Member])],
    controllers: [MemberController],
    providers: [MemberService, MemberRepository],
    exports: [MemberService, MemberRepository],
})
export class MemberModule {}
