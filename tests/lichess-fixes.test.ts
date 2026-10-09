// Fixes from the Lichess integration review, each test written to fail before its fix.
import type { TestBody } from 'claude-code/testing'
import { expect, test as kitTest } from 'claude-code/testing'

import type { ChessGame } from '../types'

import { applyLichessEvent, readCallback } from '../hooks/lichess'
import { stringsFor } from '../hooks/i18n'
import { LISTENERS, hintLine, lichessResult } from '../hooks/register'
import { mergeGames } from '../hooks/sync'
/** These tests move a simulated clock through minutes of Lichess traffic: more than the default 5 s. */
const test = (name: string, body: TestBody) => kitTest(name, { timeoutMs: 60_000 }, body)

import { following, GAME_FILE, gameFull, inGame, OLD_GAME_FILE, OLD_TOKEN_FILE, TOKEN_FILE, gameState, later, playing, run, savedLichessGame, settle, start, world } from './world'

test('harness: a game under way is followed through its stream', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  await start($)
  await w.clock.advance(1000)
  await settle(w.clock)
  const [stream] = w.streamsTo(/board\/game\/stream\/g1/)
  expect(stream).toBeDefined()
  stream!.push(gameFull('e2e4 e7e5'))
  await settle(w.clock)
  expect(w.saved().game.moves).toEqual(['e2e4', 'e7e5'])
  void run
  void gameState
})

/** Lichess answers a game against its Stockfish with game g2. */
const aiRoute = (w: ReturnType<typeof world>) => w.route('POST', /\/api\/challenge\/ai/, { status: 201, text: '{"id":"g2"}' })
const AI_GAME = 'lichess stockfish 2 5+3'

const PANE = {
  component: 'Pane',
  requestId: 'chess',
  props: { title: 'Chess', isFocused: true, bodyColumns: 21, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('#1 merge: same game, theirs further on: their moves, my flip', () => {
  const base = savedLichessGame(['e2e4', 'e7e5']).game
  const theirs = { ...base, moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] }
  const mine = { ...base, flipped: true }
  const merged = mergeGames(mine, theirs)
  expect(merged.moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6'])
  expect(merged.flipped).toBe(true)
})

test('#1 merge: my move in flight goes back on top of their confirmed moves when it follows them', () => {
  const base = savedLichessGame(['e2e4', 'e7e5']).game
  const mine = { ...base, moves: ['e2e4', 'e7e5', 'g1f3'], pending: { uci: 'g1f3', index: 2, since: 0 } }
  expect(mergeGames(mine, base).moves).toEqual(['e2e4', 'e7e5', 'g1f3'])
  expect(mergeGames(mine, base).pending?.uci).toBe('g1f3')
  // Lichess went on without it (theirs has another move at that index): their moves stand.
  const theirs = { ...base, moves: ['e2e4', 'e7e5', 'b1c3'] }
  expect(mergeGames(mine, theirs).moves).toEqual(['e2e4', 'e7e5', 'b1c3'])
  expect(mergeGames(mine, theirs).pending).toBe(undefined)
})

test('#1 merge: castling written king-to-rook by the stream is the same move as king-to-square', () => {
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']
  const base = savedLichessGame(moves).game
  const theirs = { ...base, moves: [...moves, 'e1h1', 'g8f6'] }
  const mine = { ...base, moves: [...moves, 'e1g1'] }
  expect(mergeGames(mine, theirs).moves).toEqual([...moves, 'e1h1', 'g8f6'])
})

test('#1 merge: another game in the file is never replaced by this session’s older one', () => {
  const old = savedLichessGame(['e2e4']).game
  const theirs = { ...savedLichessGame([]).game, lichess: { ...old.lichess!, gameId: 'g2' } }
  expect(mergeGames(old, theirs).lichess?.gameId).toBe('g2')
})

test('#1 a session behind does not wipe the moves another session saved', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4', 'e7e5']) })
  await start($) // Takes in version 1.
  // Another session saves two more moves; this session has not looked yet.
  w.files.set(GAME_FILE, JSON.stringify(savedLichessGame(['e2e4', 'e7e5', 'g1f3', 'b8c6'], {}, 'other', 2)))
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  await ui.press({ key: 'flip' })
  await settle(w.clock)
  expect(w.saved().writer).not.toBe('other')
  expect(w.saved().game.moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6'])
  expect(w.saved().game.flipped).toBe(true)
  await ui.unmount()
})

test('#1 a move that is not played does not rewrite the shared file', async ($, on) => {
  const w = world(on)
  await inGame(w, $, [])
  const before = w.files.get(GAME_FILE)
  expect((await run($, 'e5')).text).toContain('not a legal move')
  expect(w.files.get(GAME_FILE)).toBe(before)
})

/** Plays e4 in game g1 (the person has White) and lets the background work run for `ms`. */
async function playE4(w: ReturnType<typeof world>, $: Parameters<typeof run>[0], ms = 0) {
  const ran = run($, 'e4')
  await settle(w.clock, Math.max(ms, 200))
  return ran
}

test('#2 no clear answer, Lichess waits for another move: the move stays, and the export is never asked', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('POST', /\/move\/e2e4/, { status: 502, text: 'Bad gateway' })
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: playing(false) })
  await start($)
  await playE4(w, $, 4000)
  expect([w.saved().game.moves, w.saved().game.pending]).toEqual([['e2e4'], undefined])
  expect(w.asked(/game\/export/)).toHaveLength(0)
})

test('#2 no clear answer, Lichess still waits for the person’s move: it was not played', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('POST', /\/move\/e2e4/, { status: 502, text: 'Bad gateway' })
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: playing(true) })
  await start($)
  await playE4(w, $, 4000)
  expect(w.saved().game.moves).toEqual([])
})

test('#2 a request answering after the timeout is still waited for: a late 200 keeps the move', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']) })
  const answer = later()
  w.route('POST', /\/move\//, answer)
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: playing(true) })
  await start($)
  const ran = run($, 'd3')
  await settle(w.clock, 20_000)
  await ran
  // Still pending, still on the board, nothing decided on a guess.
  expect(w.saved().game.moves.at(-1)).toBe('d2d3')
  expect(w.saved().game.pending?.uci).toBe('d2d3')
  answer.answer({ status: 200, text: '{"ok":true}' })
  await settle(w.clock, 500)
  expect([w.saved().game.moves.at(-1), w.saved().game.pending]).toEqual(['d2d3', undefined])
  expect(w.asked(/game\/export/)).toHaveLength(0)
})

test('#2 a late refusal takes the move back with Lichess’s reason', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  const answer = later()
  w.route('POST', /\/move\//, answer)
  await start($)
  const ran = run($, 'e4')
  await settle(w.clock, 16_000)
  await ran
  answer.answer({ status: 400, text: '{"error":"Not your turn, or game already over"}' })
  await settle(w.clock, 500)
  expect(w.saved().game.moves).toEqual([])
})

test('#2 while Lichess cannot say, the move stays pending: never taken back on a guess', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('POST', /\/move\//, { status: 502, text: 'Bad gateway' })
  w.route('GET', /\/api\/account\/playing/, { status: 500, text: 'oops' })
  await start($)
  await playE4(w, $, 60_000)
  expect([w.saved().game.moves, w.saved().game.pending?.uci]).toEqual([['e2e4'], 'e2e4'])
})

test('#2 a game no longer under way whose export has the move: kept', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('POST', /\/move\//, { status: 502 })
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: '{"nowPlaying":[]}' })
  w.route('GET', /\/game\/export\/g1/, { status: 200, text: JSON.stringify({ moves: 'e4', status: 'resign', winner: 'black' }) })
  await start($)
  await playE4(w, $, 4000)
  expect(w.saved().game.moves).toEqual(['e2e4'])
})

test('#2 a game no longer under way whose export lacks the move: taken back', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('POST', /\/move\//, { status: 502 })
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: '{"nowPlaying":[]}' })
  w.route('GET', /\/game\/export\/g1/, { status: 200, text: JSON.stringify({ moves: '', status: 'aborted' }) })
  await start($)
  await playE4(w, $, 4000)
  expect(w.saved().game.moves).toEqual([])
})

const human = (you: string | undefined, current: ChessGame) =>
  applyLichessEvent(
    current,
    {
      type: 'gameFull',
      id: 'g1',
      white: { id: 'magnus', name: 'Magnus', rating: 2850 },
      black: { id: 'popflamingo', name: 'PopFlamingo', rating: 1500 },
      state: { moves: '', status: 'started' },
    },
    0,
    you,
    level => `Stockfish ${level}`,
  )

test('#3 the colour comes from the player whose id is the person’s', () => {
  const placeholder = savedLichessGame([]).game
  expect(human('PopFlamingo', placeholder).lichess?.color).toBe('b')
  expect(human('PopFlamingo', placeholder).lichess?.opponent).toBe('Magnus 2850')
})

test('#3 without the person’s name, the colour Lichess gave when pairing stands, never Black by default', () => {
  const placeholder = savedLichessGame([]).game // color 'w', from /api/account/playing
  const after = human(undefined, placeholder)
  expect(after.lichess?.color).toBe('w')
  expect(after.flipped).toBe(false)
})

test('#3 /chess connect when already connected records the name', async ($, on) => {
  const w = world(on, { user: null })
  w.route('GET', /\/api\/account$/, { status: 200, text: '{"username":"PopFlamingo"}' })
  expect((await run($, 'connect')).text).toContain('PopFlamingo')
  expect(w.store.get('lichessUser')).toBe('PopFlamingo')
})

test('#3 a game starting without the name on record fetches it first', async ($, on) => {
  const w = world(on, { user: null, saved: savedLichessGame([], { flipped: true, lichess: { gameId: 'g1', color: 'b', opponent: 'Magnus', status: 'started' } }) })
  w.route('GET', /\/api\/account$/, { status: 200, text: '{"username":"PopFlamingo"}' })
  await start($)
  await settle(w.clock, 1500)
  w.streamsTo(/stream\/g1/)[0]!.push(
    JSON.stringify({
      type: 'gameFull',
      id: 'g1',
      white: { id: 'popflamingo', name: 'PopFlamingo', rating: 1500 },
      black: { id: 'magnus', name: 'Magnus', rating: 2850 },
      state: { moves: '', status: 'started' },
    }),
  )
  await settle(w.clock)
  expect([w.saved().game.lichess?.color, w.saved().game.flipped]).toEqual(['w', false])
  expect(w.store.get('lichessUser')).toBe('PopFlamingo')
})

const LEASES = '/Users/me/.claude/vibe-gambit'

test('#4 a lease held by another session does not push this session’s turn back: it follows within seconds of the lease ending', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  // Another session follows g1 for the next 20 s.
  w.files.set(`${LEASES}/stream-lease-g1.json`, JSON.stringify({ writer: 'other', until: w.clock.now() + 20_000 }))
  await start($)
  await settle(w.clock, 19_000)
  expect(w.streamsTo(/stream\/g1/)).toHaveLength(0)
  await settle(w.clock, 4000)
  expect(w.streamsTo(/stream\/g1/)).toHaveLength(1)
})

test('#5 a lease is per game: another game followed elsewhere does not stop this one', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([], { lichess: { gameId: 'g2', color: 'w', opponent: 'Stockfish 2', status: 'started' } }) })
  // Another conversation follows g1, holding its lease.
  w.files.set(`${LEASES}/stream-lease.json`, JSON.stringify({ writer: 'other', until: w.clock.now() + 60_000, gameId: 'g1' }))
  w.files.set(`${LEASES}/stream-lease-g1.json`, JSON.stringify({ writer: 'other', until: w.clock.now() + 60_000 }))
  await start($)
  await settle(w.clock, 1500)
  expect(w.streamsTo(/stream\/g2/)).toHaveLength(1)
  expect(JSON.parse(w.files.get(`${LEASES}/stream-lease-g2.json`) ?? '{}').writer).toBeDefined()
})

const nowPlaying = (...games: Record<string, unknown>[]) => JSON.stringify({ nowPlaying: games })
const rapidGame = (gameId: string, extra: Record<string, unknown> = {}) => ({
  gameId,
  fullId: `${gameId}xxxx`,
  color: 'black',
  speed: 'rapid',
  isMyTurn: false,
  opponent: { id: 'magnus', username: 'Magnus', rating: 2850 },
  ...extra,
})

test('#10 the seek attaches the live game of its speed, never an AI game that appeared meanwhile', async ($, on) => {
  const w = world(on)
  let paired = false
  w.route('GET', /\/api\/account\/playing/, () => ({
    status: 200,
    text: paired ? nowPlaying({ ...rapidGame('ai1'), speed: 'blitz', opponent: { id: null, username: 'Stockfish', ai: 3 } }, rapidGame('g9')) : nowPlaying(),
  }))
  await start($)
  expect((await run($, 'lichess rapid')).text).toContain('10+0')
  paired = true
  w.streamsTo(/board\/seek/)[0]!.end()
  await settle(w.clock, 3000)
  expect(w.saved().game.lichess).toMatchObject({ gameId: 'g9', color: 'b', opponent: 'Magnus 2850' })
})

test('#10 Lichess slow to list the new game: the seek keeps looking well past five seconds', async ($, on) => {
  const w = world(on)
  let looks = 0
  w.route('GET', /\/api\/account\/playing/, () => {
    looks += 1
    if (looks === 1) return { status: 200, text: nowPlaying() }
    return looks < 8 ? { status: 503, text: 'busy' } : { status: 200, text: nowPlaying(rapidGame('g9')) }
  })
  await start($)
  await run($, 'lichess rapid')
  w.streamsTo(/board\/seek/)[0]!.end()
  await settle(w.clock, 40_000)
  expect(w.saved().game.lichess?.gameId).toBe('g9')
})

test('#10 the games under way cannot be read before seeking: no seek, and the person is told', async ($, on) => {
  const w = world(on)
  w.route('GET', /\/api\/account\/playing/, { status: 503, text: 'busy' })
  await start($)
  const said = (await run($, 'lichess rapid')).text
  expect(w.streamsTo(/board\/seek/)).toHaveLength(0)
  expect(said).not.toContain('Looking for an opponent')
})

test('#6 a seek ending in this session does not replace the game another session started meanwhile', async ($, on) => {
  const w = world(on)
  let paired = false
  w.route('GET', /\/api\/account\/playing/, () => ({ status: 200, text: paired ? nowPlaying(rapidGame('g1'), rapidGame('g9')) : nowPlaying() }))
  await start($)
  await run($, 'lichess rapid')
  // Another session starts game g1 against Stockfish.
  w.files.set(GAME_FILE, JSON.stringify(savedLichessGame([], {}, 'other', 9_000_000_000_000)))
  paired = true
  w.streamsTo(/board\/seek/)[0]!.end()
  await settle(w.clock, 3000)
  expect(w.saved().game.lichess?.gameId).toBe('g1')
  expect(w.toasts.join('\n')).toContain('lichess.org/g9')
})

test('#6 a stream of a game no longer the board’s changes nothing', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  await start($)
  await settle(w.clock, 1500)
  const [old] = w.streamsTo(/stream\/g1/)
  // Another session replaces the game with g2.
  w.files.set(GAME_FILE, JSON.stringify(savedLichessGame([], { lichess: { gameId: 'g2', color: 'w', opponent: 'Magnus', status: 'started' } }, 'other', 9_000_000_000_000)))
  await settle(w.clock, 1500)
  old!.push(gameState('e2e4 e7e5'))
  await settle(w.clock)
  expect([w.saved().game.lichess?.gameId, w.saved().game.moves]).toEqual(['g2', []])
})

/** Starts the session and lets it open game g1's stream. */

test('#7 the stream refused (revoked token): the game no longer blocks a new one', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  aiRoute(w)
  ;(await following(w, $)).end(401)
  await settle(w.clock, 1500)
  expect((await run($, AI_GAME)).text).toContain('Stockfish level 2')
})

test('#7 the game unknown to Lichess (404): it is over here too', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('GET', /\/game\/export\/g1/, { status: 404, text: '' })
  ;(await following(w, $)).end(404)
  await settle(w.clock, 1500)
  expect(w.saved().game.lichess?.status).not.toBe('started')
})

test('#7 the stream closing at once on a game over: Lichess’s public record ends it here', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('GET', /\/game\/export\/g1/, { status: 200, text: JSON.stringify({ status: 'resign', winner: 'black', moves: '' }) })
  ;(await following(w, $)).end(200)
  await settle(w.clock, 3000)
  expect(w.saved().game.lichess).toMatchObject({ status: 'resign', winner: 'black' })
})

test('#7 no token for a game under way: the person is told once, and the game does not block a new one', async ($, on) => {
  const w = world(on, { noToken: true, saved: savedLichessGame([]) })
  await start($)
  await settle(w.clock, 5000)
  expect(w.toasts.filter(text => text.includes('/chess connect'))).toHaveLength(1)
  expect((await run($, AI_GAME)).text).not.toContain('A Lichess game is on')
})

test('#7 disconnecting during a game says where the game goes on', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('DELETE', /\/api\/token/, { status: 204 })
  await start($)
  expect((await run($, 'disconnect')).text).toContain('lichess.org/g1')
})

/** A session that does not follow g1 (another holds its lease) and reads the shared file. */
async function bystander(w: ReturnType<typeof world>, $: Parameters<typeof start>[0]) {
  w.files.set(`${LEASES}/stream-lease-g1.json`, JSON.stringify({ writer: 'other', until: w.clock.now() + 600_000 }))
  await start($)
  await settle(w.clock, 1500)
}

test('#8 a session not following the stream still tells of the opponent’s move, once', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4']) })
  await bystander(w, $)
  const moved = savedLichessGame(['e2e4', 'e7e5'], {}, 'other', 9_000_000_000_000)
  w.files.set(GAME_FILE, JSON.stringify({ ...moved, alert: { mover: 'b', san: 'e5' } }))
  await settle(w.clock, 1500)
  w.files.set(GAME_FILE, JSON.stringify({ ...moved, version: 9_000_000_000_001, alert: { mover: 'b', san: 'e5' } }))
  await settle(w.clock, 1500)
  expect(w.toasts.filter(text => text.includes('♟e5'))).toHaveLength(1)
})

test('#8 a session not following the stream tells of the result', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4', 'e7e5']) })
  await bystander(w, $)
  const over = savedLichessGame(['e2e4', 'e7e5'], { lichess: { gameId: 'g1', color: 'w', opponent: 'Stockfish 2', status: 'resign', winner: 'black' } }, 'other', 9_000_000_000_000)
  w.files.set(GAME_FILE, JSON.stringify(over))
  await settle(w.clock, 1500)
  expect(w.toasts.some(text => text.includes('White resigned'))).toBe(true)
})

test('#8 the following session records the opponent’s move even with its own board shown', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4']) })
  w.show(true)
  const stream = await following(w, $)
  stream.push(gameFull('e2e4'))
  stream.push(gameState('e2e4 e7e5'))
  await settle(w.clock)
  expect(w.saved().alert).toMatchObject({ mover: 'b', san: 'e5' })
  expect(w.toasts.filter(text => text.includes('e5'))).toHaveLength(0)
})

const ai = (level: number) => `Stockfish ${level}`

test('#9 the opponent gone: when the win may be claimed; back or moving again: no longer gone', () => {
  const base = savedLichessGame(['e2e4', 'e7e5']).game
  const gone = applyLichessEvent(base, { type: 'opponentGone', gone: true, claimWinInSeconds: 10 } as never, 1000, 'PopFlamingo', ai)
  expect(gone.lichess?.opponentGone).toEqual({ claimAt: 11_000 })
  expect(applyLichessEvent(gone, { type: 'opponentGone', gone: false } as never, 2000, 'PopFlamingo', ai).lichess?.opponentGone).toBe(undefined)
  expect(applyLichessEvent(gone, { type: 'gameState', moves: 'e2e4 e7e5 g1f3 b8c6', status: 'started' }, 3000, 'PopFlamingo', ai).lichess?.opponentGone).toBe(undefined)
})

test('#9 the pane counts down, then offers to claim the win or a draw', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4', 'e7e5']) })
  w.route('POST', /\/claim-victory/, { status: 200, text: '{"ok":true}' })
  const stream = await following(w, $)
  stream.push(gameFull('e2e4 e7e5'))
  stream.push(JSON.stringify({ type: 'opponentGone', gone: true, claimWinInSeconds: 10 }))
  await settle(w.clock)
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Stockfish 2 left.*10 s/ })).toBeDefined()
  expect(await ui.find({ key: 'claim-win' })).toBe(undefined)
  await settle(w.clock, 11_000)
  await ui.redraw()
  expect(await ui.find({ key: 'claim-draw' })).toBeDefined()
  await ui.press({ key: 'claim-win' })
  await settle(w.clock)
  expect(w.asked(/\/board\/game\/g1\/claim-victory/)).toHaveLength(1)
  await ui.unmount()
})

test('#9 /chess claim before the time is up says how long to wait', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4', 'e7e5']) })
  const stream = await following(w, $)
  stream.push(gameFull('e2e4 e7e5'))
  stream.push(JSON.stringify({ type: 'opponentGone', gone: true, claimWinInSeconds: 30 }))
  await settle(w.clock)
  expect((await run($, 'claim')).text).toMatch(/30 s|29 s/)
  expect(w.asked(/claim-victory/)).toHaveLength(0)
})

/** A game under way that this session follows, the stream's first line in. */

test('#11 a refused resignation is reported, not announced as done', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/resign$/, { status: 400, text: '{"error":"This game cannot be resigned"}' })
  await inGame(w, $, ['e2e4', 'e7e5'])
  expect((await run($, 'resign')).text).toContain('This game cannot be resigned')
})

test('#11 /chess resign before both first moves aborts through /resign, and says the game is aborted', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/resign$/, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, ['e2e4'])
  expect((await run($, 'resign')).text).toBe('Game aborted')
  expect(w.asked(/\/abort$/)).toHaveLength(0)
  expect(w.asked(/\/resign$/)).toHaveLength(1)
})

test('#11 /chess draw with the opponent’s offer open accepts it, and says so', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/draw\/yes$/, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, ['e2e4', 'e7e5'], { bdraw: true })
  expect((await run($, 'draw')).text).toBe('Draw accepted.')
})

test('#11 a draw offer Lichess refuses is reported', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/draw\/yes$/, { status: 500, text: 'oops' })
  await inGame(w, $, ['e2e4', 'e7e5'])
  expect((await run($, 'draw')).text).not.toBe('Draw offered.')
})

test('#11 the resign button tells of a failure', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/resign$/, 'network')
  await inGame(w, $, ['e2e4', 'e7e5'])
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  await ui.press({ key: 'resign' })
  await ui.press({ key: 'resign-confirm' })
  await settle(w.clock)
  expect(w.toasts.some(text => /network|could not|failed/i.test(text))).toBe(true)
  await ui.unmount()
})

test('#12 after a 429, nothing is asked of Lichess for a minute', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/move\//, { status: 429, text: '' })
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: playing(false) })
  await inGame(w, $, [])
  const ran = run($, 'e4')
  await settle(w.clock, 400)
  await ran
  await settle(w.clock, 30_000)
  expect(w.asked(/\/api\/account\/playing/)).toHaveLength(0)
  await settle(w.clock, 35_000)
  expect(w.asked(/\/api\/account\/playing/).length).toBeGreaterThan(0)
  expect(w.saved().game.pending).toBe(undefined)
})

test('#12 a stream answered 429 is opened again only after a minute', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  ;(await following(w, $)).end(429)
  await settle(w.clock, 30_000)
  expect(w.streamsTo(/stream\/g1/)).toHaveLength(1)
  await settle(w.clock, 35_000)
  expect(w.streamsTo(/stream\/g1/).length).toBeGreaterThan(1)
})

test('#17 a revocation that fails is not announced as done', async ($, on) => {
  const w = world(on)
  w.route('DELETE', /\/api\/token/, { status: 503, text: '' })
  const said = (await run($, 'disconnect')).text
  expect(said).not.toContain('revoked')
  expect(said).toContain('lichess.org/account/security')
})

test('#17 a token Lichess no longer knows (401) counts as revoked', async ($, on) => {
  const w = world(on)
  w.route('DELETE', /\/api\/token/, { status: 401, text: '' })
  expect((await run($, 'disconnect')).text).toContain('revoked')
})

/** Runs the sign-in up to the browser coming back with a code, as the listener reads it. */
async function signIn(w: ReturnType<typeof world>, $: Parameters<typeof run>[0]) {
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran
  const opened = w.runs.find(argv => argv[0] === 'open')!
  const state = new URL(opened[1]!).searchParams.get('state')
  const listener = w.streamsTo(/^53123$/)[0]!
  listener.push(`GET /callback?code=CODE&state=${state} HTTP/1.1`)
  listener.end()
  await settle(w.clock, 1000)
}

test('#18 a token that cannot be saved: revoked at once, and the person told', async ($, on) => {
  const w = world(on, { noToken: true, user: null, runExit: argv => (argv[0] === 'sh' ? 1 : 0) })
  w.route('POST', /\/api\/token$/, { status: 200, text: '{"access_token":"NEW"}' })
  w.route('DELETE', /\/api\/token$/, { status: 204 })
  w.route('GET', /\/api\/account$/, { status: 200, text: '{"username":"PopFlamingo"}' })
  await signIn(w, $)
  expect(w.toasts.some(text => text.includes('save'))).toBe(true)
  expect(w.asked(/\/api\/token$/).filter(r => r.method === 'DELETE' && r.headers?.Authorization === 'Bearer NEW')).toHaveLength(1)
})

test('#18 a new sign-in revokes the token it replaces', async ($, on) => {
  const w = world(on, { user: null })
  let account = 401
  w.route('GET', /\/api\/account$/, () => ({ status: account, text: '{"username":"PopFlamingo"}' }))
  w.route('POST', /\/api\/token$/, { status: 200, text: '{"access_token":"NEW"}' })
  w.route('DELETE', /\/api\/token$/, { status: 204 })
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran.then(() => (account = 200))
  const opened = w.runs.find(argv => argv[0] === 'open')!
  const state = new URL(opened[1]!).searchParams.get('state')
  const listener = w.streamsTo(/^53123$/)[0]!
  listener.push(`GET /callback?code=CODE&state=${state} HTTP/1.1`)
  listener.end()
  await settle(w.clock, 1000)
  expect(w.asked(/\/api\/token$/).filter(r => r.method === 'DELETE' && r.headers?.Authorization === 'Bearer TOKEN')).toHaveLength(1)
})

test('#18 Lichess unreachable when checking an existing token: no new sign-in', async ($, on) => {
  const w = world(on, { user: null })
  w.route('GET', /\/api\/account$/, { status: 503, text: '' })
  const said = (await run($, 'connect')).text
  expect(w.runs.some(argv => argv[0] === 'open')).toBe(false)
  expect(said).not.toContain('browser')
})

/** Starts a challenge to magnus and answers its stream with these lines. */
async function challenge(w: ReturnType<typeof world>, $: Parameters<typeof run>[0] & Parameters<typeof start>[0], lines: string[], status = 200) {
  await start($)
  await run($, 'lichess friend magnus 5+3')
  const stream = w.streamsTo(/challenge\/magnus/)[0]!
  for (const line of lines) stream.push(line)
  stream.end(status)
  await settle(w.clock, 3000)
}

test('#23 a challenge answered with an HTML error page: told, search cleared', async ($, on) => {
  const w = world(on)
  await challenge(w, $, ['<html>502 Bad Gateway</html>'], 502)
  expect(w.toasts.some(text => text.includes('502'))).toBe(true)
  expect((await run($, 'cancel')).text).toBe('No search under way.')
})

test('#23 a challenge cut off without an answer, accepted meanwhile: the game is found', async ($, on) => {
  const w = world(on)
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: nowPlaying(rapidGame('ch1', { speed: 'blitz', opponent: { id: 'magnus', username: 'magnus', rating: 2850 } })) })
  await challenge(w, $, [JSON.stringify({ id: 'ch1', url: 'https://lichess.org/ch1', status: 'created' })])
  expect(w.saved().game.lichess?.gameId).toBe('ch1')
})

test('#23 a challenge cut off without an answer and not accepted: maybe still open, the person told', async ($, on) => {
  const w = world(on)
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: nowPlaying() })
  await challenge(w, $, [JSON.stringify({ id: 'ch1', url: 'https://lichess.org/ch1', status: 'created' })])
  expect(w.toasts.some(text => /still open|connection/i.test(text))).toBe(true)
  expect(w.toasts.some(text => text.includes('declined'))).toBe(false)
})

test('#23 declined and canceled are told apart', async ($, on) => {
  const w = world(on)
  await challenge(w, $, [JSON.stringify({ id: 'ch1' }), '{"done":"canceled"}'])
  expect(w.toasts.some(text => text.includes('declined'))).toBe(false)
  expect(w.toasts.some(text => /cancel/i.test(text))).toBe(true)
})

test('#24 no network when starting a game against Stockfish: a message, not an error', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/api\/challenge\/ai/, 'network')
  await start($)
  expect((await run($, 'lichess stockfish 3')).text).toContain('network')
})

test('#13 while the person’s move waits for Lichess, their clock runs on and the opponent’s stays', () => {
  const current: ChessGame = {
    ...savedLichessGame(['e2e4', 'e7e5']).game,
    moves: ['e2e4', 'e7e5', 'g1f3'],
    pending: { uci: 'g1f3', index: 2, since: 0 },
    clock: { initialMs: 300_000, incrementMs: 0, whiteMs: 300_000, blackMs: 300_000, runningSince: 0 },
  }
  expect(hintLine(current, null, stringsFor('en'), 'en', 10_000)).toMatch(/^♔ 4:50  ♚ 5:00/)
})

test('#13 a state arriving while a move is pending: clocks run from Lichess’s own move count', () => {
  // Lichess has 1. e4; the person (Black) has e5 in flight; a draw offer arrives.
  const current: ChessGame = {
    ...savedLichessGame(['e2e4']).game,
    moves: ['e2e4', 'e7e5'],
    lichess: { gameId: 'g1', color: 'b', opponent: 'Magnus', status: 'started' },
    pending: { uci: 'e7e5', index: 1, since: 0 },
  }
  const after = applyLichessEvent(current, { type: 'gameState', moves: 'e2e4', wtime: 300_000, btime: 300_000, status: 'started', wdraw: true }, 5000, 'PopFlamingo', ai)
  expect(after.moves).toEqual(['e2e4', 'e7e5'])
  expect(after.clock?.runningSince).toBe(null)
})

test('#13 the pane’s clocks follow Lichess’s side to move while a move is pending', async ($, on) => {
  const w = world(on)
  const answer = later()
  w.route('POST', /\/move\//, answer)
  await inGame(w, $, ['e2e4', 'e7e5'])
  // Both first moves made: clocks run. The person (White) plays Nf3, which waits for Lichess.
  const ran = run($, 'Nf3')
  await settle(w.clock, 10_000)
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  // White (the person) still thinks as far as Lichess knows; Black's clock does not run on it.
  expect((await ui.find({ key: 'player-w' }))?.text).toContain('4:50')
  expect((await ui.find({ key: 'player-b' }))?.text).toContain('5:00')
  answer.answer({ status: 200, text: '{"ok":true}' })
  await ran
  await ui.unmount()
})

const ended = (status: string, winner?: 'white' | 'black'): ChessGame => ({
  ...savedLichessGame(['e2e4', 'e7e5']).game,
  lichess: { gameId: 'g1', color: 'w', opponent: 'Magnus', status, winner },
})

test('#14 an end Lichess does not explain is no draw', () => {
  const t = stringsFor('en')
  expect(lichessResult(ended('unknownFinish'), t)).toBe('Game over')
  expect(lichessResult(ended('draw'), t)).toBe('Draw')
  expect(lichessResult(ended('outoftime'), t)).toBe('Draw') // Time out against bare king: a draw.
  expect(lichessResult(ended('insufficientMaterialClaim'), t)).toBe('Draw')
})

test('#22 the line under the prompt gives the result once the game is over, not “Your turn”', () => {
  const t = stringsFor('en')
  const over = ended('resign', 'black')
  const line = hintLine({ ...over, lichess: { ...over.lichess!, endedAt: 0 } }, { mover: 'b', san: 'e5' }, t, 'en', 0)
  expect(line).toContain('White resigned')
  expect(line).not.toContain('Your turn')
})

test('#21 a reconnection keeps the side the person put at the bottom', () => {
  const flippedByHand: ChessGame = { ...savedLichessGame(['e2e4']).game, flipped: true }
  expect(applyLichessEvent(flippedByHand, JSON.parse(gameFull('e2e4')), 0, 'PopFlamingo', ai).flipped).toBe(true)
  // A new game, or a colour the placeholder had wrong, still turns the board.
  const placeholder: ChessGame = { ...savedLichessGame([]).game, lichess: { gameId: 'g1', color: 'w', opponent: 'Magnus', status: 'started' } }
  const asBlack = JSON.parse(gameFull('', { white: { id: 'magnus', name: 'Magnus' }, black: { id: 'popflamingo', name: 'PopFlamingo' } }))
  expect(applyLichessEvent(placeholder, asBlack, 0, 'PopFlamingo', ai).flipped).toBe(true)
})

/** A search left in the session's state by an earlier load of the mod, which a reload forgot how to stop. */
function staleSearch(on: Parameters<typeof world>[0]) {
  let held: unknown = { kind: 'seek', timeControl: '10+0' }
  let version = 1
  on('state.get', ($, e, next) => ((e as { key: string }).key === 'search' ? { value: { value: held, version } } : next(e)))
  on('state.set', ($, e, next) => {
    if ((e as { key: string }).key !== 'search') return next(e)
    held = (e as { value: unknown }).value
    version += 1
    return { value: { isSet: true as const, version } }
  })
}

test('#15 a search left by an earlier load does not block a new game after a reload', async ($, on) => {
  staleSearch(on)
  aiRoute(world(on))
  await start($)
  expect((await run($, AI_GAME)).text).toContain('Stockfish level 2')
})

test('#15 /chess cancel clears a search left by an earlier load', async ($, on) => {
  staleSearch(on)
  aiRoute(world(on))
  expect((await run($, 'cancel')).text).toBe('Search cancelled.')
  expect((await run($, AI_GAME)).text).toContain('Stockfish level 2')
})

test('#16 a shared file left broken is written over after a few tries, not abandoned', async ($, on) => {
  const w = world(on)
  aiRoute(w)
  w.files.set(GAME_FILE, '{"version": 3, "game": {"mo')
  await start($)
  const ran = run($, AI_GAME)
  await settle(w.clock, 1000)
  await ran
  expect(w.saved().game.lichess?.gameId).toBe('g2')
})

test('#16 the shared file is written whole: through a temporary file renamed over it', async ($, on) => {
  const w = world(on)
  aiRoute(w)
  await start($)
  await run($, AI_GAME)
  await settle(w.clock, 500)
  const renames = w.runs.filter(argv => argv[0] === 'mv' && argv[2] === GAME_FILE)
  expect(renames.length).toBeGreaterThan(0)
  expect([...w.files.keys()].some(path => path.endsWith('.tmp'))).toBe(false)
})

test('#20 the opponent’s takeback offer is read from the stream, and goes with the next state', () => {
  const base = savedLichessGame(['e2e4', 'e7e5']).game
  const offered = applyLichessEvent(base, { type: 'gameState', moves: 'e2e4 e7e5', status: 'started', btakeback: true } as never, 0, 'PopFlamingo', ai)
  expect(offered.lichess?.takebackOffer).toBe('b')
  expect(applyLichessEvent(offered, { type: 'gameState', moves: 'e2e4 e7e5 g1f3', status: 'started' }, 1, 'PopFlamingo', ai).lichess?.takebackOffer).toBe(undefined)
})

test('#20 the pane offers to accept or decline the opponent’s takeback, and answers Lichess', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/takeback\/no$/, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, ['e2e4', 'e7e5', 'g1f3'], { btakeback: true })
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Stockfish 2 asks to take back/ })).toBeDefined()
  expect(await ui.find({ key: 'takeback-yes' })).toBeDefined()
  await ui.press({ key: 'takeback-no' })
  await settle(w.clock)
  expect(w.asked(/\/board\/game\/g1\/takeback\/no$/)).toHaveLength(1)
  await ui.unmount()
})

test('#20 /chess takeback accepts the opponent’s offer', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/takeback\/yes$/, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, ['e2e4', 'e7e5', 'g1f3'], { btakeback: true })
  expect((await run($, 'takeback')).text).toBe('Takeback accepted.')
  expect(w.asked(/\/takeback\/yes$/)).toHaveLength(1)
})

test('rename: a token kept under the old name is moved to Vibe Gambit’s folder and still used', async ($, on) => {
  const w = world(on, { noToken: true })
  w.files.set(OLD_TOKEN_FILE, 'TOKEN')
  w.route('GET', /\/api\/account$/, { status: 200, text: '{"username":"PopFlamingo"}' })
  expect((await run($, 'connect')).text).toContain('PopFlamingo')
  expect(w.files.get(TOKEN_FILE)).toBe('TOKEN')
  expect(w.files.has(OLD_TOKEN_FILE)).toBe(false)
})

test('rename: a game saved under the old name is taken in and saved under Vibe Gambit’s', async ($, on) => {
  const w = world(on)
  w.files.set(OLD_GAME_FILE, JSON.stringify(savedLichessGame(['e2e4'])))
  await start($)
  await settle(w.clock, 500)
  expect(w.saved().game.moves).toEqual(['e2e4'])
})

const TO_SERVE = ['nc', '-l', '-p', '53123', '-s', '127.0.0.1']
const BSD = ['nc', '-l', '127.0.0.1', '53123']

/** Approves in the browser: the request the listener `argv` receives. */
async function approve(w: ReturnType<typeof world>, opener: string) {
  const opened = w.runs.find(argv => argv[0] === opener)!
  const state = new URL(opened[1]!).searchParams.get('state')
  const listener = w.streams.filter(stream => stream.argv.includes('53123')).at(-1)!
  listener.push(`GET /callback?code=CODE&state=${state} HTTP/1.1`)
  listener.end()
  await settle(w.clock, 1000)
  return listener
}

const signInRoutes = (w: ReturnType<typeof world>) => {
  w.route('POST', /\/api\/token$/, { status: 200, text: '{"access_token":"NEW"}' })
  w.route('GET', /\/api\/account$/, { status: 200, text: '{"username":"PopFlamingo"}' })
}

test('linux: the browser opens with xdg-open, and the listener with the options most netcats take', async ($, on) => {
  const w = world(on, { noToken: true, system: 'Linux' })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran
  expect(w.runs.some(argv => argv[0] === 'xdg-open')).toBe(true)
  expect(w.runs.some(argv => argv[0] === 'open')).toBe(false)
  const listener = await approve(w, 'xdg-open')
  expect([...listener.argv]).toEqual(TO_SERVE)
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
})

test('macOS: its nc refuses -p with -l at once, so the BSD form listens', async ($, on) => {
  const w = world(on, { noToken: true, exitsAtOnce: argv => argv.join(' ') === TO_SERVE.join(' ') })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran
  const listener = await approve(w, 'open')
  expect([...listener.argv]).toEqual(BSD)
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
})

test('no netcat at all: python3 listens', async ($, on) => {
  const w = world(on, { noToken: true, system: 'Linux', missing: ['nc', 'ncat', 'busybox'] })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran
  const listener = await approve(w, 'xdg-open')
  expect(listener.argv[0]).toBe('python3')
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
})

test('nothing can listen: the person pastes the address the browser lands on', async ($, on) => {
  const w = world(on, { noToken: true, system: 'Linux', missing: ['nc', 'ncat', 'busybox', 'python3', 'xdg-open', 'wslview'] })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  const said = (await ran).text ?? ""
  expect(said).toContain('/chess connect')
  const url = /https:\/\/lichess\.org\/oauth\?\S+/.exec(said)![0]
  const state = new URL(url).searchParams.get('state')
  const back = (await run($, `connect http://127.0.0.1:53123/callback?code=CoDe&state=${state}`)).text
  expect(back).toContain('PopFlamingo')
  expect(w.asked(/\/api\/token$/).find(r => r.method === 'POST')?.body).toContain('code=CoDe')
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
})

test('commands are called by name, found on the PATH wherever the system keeps them', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  await following(w, $)
  await run($, 'open')
  await settle(w.clock, 500)
  const programs = [...w.runs.map(argv => argv[0]!), ...w.streams.map(stream => stream.argv[0]!)]
  expect(programs.length).toBeGreaterThan(0)
  expect(programs.filter(program => program.includes('/'))).toEqual([])
})

/** /chess as another origin than the person at the prompt: an agent, a peer, a schedule... */
const runAs = (
  $: { command: { run: (input: import('claude-code').CommandRunInput) => Promise<import('claude-code').CommandRunResult> } },
  args: string,
  origin: import('claude-code').PromptOrigin,
) => $.command.run({ command: 'chess', args, origin, presentation: { isFullscreen: true, columns: 200 } })

test('fair play: a move on a Lichess game comes from the person only, never from another origin', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/move\//, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, [])
  for (const origin of [{ kind: 'peer' }, { kind: 'unclassified' }, { kind: 'sdk' }, { kind: 'scheduled-trigger' }] as const) {
    expect((await runAs($, 'e4', origin as never)).text).toContain('only you')
  }
  expect(w.asked(/\/move\//)).toHaveLength(0)
  expect(w.saved().game.moves).toEqual([])
  // The person, at the prompt or from the Claude app on their phone.
  expect((await runAs($, 'e4', { kind: 'bridge' } as never)).text).toContain('Played e4')
  expect(w.asked(/\/move\//)).toHaveLength(1)
})

test('fair play: draw, resign, takeback and claim on a Lichess game come from the person only', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/board\/game\//, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, ['e2e4', 'e7e5'])
  for (const action of ['draw', 'resign', 'takeback', 'claim']) {
    expect((await runAs($, action, { kind: 'peer' } as never)).text).toContain('only you')
  }
  expect(w.asked(/\/board\/game\//)).toHaveLength(0)
})

test('fair play: starting a seek is not playing', async ($, on) => {
  const w = world(on)
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: '{"nowPlaying":[]}' })
  await start($)
  expect((await runAs($, 'lichess rapid', { kind: 'peer' } as never)).text).toContain('Looking for an opponent')
})

test('the move list wraps between moves only: a move number and its moves stay on one line', async ($, on) => {
  const w = world(on, { saved: savedLichessGame(['e2e4', 'e7e5', 'g1f3']) })
  await start($)
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  const list = await ui.find({ type: 'Text', text: /Nf3/ })
  expect(list?.text).toBe('1. e4 e5  2. Nf3')
  await ui.unmount()
  void w
})

test('/chess shows a game under way without taking the keys: a prompt typed next does not press its buttons', async ($, on) => {
  const w = world(on)
  await inGame(w, $, ['e2e4', 'e7e5'])
  w.show(false)
  await run($, '')
  expect(w.opens.at(-1)?.focus).toBeFalsy()
})

test('/chess with no game under way opens the New game screen with the keys, for its shortcuts', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, '')
  expect(w.opens.at(-1)?.focus).toBe(true)
})

test('a shortcut that starts a game opens the board without taking the keys', async ($, on) => {
  const w = world(on)
  aiRoute(w)
  await start($)
  await run($, AI_GAME)
  expect(w.opens.at(-1)?.focus).toBeFalsy()
})

test('the resign button asks again before resigning: one press sends nothing', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/resign$/, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, ['e2e4', 'e7e5'])
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  await ui.press({ key: 'resign' })
  await settle(w.clock)
  expect(w.asked(/\/resign$/)).toHaveLength(0)
  expect(await ui.find({ type: 'Button', key: 'resign-confirm' })).toBeDefined()
  await ui.press({ key: 'resign-confirm' })
  await settle(w.clock)
  expect(w.asked(/\/resign$/)).toHaveLength(1)
  await ui.unmount()
})

test('an unanswered resign question goes away after a few seconds', async ($, on) => {
  const w = world(on)
  w.route('POST', /\/resign$/, { status: 200, text: '{"ok":true}' })
  await inGame(w, $, ['e2e4', 'e7e5'])
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  await ui.press({ key: 'resign' })
  await settle(w.clock, 6_000)
  expect(await ui.find({ type: 'Button', key: 'resign-confirm' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'resign' })).toBeDefined()
  expect(w.asked(/\/resign$/)).toHaveLength(0)
  await ui.unmount()
})

// Second review: network access and sign-in.

test('/chess connect says once that the browser opens', async ($, on) => {
  const w = world(on, { noToken: true })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  const said = (await ran).text ?? ''
  expect(said.split('Your browser opens Lichess')).toHaveLength(2)
  expect(said).toMatch(/https:\/\/lichess\.org\/oauth\?/)
})

test('a sign-in nobody finishes stops waiting after 5 minutes, and a new one works', async ($, on) => {
  const w = world(on, { noToken: true })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran
  await settle(w.clock, 5 * 60_000 + 1000)
  expect(w.toasts.some(text => /timed out/i.test(text))).toBe(true)
  w.runs.length = 0
  const again = run($, 'connect')
  await settle(w.clock, 1000)
  await again
  await approve(w, 'open')
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
})

test('a second /chess connect while the first one still listens: the browser coming back to the first listener signs in', async ($, on) => {
  // Linux's ncat and busybox cannot share the port: the second attempt cannot listen.
  let w!: ReturnType<typeof world>
  w = world(on, { noToken: true, system: 'Linux', exitsAtOnce: argv => argv.includes('53123') && w.streams.some(s => s.argv.includes('53123') && !s.isClosed()) })
  signInRoutes(w)
  const first = run($, 'connect')
  await settle(w.clock, 1000)
  await first
  const firstListener = w.streams.find(s => s.argv.includes('53123'))!
  w.runs.length = 0
  const second = run($, 'connect')
  await settle(w.clock, 1000)
  await second
  // The browser approves the second attempt and lands on the port the first listener holds.
  const opened = w.runs.find(argv => argv[0] === 'xdg-open')!
  const state = new URL(opened[1]!).searchParams.get('state')
  firstListener.push(`GET /callback?code=CODE&state=${state} HTTP/1.1`)
  firstListener.end()
  await settle(w.clock, 1000)
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
  expect(w.toasts.some(text => /mismatch|failed/i.test(text))).toBe(false)
})

test('the browser on another machine (SSH): the address it lands on can be pasted even while a listener waits', async ($, on) => {
  const w = world(on, { noToken: true, system: 'Linux', missing: ['xdg-open', 'wslview'] })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  const said = (await ran).text ?? ''
  expect(w.streams.some(s => s.argv.includes('53123'))).toBe(true)
  expect(said).toContain('/chess connect <address>')
  const state = new URL(/https:\/\/lichess\.org\/oauth\?\S+/.exec(said)![0]).searchParams.get('state')
  const back = (await run($, `connect http://127.0.0.1:53123/callback?code=CoDe&state=${state}`)).text
  expect(back).toContain('PopFlamingo')
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
})

test('every listener listens on 127.0.0.1 only, never on every interface', () => {
  for (const argv of LISTENERS) expect(argv.join(' ')).toContain('127.0.0.1')
})

test('/chess open on Linux opens the browser with xdg-open', async ($, on) => {
  const w = world(on, { system: 'Linux', saved: savedLichessGame(['e2e4']) })
  await start($)
  const said = (await run($, 'open')).text ?? ''
  expect(w.runs.some(argv => argv[0] === 'xdg-open' && argv[1] === 'https://lichess.org/g1')).toBe(true)
  expect(w.runs.some(argv => argv[0] === 'open')).toBe(false)
  expect(said).toContain('https://lichess.org/g1')
})

test('/chess open with no browser to open: it does not say it is opening, it gives the address', async ($, on) => {
  const w = world(on, { system: 'Linux', missing: ['xdg-open', 'wslview'], saved: savedLichessGame(['e2e4']) })
  await start($)
  const said = (await run($, 'open')).text ?? ''
  expect(said).not.toMatch(/^Opening/)
  expect(said).toContain('https://lichess.org/g1')
  void w
})

test('a 429 error page on the game stream (not JSON) waits the minute Lichess asks', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  const stream = await following(w, $)
  stream.push('<html><body>Too many requests</body></html>')
  stream.end(429)
  await settle(w.clock, 30_000)
  expect(w.streamsTo(/stream\/g1/)).toHaveLength(1)
  await settle(w.clock, 35_000)
  expect(w.streamsTo(/stream\/g1/)).toHaveLength(2)
})

test('a seek answered 429 says so, and no challenge goes out for the minute', async ($, on) => {
  const w = world(on)
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: '{"nowPlaying":[]}' })
  await start($)
  await run($, 'lichess rapid')
  const seek = w.streamsTo(/board\/seek/)[0]!
  seek.push('{"error":"Too many requests. Try again later."}')
  seek.end(429)
  await settle(w.clock, 1000)
  expect(w.toasts.some(text => /too many requests/i.test(text))).toBe(true)
  const said = (await run($, 'lichess friend magnus 5+3')).text ?? ''
  expect(w.streamsTo(/challenge\/magnus/)).toHaveLength(0)
  expect(said).toMatch(/too many requests/i)
})

test('no HOME: no sign-in, so no token written to a shared folder such as /tmp', async ($, on) => {
  const w = world(on, { noToken: true, noHome: true })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  const said = (await ran).text ?? ''
  expect(w.runs.some(argv => argv[0] === 'open')).toBe(false)
  expect(said).toContain('HOME')
  expect([...w.files.keys()].some(path => path.startsWith('/tmp'))).toBe(false)
})

// No local games: the board is a Lichess game's, or the New game screen.

test('/chess new during a Lichess game says so on the screen, with no Start to press', async ($, on) => {
  const w = world(on)
  await inGame(w, $, ['e2e4', 'e7e5'])
  await run($, 'new')
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'A Lichess game is on: finish it or resign first.' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'start' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  await ui.unmount()
})

test('no Lichess game: the pane is the New game screen, with Start and no way back to an empty board', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', key: 'start' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'opponent-local' })).toBeUndefined()
  await ui.unmount()
})

test('a local game left by an earlier version: the New game screen, and no move goes into it', async ($, on) => {
  const w = world(on, { saved: { version: 1, writer: 'other', game: { moves: ['e2e4'], flipped: false } } })
  await start($)
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', key: 'start' })).toBeDefined()
  await ui.unmount()
  expect((await run($, 'e5')).text).toBe('No game under way: /chess new to start one.')
  expect(w.saved().game.moves).toEqual(['e2e4'])
})

test('a New game form saved with the local opponent of an earlier version starts with Stockfish', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', key: 'opponent-stockfish' })).toMatchObject({ text: expect.stringContaining('●') })
  await ui.unmount()
})

// Third review (Codex): what the second one left.

test('curl never reads ~/.curlrc, which could add a host the token would go to: -q comes first (game, seek)', async ($, on) => {
  const w = world(on)
  w.route('GET', /\/api\/account\/playing/, { status: 200, text: '{"nowPlaying":[]}' })
  await inGame(w, $, [])
  const stream = w.streamsTo(/stream\/g1/)[0]!
  stream.push(gameState('e2e4 e7e5', { status: 'resign', winner: 'white' }))
  stream.end()
  await settle(w.clock, 1000)
  await run($, 'lichess rapid')
  const curls = w.streams.filter(s => s.argv[0] === 'curl')
  expect(curls.map(c => c.argv.at(-1))).toEqual(['https://lichess.org/api/board/game/stream/g1', 'https://lichess.org/api/board/seek'])
  for (const curl of curls) expect(curl.argv[1]).toBe('-q')
})

test('curl never reads ~/.curlrc: -q comes first (challenge)', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'lichess friend magnus 5+3')
  const curl = w.streamsTo(/challenge\/magnus/)[0]!
  expect(curl.argv[1]).toBe('-q')
})

test('the token goes into a new private file renamed into place, never into one that exists; the old one is made private', async ($, on) => {
  const w = world(on, { noToken: true })
  w.files.set(OLD_TOKEN_FILE, 'OLD')
  signInRoutes(w)
  await start($)
  await run($, 'lichess rapid') // reads the token: moves the old one into place
  const moved = w.runs.find(argv => argv[0] === 'sh' && String(argv[2]).includes('mv "$2"'))!
  expect(moved[2]).toMatch(/chmod 600/)
  w.files.delete(TOKEN_FILE)
  await signIn(w, $)
  const written = w.runs.find(argv => argv[0] === 'sh' && String(argv[2]).includes('cat >'))!
  expect(written[2]).toMatch(/mktemp/)
  expect(written[2]).toMatch(/mv -f/)
  expect(written[2]).not.toMatch(/cat > "\$1\/lichess-token"/)
})

test('a disconnect does not delete a token another session saved while it revoked the old one', async ($, on) => {
  const w = world(on)
  const revoked = later()
  w.route('DELETE', /\/api\/token$/, revoked)
  const ran = run($, 'disconnect')
  await settle(w.clock, 200)
  w.files.set(TOKEN_FILE, 'NEW') // another session signed in meanwhile
  revoked.answer({ status: 204 })
  await settle(w.clock, 200)
  await ran
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
})

test('a disconnect ends a sign-in under way: the browser coming back afterwards signs nobody in', async ($, on) => {
  const w = world(on, { noToken: true })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran
  await run($, 'disconnect')
  await approve(w, 'open')
  expect(w.files.get(TOKEN_FILE)).toBeUndefined()
})

test('a replaced token Lichess would not revoke: the person is told where to revoke it', async ($, on) => {
  const w = world(on, { user: null })
  let account = 401
  w.route('GET', /\/api\/account$/, () => ({ status: account, text: '{"username":"PopFlamingo"}' }))
  w.route('POST', /\/api\/token$/, { status: 200, text: '{"access_token":"NEW"}' })
  w.route('DELETE', /\/api\/token$/, { status: 503, text: '' })
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran.then(() => (account = 200))
  await approve(w, 'open')
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
  expect(w.toasts.some(text => text.includes('lichess.org/account/security'))).toBe(true)
})

test('a stray request to the listener does not end the sign-in: it listens again for the browser', async ($, on) => {
  const w = world(on, { noToken: true })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran
  const first = w.streams.filter(s => s.argv.includes('53123')).at(-1)!
  first.push('GET / HTTP/1.1')
  first.end()
  await settle(w.clock, 1000)
  expect(w.streams.filter(s => s.argv.includes('53123'))).toHaveLength(2)
  await approve(w, 'open')
  expect(w.files.get(TOKEN_FILE)).toBe('NEW')
})

test('a request that never ends is cut off, and the listener starts again', async ($, on) => {
  const w = world(on, { noToken: true })
  signInRoutes(w)
  const ran = run($, 'connect')
  await settle(w.clock, 1000)
  await ran
  const first = w.streams.filter(s => s.argv.includes('53123')).at(-1)!
  for (let i = 0; i < 20; i++) first.push('x'.repeat(1000))
  await settle(w.clock, 1000)
  expect(first.isClosed()).toBe(true)
  expect(w.streams.filter(s => s.argv.includes('53123'))).toHaveLength(2)
})

test('the browser’s answer is read strictly: the callback path, one state, a code or an error, the loopback origin', () => {
  expect(readCallback('GET /callback?code=C&state=S HTTP/1.1', 'S')).toEqual({ code: 'C' })
  expect(readCallback('GET /wrong?code=C&state=S HTTP/1.1', 'S')).toHaveProperty('error')
  expect(readCallback('GET /callback?code=C&state=S&state=T HTTP/1.1', 'S')).toHaveProperty('error')
  expect(readCallback('GET /callback?code=C&error=access_denied&state=S HTTP/1.1', 'S')).toHaveProperty('error')
  expect(readCallback('GET /callback?code=&state=S HTTP/1.1', 'S')).toHaveProperty('error')
  expect(readCallback('GET https://evil.example/callback?code=C&state=S HTTP/1.1', 'S')).toHaveProperty('error')
  expect(readCallback('GET http://127.0.0.1:53123/callback?code=C&state=S HTTP/1.1', 'S')).toEqual({ code: 'C' })
})

test('a pasted address from another host is refused', async ($, on) => {
  const w = world(on, { noToken: true, system: 'Linux', missing: ['nc', 'ncat', 'busybox', 'python3', 'xdg-open', 'wslview'] })
  signInRoutes(w)
  const said = (await run($, 'connect')).text ?? ''
  const state = new URL(/https:\/\/lichess\.org\/oauth\?\S+/.exec(said)![0]).searchParams.get('state')
  const back = (await run($, `connect https://evil.example/callback?code=CoDe&state=${state}`)).text ?? ''
  expect(back).toMatch(/failed/)
  expect(w.asked(/\/api\/token$/)).toHaveLength(0)
})

test('the page the browser comes back to does not claim the sign-in worked: the terminal says', () => {
  for (const locale of ['en', 'fr'] as const) {
    const page = stringsFor(locale).lichessPage
    expect(page.connected).not.toMatch(/Connected|Connecté/)
  }
})

test('the line under the prompt always shows the last move, whoever played it, seen or not; none before the first', () => {
  const t = stringsFor('en')
  const at = (moves: string[]): ChessGame => ({
    ...savedLichessGame(moves).game,
    clock: { initialMs: 300_000, incrementMs: 0, whiteMs: 300_000, blackMs: 300_000, runningSince: null },
  })
  expect(hintLine(at([]), null, t, 'en', 0)).toBe('♔ 5:00  ♚ 5:00 · Your turn')
  // The person (White) played: their move, Black to move.
  expect(hintLine(at(['g1f3']), null, t, 'en', 0)).toBe('♔ 5:00  ♚ 5:00 · White ♞f3 · Black to move')
  // The opponent's move, already seen (no alert): it stays.
  expect(hintLine(at(['g1f3', 'd7d5']), null, t, 'en', 0)).toBe('♔ 5:00  ♚ 5:00 · Black ♟d5 · Your turn')
  // Not seen yet: the same line, once.
  expect(hintLine(at(['g1f3', 'd7d5']), { mover: 'b', san: 'd5' }, t, 'en', 0)).toBe('♔ 5:00  ♚ 5:00 · Black ♟d5 · Your turn')
})

test('the New game screen names a random opponent plainly', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'vibe-gambit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', key: 'opponent-random' })).toMatchObject({ text: expect.stringContaining('Random opponent') })
  await ui.unmount()
})

test('once a game is over, the line under the prompt gives the result for 10 seconds, then nothing', () => {
  const t = stringsFor('en')
  const over = ended('resign', 'black')
  const at = { ...over, lichess: { ...over.lichess!, endedAt: 1_000 } }
  expect(hintLine(at, null, t, 'en', 5_000)).toBe('Black ♟e5 · White resigned')
  expect(hintLine(at, { mover: 'b', san: 'e5' }, t, 'en', 5_000)).toBe('Black ♟e5 · White resigned')
  expect(hintLine(at, { mover: 'b', san: 'e5' }, t, 'en', 11_001)).toBe(undefined)
  // A game that ended before this version kept no time: nothing to show.
  expect(hintLine(over, { mover: 'b', san: 'e5' }, t, 'en', 5_000)).toBe(undefined)
})

test('the end of a game is timed when Lichess says it is over, not again afterwards', () => {
  const playing = savedLichessGame(['e2e4', 'e7e5']).game
  const resigned = applyLichessEvent(playing, JSON.parse(gameState('e2e4 e7e5', { status: 'resign', winner: 'black' })), 12_000, 'PopFlamingo', ai)
  expect(resigned.lichess?.endedAt).toBe(12_000)
  const later = applyLichessEvent(resigned, JSON.parse(gameState('e2e4 e7e5', { status: 'resign', winner: 'black' })), 30_000, 'PopFlamingo', ai)
  expect(later.lichess?.endedAt).toBe(12_000)
})

test('a game that ends here (unknown to Lichess) is timed too', async ($, on) => {
  const w = world(on, { saved: savedLichessGame([]) })
  w.route('GET', /\/game\/export\/g1/, { status: 404, text: '' })
  ;(await following(w, $)).end(404)
  await settle(w.clock, 1500)
  expect(w.saved().game.lichess?.endedAt).toEqual(expect.any(Number))
})
