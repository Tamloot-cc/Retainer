import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';
import {
  MAINTENANCE_RETRY_SECONDS,
  maintenanceBody,
  maintenanceHeaders,
} from '../http/maintenance.js';
import { requireEdge } from './edge.js';

/** Seconds a client waits between retries. An update lasts longer than this. */
const RETRY_SECONDS = MAINTENANCE_RETRY_SECONDS;

// Keep the mark's drawing in step with packages/web/src/ui/logo-mark.tsx.
const RING =
  'M 528 128.67731389 A 300 300 0 1 0 665.32998323 260 L 549.74979132 260 A 205 205 0 1 1 528 239.87192626 Z';

// Self-contained: the responder has no static files, so styles, mark and
// script are inline. The script checks quietly and reloads once the app
// answers, so the page doesn't flash every few seconds; without scripts the
// meta refresh does the same job.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<noscript><meta http-equiv="refresh" content="${RETRY_SECONDS}"></noscript>
<title>Retainer is updating</title>
<style>
:root{--bg:#fcfcfd;--fg:#18181b;--muted:#52525b;--ring:#1f5e3a;--dot:#1f5e3a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#18191e;--fg:#f4f4f5;--muted:#a1a1aa;--ring:#d4fa38;--dot:#d4fa38;color-scheme:dark}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:22rem;text-align:center}
svg{width:56px;height:56px;margin-bottom:28px}
.turn{transform-box:view-box;transform-origin:400px 400px;animation:turn 2.4s cubic-bezier(.6,0,.4,1) infinite}
@keyframes turn{to{transform:rotate(360deg)}}
h1{margin:0 0 8px;font-size:20px;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
.status{display:inline-flex;align-items:center;gap:8px;margin-top:28px;font-size:13px}
.status i{width:6px;height:6px;border-radius:50%;background:var(--dot);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.turn,.status i{animation:none}}
</style>
</head>
<body>
<main>
<svg viewBox="32 32 736 736" fill="none" role="img" aria-label="Retainer"><g class="turn"><path d="${RING}" fill="var(--ring)"/><rect x="565" y="129" width="96" height="96" fill="#FF603F"/></g></svg>
<h1>Retainer is updating</h1>
<p>This usually takes a few minutes. Nothing you saved is lost.</p>
<p class="status" role="status"><i aria-hidden="true"></i>This page reopens Retainer when it's ready.</p>
</main>
<script>
(function check(){setTimeout(function(){fetch(location.href,{cache:'no-store',credentials:'same-origin'}).then(function(r){if(r.status<500)location.reload();else check()},check)},${RETRY_SECONDS * 1000})})();
</script>
</body>
</html>`;

/** No database, auth service or application boot: usable throughout migrations. */
export const createMaintenanceHandler = (secret?: string) =>
  requireEdge(secret, async (event: LambdaEvent) => {
    const headers = event.headers ?? {};
    const navigation =
      headers['sec-fetch-mode'] === 'navigate' ||
      (headers.accept?.includes('text/html') && !headers.accept.includes('application/json'));
    return {
      statusCode: 503,
      headers: {
        'content-type': navigation ? 'text/html; charset=utf-8' : 'application/json',
        // This means the application was never invoked, so even a write
        // without an idempotency key can safely retry this exact response.
        ...maintenanceHeaders(true),
      },
      body: navigation ? PAGE : JSON.stringify(maintenanceBody),
      isBase64Encoded: false,
    };
  });

export const handler = (event: LambdaEvent, context: LambdaContext) =>
  createMaintenanceHandler(process.env.RETAINER_EDGE_SECRET)(event, context);
