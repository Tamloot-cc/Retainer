import { convert } from 'html-to-text';
import { addressParser, decodeWords } from 'postal-mime';
import { z } from 'zod';

const excludedLabels = new Set(['DRAFT', 'SPAM', 'TRASH']);
const email = z.email().max(320);
type Header = { name: string; value: string };
export type GmailEnvelope = { from: string[]; to: string[] };

const header = (headers: readonly Header[], name: string) =>
  headers.find((entry) => entry.name.toLowerCase() === name)?.value;

export function gmailEnvelope(headers: Header[]): GmailEnvelope {
  function addresses(name: string) {
    const values = headers.filter((entry) => entry.name.toLowerCase() === name);
    if (values.length !== 1 || !values[0] || values[0].value.length > 32_000) return [];
    const parsed = addressParser(values[0].value, { flatten: true });
    const all = parsed.flatMap((entry) => {
      if (!('address' in entry) || !entry.address) return [];
      const value = entry.address.trim().toLowerCase();
      return email.safeParse(value).success ? [value] : [];
    });
    return [...new Set(all)].sort().slice(0, 200);
  }
  return { from: addresses('from'), to: addresses('to') };
}

export const excludedGmailMessage = (labels: string[]) =>
  labels.some((label) => excludedLabels.has(label));

type MessagePart = {
  mimeType: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; attachmentId?: string };
  parts?: MessagePart[];
};

export const gmailMessagePart: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    mimeType: z.string(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
    parts: z.array(gmailMessagePart).optional(),
  }),
);

const quoteSeparators =
  /^(?:On .+ wrote:|-{2,}\s*(?:Forwarded message|Original Message)\s*-{2,}|_{8,})$/i;

function plainText(text: string) {
  const lines = text.split(/\r?\n/);
  const quoted = lines.findIndex((line) => quoteSeparators.test(line.trim()));
  const authored = quoted === -1 ? lines : lines.slice(0, quoted);
  return authored
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
}

function textPart(part: MessagePart, depth: number): string {
  if (part.filename || depth > 12) return '';
  const headers = part.headers ?? [];
  if (header(headers, 'content-disposition')?.trim().toLowerCase().startsWith('attachment'))
    return '';
  const type = part.mimeType.toLowerCase();
  if (type.startsWith('multipart/')) {
    const parts = part.parts ?? [];
    if (type === 'multipart/alternative') {
      for (const preferred of ['text/plain', 'text/html']) {
        const matched = parts.find((candidate) => candidate.mimeType.toLowerCase() === preferred);
        const content = matched && textPart(matched, depth + 1);
        if (content) return content;
      }
    }
    if (type === 'multipart/related') return parts[0] ? textPart(parts[0], depth + 1) : '';
    return parts
      .map((candidate) => textPart(candidate, depth + 1))
      .filter(Boolean)
      .join('\n\n');
  }
  if (!part.body?.data || part.body.attachmentId || !['text/plain', 'text/html'].includes(type))
    return '';
  const bytes = Buffer.from(part.body.data, 'base64url');
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(
    header(headers, 'content-type') ?? '',
  )?.[1];
  let content: string;
  try {
    content = new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return '';
  }
  if (type === 'text/plain') return plainText(content);
  return plainText(
    convert(content, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        ...['img', 'script', 'style', 'blockquote', '.gmail_quote', '.yahoo_quoted'].map(
          (selector) => ({ selector, format: 'skip' }),
        ),
      ],
    }),
  );
}

export function gmailMessageText(part: MessagePart) {
  return textPart(part, 0).replaceAll('\0', '').trim();
}

export function gmailMessageDetails(headers: Header[]) {
  const subject = decodeWords(header(headers, 'subject') ?? '')
    .replaceAll('\0', '')
    .slice(0, 500);
  const date = Date.parse(header(headers, 'date') ?? '');
  const rfcMessageId = header(headers, 'message-id')?.trim();
  return {
    subject,
    ...(Number.isFinite(date) ? { originalDate: new Date(date).toISOString() } : {}),
    ...(rfcMessageId && rfcMessageId.length <= 500 ? { rfcMessageId } : {}),
  };
}
