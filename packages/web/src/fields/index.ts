import type { FieldType } from '@retainer/shared';
import * as address from './address/index.js';
import * as boolean from './boolean/index.js';
import type { FieldModule } from './common.js';
import * as date from './date/index.js';
import * as date_time from './date_time/index.js';
import * as emails from './emails/index.js';
import * as files from './files/index.js';
import * as full_name from './full_name/index.js';
import * as json from './json/index.js';
import * as links from './links/index.js';
import * as money from './money/index.js';
import * as multi_select from './multi_select/index.js';
import * as number from './number/index.js';
import * as phones from './phones/index.js';
import * as relation from './relation/index.js';
import * as select from './select/index.js';
import * as text from './text/index.js';
export const fields = {
  text,
  number,
  boolean,
  date,
  date_time,
  select,
  multi_select,
  money,
  emails,
  phones,
  links,
  full_name,
  address,
  relation,
  json,
  files,
} satisfies Record<FieldType, FieldModule>;
