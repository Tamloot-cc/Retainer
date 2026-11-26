'use client';

import type {
  CodeUsageGenerator,
  InlineCodeUsageGenerator,
} from 'fumadocs-openapi/requests/generators';
import { curl } from 'fumadocs-openapi/requests/generators/curl';
import { javascript } from 'fumadocs-openapi/requests/generators/javascript';
import { python } from 'fumadocs-openapi/requests/generators/python';
import { createOpenAPIPage } from 'fumadocs-openapi/ui';

function example(
  id: string,
  generator: CodeUsageGenerator,
  authenticated: boolean,
): InlineCodeUsageGenerator {
  return {
    id,
    label: generator.label,
    lang: generator.lang,
    source: (data, context) =>
      generator.generate(
        authenticated
          ? {
              ...data,
              header: { ...data.header, Authorization: { value: 'Bearer YOUR_WORKSPACE_API_KEY' } },
            }
          : data,
        context,
      ),
  };
}

export const OpenAPIPage = createOpenAPIPage({
  generateCodeSamples({ operation }) {
    const authenticated =
      operation.security?.some((requirement) => 'bearerAuth' in requirement) ?? true;
    return [
      example('curl', curl, authenticated),
      example('javascript', javascript, authenticated),
      example('python', python, authenticated),
    ];
  },
  playground: { enabled: false },
  // lib/source.ts leaves the document out of page props; load it once per browser session.
  loadDocument: () => import('@/lib/rest-contract').then(({ contract }) => contract),
});
