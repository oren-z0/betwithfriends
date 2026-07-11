/** Catalog of the background patterns shipped in public/backgrounds/. */
export interface BackgroundChoice {
  id: string
  label: string
}

export const BACKGROUNDS: BackgroundChoice[] = [
  { id: 'football-green', label: 'Football' },
  { id: 'football-night', label: 'Football · Night' },
  { id: 'basketball-orange', label: 'Basketball' },
  { id: 'tennis-court', label: 'Tennis' },
  { id: 'dice-purple', label: 'Dice' },
  { id: 'hearts-red', label: 'Hearts' },
  { id: 'trophy-blue', label: 'Trophy' },
  { id: 'confetti-pink', label: 'Confetti' },
  { id: 'bolt-dark', label: 'Lightning' },
]

/** Full URL of a shipped background — pool events always store absolute URLs. */
export function shippedBackgroundUrl(id: string): string {
  return new URL(`${import.meta.env.BASE_URL}backgrounds/${id}.svg`, window.location.origin).toString()
}
