import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getCommunityAnnouncement } from '../services/announcement';

// 官网下载页（公开，无 auth）：GET / 与 GET /download 返回下载页 HTML；
// GET /app/version.json 返回当前最新安装包元数据；GET /app/lh-latest.apk
// 直接流式下载 R2 中的最新 APK。页面版本信息全部由 version.json 实装，
// 发新版只需更新 R2 对象（scripts/upload_app_release.mjs）。
export const webRoutes = new Hono<AppEnv>();

const APK_KEY = 'app/lh-latest-arm64.apk';
const VERSION_KEY = 'app/version.json';

const DOWNLOAD_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>链汇 - 官方下载</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    min-height: 100vh;
    background: linear-gradient(180deg, #0A2AA8 0%, #2B66E3 46%, #F0F5FD 46%, #F0F5FD 100%);
    display: flex; flex-direction: column; align-items: center;
  }
  .hero { width: 100%; max-width: 520px; padding: 72px 24px 40px; text-align: center; color: #fff; }
  .star { width: 88px; height: 88px; margin: 0 auto 18px; filter: drop-shadow(0 6px 20px rgba(255,255,255,.35)); }
  h1 { font-size: 30px; font-weight: 800; letter-spacing: 2px; }
  .slogan { margin-top: 12px; font-size: 14px; color: rgba(255,255,255,.82); line-height: 1.7; }
  .card {
    width: calc(100% - 40px); max-width: 420px; background: #fff; border-radius: 20px;
    padding: 28px 24px 24px; box-shadow: 0 12px 40px rgba(10,42,168,.14);
  }
  .dl-btn {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; height: 54px; border-radius: 999px; text-decoration: none;
    background: linear-gradient(90deg, #3D8BFF, #6A5CFF); color: #fff;
    font-size: 17px; font-weight: 700;
    box-shadow: 0 8px 20px rgba(61,139,255,.35);
  }
  .dl-btn:active { transform: scale(.98); }
  .meta { margin-top: 14px; text-align: center; font-size: 12px; color: #98A1AD; line-height: 1.9; }
  .note { margin-top: 18px; text-align: center; font-size: 12px; color: #B6BDC8; line-height: 1.8; }
  .features { margin-top: 22px; display: flex; justify-content: space-around; }
  .feat { text-align: center; font-size: 12px; color: #626B78; }
  .feat .ic { font-size: 22px; display: block; margin-bottom: 4px; }
  .footer { margin: auto 0 20px; padding-top: 28px; font-size: 11px; color: #B6BDC8; }
</style>
</head>
<body>
  <div class="hero">
    <svg class="star" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFFFFF"/>
          <stop offset="1" stop-color="#9DBBFF"/>
        </linearGradient>
      </defs>
      <path fill="url(#g)" d="M50 4 L61 39 L96 39 L67 60 L78 95 L50 73 L22 95 L33 60 L4 39 L39 39 Z"/>
    </svg>
    <h1>链汇</h1>
    <p class="slogan">安全加密聊天 · 链上钱包 · 红包转账<br>一个 App 全部搞定</p>
  </div>
  <div class="card">
    <a class="dl-btn" href="/app/lh-latest.apk" download>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      下载 Android 版
    </a>
    <div class="meta" id="meta">正在获取最新版本信息…</div>
    <div class="features">
      <div class="feat"><span class="ic">☁️</span>云端同步</div>
      <div class="feat"><span class="ic">💬</span>安全聊天</div>
      <div class="feat"><span class="ic">🧧</span>链上红包</div>
      <div class="feat"><span class="ic">👛</span>多链钱包</div>
    </div>
    <p class="note">下载后如提示「未知来源」，请在系统设置中允许安装。<br>iOS 版正在筹备中，敬请期待。</p>
  </div>
  <div class="footer">© 链汇 LianHui</div>
<script>
  fetch('/app/version.json').then(function (r) { return r.json(); }).then(function (v) {
    var sizeMB = v.size ? (v.size / 1048576).toFixed(1) + ' MB' : '';
    var date = v.updatedAt ? v.updatedAt.slice(0, 10) : '';
    document.getElementById('meta').textContent =
      'v' + v.version + (v.build ? ' (' + v.build + ')' : '') +
      (sizeMB ? ' · ' + sizeMB : '') + (date ? ' · 更新于 ' + date : '');
  }).catch(function () {
    document.getElementById('meta').textContent = 'Android 最新版';
  });
</script>
</body>
</html>`;

webRoutes.get('/', (c) => c.html(DOWNLOAD_PAGE));
webRoutes.get('/download', (c) => c.html(DOWNLOAD_PAGE));

// 社区公告（公开读，0024）：社区页轮播图下方滚动横条的数据源；
// 客户端按 enabled 与 start_at/end_at 时间窗决定显隐。
webRoutes.get('/community/announcement', async (c) => {
  const announcement = await getCommunityAnnouncement(c.env.DB);
  return c.json(announcement, 200, {
    'Cache-Control': 'public, max-age=60',
  });
});

// ── 邀请落地页（公开，无 auth）──────────────────────────────────────────
// 邀请链接对外统一为 https://api.chatnice.top/g/<token|slug>（群）与
// https://api.chatnice.top/u/<address>（加好友）。落地页立即尝试拉起
// chaintalk:// scheme（已装 App 则系统接管直达入群/加好友流程），1.6s
// 后仍在页面则判定未安装，展示下载引导（复用下载页视觉与 R2 APK 分发）。

const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function inviteLandingPage(opts: {
  title: string;
  subtitle: string;
  schemeUrl: string;
}): string {
  // schemeUrl 由经过严格白名单校验的 token/address 拼接，无注入面；
  // 进 JS 字符串仍再经 encodeURI 双保险。
  const safeScheme = encodeURI(opts.schemeUrl);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${opts.title} - 链汇</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    min-height: 100vh;
    background: linear-gradient(180deg, #0A2AA8 0%, #2B66E3 46%, #F0F5FD 46%, #F0F5FD 100%);
    display: flex; flex-direction: column; align-items: center;
  }
  .hero { width: 100%; max-width: 520px; padding: 64px 24px 32px; text-align: center; color: #fff; }
  .star { width: 76px; height: 76px; margin: 0 auto 16px; filter: drop-shadow(0 6px 20px rgba(255,255,255,.35)); }
  h1 { font-size: 24px; font-weight: 800; }
  .subtitle { margin-top: 10px; font-size: 14px; color: rgba(255,255,255,.85); line-height: 1.7; }
  .card {
    width: calc(100% - 40px); max-width: 420px; background: #fff; border-radius: 20px;
    padding: 26px 24px 24px; box-shadow: 0 12px 40px rgba(10,42,168,.14); text-align: center;
  }
  .open-btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; height: 52px; border-radius: 999px; text-decoration: none;
    background: linear-gradient(90deg, #3D8BFF, #6A5CFF); color: #fff;
    font-size: 16px; font-weight: 700; box-shadow: 0 8px 20px rgba(61,139,255,.35);
  }
  .open-btn:active { transform: scale(.98); }
  .divider { margin: 18px 0 12px; font-size: 12px; color: #B6BDC8; }
  .dl-btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; height: 48px; border-radius: 999px; text-decoration: none;
    border: 1.5px solid #3D8BFF; color: #3D8BFF; font-size: 15px; font-weight: 600;
  }
  .meta { margin-top: 14px; font-size: 12px; color: #98A1AD; line-height: 1.9; }
  #download-area { display: none; }
  .footer { margin: auto 0 20px; padding-top: 24px; font-size: 11px; color: #B6BDC8; }
</style>
</head>
<body>
  <div class="hero">
    <svg class="star" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFFFFF"/>
          <stop offset="1" stop-color="#9DBBFF"/>
        </linearGradient>
      </defs>
      <path fill="url(#g)" d="M50 4 L61 39 L96 39 L67 60 L78 95 L50 73 L22 95 L33 60 L4 39 L39 39 Z"/>
    </svg>
    <h1>${opts.title}</h1>
    <p class="subtitle">${opts.subtitle}</p>
  </div>
  <div class="card">
    <a class="open-btn" id="open-btn" href="${safeScheme}">已安装链汇？点此打开</a>
    <div id="download-area">
      <div class="divider">还没有安装链汇？下载后重进本页即可继续</div>
      <a class="dl-btn" href="/app/lh-latest.apk" download>下载 Android 版</a>
      <div class="meta" id="meta">正在获取最新版本信息…</div>
    </div>
  </div>
  <div class="footer">© 链汇 LianHui</div>
<script>
  var scheme = ${JSON.stringify(safeScheme)};
  // 立即尝试拉起 App：已安装则系统接管离开本页。
  window.location.href = scheme;
  // 1.6s 后仍在页面 = 未安装（或被系统拦截），展示下载引导。
  setTimeout(function () {
    document.getElementById('download-area').style.display = 'block';
  }, 1600);
  document.getElementById('open-btn').addEventListener('click', function (e) {
    e.preventDefault();
    window.location.href = scheme;
  });
  fetch('/app/version.json').then(function (r) { return r.json(); }).then(function (v) {
    var sizeMB = v.size ? (v.size / 1048576).toFixed(1) + ' MB' : '';
    document.getElementById('meta').textContent =
      'v' + v.version + (v.build ? ' (' + v.build + ')' : '') +
      (sizeMB ? ' · ' + sizeMB : '');
  }).catch(function () {
    document.getElementById('meta').textContent = 'Android 最新版';
  });
</script>
</body>
</html>`;
}

// 群邀请落地页：token（32 位 hex）或自定义 slug（小写字母/数字/_/-）。
webRoutes.get('/g/:token', (c) => {
  const token = c.req.param('token');
  if (!INVITE_TOKEN_PATTERN.test(token)) {
    return c.json({ error: 'INVALID_INVITE_TOKEN' }, 400);
  }
  return c.html(
    inviteLandingPage({
      title: '邀请你加入群聊',
      subtitle: '你的好友邀请你加入链汇群聊<br>打开 App 即可一键进群',
      schemeUrl: `chaintalk://group-invite/${token}`,
    }),
  );
});

// 加好友落地页：EVM 地址（0x+40hex）。
webRoutes.get('/u/:address', (c) => {
  const address = c.req.param('address');
  if (!EVM_ADDRESS_PATTERN.test(address)) {
    return c.json({ error: 'INVALID_ADDRESS' }, 400);
  }
  return c.html(
    inviteLandingPage({
      title: '邀请你添加好友',
      subtitle: '你的好友邀请你加入链汇<br>打开 App 即可添加 TA 为联系人',
      schemeUrl: `chaintalk://add-friend/${address.toLowerCase()}`,
    }),
  );
});

// 最新安装包元数据（R2 实装，发新版时随 APK 一起更新）。
webRoutes.get('/app/version.json', async (c) => {
  const obj = await c.env.VOICE_BUCKET.get(VERSION_KEY);
  if (!obj) return c.json({ error: 'NOT_FOUND' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
});

// 直接下载最新 APK（流式转发 R2 对象，随下随传不占 Worker 内存）。
// 必须支持 Range/206：手机浏览器与下载管理器普遍分段下载，忽略 Range
// 返回 200 全量会把文件写坏（安装时报「解析软件包时出现问题」）。
webRoutes.get('/app/lh-latest.apk', async (c) => {
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': 'attachment; filename="lh-latest-arm64.apk"',
    'Cache-Control': 'public, max-age=300',
    'Accept-Ranges': 'bytes',
  };

  const rangeHeader = c.req.header('Range');
  const range = rangeHeader
    ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    : null;
  if (range && (range[1] !== '' || range[2] !== '')) {
    const head = await c.env.VOICE_BUCKET.head(APK_KEY);
    if (!head) return c.json({ error: 'NOT_FOUND' }, 404);
    const total = head.size;
    let start: number;
    let end: number;
    if (range[1] === '') {
      // bytes=-N：最后 N 字节。
      const suffix = Math.min(Number(range[2]), total);
      start = total - suffix;
      end = total - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1);
    }
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      start >= total
    ) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` },
      });
    }
    const obj = await c.env.VOICE_BUCKET.get(APK_KEY, {
      range: { offset: start, length: end - start + 1 },
    });
    if (!obj) return c.json({ error: 'NOT_FOUND' }, 404);
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${total}`,
      },
    });
  }

  const obj = await c.env.VOICE_BUCKET.get(APK_KEY);
  if (!obj) return c.json({ error: 'NOT_FOUND' }, 404);
  return new Response(obj.body, {
    headers: {
      ...baseHeaders,
      ...(obj.size ? { 'Content-Length': String(obj.size) } : {}),
    },
  });
});
