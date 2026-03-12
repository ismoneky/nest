import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as crypto from 'crypto';

// Polyfill global.crypto for Node.js < 19
if (!global.crypto) {
  (global as any).crypto = crypto;
}

import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { HttpExceptionFilter } from './filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 启用全局异常过滤器,防止未捕获异常导致服务器崩溃
  app.useGlobalFilters(new HttpExceptionFilter());

  // 启用全局验证管道,防止无效数据导致内存问题
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true, // 自动转换类型
      whitelist: true, // 剥离未定义的属性
      forbidNonWhitelisted: false, // 不抛出错误,只是忽略
      transformOptions: {
        enableImplicitConversion: true, // 启用隐式类型转换
      },
    }),
  );

  // 启用 CORS
  app.enableCors({
    origin: 'http://localhost:5173', // 替换为前端项目的实际地址
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization',
  });

  const config = new ConfigService();
  await app.listen(await config.getPortConfig());
}
bootstrap();
