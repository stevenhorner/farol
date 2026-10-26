import type { Linker } from './links.js'

/** Escapes text that GitHub would otherwise read as HTML or code. */
export function esc(text: string, max = 300): string {
  const short = text.length > max ? `${text.slice(0, max - 1)}…` : text
  return short.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('`', "'")
}

export function code(text: string): string {
  return `\`${text.replaceAll('`', "'")}\``
}

export function link(text: string, url: string | null): string {
  return url === null ? text : `[${text}](${url})`
}

/** A file path in code style, linked to its diff when links are available. */
export function fileMd(l: Linker, path: string, label = path): string {
  return link(code(label), l.file(path))
}

export function locationMd(l: Linker, path: string, line: number, label = path): string {
  return link(code(`${label}:${line}`), l.lines(path, line))
}
