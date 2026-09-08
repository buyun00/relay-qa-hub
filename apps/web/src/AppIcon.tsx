import { useEffect, useRef, useState } from "react";
import { MorphIcon } from "morphicons/react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Bell,
  BellRing,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsRight,
  CircleCheck,
  CirclePlus,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Code,
  CodeXml,
  Copy,
  Download,
  ExternalLink,
  FileCheck,
  FolderDown,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  LoaderCircle,
  LogOut,
  Maximize2,
  Minimize2,
  Minus,
  Package,
  PackageOpen,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ScanSearch,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Table,
  TableProperties,
  Timer,
  Upload,
  Users,
  UsersRound,
  X,
} from "lucide";
import type { IconInput } from "morphicons";

// Import icon data explicitly so unused Lucide icons stay out of the EXE.
const icons = {
  dashboard: [LayoutDashboard, TableProperties],
  overview: [Table, TableProperties],
  production: [Play, Sparkles],
  package: [Package, PackageOpen],
  upload: [Upload, ArrowUpFromLine],
  download: [Download, ArrowDownToLine],
  users: [Users, UsersRound],
  code: [Code, CodeXml],
  clock: [Clock, Timer],
  search: [Search, ScanSearch],
  refresh: [RotateCw, RefreshCw],
  plus: [Plus, CirclePlus],
  check: [Check, CheckCheck],
  success: [CircleCheck, ShieldCheck],
  close: [X, "M5 5 19 19M19 5 5 19"],
  right: [ChevronRight, ChevronsRight],
  down: [ChevronDown, ChevronDown],
  up: [ChevronUp, ChevronUp],
  external: [ArrowUpRight, ExternalLink],
  logout: [LogOut, ArrowUpRight],
  pending: [ClipboardList, ListTodo],
  inProgress: [Timer, Clock],
  verification: [ClipboardCheck, FileCheck],
  closed: [CircleCheck, ShieldCheck],
  minimize: [Minus, ArrowDownToLine],
  maximize: [Square, Maximize2],
  restore: [Copy, Minimize2],
  settings: [Settings, CodeXml],
  copy: [Copy, ClipboardCheck],
  folder: [FolderOpen, FolderDown],
  bell: [Bell, BellRing],
  loader: [LoaderCircle, LoaderCircle],
  minus: [Minus, Minus],
  filter: [ListTodo, ListChecks],
} satisfies Record<string, readonly [IconInput, IconInput]>;

export type AppIconName = keyof typeof icons;

export default function AppIcon({
  name,
  active = false,
  busy = false,
  size = 18,
  className = "",
}: {
  name: AppIconName;
  active?: boolean;
  busy?: boolean;
  size?: number;
  className?: string;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    const control = root.current?.closest("button, a, summary, label");
    if (!control) return;
    const update = () =>
      setEngaged(
        !control.matches(":disabled, [aria-disabled='true']") &&
          (control.matches(":hover") || control.contains(document.activeElement)),
      );
    const events = ["pointerenter", "pointerleave", "focusin", "focusout"];
    events.forEach((event) => control.addEventListener(event, update));
    return () => events.forEach((event) => control.removeEventListener(event, update));
  }, []);
  const pair = icons[busy ? "loader" : name];
  return (
    <span
      ref={root}
      aria-hidden="true"
      data-icon={name}
      className={`app-icon${busy ? " is-spinning" : ""} ${className}`.trim()}
    >
      <MorphIcon
        icon={pair[active || engaged ? 1 : 0]}
        size={size}
        strokeWidth={1.9}
        spring="snappy"
        reducedMotion="user"
      />
    </span>
  );
}
