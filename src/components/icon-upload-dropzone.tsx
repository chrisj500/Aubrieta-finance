"use client";

import { useRef, useState } from "react";
import NextImage from "next/image";
import { ImageUp } from "lucide-react";

export type IconArtworkShape = "square" | "card";

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.readAsDataURL(file);
  });
}

export async function prepareCustomIcon(file: File, shape: IconArtworkShape): Promise<string> {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Choose an image smaller than 8 MB.");

  const sourceDataUrl = await fileToDataUrl(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image could not be read."));
    img.src = sourceDataUrl;
  });

  const target = shape === "card" ? { width: 320, height: 200 } : { width: 160, height: 160 };
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image resizing is unavailable in this browser.");
  ctx.clearRect(0, 0, target.width, target.height);
  const scale = Math.min(target.width / image.naturalWidth, target.height / image.naturalHeight);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  ctx.drawImage(image, Math.round((target.width - width) / 2), Math.round((target.height - height) / 2), width, height);

  const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  const output = webp ?? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!output) throw new Error("That image could not be prepared.");
  return fileToDataUrl(new File([output], "icon", { type: output.type }));
}

export function IconUploadDropzone({
  preview,
  shape,
  fallback,
  disabled = false,
  onPrepared,
  onError,
  onPreparingChange,
}: {
  preview: string | null;
  shape: IconArtworkShape;
  fallback: React.ReactNode;
  disabled?: boolean;
  onPrepared: (dataUrl: string) => void;
  onError: (message: string | null) => void;
  onPreparingChange?: (preparing: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file || disabled || preparing) return;
    setPreparing(true);
    onPreparingChange?.(true);
    onError(null);
    try {
      onPrepared(await prepareCustomIcon(file, shape));
    } catch (error) {
      onError(error instanceof Error ? error.message : "That image could not be prepared.");
    } finally {
      setPreparing(false);
      onPreparingChange?.(false);
    }
  }

  const card = shape === "card";
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className={`flex shrink-0 items-center justify-center overflow-hidden bg-surface-muted text-text-muted ring-1 ring-border ${card ? "h-20 w-32 rounded-xl" : "h-20 w-20 rounded-2xl"}`}>
        {preview ? (
          <NextImage
            src={preview}
            alt="Icon preview"
            width={card ? 128 : 80}
            height={80}
            unoptimized
            className="h-full w-full object-contain"
          />
        ) : fallback}
      </div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Upload icon image"
        onClick={() => !disabled && !preparing && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (!disabled && !preparing && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleFile(event.dataTransfer.files?.[0]);
        }}
        className={`flex min-h-20 flex-1 cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
          dragging ? "border-accent bg-accent/10" : "border-border bg-surface-muted/25 hover:border-accent/50 hover:bg-surface-muted/50"
        } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        <ImageUp size={20} className="shrink-0 text-text-muted" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">{preparing ? "Preparing image…" : "Drop an image here or click to choose"}</p>
          <p className="mt-0.5 text-xs text-text-muted">PNG, JPEG, or WebP · up to 8 MB</p>
        </div>
      </div>
    </div>
  );
}
