import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { MediaModule } from '../media/media.module.js';
import { BackupController } from './backup.controller.js';

@Module({
  imports: [ConfigModule, AuthModule, RbacModule, MediaModule],
  controllers: [BackupController],
})
export class AdminModule {}
