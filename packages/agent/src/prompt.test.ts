import { expect, it } from 'vitest';
import { BASE_SYSTEM_PROMPT } from './prompt.js';

it('directs the agent to research public facts and cite evidence for writes', () => {
  expect(BASE_SYSTEM_PROMPT).toMatch(/web search for current facts/);
  expect(BASE_SYSTEM_PROMPT).toMatch(/private workspace data .* out of web searches/);
  expect(BASE_SYSTEM_PROMPT).toMatch(/Verify outside facts before writing/);
  expect(BASE_SYSTEM_PROMPT).toMatch(/event ID as source to upsert_record/);
  expect(BASE_SYSTEM_PROMPT).toMatch(/supporting links for each write in your reply/);
  expect(BASE_SYSTEM_PROMPT).toMatch(/own knowledge and ask before saving/);
  expect(BASE_SYSTEM_PROMPT).toMatch(/allowed values, adjust your input and retry/);
});
