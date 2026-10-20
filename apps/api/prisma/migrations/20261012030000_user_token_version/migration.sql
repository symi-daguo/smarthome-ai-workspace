-- 改密后强制旧 JWT 失效：User 增加令牌版本号，JWT payload 携带 tv 并每请求比对
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
