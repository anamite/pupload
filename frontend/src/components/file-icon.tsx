import {
  CalendarDays,
  FileArchive,
  FileAudio,
  FileCode2,
  FileIcon,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderLock,
  ImageIcon,
  Link2,
  ListChecks,
  Mic,
  NotebookPen,
  type LucideIcon,
} from "lucide-react";
import type { Kind, PrivateKind } from "@/lib/api";
import { cn } from "@/lib/utils";

export type IconKind = Kind | "link" | "vault" | PrivateKind;

export const KIND_META: Record<IconKind, { icon: LucideIcon; tint: string; label: string }> = {
  folder: { icon: Folder, tint: "text-folder bg-folder/15", label: "Folder" },
  image: { icon: ImageIcon, tint: "text-[oklch(0.62_0.13_190)] bg-[oklch(0.62_0.13_190/0.13)]", label: "Image" },
  video: { icon: FileVideo, tint: "text-[oklch(0.6_0.17_300)] bg-[oklch(0.6_0.17_300/0.13)]", label: "Video" },
  audio: { icon: FileAudio, tint: "text-[oklch(0.62_0.19_350)] bg-[oklch(0.62_0.19_350/0.12)]", label: "Audio" },
  pdf: { icon: FileText, tint: "text-[oklch(0.58_0.2_27)] bg-[oklch(0.58_0.2_27/0.12)]", label: "PDF" },
  doc: { icon: FileSpreadsheet, tint: "text-[oklch(0.58_0.14_250)] bg-[oklch(0.58_0.14_250/0.12)]", label: "Document" },
  text: { icon: FileCode2, tint: "text-[oklch(0.6_0.1_150)] bg-[oklch(0.6_0.1_150/0.12)]", label: "Text" },
  archive: { icon: FileArchive, tint: "text-[oklch(0.62_0.1_60)] bg-[oklch(0.62_0.1_60/0.13)]", label: "Archive" },
  file: { icon: FileIcon, tint: "text-muted-foreground bg-muted", label: "File" },
  link: { icon: Link2, tint: "text-primary bg-primary/12", label: "Link" },
  vault: { icon: FolderLock, tint: "text-primary bg-primary/12", label: "Secure folder" },
  note: { icon: NotebookPen, tint: "text-[oklch(0.62_0.13_80)] bg-[oklch(0.62_0.13_80/0.14)]", label: "Note" },
  list: { icon: ListChecks, tint: "text-[oklch(0.6_0.13_155)] bg-[oklch(0.6_0.13_155/0.13)]", label: "List" },
  event: { icon: CalendarDays, tint: "text-[oklch(0.58_0.14_250)] bg-[oklch(0.58_0.14_250/0.12)]", label: "Event" },
  memo: { icon: Mic, tint: "text-[oklch(0.62_0.19_350)] bg-[oklch(0.62_0.19_350/0.12)]", label: "Voice memo" },
};

const EXT_KIND: Record<string, Kind> = {};
(
  [
    ["image", "jpg jpeg png gif webp bmp svg avif heic ico tiff"],
    ["video", "mp4 m4v mkv webm mov avi mpg mpeg wmv flv 3gp"],
    ["audio", "mp3 flac wav m4a aac ogg oga opus wma aiff alac"],
    ["pdf", "pdf"],
    ["doc", "doc docx odt rtf ppt pptx odp xls xlsx ods csv"],
    ["text", "txt md log json xml yml yaml ini conf py js ts html css sh c h cpp java rs go sql"],
    ["archive", "zip tar gz bz2 xz 7z rar iso img deb rpm"],
  ] as [Kind, string][]
).forEach(([kind, exts]) => exts.split(" ").forEach((e) => (EXT_KIND[e] = kind)));

/** A file's kind from its name (the server's rule, for references in notes). */
export function kindFromName(name: string): Kind {
  const dot = name.lastIndexOf(".");
  return (dot > 0 && EXT_KIND[name.slice(dot + 1).toLowerCase()]) || "file";
}

export function KindIcon({
  kind,
  className,
  iconClassName,
}: {
  kind: IconKind;
  className?: string;
  iconClassName?: string;
}) {
  const meta = KIND_META[kind] ?? KIND_META.file;
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-lg", meta.tint, className)}>
      <Icon className={cn("size-[55%]", iconClassName)} strokeWidth={1.75} />
    </span>
  );
}
