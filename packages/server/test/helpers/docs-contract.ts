type PublicContract = {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId: string;
        'x-retainer-scope'?: string;
        parameters?: { in: string; name: string; required?: boolean; example?: unknown }[];
        requestBody?: { content: { 'application/json': { schema: unknown; example?: unknown } } };
      }
    >
  >;
  components: { schemas: Record<string, { properties: Record<string, unknown> }> };
};

const contractUrl = new URL('../../../../apps/docs/lib/rest-contract.ts', import.meta.url).href;

export async function loadDocsContract(): Promise<PublicContract> {
  const { contract } = (await import(/* @vite-ignore */ contractUrl)) as {
    contract: PublicContract;
  };
  return contract;
}
