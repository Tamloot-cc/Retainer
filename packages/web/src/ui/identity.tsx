import { type ReactNode, useState } from 'react';
import { type CategoryColor, categoryColor, objectColor } from './colors.js';
import { cn } from './core.js';
import { objectIcon } from './object-icons.js';

export function ObjectIcon({
  name,
  objectClass = 'entity',
  size = 16,
}: {
  name: string;
  objectClass?: 'entity' | 'event';
  size?: number;
}) {
  const Icon = objectIcon(name, objectClass);
  return (
    <Icon
      size={size}
      aria-hidden
      data-color={objectColor(name)}
      className="category-color shrink-0"
    />
  );
}

export function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => [...word][0]?.toLocaleUpperCase())
      .join('') || '?'
  );
}

/** Person identity follows the record; other records carry their object's identity. */
export function RecordAvatar({
  id,
  name,
  object = 'record',
  objectClass = 'entity',
  large = false,
  imageUrl,
}: {
  id: string;
  name: string;
  object: string;
  objectClass?: 'entity' | 'event';
  large?: boolean;
  imageUrl?: string | undefined;
}) {
  const person = object === 'person' && objectClass !== 'event';
  const Icon = objectIcon(object, objectClass);
  const fallback = person ? (
    <span data-initials={initials(name)} className="record-initials" />
  ) : (
    <Icon size={large ? 22 : 12} />
  );
  return (
    <span
      aria-hidden
      data-color={person ? categoryColor(`record:${id}`) : objectColor(object)}
      className={cn(
        'category-tag relative inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold',
        person ? 'rounded-full' : 'rounded-lg',
        large ? 'size-12 text-base' : 'size-5 text-[9px]',
      )}
    >
      {imageUrl ? (
        <RecordAvatarImage key={imageUrl} url={imageUrl} fallback={fallback} />
      ) : (
        fallback
      )}
    </span>
  );
}

function RecordAvatarImage({ url, fallback }: { url: string; fallback: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  return (
    <>
      {status !== 'loaded' ? fallback : null}
      {status !== 'failed' ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('failed')}
          className={cn(
            'absolute inset-0 size-full object-contain',
            status === 'loading' && 'opacity-0',
          )}
        />
      ) : null}
    </>
  );
}

/** Actor and source identity is separate from review/success/error status. */
export function IdentityTag({
  identity,
  color,
  children,
}: {
  identity: string;
  color?: CategoryColor;
  children: ReactNode;
}) {
  return (
    <span
      data-color={color ?? categoryColor(identity)}
      className="category-tag inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
    >
      {children}
    </span>
  );
}

export function ColorDot({ color, label }: { color?: CategoryColor; label?: string }) {
  return (
    <span
      aria-hidden={!label || undefined}
      role="img"
      aria-label={label}
      title={label}
      data-color={color}
      className={cn(
        'inline-flex size-2 shrink-0 rounded-full',
        color ? 'category-dot' : 'bg-muted-foreground',
      )}
    />
  );
}
