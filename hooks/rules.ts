// Chess rules: positions, legal moves, SAN. Squares are 0..63, a1 = 0, h8 = 63.
// Pieces are FEN letters: uppercase white, lowercase black.

export type Color = 'w' | 'b'
export type Piece = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
export type Move = { from: number; to: number; promotion?: 'q' | 'r' | 'b' | 'n' }
export type Position = {
  board: (Piece | null)[]
  turn: Color
  castling: string
  enPassant: number | null
  halfmove: number
  fullmove: number
}
export type Status = 'playing' | 'checkmate' | 'stalemate' | 'draw'

const FILES = 'abcdefgh'
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const ROOK = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const BISHOP = [[1, 1], [-1, 1], [-1, -1], [1, -1]]

export const fileOf = (sq: number) => sq % 8
export const rankOf = (sq: number) => Math.floor(sq / 8)
export const squareName = (sq: number) => `${FILES[fileOf(sq)]}${rankOf(sq) + 1}`
export const squareAt = (file: number, rank: number) => rank * 8 + file
export const colorOf = (piece: Piece): Color => (piece === piece.toUpperCase() ? 'w' : 'b')
const opponent = (color: Color): Color => (color === 'w' ? 'b' : 'w')
const onBoard = (file: number, rank: number) => file >= 0 && file < 8 && rank >= 0 && rank < 8

export function parseSquare(name: string): number | null {
  const file = FILES.indexOf(name[0] ?? '')
  const rank = Number(name[1]) - 1
  return name.length === 2 && file >= 0 && rank >= 0 && rank < 8 ? squareAt(file, rank) : null
}

export function startPosition(): Position {
  const back = 'RNBQKBNR'.split('') as Piece[]
  const board: (Piece | null)[] = Array(64).fill(null)
  back.forEach((piece, file) => {
    board[squareAt(file, 0)] = piece
    board[squareAt(file, 1)] = 'P'
    board[squareAt(file, 6)] = 'p'
    board[squareAt(file, 7)] = piece.toLowerCase() as Piece
  })
  return { board, turn: 'w', castling: 'KQkq', enPassant: null, halfmove: 0, fullmove: 1 }
}

export function isAttacked(board: (Piece | null)[], sq: number, by: Color): boolean {
  const f = fileOf(sq)
  const r = rankOf(sq)
  const is = (file: number, rank: number, kinds: string) => {
    if (!onBoard(file, rank)) return false
    const piece = board[squareAt(file, rank)]
    return piece != null && colorOf(piece) === by && kinds.includes(piece.toUpperCase())
  }
  const pawnRank = by === 'w' ? r - 1 : r + 1
  if (is(f - 1, pawnRank, 'P') || is(f + 1, pawnRank, 'P')) return true
  if (KNIGHT.some(([df, dr]) => is(f + df!, r + dr!, 'N'))) return true
  if (KING.some(([df, dr]) => is(f + df!, r + dr!, 'K'))) return true
  const slides = (dirs: number[][], kinds: string) =>
    dirs.some(([df, dr]) => {
      for (let file = f + df!, rank = r + dr!; onBoard(file, rank); file += df!, rank += dr!) {
        const piece = board[squareAt(file, rank)]
        if (piece != null) return colorOf(piece) === by && kinds.includes(piece.toUpperCase())
      }
      return false
    })
  return slides(ROOK, 'RQ') || slides(BISHOP, 'BQ')
}

export function kingSquare(pos: Position, color: Color): number {
  return pos.board.indexOf(color === 'w' ? 'K' : 'k')
}

export function inCheck(pos: Position, color: Color = pos.turn): boolean {
  const king = kingSquare(pos, color)
  return king >= 0 && isAttacked(pos.board, king, opponent(color))
}

function pseudoMoves(pos: Position): Move[] {
  const moves: Move[] = []
  const { board, turn } = pos
  const add = (from: number, to: number) => {
    const isPromotion = board[from]?.toUpperCase() === 'P' && (rankOf(to) === 0 || rankOf(to) === 7)
    if (isPromotion) for (const promotion of ['q', 'r', 'b', 'n'] as const) moves.push({ from, to, promotion })
    else moves.push({ from, to })
  }
  board.forEach((piece, from) => {
    if (piece == null || colorOf(piece) !== turn) return
    const f = fileOf(from)
    const r = rankOf(from)
    const target = (file: number, rank: number) => (onBoard(file, rank) ? board[squareAt(file, rank)] : undefined)
    const canLand = (file: number, rank: number) => {
      const there = target(file, rank)
      return there === null || (there !== undefined && colorOf(there) !== turn)
    }
    const kind = piece.toUpperCase()
    if (kind === 'P') {
      const dir = turn === 'w' ? 1 : -1
      const home = turn === 'w' ? 1 : 6
      if (target(f, r + dir) === null) {
        add(from, squareAt(f, r + dir))
        if (r === home && target(f, r + 2 * dir) === null) add(from, squareAt(f, r + 2 * dir))
      }
      for (const df of [-1, 1]) {
        const there = target(f + df, r + dir)
        const to = onBoard(f + df, r + dir) ? squareAt(f + df, r + dir) : -1
        if ((there != null && colorOf(there) !== turn) || (to >= 0 && to === pos.enPassant)) add(from, to)
      }
    } else if (kind === 'N' || kind === 'K') {
      for (const [df, dr] of kind === 'N' ? KNIGHT : KING) {
        if (canLand(f + df!, r + dr!)) add(from, squareAt(f + df!, r + dr!))
      }
      if (kind === 'K') moves.push(...castlingMoves(pos, from))
    } else {
      const dirs = kind === 'R' ? ROOK : kind === 'B' ? BISHOP : [...ROOK, ...BISHOP]
      for (const [df, dr] of dirs) {
        for (let file = f + df!, rank = r + dr!; onBoard(file, rank); file += df!, rank += dr!) {
          const there = board[squareAt(file, rank)]
          if (there == null) add(from, squareAt(file, rank))
          else {
            if (colorOf(there) !== turn) add(from, squareAt(file, rank))
            break
          }
        }
      }
    }
  })
  return moves
}

function castlingMoves(pos: Position, from: number): Move[] {
  const { board, turn, castling } = pos
  const rank = turn === 'w' ? 0 : 7
  if (from !== squareAt(4, rank) || inCheck(pos, turn)) return []
  const enemy = opponent(turn)
  const sides = [
    { right: turn === 'w' ? 'K' : 'k', empty: [5, 6], safe: [5, 6], to: 6 },
    { right: turn === 'w' ? 'Q' : 'q', empty: [1, 2, 3], safe: [3, 2], to: 2 },
  ]
  return sides
    .filter(side => castling.includes(side.right))
    .filter(side => side.empty.every(file => board[squareAt(file, rank)] == null))
    .filter(side => side.safe.every(file => !isAttacked(board, squareAt(file, rank), enemy)))
    .map(side => ({ from, to: squareAt(side.to, rank) }))
}

export function applyMove(pos: Position, move: Move): Position {
  const board = [...pos.board]
  const piece = board[move.from]!
  const captured = board[move.to]
  const kind = piece.toUpperCase()
  const rank = rankOf(move.from)
  board[move.to] = move.promotion ? ((pos.turn === 'w' ? move.promotion.toUpperCase() : move.promotion) as Piece) : piece
  board[move.from] = null
  if (kind === 'P' && move.to === pos.enPassant) board[squareAt(fileOf(move.to), rank)] = null
  if (kind === 'K' && Math.abs(fileOf(move.to) - fileOf(move.from)) === 2) {
    const isShort = fileOf(move.to) === 6
    board[squareAt(isShort ? 5 : 3, rank)] = board[squareAt(isShort ? 7 : 0, rank)]!
    board[squareAt(isShort ? 7 : 0, rank)] = null
  }
  const lost = (sq: number) => ({ 0: 'Q', 7: 'K', 56: 'q', 63: 'k' } as Record<number, string>)[sq] ?? ''
  let castling = pos.castling
  if (kind === 'K') castling = castling.replace(pos.turn === 'w' ? /[KQ]/g : /[kq]/g, '')
  castling = castling.replace(lost(move.from), '').replace(lost(move.to), '')
  const isDouble = kind === 'P' && Math.abs(rankOf(move.to) - rank) === 2
  return {
    board,
    turn: opponent(pos.turn),
    castling,
    enPassant: isDouble ? (move.from + move.to) / 2 : null,
    halfmove: kind === 'P' || captured != null ? 0 : pos.halfmove + 1,
    fullmove: pos.fullmove + (pos.turn === 'b' ? 1 : 0),
  }
}

export function legalMoves(pos: Position): Move[] {
  return pseudoMoves(pos).filter(move => !inCheck(applyMove(pos, move), pos.turn))
}

export function status(pos: Position): Status {
  if (legalMoves(pos).length === 0) return inCheck(pos) ? 'checkmate' : 'stalemate'
  if (pos.halfmove >= 100) return 'draw'
  const rest = pos.board.filter(p => p != null && p.toUpperCase() !== 'K').map(p => p!.toUpperCase())
  if (rest.length === 0 || (rest.length === 1 && 'NB'.includes(rest[0]!))) return 'draw'
  return 'playing'
}

export function toUci(move: Move): string {
  return squareName(move.from) + squareName(move.to) + (move.promotion ?? '')
}

/**
 * The legal move a UCI string names. Castling is read in both forms: king to its square (e1g1) and
 * king to rook (e1h1), the form Lichess's game stream sends.
 */
export function fromUci(pos: Position, uci: string): Move | null {
  const from = parseSquare(uci.slice(0, 2))
  let to = parseSquare(uci.slice(2, 4))
  const promotion = uci[4] ?? undefined
  const piece = from === null ? null : pos.board[from]
  const target = to === null ? null : pos.board[to]
  const isKingOnRook = piece != null && target != null && piece.toUpperCase() === 'K' && target === (piece === 'K' ? 'R' : 'r')
  if (isKingOnRook && from !== null && to !== null) to = squareAt(fileOf(to) > fileOf(from) ? 6 : 2, rankOf(from))
  return legalMoves(pos).find(m => m.from === from && m.to === to && m.promotion === promotion) ?? null
}

export function san(pos: Position, move: Move): string {
  const piece = pos.board[move.from]!
  const kind = piece.toUpperCase()
  const isCapture = pos.board[move.to] != null || (kind === 'P' && move.to === pos.enPassant)
  let text: string
  if (kind === 'K' && Math.abs(fileOf(move.to) - fileOf(move.from)) === 2) {
    text = fileOf(move.to) === 6 ? 'O-O' : 'O-O-O'
  } else if (kind === 'P') {
    text = (isCapture ? `${FILES[fileOf(move.from)]}x` : '') + squareName(move.to)
    if (move.promotion) text += `=${move.promotion.toUpperCase()}`
  } else {
    const rivals = legalMoves(pos).filter(
      m => m.to === move.to && m.from !== move.from && pos.board[m.from] === piece,
    )
    let hint = ''
    if (rivals.length > 0) {
      const sameFile = rivals.some(m => fileOf(m.from) === fileOf(move.from))
      const sameRank = rivals.some(m => rankOf(m.from) === rankOf(move.from))
      hint = !sameFile ? FILES[fileOf(move.from)]! : !sameRank ? String(rankOf(move.from) + 1) : squareName(move.from)
    }
    text = kind + hint + (isCapture ? 'x' : '') + squareName(move.to)
  }
  const after = applyMove(pos, move)
  if (inCheck(after)) text += status(after) === 'checkmate' ? '#' : '+'
  return text
}

/** Replays UCI moves from the start; stops at the first one that is not legal. */
export function replay(uciMoves: readonly string[]): { position: Position; sans: string[]; last: Move | null } {
  let position = startPosition()
  const sans: string[] = []
  let last: Move | null = null
  for (const uci of uciMoves) {
    const move = fromUci(position, uci)
    if (move == null) break
    sans.push(san(position, move))
    position = applyMove(position, move)
    last = move
  }
  return { position, sans, last }
}
