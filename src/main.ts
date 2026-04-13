import * as dotenv from 'dotenv';
dotenv.config();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as crypto from 'crypto';

// Polyfill global.crypto for Node.js < 19
if (!global.crypto) {
  (global as any).crypto = crypto;
}

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // 保留原始请求体，用于微信支付回调验签
    rawBody: true,
  });

  // 启用全局异常过滤器,防止未捕获异常导致服务器崩溃
  app.useGlobalFilters(new HttpExceptionFilter());

  // 启用全局验证管道,防止无效数据导致内存问题
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // 启用 CORS
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  app.enableCors({
    origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map(o => o.trim()),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization, x-admin-key',
    credentials: corsOrigin !== '*',
  });

  const port = process.env.PORT || '3000';
  await app.listen(port, '0.0.0.0');

}
bootstrap();
