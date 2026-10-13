import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module.js';
import { AdminModule } from './admin/admin.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { BillingModule } from './billing/billing.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { ContentModule } from './content/content.module.js';
import { LlmModule } from './llm/llm.module.js';
import { MediaModule } from './media/media.module.js';
import { PlansModule } from './plans/plans.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { LayoutModule } from './layout/layout.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { LightingModule } from './lighting/lighting.module.js';
import { CanvasModule } from './canvas/canvas.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    // 限流 env 可配（自部署单机默认放宽；云服务器按需收紧）
    ThrottlerModule.forRoot([
      {
        limit: Number(process.env.RATE_LIMIT_GLOBAL ?? 300),
        ttl: 60_000,
      },
    ]),
    PrismaModule,
    AdminModule,
    HealthModule,
    AuthModule,
    RbacModule,
    BillingModule,
    TenantsModule,
    ContentModule,
    LlmModule,
    MediaModule,
    PlansModule,
    OrdersModule,
    KnowledgeModule,
    LayoutModule,
    AgentsModule,
    FeedbackModule,
    LightingModule,
    CanvasModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
