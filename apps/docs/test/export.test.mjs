import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { staticClient } from 'fumadocs-core/search/client/orama-static';

test('the static export uses the docs origin for social images and Markdown', async () => {
  const origin = process.env.RETAINER_DOCS_ORIGIN ?? 'http://localhost:3000';
  for (const slug of ['hosted', 'api/workspace/get-caller']) {
    const html = await readFile(`out/docs/${slug}/index.html`, 'utf8');
    const image = `/og/docs/${slug}/image.png`;
    assert.ok(html.includes(`property="og:image" content="${new URL(image, origin)}"`), slug);
    const markdown = new URL(`/llms.mdx/docs/${slug}.md`, origin);
    assert.ok(html.includes(`type="text/markdown" href="${markdown}"`), slug);
    const png = await readFile(`out${image}`);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  }
});

test('the exported index finds onboarding and exact endpoints and supports section filters', async () => {
  const data = await readFile('out/search-index.json');
  const from = `data:application/json;base64,${data.toString('base64')}`;
  const all = staticClient({ from });
  assert.equal((await all.search('self host'))[0]?.url, '/docs/self-hosted');
  assert.equal((await all.search('GET /v1/me'))[0]?.url, '/docs/api/workspace/get-caller');

  const mcp = staticClient({ from, tag: 'mcp' });
  const hits = await mcp.search('describe_schema');
  assert.equal(hits[0]?.url, '/docs/mcp/tool-reference');
  assert.ok(hits.every(({ url }) => url === '/docs/mcp' || url.startsWith('/docs/mcp/')));
});
