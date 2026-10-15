import type { SpriteData } from '../types.js'

/** Stable across reloads, roster ordering, renames and newly added repos. */
export function repositoryColor(repoId: string): string {
  let hash = 2166136261
  for (const code of repoId) hash = Math.imul(hash ^ code.charCodeAt(0), 16777619)
  const hue = (hash >>> 0) % 360
  const s = .64, l = .57, chroma = (1 - Math.abs(2 * l - 1)) * s
  const x = chroma * (1 - Math.abs(hue / 60 % 2 - 1)), m = l - chroma / 2
  const channels = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x]
  return `#${channels.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

// Material swatches from the six shipped PNGs. Skin, hair, outlines, books,
// trousers and shoes are deliberately excluded. Character 0 shares blue
// swatches with its trousers, so its torso mask also has curated pose bounds.
const shirtSwatches: ReadonlyArray<Record<string, number>> = [
  { '#071C2E': .48, '#0F406A': .7, '#114978': .85, '#1164A9': 1.1 },
  { '#1A1A1A': .65, '#252525': .9, '#2B2B2B': 1.1 },
  { '#56110E': .45, '#741713': .62, '#8B1A16': .78, '#A91D18': 1, '#E87218': 1.15, '#E8741B': 1.15, '#F67D20': 1.25 },
  { '#BDBDBD': .75, '#D4D4D4': .95, '#EEEEEE': 1.15 },
  { '#BDBDBD': .75, '#D4D4D4': .95, '#EEEEEE': 1.15 },
  { '#640026': .45, '#9F3F31': .7, '#B24737': .9, '#E16451': 1.15 },
]

export function recolorShirt(original: SpriteData, current: SpriteData, palette: number, direction: 'down' | 'up' | 'right', frame: number, color: string, templateShirt?: string): SpriteData {
  const swatches = shirtSwatches[palette % shirtSwatches.length]
  const maxRow = templateShirt ? Infinity : palette % 6 === 0
    ? direction === 'down' ? [23, 24, 23, 25, 25, 24, 24][frame] : direction === 'up' ? [23, 24, 23, 24, 24, 24, 24][frame] : frame === 1 ? 24 : 25
    : palette % 6 === 1 && direction === 'down' && frame >= 5 ? 27 : Infinity
  const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16))
  return current.map((row, y) => row.map((pixel, x) => {
    const material = original[y]?.[x]?.toUpperCase()
    const shade = templateShirt ? material === templateShirt.toUpperCase() ? 1 : undefined : swatches[material]
    if (shade === undefined || y > maxRow) return pixel
    return `#${rgb.map(value => Math.min(255, Math.round(value * shade)).toString(16).padStart(2, '0')).join('').toUpperCase()}`
  }))
}
