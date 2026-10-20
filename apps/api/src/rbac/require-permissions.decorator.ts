import { SetMetadata } from '@nestjs/common';
import type { PermissionAction } from './permissions.js';

export const REQUIRED_PERMISSIONS_KEY = 'required-permissions';

export const RequirePermissions = (...actions: PermissionAction[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, actions);
