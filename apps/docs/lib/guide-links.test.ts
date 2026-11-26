import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repository, resolveGuideLink } from './guide-links.ts';
import { guideUrl } from './guides.ts';

test('relative links use the published route and preserve the heading', () => {
  for (const href of ['self-hosting.md#accounts-mode', './self-hosting.md#accounts-mode']) {
    const result = resolveGuideLink(href, 'agents.md', (path) => {
      assert.equal(path, 'self-hosting.md');
      return '/docs/self-hosting/';
    });
    assert.equal(result, '/docs/self-hosting/#accounts-mode');
  }
  assert.equal(
    resolveGuideLink('../agents.md#over-stdio', 'mcp/connection-options.md', (path) =>
      path === 'agents.md' ? '/docs/mcp/agents/' : undefined,
    ),
    '/docs/mcp/agents/#over-stdio',
  );
});

test('repository files outside the published guides point to GitHub', () => {
  assert.equal(
    resolveGuideLink('../ARCHITECTURE.md#6-interfaces', 'rest-api.md', () => undefined),
    `${repository}/blob/main/ARCHITECTURE.md#6-interfaces`,
  );
  assert.equal(
    resolveGuideLink('specs/extensions.md', 'standalone-apps.md', () => undefined),
    `${repository}/blob/main/docs/specs/extensions.md`,
  );
});

test('absolute URLs, site paths, and page fragments pass through', () => {
  for (const href of ['', 'mailto:help@example.com', 'https://example.com', '/docs/', '#mcp']) {
    assert.equal(
      resolveGuideLink(href, 'index.mdx', () => assert.fail('Unexpected lookup')),
      href,
    );
  }
});

test('section meta.json files publish root guides inside their section', () => {
  assert.equal(guideUrl('guides/index.mdx'), '/docs/');
  assert.equal(guideUrl('guides/hosted.mdx'), '/docs/hosted/');
  assert.equal(guideUrl('self-hosting.md'), '/docs/self-hosting/');
  assert.equal(guideUrl('mcp/index.mdx'), '/docs/mcp/');
  assert.equal(guideUrl('agents.md'), '/docs/mcp/agents/');
  assert.equal(guideUrl('rest-api.md'), '/docs/api/rest-api/');
  assert.equal(guideUrl('specs/extensions.md'), undefined);
});
