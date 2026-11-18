import type { FieldView } from '@retainer/shared';
import { ListFilter } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useWorkspace } from '../../api/client.js';
import { FieldPicker } from '../../fields/common.js';
import {
  ApiName,
  Button,
  Form,
  FormField,
  Input,
  OptionList,
  PanelBody,
  PanelHeader,
  Popover,
  toggleValue,
} from '../../ui/index.js';
import { useApiName } from '../developer.js';
import { sortObjects } from '../state.js';
import type { FeedFilters } from './activity-state.js';

type Step = 'type' | 'channel' | 'date' | 'linked';
const STEPS: { value: Step; label: string }[] = [
  { value: 'type', label: 'Type' },
  { value: 'channel', label: 'Source' },
  { value: 'date', label: 'Date' },
  { value: 'linked', label: 'Linked record' },
];

/** Adds a filter: first what to filter by, then its value. */
export function FeedFilterMenu({
  filters,
  anyEntity,
  onChange,
}: {
  filters: FeedFilters;
  anyEntity: FieldView;
  onChange: (next: FeedFilters) => void;
}) {
  const { schema } = useWorkspace(),
    apiName = useApiName();
  const [open, setOpen] = useState(false),
    [step, setStep] = useState<Step | null>(null),
    [channel, setChannel] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  const types = sortObjects(schema.objects);
  const linkedField = useMemo<FieldView>(
    () => ({
      ...anyEntity,
      name: 'linked',
      label: 'Linked record',
      settings: { ...anyEntity.settings, relationCardinality: 'many_to_one' },
    }),
    [anyEntity],
  );
  function choose(next: Step) {
    setStep(next);
    setChannel(filters.channel ?? '');
    setFrom(filters.from ?? '');
    setTo(filters.to ?? '');
  }
  const close = () => {
    setOpen(false);
    setStep(null);
  };
  const header = (title: string) => (
    <PanelHeader
      title={title}
      back={{ label: 'Choose another filter', onClick: () => setStep(null) }}
    />
  );
  return (
    <Popover
      label="Filter activity"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setStep(null);
      }}
      trigger={
        <Button variant="ghost" size="small" className="pointer-coarse:min-h-11">
          <ListFilter size={14} />
          Filter
        </Button>
      }
    >
      {step === 'type' ? (
        <>
          {header('Type')}
          <OptionList
            label="Record types"
            multiple
            searchable={types.length > 7}
            options={types.map((t) => {
              const name = apiName(t.nameSingular);
              return {
                value: t.nameSingular,
                label: t.labelPlural,
                ...(name
                  ? {
                      content: (
                        <>
                          {t.labelPlural}
                          <ApiName>{name}</ApiName>
                        </>
                      ),
                      keywords: name,
                    }
                  : {}),
              };
            })}
            selected={filters.types}
            onPick={(t) => onChange({ ...filters, types: toggleValue(filters.types, t) })}
          />
        </>
      ) : step === 'channel' ? (
        <>
          {header('Source')}
          <PanelBody>
            <Form
              autoFocus
              onSubmit={() => {
                onChange({ ...filters, channel: channel.trim() || undefined });
                close();
              }}
            >
              <FormField label="Source is" apiName={apiName('channel')}>
                <Input
                  aria-label="Source"
                  placeholder="gmail, zoom, web…"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                />
              </FormField>
              <Button type="submit" variant="primary">
                Apply filter
              </Button>
            </Form>
          </PanelBody>
        </>
      ) : step === 'date' ? (
        <>
          {header('Date')}
          <PanelBody>
            <Form
              autoFocus
              onSubmit={() => {
                onChange({ ...filters, from: from || undefined, to: to || undefined });
                close();
              }}
            >
              <FormField label="From" apiName={apiName('occurredAt')}>
                <Input
                  aria-label="From"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </FormField>
              <FormField label="To">
                <Input
                  aria-label="To"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </FormField>
              <Button type="submit" variant="primary" disabled={!from && !to}>
                Apply filter
              </Button>
            </Form>
          </PanelBody>
        </>
      ) : step === 'linked' ? (
        <>
          {header('Linked record')}
          <FieldPicker
            field={linkedField}
            value={filters.linked ?? null}
            onChange={(id) => {
              onChange({ ...filters, linked: typeof id === 'string' && id ? id : undefined });
              close();
            }}
          />
        </>
      ) : (
        <OptionList
          label="Filter by"
          searchable={false}
          options={STEPS}
          onPick={(s) => choose(s as Step)}
        />
      )}
    </Popover>
  );
}
