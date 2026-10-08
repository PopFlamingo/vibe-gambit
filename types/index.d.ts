/** Each side's time left, in ms, as of `runningSince` for the side to move; null before the first move. */
export type ChessClock = {
  initialMs: number
  incrementMs: number
  whiteMs: number
  blackMs: number
  runningSince: number | null
}

/**
 * The game the pane shows: the moves played, in UCI, which side is at the bottom, and the
 * clock, set at the first move.
 */
export type ChessGame = {
  moves: string[]
  flipped: boolean
  clock?: ChessClock
  lichess?: LichessGame
  /** The person's move shown ahead of Lichess: the last of `moves` until Lichess has it, at `index`. */
  pending?: PendingMove
  /** The time control the game was started with. */
  timeControl?: string
}

/** A move sent to Lichess and not confirmed yet. */
export type PendingMove = { uci: string; index: number; since: number }

/** A Lichess game the board mirrors: which, the person's colour, who they play, and how it stands. */
export type LichessGame = {
  gameId: string
  color: 'w' | 'b'
  opponent: string
  status: string
  winner?: 'white' | 'black'
  /** The side offering a draw, while one does. */
  drawOffer?: 'w' | 'b'
  /** The side asking to take back its last move, while one does. */
  takebackOffer?: 'w' | 'b'
  /**
   * The opponent has left the game: from `claimAt` (ms) the person may claim the win or a draw; null
   * when Lichess gave no delay.
   */
  opponentGone?: { claimAt: number | null }
  /** Why this session cannot follow the game (no token, a token Lichess refuses): it goes on on Lichess. */
  unreachable?: string
}

/** The New game screen's choices. */
export type SetupForm = {
  opponent: 'stockfish' | 'random' | 'friend'
  level: number
  timeControl: string
  color: 'random' | 'white' | 'black'
  rated: boolean
  friend: string
}

/** A search for an opponent this session has under way on Lichess. */
export type ChessSearch = { kind: 'seek' | 'challenge'; timeControl: string; friend?: string }

/** The opponent's move that landed while the board was hidden: who played, and what (English SAN). */
export type ChessAlert = { mover: 'w' | 'b'; san: string }

/** What the hooks module hands the board's Client. */
export type BoardProps = {
  /** 64 FEN letters from a1 to h8, '.' for an empty square. */
  pieces: string
  flipped: boolean
  /** The last move's from and to squares. */
  last: [number, number] | null
  /** The king's square when the side to move is in check. */
  check: number | null
  /** For each square holding a piece that can move: its target squares. */
  legal: Record<string, number[]>
}

/** The board's own state, kept by the surface across redraws. */
export type BoardState = {
  selected: number | null
  cursor: number | null
  aimed: number | null
  dragFrom: number | null
  /** A move drawn at once, before the hooks module has taken it in: dropped once the pieces change or it is stale. */
  pending?: { from: number; to: number; base: string; at: number } | null
}

/** A move Lichess did not play, and why: shown under the status for a few seconds. */
export type ChessDelivery = { san: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'vibe-gambit': {
      game: ChessGame
      alert: ChessAlert | null
      delivery: ChessDelivery | null
      screen: 'board' | 'new'
      form: SetupForm
      search: ChessSearch | null
    }
  }
}
