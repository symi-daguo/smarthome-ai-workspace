import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { CanvasController } from './canvas.controller.js';
import { CanvasService } from './canvas.service.js';

@Module({
  imports: [AuthModule, MediaModule, RbacModule],
  controllers: [CanvasController],
  providers: [CanvasService],
})
export class CanvasModule {}
