import { serveLlms } from '@/lib/llms';

export const dynamic = 'force-static';

export const GET = () => serveLlms('/llms.txt');
