#!/usr/bin/env node
/**
 * 假 docker：把脚本要执行的 docker 命令原样记进日志，然后立刻返回成功。
 *
 * 给 apps/api/test/backup-scripts.mjs 用 —— 让 backup-full.sh / restore-full.sh
 * 在**不碰真容器、不碰真数据**的前提下跑完整条控制流。
 *
 * 它要答的问题只有一个：脚本按什么顺序、调用了什么 docker 命令。
 * 所以每条调用都记成一行 JSON 数组（argv），便于断言。
 *
 * 环境变量：
 *   FAKE_DOCKER_LOG       记日志的文件路径（必填）
 *   FAKE_UPLOAD_SOURCE    docker inspect 返回的 uploads 卷宿主路径（默认 /tmp/fake-uploads）
 *   FAKE_UPLOAD_VOLUME    docker inspect 返回的 uploads 卷名（默认 fake_api-uploads）
 */
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG ?? '/tmp/fake-docker.log';
appendFileSync(log, `${JSON.stringify(args)}\n`);

const SOURCE = process.env.FAKE_UPLOAD_SOURCE ?? '/tmp/fake-uploads';
const VOLUME = process.env.FAKE_UPLOAD_VOLUME ?? 'fake_api-uploads';
const IMAGE = process.env.FAKE_API_IMAGE ?? 'aisaas-api';

/** 把 stdin 读完：真 docker 的 -i 会消费管道，不消费的话上游会收到 SIGPIPE */
function drainStdin() {
  try {
    readFileSync(0);
  } catch {
    // 没有 stdin（< /dev/null 或非交互）——忽略
  }
}

if (args[0] === 'compose' && args[1] === 'ps') {
  const quiet = args.some((a) => a.startsWith('-') && a.includes('q'));
  const services = args.slice(2).filter((a) => !a.startsWith('-'));
  if (quiet) {
    // 假 docker 里 api 与 db 一律「在运行」：脚本据此判断能不能归档卷
    if (services.length === 0 || services.includes('api')) console.log('fakeapi');
    if (services.length === 0 || services.includes('db')) console.log('fakedb');
  }
  process.exit(0);
}

if (args[0] === 'inspect') {
  const i = args.indexOf('--format');
  const fmt = i >= 0 ? (args[i + 1] ?? '') : '';
  if (fmt.includes('Config.Image')) console.log(IMAGE);
  else if (fmt.includes('State.Running')) console.log('true');
  else if (fmt.includes('.Source')) console.log(SOURCE);
  else if (fmt.includes('.Name')) console.log(VOLUME);
  process.exit(0);
}

if (args[0] === 'exec' || args[0] === 'run') {
  if (args.includes('-i')) drainStdin();
  process.exit(0);
}

process.exit(0);
