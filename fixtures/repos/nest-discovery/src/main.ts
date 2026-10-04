// Synthetic discovery input only; this file is never compiled or executed.
// biome-ignore lint/correctness/noUnusedImports: verifies zero-count symbols are hidden.
import { Controller, Module, UnusedDecorator } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import cookie from 'cookie-plugin';
import { serve } from 'current-runtime';

@Controller('example')
class ExampleController {}
@Module({ controllers: [ExampleController] })
class ExampleModule {}
const app = await NestFactory.create<NestExpressApplication>(ExampleModule);
app.register(cookie);
new FastifyAdapter();
SwaggerModule.createDocument(app, {});
serve();
