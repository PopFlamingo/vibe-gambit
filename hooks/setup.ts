// The "New game" screen's choices, and what each opponent allows.
import type { SetupForm } from '../types'

export type Opponent = SetupForm['opponent']
export type SetupColor = SetupForm['color']

export const OPPONENTS: readonly Opponent[] = ['stockfish', 'random', 'friend']
export const COLORS: readonly SetupColor[] = ['random', 'white', 'black']

/**
 * The time controls each opponent takes. Live games only, no correspondence. Lichess's Board API
 * pairs a random opponent at rapid and classical speeds only; blitz needs a challenge (Stockfish, a friend).
 */
export const TIME_CONTROLS: Record<Opponent, readonly string[]> = {
  stockfish: ['3+2', '5+3', '10+0', '10+5', '15+10', '30+0'],
  random: ['10+0', '10+5', '15+10', '30+0', '30+20'],
  friend: ['3+2', '5+3', '10+0', '10+5', '15+10', '30+0'],
}

export const DEFAULT_FORM: SetupForm = {
  opponent: 'stockfish',
  level: 3,
  timeControl: '5+3',
  color: 'random',
  rated: false,
  friend: '',
}

/** What the screen asks for this opponent. A random pairing has no colour to pick: Lichess draws it. */
export const asks = (opponent: Opponent) => ({
  level: opponent === 'stockfish',
  color: opponent === 'stockfish' || opponent === 'friend',
  rated: opponent === 'random' || opponent === 'friend',
  friend: opponent === 'friend',
})

/** The next item of a list after `current`, round and round; the first when `current` is not in it. */
export function cycle<T>(list: readonly T[], current: T): T {
  const at = list.indexOf(current)
  return list[(at + 1) % list.length]!
}

/** The form with a time control this opponent takes: the same if it can, else the nearest default. */
export function fitForm(form: SetupForm): SetupForm {
  // An opponent this version no longer has (a local game, from a saved form): the default one.
  if (!OPPONENTS.includes(form.opponent)) return fitForm({ ...form, opponent: DEFAULT_FORM.opponent })
  const controls = TIME_CONTROLS[form.opponent]
  if (controls.includes(form.timeControl)) return form
  return { ...form, timeControl: form.opponent === 'random' ? '10+0' : '5+3' }
}

/** Lichess's speed for a time control: from its estimated length, base + 40 × increment. */
export function speedOf(timeControl: string): 'bullet' | 'blitz' | 'rapid' | 'classical' {
  const match = /^(\d+(?:\.\d+)?)\+(\d+)$/.exec(timeControl.trim())
  const seconds = match ? Number(match[1]) * 60 + 40 * Number(match[2]) : 600
  if (seconds < 180) return 'bullet'
  if (seconds < 480) return 'blitz'
  if (seconds < 1500) return 'rapid'
  return 'classical'
}

/** The body of a Board API seek: minutes and seconds, live only. */
export function seekBody(form: SetupForm): string {
  const [minutes = '10', increment = '0'] = form.timeControl.split('+')
  // No colour: Lichess picks one, which its API docs advise for a fair share of each colour.
  return new URLSearchParams({ rated: String(form.rated), time: minutes, increment, variant: 'standard' }).toString()
}

/** The body of a challenge to a friend, kept open while waiting so closing it cancels the challenge. */
export function challengeBody(form: SetupForm): string {
  const [minutes = '5', increment = '0'] = form.timeControl.split('+')
  return new URLSearchParams({
    rated: String(form.rated),
    'clock.limit': String(Math.round(Number(minutes) * 60)),
    'clock.increment': increment,
    color: form.color,
    variant: 'standard',
    keepAliveStream: 'true',
  }).toString()
}

/** A Lichess username as Lichess allows it: letters, digits, _ and -, 2 to 30 long. */
export const isUsername = (name: string) => /^[A-Za-z0-9][\w-]{1,29}$/.test(name.trim())
