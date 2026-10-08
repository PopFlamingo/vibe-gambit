// Game clocks: each side's time left, the side to move's running since its turn began.
import type { ChessClock } from '../types'

type Side = 'w' | 'b'

/** "10+5": ten minutes each, five seconds added after every move. 10+0 when unreadable. */
export function newClock(timeControl: string): ChessClock {
  const match = /^\s*(\d+(?:\.\d+)?)\s*\+\s*(\d+)\s*$/.exec(timeControl)
  const minutes = match ? Number(match[1]) : 10
  const increment = match ? Number(match[2]) : 0
  const initialMs = Math.round(minutes * 60_000)
  return { initialMs, incrementMs: increment * 1000, whiteMs: initialMs, blackMs: initialMs, runningSince: null }
}

/** `side`'s time left at `now`, counting down while it is their turn. */
export function timeLeft(clock: ChessClock, side: Side, turn: Side, now: number): number {
  const stored = side === 'w' ? clock.whiteMs : clock.blackMs
  const running = clock.runningSince !== null && side === turn ? now - clock.runningSince : 0
  return Math.max(0, stored - running)
}

/** "9:42", "1:02:05"; seconds rounded up so 0:00 means the time is gone. */
export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
