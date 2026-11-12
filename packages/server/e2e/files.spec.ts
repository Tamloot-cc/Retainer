import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ fileStorage: true });
test('uploads and finalizes a real file before attachment, downloads it and keeps history', async ({
  page,
  retainer: r,
}) => {
  await r.request(
    '/schema/changes',
    {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'attachments', label: 'Attachments', type: 'files' },
        },
      ],
    },
    r.keys.user,
  );
  const record = (
    await r.request('/objects/person/records', { values: { name: 'File owner' } }, r.keys.user)
  ).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${record.id}`);
  await page.getByRole('button', { name: 'Edit Attachments', exact: true }).click();
  await page.getByLabel('Upload Attachments').setInputFiles({
    name: 'meeting.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('fixture transcript'),
  });
  await expect(page.getByText('meeting.txt · Ready to attach')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Attachments', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'meeting.txt', exact: true })).toBeVisible();
  const saved = await r.request(`/records/${record.id}`, undefined, r.keys.user);
  expect(saved.fields.attachments).toHaveLength(1);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'meeting.txt', exact: true }).click();
  const download = await downloading;
  const path = await download.path();
  if (!path) throw new Error('download missing');
  expect(await readFile(path, 'utf8')).toBe('fixture transcript');
  await page.getByRole('button', { name: 'Edit Attachments', exact: true }).click();
  await page.getByRole('button', { name: 'Remove attachment 1' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Attachments', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'meeting.txt', exact: true })).toHaveCount(0);
  expect(
    (await r.request(`/records/${record.id}`, undefined, r.keys.user)).fields.attachments,
  ).toEqual([]);
  const metadata = await r.request(`/files/${saved.fields.attachments[0]}`, undefined, r.keys.user);
  expect(metadata.name).toBe('meeting.txt');
  await page.screenshot({ path: '/tmp/retainer-files-ui.png', fullPage: true });
});
