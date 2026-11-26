/**
 * Text the server adds to a person's message (the per-chat context on the
 * first turn, "Today is …" on a later date, spec §3.5) carries this marker in
 * its provider metadata. The model reads it like any text; the chat read
 * endpoint and the stream leave it out, so a person sees only what they wrote.
 * Anthropic ignores provider metadata outside its own namespace.
 */
const MARKER_NAMESPACE = 'retainer';

export type ServerAddedTextPart = {
  type: 'text';
  text: string;
  providerMetadata: { retainer: { serverAdded: true } };
};

export function serverAddedTextPart(text: string): ServerAddedTextPart {
  return { type: 'text', text, providerMetadata: { [MARKER_NAMESPACE]: { serverAdded: true } } };
}

export function isServerAddedPart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false;
  const meta = (part as { providerMetadata?: unknown }).providerMetadata;
  if (!meta || typeof meta !== 'object') return false;
  const ours = (meta as Record<string, unknown>)[MARKER_NAMESPACE];
  return (
    !!ours && typeof ours === 'object' && (ours as { serverAdded?: unknown }).serverAdded === true
  );
}
