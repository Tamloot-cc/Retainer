import { STARTER_ENTITY_OPERATIONS, STARTER_EVENT_OPERATIONS } from './base.js';
import { clinic } from './clinic.js';
import { realEstate } from './real-estate.js';
import { recruiting } from './recruiting.js';
import { sales } from './sales.js';
import { services } from './services.js';
import type { Template, TemplateName } from './types.js';

export {
  INTERNAL_OPERATIONS,
  STARTER_ENTITY_OPERATIONS,
  STARTER_EVENT_OPERATIONS,
  STARTER_OBJECT_IDS,
} from './base.js';
export { TEMPLATE_NAMES, type Template, type TemplateName } from './types.js';

export const TEMPLATES: Record<TemplateName, Template> = {
  sales,
  services,
  clinic,
  real_estate: realEstate,
  recruiting,
  starter: {
    name: 'starter',
    version: 1,
    label: 'Starter',
    description: 'People, companies, tasks and conversations',
    operations: [...STARTER_ENTITY_OPERATIONS, ...STARTER_EVENT_OPERATIONS],
  },
};

export function getTemplate(name: string): Template | undefined {
  return Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name as TemplateName] : undefined;
}

export function templateOperations(template: Template): Template['operations'] {
  return [
    ...(template.extends ? templateOperations(TEMPLATES[template.extends]) : []),
    ...template.operations,
  ];
}
