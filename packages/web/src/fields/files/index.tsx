import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { Button, Muted, Notice, Row, Stack } from '../../ui/index.js';
import type { DisplayProps, InputProps } from '../common.js';

export const label = 'Files';
export const icon = Paperclip;
export const isEmpty = (value: unknown) => !Array.isArray(value) || value.length === 0;
const idsOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
function FileLink({ id }: { id: string }) {
  const { session } = useWorkspace();
  const metadata = useQuery({
    queryKey: [session.workspace.id, 'files', id],
    queryFn: ({ signal }) => api.file(id, signal),
    retry: false,
  });
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    setError('');
    try {
      const transfer = await api.downloadFile(id);
      const link = document.createElement('a');
      link.href = transfer.url;
      link.rel = 'noreferrer noopener';
      link.target = '_blank';
      link.download = metadata.data?.name ?? 'download';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'File unavailable');
    } finally {
      setBusy(false);
    }
  }
  if (metadata.error) return <Muted small>File unavailable</Muted>;
  return (
    <span className="inline-flex min-w-0 flex-col">
      <Button
        variant="ghost"
        size="small"
        disabled={busy || !metadata.data}
        onClick={() => void download()}
      >
        <Paperclip size={12} />
        <span className="max-w-64 truncate">{metadata.data?.name ?? 'Loading file…'}</span>
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
export function Display({ value }: DisplayProps) {
  const ids = idsOf(value);
  return ids.length ? (
    <Row>
      {ids.map((id) => (
        <FileLink key={id} id={id} />
      ))}
    </Row>
  ) : (
    <Muted>—</Muted>
  );
}
export function Input({ field, value, onChange, onBusyChange }: InputProps) {
  const ids = idsOf(value),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [names, setNames] = useState<Record<string, string>>({});
  async function upload(file: File) {
    if (ids.length >= 20) {
      setError('A field can hold up to 20 files.');
      return;
    }
    if (file.size < 1 || file.size > 25 * 1024 * 1024) {
      setError('Choose a file between 1 byte and 25 MiB.');
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      const intent = await api.createFileIntent(
        {
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          bytes: file.size,
          sha256,
        },
        crypto.randomUUID(),
      );
      const response = await fetch(intent.upload.url, {
        method: 'PUT',
        headers: intent.upload.headers,
        body: file,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Upload failed. Try again.');
      const ready = await api.finalizeFile(intent.id);
      setNames((previous) => ({ ...previous, [ready.id]: file.name }));
      onChange([...ids, ready.id]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <Stack>
      <Row>
        {ids.map((id) =>
          names[id] ? (
            <Muted key={id}>{names[id]} · Ready to attach</Muted>
          ) : (
            <FileLink key={id} id={id} />
          ),
        )}
      </Row>
      {ids.map((id, index) => (
        <Button
          key={id}
          size="small"
          disabled={busy}
          onClick={() => onChange(ids.filter((other) => other !== id))}
        >
          Remove attachment {index + 1}
        </Button>
      ))}
      <label className="text-sm">
        <span>{busy ? 'Uploading…' : 'Attach a file (up to 25 MiB)'}</span>
        <input
          aria-label={`Upload ${field.label}`}
          type="file"
          className="block w-full text-sm"
          disabled={busy || ids.length >= 20}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) void upload(file);
          }}
        />
      </label>
      {error ? <Notice>{error}</Notice> : null}
    </Stack>
  );
}
export function Filter() {
  return <Muted>Files cannot be filtered.</Muted>;
}
