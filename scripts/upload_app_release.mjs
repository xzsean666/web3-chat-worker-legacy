#!/usr/bin/env node
// 上传最新安装包到 R2 并更新 version.json（官网下载页数据源）。
// 用法：node scripts/upload_app_release.mjs <apk路径> <版本号> <构建号>
//   例：node scripts/upload_app_release.mjs ../../release/lh-v1.1.5-15-arm64.apk 1.1.5 15
import { execFileSync } from 'node:child_process';
import { statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const [apkPath, version, build] = process.argv.slice(2);
if (!apkPath || !version) {
  console.error('用法: node scripts/upload_app_release.mjs <apk路径> <版本号> [构建号]');
  process.exit(1);
}

const size = statSync(apkPath).size;
const bucket = 'web3-chat-voice';
const apkKey = 'app/lh-latest-arm64.apk';

function r2put(key, file, contentType) {
  // Windows 上 npx 是 npx.cmd，execFile 不带 shell 无法解析 .cmd，
  // 统一走 shell 字符串形式（路径含空格也能正常工作）。
  const cmd = [
    'npx wrangler r2 object put',
    `"${bucket}/${key}"`,
    '--file', `"${file}"`,
    '--content-type', `"${contentType}"`,
    '--remote',
  ].join(' ');
  execFileSync(cmd, { stdio: 'inherit', shell: true });
}

console.log(`上传 ${basename(apkPath)} (${(size / 1048576).toFixed(1)} MB) → r2:${apkKey}`);
r2put(apkKey, apkPath, 'application/vnd.android.package-archive');

const versionJson = JSON.stringify(
  {
    version,
    build: build ?? null,
    file: basename(apkPath),
    size,
    updatedAt: new Date().toISOString(),
  },
  null,
  2
);
const dir = mkdtempSync(join(tmpdir(), 'lh-ver-'));
const versionFile = join(dir, 'version.json');
writeFileSync(versionFile, versionJson);
console.log(`更新 r2:app/version.json → ${versionJson.replace(/\n/g, ' ')}`);
r2put('app/version.json', versionFile, 'application/json');

console.log('完成。验证：https://api.chatnice.top/app/version.json');
