// Sharing the game between Claude Code sessions: what to keep when two sessions' copies meet.
import type { ChessGame } from '../types'
import { replay } from './rules'

/** Which game a copy is: its Lichess game, or the local one. */
const gameKey = (current: ChessGame) => current.lichess?.gameId ?? 'local'

/** The moves Lichess has, without a move still in flight. */
const confirmedMoves = (current: ChessGame) => (current.pending ? current.moves.slice(0, current.pending.index) : current.moves)

/** Is `short` the start of `long`, move by move? Compared as SAN, so e1g1 and e1h1 castle alike. */
function isStartOf(short: readonly string[], long: readonly string[]): boolean {
  if (short.length > long.length) return false
  const a = replay(short).sans
  const b = replay(long).sans.slice(0, short.length)
  return a.length === short.length && a.every((san, i) => san === b[i])
}

/**
 * Merges this session's copy with a newer one another session saved, which this session has not
 * taken in yet. Another game in the file stands (this session must not undo it); for the same game,
 * the copy further on stands, this session's move in flight going back on top when it follows it,
 * and this session's own choice of side at the bottom kept.
 */
export function mergeGames(mine: ChessGame, theirs: ChessGame): ChessGame {
  if (gameKey(mine) !== gameKey(theirs)) return theirs
  const myMoves = confirmedMoves(mine)
  const theirMoves = confirmedMoves(theirs)
  const base = isStartOf(theirMoves, myMoves) && myMoves.length > theirMoves.length ? mine : theirs
  const confirmed = confirmedMoves(base)
  const pending = mine.pending ?? theirs.pending
  const isStillOn = pending !== undefined && pending.index === confirmed.length && (!base.lichess || base.lichess.status === 'started')
  return {
    ...base,
    moves: isStillOn ? [...confirmed, pending.uci] : confirmed,
    pending: isStillOn ? pending : undefined,
    flipped: mine.flipped,
  }
}
