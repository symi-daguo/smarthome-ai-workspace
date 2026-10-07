export const PERMISSIONS = [
  'platform:tenant:manage',
  'platform:billing:manage',
  'platform:audit:view',
  'tenant:member:manage',
  'tenant:role:assign',
  'tenant:billing:view',
  'tenant:token:grant',
  'content:generate',
  'content:extract',
  'knowledge:manage',
  'knowledge:read',
  'order:manage',
  'quote:manage',
  'publish:manage',
  'cs:manage',
] as const;

export type PermissionAction = (typeof PERMISSIONS)[number];
