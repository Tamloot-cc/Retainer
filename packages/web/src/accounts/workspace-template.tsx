import { useQuery } from '@tanstack/react-query';
import { account } from '../api/account.js';
import { Label } from '../ui/index.js';

export function WorkspaceTemplateField() {
  const templates = useQuery({
    queryKey: ['workspace-templates'],
    queryFn: account.templates,
    staleTime: Infinity,
  });
  return (
    <Label>
      Template
      <select className="h-9 rounded-md border bg-background px-2" name="template">
        <option value="">Empty workspace</option>
        {templates.data?.templates.map((template) => (
          <option key={template.name} value={template.name}>
            {template.label}
          </option>
        ))}
      </select>
    </Label>
  );
}
