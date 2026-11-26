import { Link } from '@tanstack/react-router';
import { Clock } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useWorkspace } from '../../api/client.js';
import { Button, Notice, Page, Tabs } from '../../ui/index.js';
import { useView } from '../state.js';
import { HistoryTab } from './history-tab.js';
import { ObjectsTab } from './objects-tab.js';
import { useSchemaChanges } from './schema-model.js';

const DiagramTab = lazy(() => import('./diagram-tab.js').then((m) => ({ default: m.DiagramTab })));

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
          <Button size="small" className="pointer-coarse:min-h-11" asChild>
            <Link to="/review" search={{ tab: 'schema' }}>
              <Clock size={14} aria-hidden />
              {pending} proposed
            </Link>
          </Button>
        ) : null
      }
    >
      <Tabs
        wrapLabels
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
      {tab === 'objects' ? (
        <ObjectsTab />
      ) : tab === 'diagram' ? (
        <Suspense fallback={<Notice>Loading diagram…</Notice>}>
          <DiagramTab />
        </Suspense>
      ) : (
        <HistoryTab />
      )}
    </Page>
  );
}
