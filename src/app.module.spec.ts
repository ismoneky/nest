/**
 * 依赖注入装配冒烟测试。
 *
 * ⚠️ 必须在 `import` 之前设置环境变量：
 * `TypeOrmModule.forRoot({ database: process.env.DATABASE_PATH || ... })` 是在
 * **模块文件被加载时**求值的，等到 `beforeAll` 里再设已经晚了，会去打开真实的
 * `data/app.db`。TS 会按源码顺序发出 `require`，所以写在 import 之前的语句先生效。
 * （这是本文件唯一允许「语句排在 import 之前」的地方，别照抄到别处。）
 */
process.env.DATABASE_PATH = ':memory:';
process.env.LOG_DATABASE_PATH = ':memory:';

import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { MessageService } from './modules/message/message.service';

/**
 * 为什么需要这个测试
 *
 * Nest 的**守卫/拦截器是在宿主模块的注入上下文里实例化的**。所以一个
 * `@UseGuards(SomeGuard)` 只要那个 Guard 有构造依赖，宿主模块就必须自己能解析它。
 * 这类错误：
 *   · `tsc --noEmit` 看不见（类型没问题）；
 *   · 单元测试看不见（每个 spec 自己搭 testing module，不走真实模块图）；
 *   · 只有**把应用真正启动一次**才会暴露，表现为
 *     `Nest can't resolve dependencies of the XxxService (..., ?)`。
 *
 * 阶段 3 就踩了这个坑：给共享的 `AdminAuthGuard` 加了 `JwtService` 注入，
 * 却只改了 `AdminModule`，于是 `AdminModule`（AdminService 注入 LoggingService
 * 但没 import LoggingModule）与 `MemberModule` 双双起不来，
 * 而当时 stage 3 的验收只跑了 tsc + jest，全部通过。
 *
 * 本测试把「应用能不能装配起来」变成一条会失败的断言，代价是一次内存库装配。
 * 它不测业务行为——业务行为各有专门的 spec。
 */
describe('AppModule 依赖装配', () => {
    it('整个模块图能装配起来（守卫的依赖都能在宿主模块内解析）', async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

        // 装配成功本身即是断言；再显式取一个本阶段新增的 provider，
        // 确保失败时输出的是「哪个服务没装配上」而不是一句笼统的 compile 失败
        expect(moduleRef.get(MessageService)).toBeDefined();

        await moduleRef.close();
    }, 30000);
});
