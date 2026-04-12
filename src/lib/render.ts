import type { DisplaySnapshot } from "./codex-app-server";

const SIZE = 144;
type WindowMode = "5h" | "7d";

export function renderBlankImage(): string {
  return svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
      <rect width="${SIZE}" height="${SIZE}" rx="24" fill="#000000" />
    </svg>
  `);
}

export function renderErrorImage(title: string, subtitle: string): string {
  return svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#450a0a" />
          <stop offset="100%" stop-color="#991b1b" />
        </linearGradient>
      </defs>
      <rect width="${SIZE}" height="${SIZE}" rx="24" fill="url(#bg)" />
      <circle cx="72" cy="42" r="20" fill="none" stroke="#fecaca" stroke-width="8" />
      <path d="M72 28v16" stroke="#fecaca" stroke-width="8" stroke-linecap="round" />
      <circle cx="72" cy="54" r="4" fill="#fecaca" />
      <text x="72" y="96" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" font-weight="700" fill="#fff1f2">${escapeXml(title)}</text>
      <text x="72" y="118" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="16" fill="#fecdd3">${escapeXml(subtitle)}</text>
    </svg>
  `);
}

export function renderUsageImage(snapshot: DisplaySnapshot, windowMode: WindowMode): string {
  const selected = windowMode === "7d" ? snapshot.secondaryWindow : snapshot.primaryWindow;
  const accent = pickAccent(selected.remainingPercent);
  const resetText = formatUpdateTime(selected.resetAt);
  const windowLabel = windowMode === "7d" ? "1week" : "5hours";

  return svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
      <defs>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${accent.start}" />
          <stop offset="100%" stop-color="${accent.end}" />
        </linearGradient>
      </defs>
      <rect width="${SIZE}" height="${SIZE}" rx="24" fill="#000000" />
      <rect x="12" y="14" width="120" height="14" rx="7" fill="#1f2937" />
      <rect x="12" y="14" width="${Math.max(14, (120 * selected.remainingPercent) / 100)}" height="14" rx="7" fill="url(#accent)" />
      <text x="72" y="48" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="#e5e7eb">${windowLabel}</text>
      <text x="64" y="95" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="52" font-weight="800" fill="#f8fafc">${selected.remainingPercent}</text>
      <text x="116" y="95" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="31" font-weight="700" fill="#cbd5e1">%</text>
      <text x="72" y="126" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="600" fill="#cbd5e1">${escapeXml(resetText)}</text>
    </svg>
  `);
}

function pickAccent(remainingPercent: number): { start: string; end: string } {
  if (remainingPercent <= 20) {
    return { start: "#fb7185", end: "#ef4444" };
  }

  if (remainingPercent <= 50) {
    return { start: "#fde047", end: "#eab308" };
  }

  return { start: "#4ade80", end: "#22c55e" };
}

function formatUpdateTime(unixSeconds: number): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return formatter.format(new Date(unixSeconds * 1000));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;
}
