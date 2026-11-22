import { STARTER_OBJECT_IDS } from './base.js';
import { TEMPLATES, type Template, templateOperations } from './index.js';

const BASE_NAMES = new Map<string, string>(
  Object.entries(STARTER_OBJECT_IDS).map(([name, id]) => [id, name]),
);

export type TemplateView = {
  name: string;
  version: number;
  label: string;
  description: string;
  applied: boolean;
  /** What applying the template adds (3.1). */
  adds: {
    objects: { name: string; fields: string[] }[];
    fields: { object: string; field: string }[];
  };
};

function describeTemplate(template: Template, applied: boolean): TemplateView {
  const objects: TemplateView['adds']['objects'] = [];
  const fields: TemplateView['adds']['fields'] = [];
  for (const operation of templateOperations(template)) {
    if (operation.op === 'create_object') {
      objects.push({
        name: operation.object.nameSingular,
        fields: operation.object.fields.map((f) => f.name),
      });
    } else if (operation.op === 'create_field') {
      fields.push({
        object: BASE_NAMES.get(operation.object) ?? operation.object,
        field: operation.field.name,
      });
    }
  }
  return {
    name: template.name,
    version: template.version,
    label: template.label,
    description: template.description,
    applied,
    adds: { objects, fields },
  };
}

export function listTemplates(appliedNames: readonly string[]): TemplateView[] {
  return Object.values(TEMPLATES).map((t) => describeTemplate(t, appliedNames.includes(t.name)));
}
