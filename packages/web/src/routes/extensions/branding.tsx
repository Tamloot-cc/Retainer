import { Clock, Puzzle } from 'lucide-react';
import { IdentityTag } from '../../ui/index.js';
import exa from './logos/exa.svg?no-inline';
import gmail from './logos/gmail.webp?no-inline';
import granola from './logos/granola.webp?no-inline';
import tamloot from './logos/tamloot.webp?no-inline';

const lastContactId = 'c1e8ba8a-69bb-4b2e-8db3-6ddc6c7b1606';

// Registration IDs identify the same extension across releases and catalogs.
const branding = new Map<string, { name: string; logo?: string }>([
  ['9796c2c7-46f3-4006-8f35-059d5ef3553e', { name: 'Exa', logo: exa }],
  ['4c60fc8e-45f9-49c8-919e-5c05c947a9aa', { name: 'Gmail', logo: gmail }],
  ['9e427713-3c8a-4981-872c-c8db69703113', { name: 'Granola', logo: granola }],
  ['54326882-cc28-4983-a5fe-cf0298520b68', { name: 'Tamloot', logo: tamloot }],
  [lastContactId, { name: 'Last Contact' }],
]);

export function extensionName(registrationId: string, fallback: string) {
  return branding.get(registrationId)?.name ?? fallback;
}

export function ExtensionIcon({ registrationId }: { registrationId: string }) {
  const logo = branding.get(registrationId)?.logo;
  if (logo)
    return <img src={logo} width={26} height={26} alt="" className="rounded object-contain" />;

  const Icon = registrationId === lastContactId ? Clock : Puzzle;
  return (
    <IdentityTag identity={registrationId}>
      <Icon size={18} aria-hidden />
    </IdentityTag>
  );
}
