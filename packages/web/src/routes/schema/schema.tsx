import { Link } from '@tanstack/react-router';
import { Clock } from 'lucide-react';
import { useWorkspace } from '../../api/client.js';
import { Button, Page, Tabs } from '../../ui/index.js';
import { useView } from '../state.js';
import { DiagramTab } from './diagram-tab.js';
import { HistoryTab } from './history-tab.js';
import { ObjectsTab } from './objects-tab.js';
import { useSchemaChanges } from './schema-model.js';

export function SchemaPage() {
  const { schema } = useWorkspace(),
    { search, setSearch } = useView();
  const tab = search.tab === 'history' || search.tab === 'diagram' ? search.tab : 'objects';
  const proposed = useSchemaChanges('proposed');
  const all = useSchemaChanges();
  const pending = proposed.data?.total ?? 0;
  const templates = schema.workspace.templates.map((t) => t.name).join(', ');
  return (
    <Page
      eyebrow="Workspace structure"
      title="Schema"
      description={[
        `Version ${schema.workspace.schemaVersion}`,
        templates ? `Template: ${templates}` : null,
        'Agents propose changes; people approve them.',
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={
        pending ? (
          <Button size="small" asChild>
            <Link to="/review" search={{ tab: 'schema' }}>
              <Clock size={14} aria-hidden />
              {pending} proposed
            </Link>
          </Button>
        ) : null
      }
    >
      <Tabs
        value={tab}
        onChange={(v) =>
          void setSearch({ tab: v, cursor: undefined, field: undefined, status: undefined })
        }
        items={[
          { value: 'objects', label: 'Objects', count: schema.objects.length },
          { value: 'diagram', label: 'Diagram' },
          { value: 'history', label: 'Change history', count: all.data?.total },
        ]}
      />
      {tab === 'objects' ? <ObjectsTab /> : tab === 'diagram' ? <DiagramTab /> : <HistoryTab />}
    </Page>
  );
}
