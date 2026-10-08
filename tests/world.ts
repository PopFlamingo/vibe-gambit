// A world beneath the mod for tests: a disk, Lichess's HTTP API, curl streams the test feeds line
// by line, panes, toasts, the status line, a clock and a store.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

import type { ChessGame } from '../types'

export const HOME = '/Users/me'
export const GAME_FILE = `${HOME}/.claude/vibe-gambit/game.json`
export const TOKEN_FILE = `${HOME}/.config/vibe-gambit/lichess-token`
/** Where the mod kept them before it was named Vibe Gambit. */
export const OLD_GAME_FILE = `${HOME}/.claude/chess/game.json`
export const OLD_TOKEN_FILE = `${HOME}/.config/chess-mod/lichess-token`

export type Answer = { status: number; text?: string } | 'hang' | 'network'
/** An answer the test gives later: `later.answer({ status: 200 })`. */
export type Later = { promise: Promise<Answer>; answer: (answer: Answer) => void }

export function later(): Later {
  let answer!: (value: Answer) => void
  const promise = new Promise<Answer>(resolve => (answer = resolve))
  return { promise, answer }
}
export type Request = { method: string; url: string; body?: string; headers?: Record<string, string> }

/** A curl stream the test controls: push lines, then end it with an HTTP status. */
export type Stream = {
  argv: readonly string[]
  input?: string
  push: (line: string) => void
  end: (httpStatus?: number) => void
  isClosed: () => boolean
}

type Options = {
  lang?: string
  /** No Lichess token on disk. */
  noToken?: boolean
  /** The Lichess username the store holds; null for none. */
  user?: string | null
  /** The shared game file's content at the start. */
  saved?: { version: number; writer: string; game: ChessGame; alert?: unknown }
  /** Exit code of `$.process.run` for a command, 0 by default. */
  runExit?: (argv: readonly string[]) => number
  /** The system `uname -s` names: Darwin by default. */
  system?: string
  /** Commands that do not exist here: `$.process.run` and `$.process.spawn` cannot start them. */
  missing?: readonly string[]
  /** Spawned commands that exit at once (a usage error, a bad option), by their argv. */
  exitsAtOnce?: (argv: readonly string[]) => boolean
  /** No HOME in the environment. */
  noHome?: boolean
}

export function world(on: On, options: Options = {}) {
  mock.env(on, options.noHome ? { LANG: options.lang ?? 'en_US.UTF-8' } : { LANG: options.lang ?? 'en_US.UTF-8', HOME })
  const clock = mock.clock(on)
  // The mod's store, readable by the test.
  const store = new Map<string, unknown>(options.user === null ? [] : [['lichessUser', options.user ?? 'PopFlamingo']])
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))

  const files = new Map<string, string>()
  if (!options.noToken) files.set(TOKEN_FILE, 'TOKEN')
  if (options.saved) files.set(GAME_FILE, JSON.stringify({ alert: null, ...options.saved }))
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'no such file' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('session.id', () => ({ value: 'conversation-1' }))

  // Lichess over HTTP: the first route that answers wins; unanswered requests are a test error.
  const requests: Request[] = []
  const routes: ((request: Request) => Answer | Promise<Answer> | undefined)[] = []
  on('http.fetch', async (_, e) => {
    const request: Request = { method: e.init?.method ?? 'GET', url: e.url, body: e.init?.body, headers: e.init?.headers }
    requests.push(request)
    for (const route of routes) {
      const answer = await route(request)
      if (answer === undefined) continue
      if (answer === 'hang') return new Promise(() => undefined)
      if (answer === 'network') return { deny: 'network error' }
      return { value: { status: answer.status, ok: answer.status >= 200 && answer.status < 300, headers: {}, text: answer.text ?? '' } }
    }
    return { deny: `no route for ${request.method} ${request.url}` }
  })

  // curl streams: each spawn becomes a Stream the test feeds.
  const streams: Stream[] = []
  const spawnedAndExited: (readonly string[])[] = []
  on('process.spawn', async function* (_, e) {
    if (options.missing?.includes(e.argv[0]!)) throw new Error(`${e.argv[0]}: command not found`)
    if (options.exitsAtOnce?.(e.argv)) {
      spawnedAndExited.push(e.argv)
      yield { stream: 'stderr' as const, text: 'usage: bad options\n' }
      return { value: { code: 1, signal: null } }
    }
    const queue: string[] = []
    let wake: (() => void) | undefined
    let closed = false
    let httpStatus = 200
    const stream: Stream = {
      argv: e.argv,
      input: e.input,
      push: line => {
        queue.push(`${line}\n`)
        wake?.()
      },
      end: status => {
        if (status !== undefined) httpStatus = status
        closed = true
        wake?.()
      },
      isClosed: () => closed,
    }
    streams.push(stream)
    try {
      for (;;) {
        while (queue.length > 0) yield { stream: 'stdout' as const, text: queue.shift()! }
        if (closed) break
        await new Promise<void>(resolve => (wake = resolve))
        wake = undefined
      }
      // curl's -w '\n%{http_code}' line, when the mod asks for it.
      if (e.argv.includes('-w')) yield { stream: 'stdout' as const, text: `\n${httpStatus}` }
      return { value: { code: 0, signal: null } }
    } finally {
      closed = true
    }
  })

  const runs: (readonly string[])[] = []
  on('process.run', (_, e) => {
    runs.push(e.argv)
    if (options.missing?.includes(e.argv[0]!)) return { deny: `${e.argv[0]}: command not found` }
    if (e.argv[0] === 'uname') {
      return { value: { exitCode: 0, stdout: `${options.system ?? 'Darwin'}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const exitCode = options.runExit?.(e.argv) ?? 0
    // The token is written through sh -c with stdin; mv renames on the disk.
    // sh writes the token from stdin (cat >), or moves the old one into place (mv "$2" ...).
    const command = e.argv[0]!.replace(/^\/(usr\/)?bin\//, '')
    if (exitCode === 0 && command === 'sh' && String(e.argv[2]).includes('cat >')) files.set(TOKEN_FILE, e.init?.stdin ?? '')
    if (exitCode === 0 && command === 'sh' && String(e.argv[2]).includes('mv "$2"')) {
      files.set(TOKEN_FILE, files.get(e.argv[5]!) ?? '')
      files.delete(e.argv[5]!)
    }
    if (exitCode === 0 && command === 'mv') {
      files.set(e.argv[2]!, files.get(e.argv[1]!) ?? '')
      files.delete(e.argv[1]!)
    }
    if (exitCode === 0 && command === 'rm') files.delete(e.argv.at(-1)!)
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  let isShown = false
  on('ui.panes', () => ({ value: isShown ? [{ id: 'chess', title: 'Chess', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  // Each opening of the pane, to tell whether it took the keys.
  const opens: { focus?: boolean }[] = []
  on('ui.open', (_, e) => {
    opens.push({ focus: e.focus })
    isShown = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    isShown = false
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return {
    clock,
    store,
    spawnedAndExited,
    files,
    requests,
    streams,
    runs,
    toasts,
    statuses,
    opens,
    /** Answers matching requests: `route('POST', /\/move\//, { status: 200 })`. */
    route(method: string, url: RegExp, answer: Answer | Later | ((request: Request) => Answer | Promise<Answer>)) {
      routes.unshift(request => {
        if (request.method !== method || !url.test(request.url)) return undefined
        if (typeof answer === 'function') return answer(request)
        if (typeof answer === 'object' && 'promise' in answer) return answer.promise
        return answer
      })
    },
    show(shown: boolean) {
      isShown = shown
    },
    saved(): { version: number; writer: string; game: ChessGame; alert: unknown } {
      return JSON.parse(files.get(GAME_FILE)!)
    },
    /** The requests made to a URL. */
    asked(url: RegExp) {
      return requests.filter(request => url.test(request.url))
    },
    /** The streams opened on a URL. */
    streamsTo(url: RegExp) {
      return streams.filter(stream => stream.argv.some(arg => url.test(arg)))
    },
  }
}

/** Lets the mod's background work run: the clock moved on in steps (200 ms in all by default). */
export async function settle(clock: { advance: (ms: number) => Promise<void> }, ms = 200) {
  // Steps of 50 ms, or fewer longer ones over a long wait (40 steps at most past 2 s).
  const step = Math.max(50, Math.ceil(ms / 40))
  for (let spent = 0; spent < ms; spent += step) await clock.advance(step)
}

export const run = (
  $: { command: { run: (input: import('claude-code').CommandRunInput) => Promise<import('claude-code').CommandRunResult> } },
  args: string,
) => $.command.run({ command: 'chess', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

export const start = ($: { session: { start: (input: import('claude-code').SessionStartInput) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

/** A Lichess game under way as the shared file holds it. */
export function savedLichessGame(moves: string[], extra: Partial<ChessGame> = {}, writer = 'other', version = 1) {
  return {
    version,
    writer,
    game: {
      moves,
      flipped: false,
      clock: { initialMs: 300_000, incrementMs: 3_000, whiteMs: 300_000, blackMs: 300_000, runningSince: null },
      lichess: { gameId: 'g1', color: 'w' as const, opponent: 'Stockfish 2', status: 'started' },
      ...extra,
    },
  }
}

export const gameFull = (moves: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'gameFull',
    id: 'g1',
    white: { id: 'popflamingo', name: 'PopFlamingo', rating: 1500 },
    black: { aiLevel: 2 },
    clock: { initial: 300_000, increment: 3_000 },
    state: { type: 'gameState', moves, wtime: 300_000, btime: 300_000, status: 'started' },
    ...extra,
  })

export const gameState = (moves: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'gameState', moves, wtime: 290_000, btime: 295_000, status: 'started', ...extra })

/** /api/account/playing with game g1 in it, waiting for the person or not. */
export const playing = (isMyTurn: boolean, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    nowPlaying: [
      { gameId: 'g1', fullId: 'g1xxxx', color: 'white', speed: 'blitz', isMyTurn, opponent: { id: null, username: 'Stockfish', ai: 2 }, ...extra },
    ],
  })

/** Starts the session on the shared Lichess game and answers the stream it follows. */
export async function following(w: ReturnType<typeof world>, $: Parameters<typeof start>[0]) {
  await start($)
  await settle(w.clock, 1500)
  return w.streamsTo(/stream\/g1/).at(-1)!
}

/** A Lichess game under way against Stockfish 2, the person White, at these moves: answers its stream. */
export async function inGame(w: ReturnType<typeof world>, $: Parameters<typeof start>[0], moves: string[], state: Record<string, unknown> = {}) {
  w.files.set(GAME_FILE, JSON.stringify(savedLichessGame(moves)))
  const stream = await following(w, $)
  stream.push(gameFull(moves.join(' '), { state: { type: 'gameState', moves: moves.join(' '), wtime: 300_000, btime: 300_000, status: 'started', ...state } }))
  await settle(w.clock)
  return stream
}
