'use client';

import { useStaticSearch } from 'fumadocs-core/search/client';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
  TagsList,
  TagsListItem,
} from 'fumadocs-ui/components/dialog/search';
import { useState } from 'react';

export default function DocsSearch(props: SharedProps) {
  const [tag, setTag] = useState<string | undefined>('all');
  const search = useStaticSearch({
    from: '/search-index.json',
    tag: tag === 'all' ? undefined : tag,
  });

  return (
    <SearchDialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
        <SearchDialogFooter>
          <TagsList tag={tag} onTagChange={setTag} allowClear={false}>
            <TagsListItem value="all">All</TagsListItem>
            <TagsListItem value="guides">Guides</TagsListItem>
            <TagsListItem value="mcp">MCP</TagsListItem>
            <TagsListItem value="api">API Reference</TagsListItem>
          </TagsList>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}
