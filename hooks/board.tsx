// The board, drawn on the surface's thread: click a piece then its square, drag it,
// or move a cursor with the arrows and press Enter. Moves go to the hooks module by post.
import type { ClientModule } from 'claude-code'

import type { BoardProps, BoardState } from '../types'

const GLYPHS: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
const LIGHT = '#c49a6c'
const DARK = '#8b5a33'
const LAST_LIGHT = '#c9b35a'
const LAST_DARK = '#9a8530'
const SELECTED = '#6f9a4e'
const AIMED = '#5f8fbf'
const CHECK = '#d0453c'
const CAPTURE = '#b86b4b'
const WHITE_PIECE = '#fffaf0'
const BLACK_PIECE = '#141414'
const DOT = '#2f4a1f'
const LABEL_COLUMNS = 2
/** How long a move drawn ahead may wait for the hooks module before it is taken back. */
const PENDING_MS = 1500

/** The pieces once a move is made, as drawn ahead of the hooks module: the castling rook goes too. */
function movedPieces(pieces: string, from: number, to: number): string {
  const cells = pieces.split('')
  const piece = cells[from] ?? '.'
  cells[to] = piece
  cells[from] = '.'
  if (piece.toLowerCase() === 'k' && Math.abs((to % 8) - (from % 8)) === 2) {
    const isShort = to % 8 === 6
    const rank = Math.floor(from / 8) * 8
    cells[rank + (isShort ? 5 : 3)] = cells[rank + (isShort ? 7 : 0)] ?? '.'
    cells[rank + (isShort ? 7 : 0)] = '.'
  }
  return cells.join('')
}

const Board: ClientModule<BoardProps, BoardState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state: BoardState = surface.state ?? { selected: null, cursor: null, aimed: null, dragFrom: null }
  // A move just made shows at once; the pieces the hooks module sends next replace it. One the module
  // did not take (refused, or not the person's turn) goes after PENDING_MS.
  const pending = state.pending && state.pending.base === props.pieces && Date.now() - state.pending.at < PENDING_MS ? state.pending : null
  if (surface.state === undefined) {
    surface.every(250, () => {
      const held = surface.state?.pending
      if (held && Date.now() - held.at >= PENDING_MS) surface.setState({ ...surface.state!, pending: null })
    })
  }
  const pieces = pending ? movedPieces(props.pieces, pending.from, pending.to) : props.pieces
  const last = pending ? ([pending.from, pending.to] as [number, number]) : props.last
  const targetsOf = (sq: number | null) => (pending || sq == null ? [] : (props.legal[String(sq)] ?? []))
  const selected = targetsOf(state.selected).length > 0 ? state.selected : null

  const squareAtCell = (x: number, y: number): number | null => {
    // A square is a half cell, its piece's cell, a half cell: the edge cells are shared.
    const col = Math.min(7, Math.floor((x - LABEL_COLUMNS) / 2))
    const row = y
    if (x < LABEL_COLUMNS || x > LABEL_COLUMNS + 16 || row < 0 || row > 7) return null
    return props.flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col
  }

  const set = (next: Partial<BoardState>) => surface.setState({ ...state, selected, ...next })

  const play = (from: number, to: number) => {
    surface.post({ type: 'move', from, to })
    set({ selected: null, dragFrom: null, aimed: null, pending: { from, to, base: props.pieces, at: Date.now() } })
  }

  // One click (or Enter) on a square: move there if it is a target, else pick the piece.
  const choose = (sq: number) => {
    if (selected != null && targetsOf(selected).includes(sq)) play(selected, sq)
    else set({ selected: targetsOf(sq).length > 0 && sq !== selected ? sq : null, dragFrom: null })
  }

  surface.onPointer(event => {
    const sq = squareAtCell(event.x, event.y)
    if (event.type === 'down' && event.button === 'left') {
      if (sq == null) return set({ selected: null })
      if (selected != null && targetsOf(selected).includes(sq)) return play(selected, sq)
      const canPick = targetsOf(sq).length > 0
      return set({ selected: canPick ? sq : null, dragFrom: canPick ? sq : null, aimed: null })
    }
    if (event.type === 'move' && state.dragFrom != null) {
      if (sq !== state.aimed) set({ aimed: sq })
      return
    }
    if (event.type === 'up' && state.dragFrom != null) {
      const from = state.dragFrom
      if (sq != null && sq !== from && targetsOf(from).includes(sq)) return play(from, sq)
      return set({ dragFrom: null, aimed: null })
    }
  })

  surface.onKey(event => {
    const start = props.flipped ? 52 : 12
    const cursor = state.cursor ?? start
    const step: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] }
    const delta = step[event.key]
    if (delta) {
      const sign = props.flipped ? -1 : 1
      const file = Math.min(7, Math.max(0, (cursor % 8) + sign * delta[0]))
      const rank = Math.min(7, Math.max(0, Math.floor(cursor / 8) + sign * delta[1]))
      return set({ cursor: rank * 8 + file })
    }
    if (event.key === 'return' || event.key === ' ') {
      if (state.cursor == null) return set({ cursor })
      return choose(cursor)
    }
  })

  const targets = targetsOf(state.dragFrom ?? selected)
  const backgroundOf = (sq: number) => {
    const isLight = (Math.floor(sq / 8) + (sq % 8)) % 2 === 1
    if (sq === props.check) return CHECK
    if (sq === selected) return SELECTED
    if (sq === state.aimed || sq === state.cursor) return AIMED
    if (last && (sq === last[0] || sq === last[1])) return isLight ? LAST_LIGHT : LAST_DARK
    return isLight ? LIGHT : DARK
  }
  const squareOf = (row: number, col: number) => (props.flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col)
  // The cell between two squares: its left half the left square's color, its right half the right one's.
  // The board's left edge has no square on its left: its right half is drawn, the rest is the terminal's.
  const edge = (key: string, left: string | undefined, right: string | undefined) =>
    left === undefined ? (
      <Text key={key} color={right}>
        ▐
      </Text>
    ) : (
      <Text key={key} color={left} backgroundColor={right}>
        ▌
      </Text>
    )

  const lines = []
  for (let row = 0; row < 8; row++) {
    const rank = props.flipped ? row + 1 : 8 - row
    const colors = [0, 1, 2, 3, 4, 5, 6, 7].map(col => {
      const sq = squareOf(row, col)
      const piece = pieces[sq] ?? '.'
      return targets.includes(sq) && piece !== '.' ? CAPTURE : backgroundOf(sq)
    })
    const cells = [edge(`e${row}-0`, undefined, colors[0])]
    for (let col = 0; col < 8; col++) {
      const sq = squareOf(row, col)
      const piece = pieces[sq] ?? '.'
      const glyph = piece !== '.' ? (GLYPHS[piece.toLowerCase()] ?? '?') : targets.includes(sq) ? '●' : ' '
      const color = piece === '.' ? DOT : piece === piece.toUpperCase() ? WHITE_PIECE : BLACK_PIECE
      cells.push(
        <Text key={`c${sq}`} backgroundColor={colors[col]} color={color} bold>
          {glyph}
        </Text>,
      )
      cells.push(col < 7 ? edge(`e${row}-${col + 1}`, colors[col], colors[col + 1]) : <Text key={`e${row}-8`} color={colors[7]}>▌</Text>)
    }
    lines.push(
      <Box key={`r${row}`} flexDirection="row">
        <Text dimColor>{`${rank} `}</Text>
        {cells}
      </Box>,
    )
  }
  const files = ` ${(props.flipped ? 'hgfedcba' : 'abcdefgh').split('').join(' ')} `

  return (
    <Box flexDirection="column">
      {lines}
      <Text dimColor>{' '.repeat(LABEL_COLUMNS) + files}</Text>
    </Box>
  )
}

export default Board
