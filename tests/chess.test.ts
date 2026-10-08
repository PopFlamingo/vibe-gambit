import type { CommandRunInput, CommandRunResult, On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'
import { expect, mock, test as kitTest } from 'claude-code/testing'

/** The kit's test with more time: drawing in several environments at once can pass the default 5 s. */
const test = (name: string, body: TestBody) => kitTest(name, { timeoutMs: 60_000 }, body)

import { formatClock, newClock, timeLeft } from '../hooks/clock'
import { figurine, localSan, pickLocale, stringsFor } from '../hooks/i18n'
import { aiChallengeBody, applyLichessEvent, authorizeUrl, callbackResponse, base64url, challengeFor, newSignIn, readCallback, tokenRequestBody } from '../hooks/lichess'
import { formFromWords, hintLine, lichessResult, moveLines, parseMove, statusLine } from '../hooks/register'
import { challengeBody, DEFAULT_FORM, seekBody, speedOf } from '../hooks/setup'
import type { ChessGame } from '../types'
import { applyMove, fromUci, legalMoves, parseSquare, replay, startPosition, toUci } from '../hooks/rules'
import { GAME_FILE, gameState, inGame, run as runChess, savedLichessGame, settle, start, world } from './world'

const sq = (name: string) => parseSquare(name)!

test('the start position has 20 legal moves', () => {
  expect(legalMoves(startPosition())).toHaveLength(20)
})

test('the fool’s mate is checkmate, written in SAN', () => {
  const { position, sans } = replay(['f2f3', 'e7e5', 'g2g4', 'd8h4'])
  expect(sans).toEqual(['f3', 'e5', 'g4', 'Qh4#'])
  expect(statusLine(position, stringsFor('en'), 'w')).toBe('Checkmate: Black wins')
  expect(statusLine(position, stringsFor('fr'), 'w')).toBe('Échec et mat : les Noirs gagnent')
})

test('castling, en passant and promotion', () => {
  const castled = replay(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1g1'])
  expect(castled.sans.at(-1)).toBe('O-O')
  expect(castled.position.board[sq('f1')]).toBe('R')
  expect(castled.position.castling).toBe('kq')

  const passant = replay(['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'])
  expect(passant.sans.at(-1)).toBe('exd6')
  expect(passant.position.board[sq('d5')]).toBe(null)

  const promoted = replay(['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'c8b7', 'a6b7', 'b8c6', 'b7a8q'])
  expect(promoted.sans.at(-1)).toBe('bxa8=Q')
})

test('an illegal move is refused', () => {
  const pinned = replay(['e2e4', 'd7d5', 'f1b5']).position
  expect(fromUci(pinned, 'c7c6')).not.toBe(null)
  const afterC6 = applyMove(startPosition(), fromUci(startPosition(), 'e2e4')!)
  expect(fromUci(afterC6, 'e7e4')).toBe(null)
})

test('move lines pair the moves', () => {
  expect(moveLines(['e4', 'e5', 'Nf3'])).toEqual(['1. e4 e5', '2. Nf3'])
})

const PANE = {
  component: 'Pane',
  requestId: 'chess',
  props: {
    title: 'Échecs',
    isFocused: true,
    bodyColumns: 21,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('on a Lichess game: click e2 then e4, then drag the knight once Black answered', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/move\//, { status: 200, text: '{"ok":true}' })
  const stream = await inGame(w, $, [])
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  await ui.resize({ columns: 19, rows: 9, in: 'board' })
  // After two label columns, a half-cell edge then each piece's cell every two cells. e2 = column 4, row 6 from the top.
  const at = (file: number, rowFromTop: number) => ({ x: 2 + 1 + file * 2, y: rowFromTop })
  await ui.pointer({ type: 'down', button: 'left', ...at(4, 6), in: 'board' })
  await ui.pointer({ type: 'up', button: 'left', ...at(4, 6), in: 'board' })
  await ui.pointer({ type: 'down', button: 'left', ...at(4, 4), in: 'board' })
  await ui.pointer({ type: 'up', button: 'left', ...at(4, 4), in: 'board' })
  expect(await ui.find({ type: 'Text', text: /^1\.\se4$/ })).toBeDefined()
  await settle(w.clock)
  expect(w.asked(/\/move\/e2e4$/)).toHaveLength(1)

  stream.push(gameState('e2e4 e7e5'))
  await settle(w.clock)
  await ui.pointer({ type: 'down', button: 'left', ...at(6, 7), in: 'board' })
  await ui.pointer({ type: 'move', button: 'left', ...at(5, 5), in: 'board' })
  await ui.pointer({ type: 'up', button: 'left', ...at(5, 5), in: 'board' })
  expect(await ui.find({ type: 'Text', text: /^1\.\se4\se5\s+2\.\sNf3$/ })).toBeDefined()
  await settle(w.clock)
  expect(w.asked(/\/move\/g1f3$/)).toHaveLength(1)
  await ui.unmount()
})

test('the arrows and Enter play too', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/move\//, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, [])
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  await ui.resize({ columns: 19, rows: 9, in: 'board' })
  await ui.key({ key: 'return', in: 'board' }) // shows the cursor on e2
  await ui.key({ key: 'right', in: 'board' }) // f2
  await ui.key({ key: 'right', in: 'board' }) // g2
  await ui.key({ key: 'left', in: 'board' }) // f2
  await ui.key({ key: 'left', in: 'board' }) // e2
  await ui.key({ key: 'return', in: 'board' }) // pick the pawn
  await ui.key({ key: 'up', in: 'board' })
  await ui.key({ key: 'up', in: 'board' })
  await ui.key({ key: 'return', in: 'board' }) // e4
  expect(await ui.find({ type: 'Text', text: /^1\.\se4$/ })).toBeDefined()
  await settle(w.clock)
  expect(w.asked(/\/move\/e2e4$/)).toHaveLength(1)
  await ui.unmount()
})

test('/chess shows the board, then hides it', async ($, on) => {
  mock.env(on, { LANG: 'en_US.UTF-8' })
  mock.clock(on)
  // The surface beneath: one pane, shown while open.
  let isOpen = false
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'chess', title: 'Échecs', isShown: true, isFocused: true, isPlaced: true }] : [],
  }))
  on('ui.open', () => {
    isOpen = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    isOpen = false
    return { value: undefined }
  })
  const run = () =>
    $.command.run({
      command: 'chess',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 200 },
    })
  expect((await run()).text).toMatch(/open/)
  expect(isOpen).toBe(true)
  expect((await run()).text).toMatch(/hidden/)
  expect(isOpen).toBe(false)
})

test('the language: the option, then Claude Code’s setting, then the locale; English otherwise', () => {
  expect(pickLocale([undefined, undefined, undefined, undefined, 'fr_FR.UTF-8'])).toBe('fr')
  expect(pickLocale(['auto', 'Français', 'en_US.UTF-8'])).toBe('fr')
  expect(pickLocale(['en', 'french', 'fr_FR.UTF-8'])).toBe('en')
  expect(pickLocale([undefined, undefined, 'C', 'de_DE.UTF-8'])).toBe('en')
  expect(pickLocale([])).toBe('en')
})

test('French SAN uses French piece letters', () => {
  expect(['Nf3', 'Qh4#', 'exd6', 'bxa8=Q', 'O-O', 'Kxe2'].map(san => localSan(san, 'fr'))).toEqual([
    'Cf3',
    'Dh4#',
    'exd6',
    'bxa8=D',
    'O-O',
    'Rxe2',
  ])
  expect(localSan('Nf3', 'en')).toBe('Nf3')
})

test('a French locale draws the pane in French', async ($, on) => {
  const w = world(on, { lang: 'fr_FR.UTF-8' })
  await inGame(w, $, ['e2e4', 'e7e5'])
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'À vous de jouer' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'resign' })).toMatchObject({ text: expect.stringContaining('Abandonner') })
  await ui.unmount()
})

test('with the board hidden, the opponent’s move and both clocks show under the prompt until the person plays', async ($, on) => {
  const w = world(on, { lang: 'fr_FR.UTF-8' })
  w.route('POST', /\/move\//, { status: 200, text: '{"ok":true}' })
  // The engine's hint line, beneath the plugin: it shows the tail the plugin hands it.
  on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ children: e.props.tail ?? '' }))
  const stream = await inGame(w, $, ['e2e4'])
  const hint = await $.ui.mount({
    plugin: 'vibe-gambit',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  })
  const tail = async () => (await hint.find({ type: 'Text' }))?.text

  stream.push(gameState('e2e4 e7e5'))
  await settle(w.clock)
  await hint.redraw()
  expect(w.toasts.some(text => text.includes('♟e5'))).toBe(true)
  expect(await tail()).toMatch(/^♔ \S+  ♚ \S+ · Noirs ♟e5 · À vous de jouer$/)

  await runChess($, 'Cf3')
  await settle(w.clock)
  await hint.redraw()
  expect(await tail()).toMatch(/^♔ \S+  ♚ \S+ · Blancs ♞f3 · Trait aux Noirs$/)
  await hint.unmount()
})

test('a typed move: SAN in English or French, or UCI', () => {
  const start = replay([]).position
  const uci = (text: string, locale: 'en' | 'fr' = 'fr') => {
    const move = parseMove(start, text, locale)
    return move ? toUci(move) : undefined
  }
  expect(uci('Cf3')).toBe('g1f3')
  expect(uci('Nf3', 'en')).toBe('g1f3')
  expect(uci('e4')).toBe('e2e4')
  expect(uci('g1f3')).toBe('g1f3')
  expect(uci('e5')).toBe(undefined)
  expect(uci('Cd2')).toBe(undefined)

  const ready = replay(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']).position
  expect(toUci(parseMove(ready, 'O-O', 'fr')!)).toBe('e1g1')
  expect(toUci(parseMove(ready, '0-0', 'en')!)).toBe('e1g1')
  expect(toUci(parseMove(ready, 'Fxf7+', 'fr')!)).toBe('c4f7')

  // Both knights reach d2: the bare move is ambiguous, the file settles it.
  const knights = replay(['d2d4', 'a7a6', 'g1f3', 'a6a5']).position
  expect(parseMove(knights, 'Cd2', 'fr')).toBe(undefined)
  expect(toUci(parseMove(knights, 'Cbd2', 'fr')!)).toBe('b1d2')
  expect(toUci(parseMove(knights, 'Nfd2', 'en')!)).toBe('f3d2')
})

test('/chess <move> plays without the board and answers in a line', async ($, on) => {
  const w = world(on, { lang: 'fr_FR.UTF-8' })
  w.route('POST', /\/move\//, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, [])
  expect((await runChess($, 'e5')).text).toBe('« e5 » n’est pas un coup légal ici. Écrivez-le comme Cf3, e4, exd5, O-O ou g1f3.')
  expect((await runChess($, 'e4')).text).toBe('Joué e4. Trait aux Noirs.')
})

test('/chess <move> with no game under way says how to start one', async ($, on) => {
  world(on)
  await start($)
  expect((await runChess($, 'e4')).text).toBe('No game under way: /chess new to start one.')
})

test('the clock: the side to move’s time runs down; the others’ stays', () => {
  const clock = { ...newClock('5+3'), runningSince: 1_000 }
  expect(clock.whiteMs).toBe(300_000)
  expect(timeLeft(clock, 'b', 'b', 11_000)).toBe(290_000)
  expect(timeLeft(clock, 'w', 'b', 11_000)).toBe(300_000)
  expect(timeLeft(clock, 'b', 'b', 400_000)).toBe(0)
  expect(formatClock(599_001)).toBe('10:00')
  expect(formatClock(61_000)).toBe('1:01')
  expect(formatClock(3_725_000)).toBe('1:02:05')
  expect(newClock('nonsense').initialMs).toBe(600_000)
})

test('figurines draw the piece instead of its letter', () => {
  expect(['Nf6', 'h6', 'exd5', 'Qxh7#', 'e8=Q+', 'O-O-O'].map(figurine)).toEqual(['♞f6', '♟h6', '♟exd5', '♛xh7#', '♟e8=♛+', 'O-O-O'])
})

test('the pane draws with an alert pending, and /chess takes the alert down', async ($, on) => {
  const w = world(on)
  on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ children: e.props.tail ?? '' }))
  const stream = await inGame(w, $, ['e2e4'])
  stream.push(gameState('e2e4 e7e5')) // Black plays with the board hidden: an alert is pending.
  await settle(w.clock)
  expect(w.saved().alert).not.toBe(null)
  const pane = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: 'Your turn' })).toBeDefined()

  await runChess($, '') // Shows the board: the alert goes.
  w.show(false)
  const hint = await $.ui.mount({
    plugin: 'vibe-gambit',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '' },
  })
  expect((await hint.find({ type: 'Text' }))?.text).toMatch(/^♔ \S+  ♚ \S+ · Black ♟e5 · Your turn$/)
  await pane.unmount()
  await hint.unmount()
})

test('global scope: moves go to the shared file, and what another session plays shows here', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/move\//, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, [])
  await runChess($, 'e4')
  const mine = w.saved()
  expect(mine.game.moves).toEqual(['e2e4'])

  // Another session, following the stream, writes Black's answer in the file.
  w.files.set(
    GAME_FILE,
    JSON.stringify({ ...mine, version: mine.version + 1, writer: 'other', game: { ...mine.game, pending: undefined, moves: ['e2e4', 'e7e5'] } }),
  )
  await settle(w.clock, 1000)
  await runChess($, '') // Opening the board reads the file first.
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^1\.\se4\se5$/ })).toBeDefined()
  await ui.unmount()

  // A move typed here goes on from the other session's.
  expect((await runChess($, 'Nf3')).text).toBe('Played Nf3. Black to move.')
  expect(w.saved().game.moves).toEqual(['e2e4', 'e7e5', 'g1f3'])
})

test('a session with a game under way saves it at start when no saved game exists', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4']) })
  await start($)
  w.files.delete(GAME_FILE) // As if the game was played before saving existed.
  await start($)
  expect(w.saved().game.moves).toEqual(['e2e4'])
})

test('the board’s left edge colours half a cell, so the a-file is as wide as the others', async ($, on) => {
  world(on, { saved: savedLichessGame([]) })
  await start($)
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  await ui.resize({ columns: 19, rows: 9, in: 'board' })
  // Each rank row opens on '▐': its right half the a-file's colour, its left half the terminal's own.
  const edges = await ui.findAll({ type: 'Text', text: '▐', in: 'board' })
  expect(edges).toHaveLength(8)
  for (const edge of edges) {
    expect(edge.props.color).toBeDefined()
    expect(edge.props.backgroundColor).toBeUndefined()
  }
  await ui.unmount()
})

test('PKCE: the challenge of RFC 7636’s example verifier, and fresh sign-ins', async () => {
  expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  expect([1, 2, 3, 4].map(n => base64url(new Uint8Array(n).fill(255)))).toEqual(['_w', '__8', '____', '_____w'])
  const one = await newSignIn()
  const two = await newSignIn()
  expect(one.verifier).toMatch(/^[\w-]{43}$/)
  expect(one.verifier).not.toBe(two.verifier)
  expect(one.challenge).toBe(await challengeFor(one.verifier))
})

test('the Lichess authorization request and the browser’s answer', () => {
  const url = new URL(authorizeUrl('CHALLENGE', 'STATE'))
  expect(url.origin + url.pathname).toBe('https://lichess.org/oauth')
  const params: Record<string, string> = {}
  url.searchParams.forEach((value, key) => (params[key] = value))
  expect(params).toEqual({
    response_type: 'code',
    client_id: 'vibe-gambit',
    redirect_uri: 'http://127.0.0.1:53123/callback',
    code_challenge_method: 'S256',
    code_challenge: 'CHALLENGE',
    scope: 'board:play',
    state: 'STATE',
  })
  expect(readCallback('GET /callback?code=abc&state=STATE HTTP/1.1\r\nHost: x\r\n', 'STATE')).toEqual({ code: 'abc' })
  expect(readCallback('GET /callback?code=abc&state=OTHER HTTP/1.1\r\n', 'STATE')).toEqual({ error: 'state-mismatch' })
  expect(readCallback('GET /callback?error=access_denied&state=STATE HTTP/1.1\r\n', 'STATE')).toEqual({ error: 'access_denied' })
  expect(readCallback('', 'STATE')).toEqual({ error: 'no-request' })
  expect(new URLSearchParams(tokenRequestBody('abc', 'VERIFIER')).get('code_verifier')).toBe('VERIFIER')
})

test('a Lichess game: the stream’s lines set colours, moves, clocks and how it ended', () => {
  const ai = (level: number) => `Stockfish level ${level}`
  const start: ChessGame = { moves: [], flipped: false }
  // Stockfish has White: the person plays Black, at the bottom.
  const full = applyLichessEvent(
    start,
    {
      type: 'gameFull',
      id: 'abcd1234',
      white: { aiLevel: 3 },
      black: { id: 'popflamingo', name: 'PopFlamingo' },
      clock: { initial: 300_000, increment: 3_000 },
      state: { moves: 'e2e4', wtime: 300_000, btime: 300_000, status: 'started' },
    },
    1_000,
    'PopFlamingo',
    ai,
  )
  expect(full.lichess).toEqual({ gameId: 'abcd1234', color: 'b', opponent: 'Stockfish level 3', status: 'started', winner: undefined })
  expect(full.flipped).toBe(true)
  expect(full.moves).toEqual(['e2e4'])
  expect(full.clock?.runningSince).toBe(null) // Clocks run once both sides have moved.

  const later = applyLichessEvent(full, { type: 'gameState', moves: 'e2e4 e7e5 g1f3', wtime: 295_000, btime: 297_000, status: 'started' }, 9_000, 'PopFlamingo', ai)
  expect(later.moves).toEqual(['e2e4', 'e7e5', 'g1f3'])
  expect(later.clock).toMatchObject({ whiteMs: 295_000, blackMs: 297_000, incrementMs: 3_000, runningSince: 9_000 })
  expect(applyLichessEvent(later, { type: 'chatLine' }, 10_000, 'PopFlamingo', ai)).toBe(later)

  const resigned = applyLichessEvent(later, { type: 'gameState', moves: 'e2e4 e7e5 g1f3', wtime: 1, btime: 1, status: 'resign', winner: 'white' }, 12_000, 'PopFlamingo', ai)
  expect(resigned.clock?.runningSince).toBe(null)
  expect(lichessResult(resigned, stringsFor('fr'))).toBe('Les Noirs abandonnent')
  expect(lichessResult({ ...resigned, lichess: { ...resigned.lichess!, status: 'outoftime' } }, stringsFor('en'))).toBe('Time out: White wins')
  expect(lichessResult({ ...resigned, lichess: { ...resigned.lichess!, status: 'aborted', winner: undefined } }, stringsFor('en'))).toBe('Game aborted')
  expect(lichessResult(later, stringsFor('en'))).toBe(undefined)
})

test('an AI challenge asks Lichess for the level and clock, colour at random', () => {
  const body = new URLSearchParams(aiChallengeBody(3, '5+3'))
  expect([body.get('level'), body.get('clock.limit'), body.get('clock.increment'), body.get('color')]).toEqual(['3', '300', '3', 'random'])
  expect(new URLSearchParams(aiChallengeBody(12, 'nonsense')).get('level')).toBe('8')
})

test('a move in flight stays after Lichess’s moves until Lichess has it, then is no longer pending', () => {
  const ai = (level: number) => `Stockfish ${level}`
  const base: ChessGame = {
    moves: ['e2e4'],
    flipped: false,
    lichess: { gameId: 'g', color: 'w', opponent: 'Stockfish 2', status: 'started' },
    pending: { uci: 'e2e4', index: 0, since: 0 },
  }
  // Lichess has not reached it yet (a draw offer, say): still shown, still pending.
  const early = applyLichessEvent(base, { type: 'gameState', moves: '', status: 'started' }, 1, undefined, ai)
  expect([early.moves, early.pending?.uci]).toEqual([['e2e4'], 'e2e4'])
  // Lichess has it: no longer pending.
  const taken = applyLichessEvent(base, { type: 'gameState', moves: 'e2e4 e7e5', status: 'started' }, 2, undefined, ai)
  expect([taken.moves, taken.pending]).toEqual([['e2e4', 'e7e5'], undefined])
})

/** A disk in memory beneath the plugin, so a test can stand for another session writing the game. */
function memoryDisk(on: On) {
  const files = new Map<string, string>()
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'no such file' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'conversation-1' }))
  return files
}

const GLOBAL_FILE = '/Users/me/.claude/vibe-gambit/game.json'

/** A Lichess game under way, as the shared file holds it, with a token on disk. */
function lichessSetup(on: On, moveAnswer: { status: number; text: string }, exported: () => string) {
  mock.env(on, { LANG: 'en_US.UTF-8', HOME: '/Users/me' })
  const clock = mock.clock(on)
  const files = memoryDisk(on)
  files.set('/Users/me/.config/vibe-gambit/lichess-token', 'TOKEN')
  files.set(
    GLOBAL_FILE,
    JSON.stringify({
      version: 1,
      writer: 'other',
      game: { moves: [], flipped: false, lichess: { gameId: 'g1', color: 'w', opponent: 'Stockfish 2', status: 'started' } },
      alert: null,
    }),
  )
  const asked: string[] = []
  on('http.fetch', (_, e) => {
    asked.push(`${e.init?.method ?? 'GET'} ${e.url}`)
    if (e.url.includes('/move/')) return { value: { ...moveAnswer, ok: moveAnswer.status < 300, headers: {} } }
    if (e.url.includes('/game/export/')) return { value: { status: 200, ok: true, headers: {}, text: exported() } }
    return { deny: 'unexpected request' }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  const saved = () => JSON.parse(files.get(GLOBAL_FILE)!).game as ChessGame
  return { clock, asked, saved }
}

const runIn = ($: { command: { run: (input: CommandRunInput) => Promise<CommandRunResult> } }, args: string) =>
  $.command.run({ command: 'chess', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

test('Lichess refuses the move: it leaves the board, with the reason', async ($, on) => {
  const { saved } = lichessSetup(on, { status: 400, text: '{"error":"Not your turn, or game already over"}' }, () => '{}')
  await runIn($, '') // Takes in the shared game.
  expect((await runIn($, 'e4')).text).toBe('Lichess refused the move (Not your turn, or game already over).')
  expect(saved().moves).toEqual([])
})

test('Lichess plays the move: it stays, no longer pending', async ($, on) => {
  const { saved } = lichessSetup(on, { status: 200, text: '{"ok":true}' }, () => '{}')
  await runIn($, '')
  expect((await runIn($, 'e4')).text).toBe('Played e4. Black to move.')
  expect([saved().moves, saved().pending]).toEqual([['e2e4'], undefined])
})



test('the line under the prompt shows a Lichess game before its clocks run', () => {
  const current: ChessGame = {
    moves: ['e2e4'],
    flipped: true,
    clock: { initialMs: 300_000, incrementMs: 3_000, whiteMs: 300_000, blackMs: 300_000, runningSince: null },
    lichess: { gameId: 'g', color: 'b', opponent: 'Stockfish 2', status: 'started' },
  }
  expect(hintLine(current, null, stringsFor('en'), 'en', 0)).toBe('♔ 5:00  ♚ 5:00 · White ♟e4 · Your turn')
  const over = { ...current, lichess: { ...current.lichess!, status: 'resign' } }
  expect(hintLine(over, null, stringsFor('en'), 'en', 0)).toBe(undefined)
})

test('shortcuts: /chess lichess rapid, /chess lichess stockfish 3 5+3 black, /chess lichess friend magnus; no local game', () => {
  const base = DEFAULT_FORM
  expect(formFromWords(['lichess', 'rapid'], base)).toMatchObject({ opponent: 'random', timeControl: '10+0', color: 'random' })
  expect(formFromWords(['lichess', 'classique'], base)).toMatchObject({ opponent: 'random', timeControl: '30+0' })
  expect(formFromWords(['lichess', '15+10', 'rated'], base)).toMatchObject({ opponent: 'random', timeControl: '15+10', rated: true })
  // Blitz is no random pairing on the Board API: the nearest rapid default instead.
  expect(formFromWords(['lichess', '5+3'], base)).toMatchObject({ opponent: 'random', timeControl: '10+0' })
  expect(formFromWords(['lichess', 'stockfish', '3', '5+3', 'black'], base)).toMatchObject({ opponent: 'stockfish', level: 3, timeControl: '5+3', color: 'black' })
  expect(formFromWords(['lichess', 'friend', '@Magnus', '3+2', 'noirs'], base)).toMatchObject({ opponent: 'friend', friend: 'Magnus', timeControl: '3+2', color: 'black' })
  expect(formFromWords(['local', '10+0'], base)).toBe(undefined)
  expect(formFromWords(['new', 'lichess', 'rapide'], base)).toMatchObject({ opponent: 'random' })
  expect(formFromWords(['new'], base)).toBe(undefined)
  expect(formFromWords(['lichess'], base)).toBe(undefined)
})

test('Lichess sends castling king-to-rook (e1h1): it reads as castling', () => {
  const { position, sans } = replay(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1h1'])
  expect(sans.at(-1)).toBe('O-O')
  expect(position.board[sq('g1')]).toBe('K')
  expect(position.board[sq('f1')]).toBe('R')
})

test('seek and challenge bodies, and speeds', () => {
  const seek = new URLSearchParams(seekBody({ ...DEFAULT_FORM, opponent: 'random', timeControl: '15+10', color: 'random' }))
  expect([seek.get('time'), seek.get('increment'), seek.get('rated'), seek.has('color')]).toEqual(['15', '10', 'false', false])
  // A random pairing never names a colour, whatever the form held.
  expect(new URLSearchParams(seekBody({ ...DEFAULT_FORM, timeControl: '10+0', color: 'white' })).has('color')).toBe(false)
  const challenge = new URLSearchParams(challengeBody({ ...DEFAULT_FORM, opponent: 'friend', timeControl: '3+2', color: 'black', rated: true }))
  expect([challenge.get('clock.limit'), challenge.get('clock.increment'), challenge.get('color'), challenge.get('rated'), challenge.get('keepAliveStream')]).toEqual(['180', '2', 'black', 'true', 'true'])
  expect(['1+0', '3+2', '5+3', '10+0', '15+10', '30+0'].map(speedOf)).toEqual(['bullet', 'blitz', 'blitz', 'rapid', 'rapid', 'classical'])
})

test('a draw offer from the stream, and its end', () => {
  const ai = (level: number) => `Stockfish ${level}`
  const base: ChessGame = { moves: ['e2e4', 'e7e5'], flipped: false, lichess: { gameId: 'g', color: 'w', opponent: 'Magnus 2850', status: 'started' } }
  const offered = applyLichessEvent(base, { type: 'gameState', moves: 'e2e4 e7e5', status: 'started', bdraw: true }, 1, undefined, ai)
  expect(offered.lichess?.drawOffer).toBe('b')
  expect(applyLichessEvent(offered, { type: 'gameState', moves: 'e2e4 e7e5 g1f3', status: 'started' }, 2, undefined, ai).lichess?.drawOffer).toBe(undefined)
})

test('the page after sign-in offers commands to start a game at once', () => {
  const page = callbackResponse(stringsFor('fr').lichessPage)
  expect(page).toContain('<code>/chess lichess rapid</code><span>une partie en 10+0 contre un adversaire au hasard</span>')
  const length = Number(/Content-Length: (\d+)/.exec(page)?.[1])
  expect(new TextEncoder().encode(page.split('\r\n\r\n').slice(1).join('\r\n\r\n')).length).toBe(length)
})
