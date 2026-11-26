import { bodyLimit } from 'hono/body-limit';

/** The longest message a person may send in one turn. */
export const MAX_MESSAGE_CHARS = 100_000;

/**
 * The largest stream request body read: room for the longest message as
 * JSON, every character escaped. Larger bodies are refused before they are
 * buffered, by the agent runtime and by the API's self-hosted forward.
 */
export const MAX_STREAM_BODY_BYTES = 1024 * 1024;

/** Refuses a stream request body over `MAX_STREAM_BODY_BYTES` with `413`, before buffering it. */
export const streamBodyLimit = () =>
  bodyLimit({
    maxSize: MAX_STREAM_BODY_BYTES,
    onError: (c) => c.json({ code: 'payload_too_large' }, 413),
  });
