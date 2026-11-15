import {
  Box,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CircleCheck,
  Eye,
  FileSignature,
  FileText,
  FolderKanban,
  Handshake,
  House,
  type LucideIcon,
  MessageSquareDot,
  MessageSquareMore,
  MessageSquareQuote,
  MessageSquareText,
  MessagesSquare,
  SquarePen,
  UserRound,
} from 'lucide-react';

/** Icons for the objects the built-in templates define; any other object gets a box. */
const OBJECT_ICONS: Record<string, LucideIcon> = {
  person: UserRound,
  company: Building2,
  deal: Handshake,
  task: CircleCheck,
  project: FolderKanban,
  property: House,
  viewing: Eye,
  job: BriefcaseBusiness,
  application: FileText,
  proposal: FileSignature,
  appointment: CalendarDays,
};
/**
 * Event types draw from one family (squared speech marks), so Activity reads
 * apart from Records at a glance; any other event type gets the plain one.
 */
const EVENT_ICONS: Record<string, LucideIcon> = {
  conversation: MessagesSquare,
  note: SquarePen,
  meeting: MessageSquareMore,
  call: MessageSquareDot,
  email: MessageSquareText,
  message: MessageSquareText,
};
const EVENT_ICON = MessageSquareQuote;

/** The icon for an object or event type, by its singular API name and class. */
export const objectIcon = (name: string, objectClass: 'entity' | 'event' = 'entity'): LucideIcon =>
  objectClass === 'event'
    ? Object.hasOwn(EVENT_ICONS, name)
      ? (EVENT_ICONS[name] ?? EVENT_ICON)
      : EVENT_ICON
    : Object.hasOwn(OBJECT_ICONS, name)
      ? (OBJECT_ICONS[name] ?? Box)
      : Box;
