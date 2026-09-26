import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileIcon,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  ImageIcon,
  Link2,
  type LucideIcon,
} from "lucide-react";
import type { Kind } from "@/lib/api";
import { cn } from "@/lib/utils";

export const KIND_META: Record<Kind | "link", { icon: LucideIcon; tint: string; label: string }> = {
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
};

export function KindIcon({
  kind,
  className,
  iconClassName,
}: {
  kind: Kind | "link";
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
