import type { ServerResponse } from 'node:http';

const outcomes = {
  connected: {
    title: 'Retainer CLI is connected',
    message: 'Return to your terminal to continue. You can close this tab.',
    icon: '✓',
  },
  denied: {
    title: 'Connection denied',
    message:
      'You can close this tab. To try again, run <code>retainer login</code> in your terminal.',
    icon: '−',
  },
  failed: {
    title: 'Could not connect Retainer CLI',
    message: 'Return to your terminal and run <code>retainer login</code> to try again.',
    icon: '!',
  },
};

/** The loopback server responds and exits, so the page carries its own styles. */
export function sendLoginPage(response: ServerResponse, outcome: keyof typeof outcomes) {
  const { title, message, icon } = outcomes[outcome];
  response
    .writeHead(outcome === 'failed' ? 400 : 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    .end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="text-scale" content="scale">
  <title>${title} · Retainer</title>
  <style>
    :root {
      color-scheme: light;
      font-family: system-ui, sans-serif;
      --frame: #f7f7f8;
      --card: #fff;
      --text: #18181b;
      --muted: #52525b;
      --border: #e4e4e7;
      --surface: #f4f4f5;
      --accent: #1f5e3a;
      --accent-bg: #e8f2e9;
      --error: #b42335;
      --error-bg: #fcece5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --frame: #141415;
        --card: #1b1b1d;
        --text: #f4f4f5;
        --muted: #a1a1aa;
        --border: #343438;
        --surface: #242427;
        --accent: #d4fa38;
        --accent-bg: #353c21;
        --error: #ff8997;
        --error-bg: #44262c;
      }
    }
    * { box-sizing: border-box; }
    body {
      display: grid;
      place-items: center;
      min-height: 100vh;
      min-height: 100dvh;
      margin: 0;
      padding: 1rem;
      background: var(--frame);
      color: var(--text);
    }
    main {
      width: min(100%, 30rem);
      overflow: hidden;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 1rem;
      box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
    }
    header {
      display: flex;
      align-items: center;
      gap: .625rem;
      padding: .75rem clamp(1.25rem, 4vw, 2rem);
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      font-size: .875rem;
      font-weight: 600;
    }
    .prompt {
      display: grid;
      place-items: center;
      width: 1.75rem;
      height: 1.75rem;
      border-radius: .375rem;
      background: #111b21;
      color: #d4fa38;
      font: 600 1rem ui-monospace, monospace;
    }
    .outcome { padding: clamp(1.25rem, 4vw, 2rem); }
    .icon {
      display: grid;
      place-items: center;
      width: 3rem;
      height: 3rem;
      margin-bottom: 1rem;
      border-radius: .75rem;
      background: var(--surface);
      color: var(--muted);
      font-size: 1.5rem;
      font-weight: 600;
    }
    .connected .icon { background: var(--accent-bg); color: var(--accent); }
    .failed .icon { background: var(--error-bg); color: var(--error); }
    h1 {
      margin: 0;
      font-size: clamp(1.5rem, 1.25rem + 1vw, 1.875rem);
      line-height: 1.15;
      letter-spacing: -.035em;
    }
    p { margin: .625rem 0 0; color: var(--muted); line-height: 1.55; }
    code {
      padding: .1em .25em;
      border-radius: .25rem;
      background: var(--surface);
      color: var(--text);
      font-size: .9em;
    }
  </style>
</head>
<body>
  <main class="${outcome}">
    <header><span class="prompt" aria-hidden="true">›_</span>Retainer CLI</header>
    <div class="outcome">
      <span class="icon" aria-hidden="true">${icon}</span>
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
  </main>
</body>
</html>`);
}
