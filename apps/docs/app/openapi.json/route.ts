import { contract } from '@/lib/rest-contract';

export const dynamic = 'force-static';

export function GET() {
  return Response.json(contract);
}
