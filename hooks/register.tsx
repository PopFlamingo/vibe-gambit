import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardProps, ChessAlert, ChessDelivery, ChessGame, ChessSearch, SetupForm } from '../types'
import { formatClock, newClock, timeLeft } from './clock'
import { figurine, localSan, normalizeMove, pickLocale, stringsFor } from './i18n'
import type { Locale, Strings } from './i18n'
import {
  aiChallengeBody,
  applyLichessEvent,
  authorizeUrl,
  callbackResponse,
  LICHESS,
  newSignIn,
  OAUTH_PORT,
  readCallback,
  readReply,
  tokenRequestBody,
} from './lichess'
import type { LichessEvent, LichessReply } from './lichess'
import { fromUci, inCheck, kingSquare, legalMoves, replay, san, status, toUci } from './rules'
import type { Move, Position } from './rules'
import { mergeGames } from './sync'
import { asks, challengeBody, cycle, COLORS, DEFAULT_FORM, fitForm, isUsername, OPPONENTS, seekBody, speedOf, TIME_CONTROLS } from './setup'

const PANE = 'chess'

/**
 * Runs work in the background: a failure there (Lichess gone, the session ending, the module
 * reloading) is dropped rather than left as a rejection no one handles.
 */
function inBackground(work: Promise<unknown>): void {
  work.catch(() => undefined)
}
const game = atom({ plugin: 'vibe-gambit', key: 'game' } as const, { moves: [], flipped: false } as ChessGame)
/** The opponent's move that landed while the board was hidden, shown under the prompt until the person plays. */
const alert = atom({ plugin: 'vibe-gambit', key: 'alert' } as const, null as ChessAlert | null)
/** A move Lichess did not play, shown under the status for a moment. */
const delivery = atom({ plugin: 'vibe-gambit', key: 'delivery' } as const, null as ChessDelivery | null)
/** What the pane shows: the board, or the New game screen. Each session's own. */
const screen = atom({ plugin: 'vibe-gambit', key: 'screen' } as const, 'board' as 'board' | 'new')
/** The New game screen's choices, kept between visits. */
const form = atom({ plugin: 'vibe-gambit', key: 'form' } as const, DEFAULT_FORM)
/** A search for an opponent this session has under way on Lichess. */
const search = atom({ plugin: 'vibe-gambit', key: 'search' } as const, null as ChessSearch | null)
/** How long a sign-in's outcome stays on the status line. */
const NOTICE_MS = 10_000

/** Two label columns, then 8 squares of two cells whose edges fall in the middle of a cell. */
export const BOARD_COLUMNS = 2 + 17
export const BOARD_ROWS = 9
/** The dock's width: the board and a margin, everything else stacked under it. */
const PANE_COLUMNS = BOARD_COLUMNS + 2
/** How many full moves the list under the board shows. */
const SHOWN_MOVES = 10

/** "1. e4 e5", "2. Nf3", ... */
export function moveLines(sans: readonly string[]): string[] {
  const lines: string[] = []
  for (let i = 0; i < sans.length; i += 2) {
    lines.push(`${i / 2 + 1}. ${sans[i]}${sans[i + 1] ? ` ${sans[i + 1]}` : ''}`)
  }
  return lines
}

/**
 * The legal move a typed text names: SAN in English or the locale's letters (Nf3, Cf3, exd5,
 * O-O, e8=D), or UCI (g1f3, e7e8q). Undefined when none, or when it is ambiguous.
 */
export function parseMove(position: Position, text: string, locale: Locale): Move | undefined {
  const uci = text.trim().toLowerCase()
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return fromUci(position, uci) ?? undefined
  const wanted = normalizeMove(text, locale)
  const matches = legalMoves(position).filter(move => normalizeMove(san(position, move), 'en') === wanted)
  return matches.length === 1 ? matches[0] : undefined
}

export function legalMap(position: Position): Record<string, number[]> {
  const legal: Record<string, number[]> = {}
  for (const move of legalMoves(position)) {
    const targets = (legal[String(move.from)] ??= [])
    if (!targets.includes(move.to)) targets.push(move.to)
  }
  return legal
}

/** The side the person plays: their colour on Lichess, else the one at the bottom of the board. */
export const yourSide = (current: ChessGame): 'w' | 'b' => current.lichess?.color ?? (current.flipped ? 'b' : 'w')

/**
 * Whose clock runs: the side to move as far as Lichess knows. A move of the person's still in flight
 * is not Lichess's yet, so their clock runs on and the opponent's waits.
 */
export function clockTurn(current: ChessGame): 'w' | 'b' {
  const confirmed = current.pending ? current.moves.slice(0, current.pending.index) : current.moves
  return replay(confirmed).position.turn
}

/**
 * Fair play: on a Lichess game, only the person acts. Claude Code stamps a command typed at the prompt
 * `composer`, and one sent from the Claude app `bridge`; anything else (another agent, a peer session,
 * a schedule, an SDK host, an unknown source) may not move, offer, resign or claim for them.
 * (The board itself takes only the person's clicks and keys.)
 */
export const isThePerson = (origin: { kind: string }) => origin.kind === 'composer' || origin.kind === 'bridge'

/** A Lichess game still being played, that this session can follow. */
const isLichessOn = (current: ChessGame) => current.lichess?.status === 'started' && !current.lichess.unreachable

/** How a finished Lichess game ended, where the board alone cannot tell (resignation, time, abort). */
export function lichessResult(current: ChessGame, t: Strings): string | undefined {
  const lichess = current.lichess
  if (!lichess || lichess.status === 'started' || lichess.status === 'mate' || lichess.status === 'stalemate') return undefined
  const winner = lichess.winner === 'white' ? t.white : lichess.winner === 'black' ? t.black : undefined
  const loser = lichess.winner === 'white' ? t.black : t.white
  if (lichess.status === 'aborted' || lichess.status === 'noStart') return t.aborted
  if (lichess.status === 'resign' && winner) return t.resigned(loser)
  if ((lichess.status === 'outoftime' || lichess.status === 'timeout') && winner) return t.timeout(winner)
  if (winner) return t.wins(winner)
  // No winner: a draw only where Lichess's status says one (time out against a bare king is a draw);
  // an end it does not explain (unknownFinish) is just over.
  return ['draw', 'insufficientMaterialClaim', 'outoftime', 'timeout'].includes(lichess.status) ? t.draw : t.gameOver
}

/** "Your turn" when it is the person's, "Black to move" when the opponent's; the result once over. */
export function statusLine(position: Position, t: Strings, you: 'w' | 'b', flagged: 'w' | 'b' | null = null): string {
  const side = position.turn === 'w' ? t.white : t.black
  const other = position.turn === 'w' ? t.black : t.white
  if (flagged) return t.timeout(flagged === 'w' ? t.black : t.white)
  switch (status(position)) {
    case 'checkmate':
      return t.checkmate(other)
    case 'stalemate':
      return t.stalemate
    case 'draw':
      return t.draw
    default:
      if (position.turn === you) return inCheck(position) ? t.yourTurnInCheck : t.yourTurn
      return inCheck(position) ? t.check(side) : t.toMove(side)
  }
}

/** The mod's option, Claude Code's language setting, then the locale variables. */
async function readLocale($: EngineInterface, option: string | undefined): Promise<Locale> {
  const language = await $.settings
    .read()
    .then(settings => (settings as { language?: unknown }).language)
    .catch(() => undefined)
  return pickLocale([
    option,
    typeof language === 'string' ? language : undefined,
    await $.env.get('LC_ALL'),
    await $.env.get('LC_MESSAGES'),
    await $.env.get('LANG'),
  ])
}

/**
 * Where the game is kept on disk, so other sessions show it too: one file for every session
 * (`global`), or one per conversation, found again when the conversation is resumed.
 */
export type Scope = 'global' | 'conversation'
type Saved = { version: number; writer: string; game: ChessGame; alert: ChessAlert | null }
/** This load of the module, so it skips its own writes when it reads the file back. */
const WRITER = crypto.randomUUID()
/** The newest version this session wrote or took in. */
let seenVersion = 0
let writes: Promise<void> = Promise.resolve()

async function savedPath($: EngineInterface, scope: Scope): Promise<string> {
  const base = `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/vibe-gambit`
  return scope === 'global' ? `${base}/game.json` : `${base}/conversations/${await $.session.id()}.json`
}

/** The file as it stands: missing, broken (caught mid-write by another session), or read. */
async function readSaved($: EngineInterface, path: string): Promise<'missing' | 'broken' | Saved> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return 'missing'
  }
  try {
    return JSON.parse(text) as Saved
  } catch {
    return 'broken'
  }
}

/** The strings of the language this session speaks, once known: for what it tells on its own. */
let strings: Strings | undefined

/** What this session has told the person already, so another session's news is told once: `game:moves`, `game:end`. */
const announced = new Set<string>()

/** Tells the person `text` in a toast, once per `key`, and only while this session's board is hidden. */
async function announce($: EngineInterface, key: string, text: string) {
  if (announced.has(key)) return
  announced.add(key)
  const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  if (!isShown) $.ui.toast(text)
}

/** Tells what changed in a Lichess game: the opponent's move (the alert), or its end. */
async function announceChange($: EngineInterface, before: ChessGame, after: ChessGame, pending: ChessAlert | null) {
  const t = strings
  const lichess = after.lichess
  if (!t || !lichess || before.lichess?.gameId !== lichess.gameId) return
  if (pending && after.moves.length > before.moves.length) {
    await announce($, `${lichess.gameId}:${after.moves.length}`, t.opponentMoved(lichess.opponent, figurine(pending.san)))
  }
  if (before.lichess.status === 'started' && lichess.status !== 'started') {
    await announce($, `${lichess.gameId}:end`, lichessResult(after, t) ?? statusLine(replay(after.moves).position, t, lichess.color))
  }
}

/**
 * Takes in what another session wrote since this one last looked, and tells the person what it
 * brought: the opponent's move and the end of a game reach every session, not only the one following.
 */
async function adoptSaved($: EngineInterface, scope: Scope): Promise<void> {
  try {
    const saved = await readSaved($, await savedPath($, scope))
    if (typeof saved === 'string' || saved.version <= seenVersion) return
    seenVersion = saved.version
    if (saved.writer === WRITER) return
    const before = await read($, game)
    const after = await update($, game, () => saved.game)
    const pending = await update($, alert, () => saved.alert ?? null)
    await announceChange($, before, after, pending)
  } catch {
    // No file system or session id here (a test, a remote host): the game stays this session's.
  }
}

/**
 * At start: take in the saved game, or save this session's if there is none yet and it has one.
 * A game saved before the mod was named Vibe Gambit is taken over first.
 */
async function startSaved($: EngineInterface, scope: Scope): Promise<void> {
  try {
    const path = await savedPath($, scope)
    if (scope === 'global' && (await readSaved($, path)) === 'missing') {
      const old = await readSaved($, `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/chess/game.json`)
      if (typeof old === 'object') await writeWhole($, path, JSON.stringify({ ...old, writer: 'earlier-name' }))
    }
    const saved = await readSaved($, path)
    if (saved !== 'missing') return adoptSaved($, scope)
    if ((await read($, game)).moves.length > 0) await saveGame($, scope)
  } catch {
    // No file system or session id here: the game stays this session's.
  }
}

/**
 * Writes a file whole: to a temporary file first, then renamed over it, so a reader never meets it
 * half written. Without a rename (no mv), written in place.
 */
async function writeWhole($: EngineInterface, path: string, text: string) {
  const temporary = `${path}.${WRITER}.tmp`
  await $.fs.write(temporary, text)
  const moved = await $.process.run(['mv', temporary, path]).catch(() => undefined)
  if (moved?.exitCode !== 0) await $.fs.write(path, text)
}

/**
 * Writes the game for the other sessions, one write at a time. When another session has saved a
 * newer copy this one has not taken in, the two are merged first (mergeGames) and this session takes
 * the result in: a session behind never wipes what another saved. `replace` is for a new game, which
 * stands whatever the file holds.
 */
function saveGame($: EngineInterface, scope: Scope, options: { replace?: boolean } = {}): Promise<void> {
  writes = writes
    .then(async () => {
      const path = await savedPath($, scope)
      let saved = await readSaved($, path)
      // Caught mid-write by another session: read again. Still broken after that, it was left so
      // (a crash, a full disk): written over rather than abandoned for good.
      for (let tries = 0; saved === 'broken' && tries < 3; tries++) {
        await $.clock.sleep(100)
        saved = await readSaved($, path)
      }
      if (saved === 'broken') saved = 'missing'
      let mine = await read($, game)
      let myAlert = await read($, alert)
      if (typeof saved === 'object' && saved.writer !== WRITER && saved.version > seenVersion && !options.replace) {
        const merged = mergeGames(mine, saved.game)
        const isOtherGame = (merged.lichess?.gameId ?? 'local') !== (mine.lichess?.gameId ?? 'local')
        mine = await update($, game, () => merged)
        // The alert goes with its game: theirs for another game, else this session's, or theirs if none.
        myAlert = await update($, alert, held => (isOtherGame ? (saved.alert ?? null) : (held ?? saved.alert ?? null)))
      }
      const version = Math.max(await $.clock.now(), (typeof saved === 'object' ? saved.version : 0) + 1)
      seenVersion = version
      const next: Saved = { version, writer: WRITER, game: mine, alert: myAlert }
      await writeWhole($, path, JSON.stringify(next))
    })
    .catch(() => undefined)
  return writes
}

/** How long the sign-in listener waits for the browser to come back. */
const SIGN_IN_WAIT_MS = 5 * 60_000

/**
 * The folder of the Lichess token: a file only the user can read, never shown anywhere. Undefined
 * without HOME: never a shared folder such as /tmp, where another user could make it first.
 */
async function tokenFolder($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.config/vibe-gambit` : undefined
}

/** Where the token was kept before the mod was named Vibe Gambit. */
async function oldTokenFile($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.config/chess-mod/lichess-token` : undefined
}

async function readToken($: EngineInterface): Promise<string | undefined> {
  const folder = await tokenFolder($)
  if (!folder) return undefined
  try {
    return (await $.fs.read(`${folder}/lichess-token`)).trim() || undefined
  } catch {
    // Kept under the old name: moved into place (still private), then read from there.
    const old = await oldTokenFile($)
    if (!old || !(await $.fs.exists(old).catch(() => false))) return undefined
    const script = 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && mv "$2" "$1/lichess-token" && chmod 600 "$1/lichess-token"'
    await $.process.run(['sh', '-c', script, 'sh', folder, old]).catch(() => undefined)
    return (await $.fs.read(`${folder}/lichess-token`).catch(() => '')).trim() || undefined
  }
}

/**
 * Writes the token through stdin, so it is never on a command line, into a new private file renamed
 * over the old one: never into a file that exists, whose permissions (or link) would stand.
 * Answers whether it was written.
 */
async function saveToken($: EngineInterface, token: string): Promise<boolean> {
  const folder = await tokenFolder($)
  if (!folder) return false
  const script = 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && f=$(mktemp "$1/.lichess-token.XXXXXX") && cat > "$f" && mv -f "$f" "$1/lichess-token"'
  const ran = await $.process.run(['sh', '-c', script, 'sh', folder], { stdin: token }).catch(() => undefined)
  return ran?.exitCode === 0
}

/** Revokes a token at Lichess. True when Lichess no longer accepts it (revoked now, or already unknown: 401). */
async function revokeToken($: EngineInterface, token: string): Promise<boolean> {
  const reply = await lichessRequest($, '/api/token', { method: 'DELETE', token })
  return reply.kind === 'ok' || (reply.kind === 'refused' && reply.status === 401)
}

/** The Lichess user the token signs in as, or undefined when Lichess refuses it. */
async function lichessUser($: EngineInterface, token: string): Promise<string | undefined> {
  const reply = await lichessRequest($, '/api/account', { token })
  return reply.kind === 'ok' ? (JSON.parse(reply.text) as { username?: string }).username : undefined
}

/**
 * The ways to wait for the browser's one request, tried in order; the first that starts and stays up
 * listens. Checked on macOS, Ubuntu, Debian, Fedora, Arch and Alpine:
 * - `-l -p … -s …`: the OpenBSD netcat (Ubuntu, Debian, Arch), the traditional one, busybox's on
 *   Alpine. macOS's nc and ncat refuse it at once, which moves on to the next;
 * - `-l address port`: macOS's nc and ncat (Fedora's nc). The traditional netcat and busybox would
 *   take it without listening there, so it comes after;
 * - busybox's nc where it is no `nc`, on 127.0.0.1 too: a busybox whose nc takes no address
 *   refuses it at once, which moves on to python3. Never every interface.
 */
export const LISTENERS: readonly (readonly string[])[] = [
  ['nc', '-l', '-p', String(OAUTH_PORT), '-s', '127.0.0.1'],
  ['nc', '-l', '127.0.0.1', String(OAUTH_PORT)],
  ['ncat', '-l', '127.0.0.1', String(OAUTH_PORT)],
  ['busybox', 'nc', '-l', '-p', String(OAUTH_PORT), '-s', '127.0.0.1'],
  [
    'python3',
    '-c',
    [
      'import socket,sys',
      's=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
      's.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(1)',
      'c,_=s.accept(); data=b""',
      'while b"\\r\\n\\r\\n" not in data and len(data) < 8192:',
      '    chunk=c.recv(4096)',
      '    if not chunk: break',
      '    data+=chunk',
      'sys.stdout.write(data.split(b"\\r\\n")[0].decode("latin-1")+"\\n"); sys.stdout.flush()',
      'c.sendall(sys.stdin.buffer.read()); c.close()',
    ].join('\n'),
    String(OAUTH_PORT),
  ],
]
/** A listener that ends within this, or says something first, did not take its options. */
const LISTENER_SETTLE_MS = 500

type Listener = ReturnType<EngineInterface['process']['spawn']>
/** A listener up and waiting, and its first step (still owed to the reader). */
type Started = { listener: Listener; first: Promise<IteratorResult<ProcessChunk, unknown> | 'failed'> }
type ProcessChunk = { stream: 'stdout' | 'stderr'; text: string }

/** The first of LISTENERS that starts and keeps listening, or undefined when none can. */
async function startListener($: EngineInterface, input: string): Promise<Started | undefined> {
  for (const argv of LISTENERS) {
    let listener: Listener
    try {
      listener = $.process.spawn({ argv, input })
    } catch {
      continue
    }
    // The browser has not come back yet: anything this soon (an exit, a usage message) is a failure.
    const first = listener.next().then(
      step => step,
      () => 'failed' as const,
    )
    const early = await within($, first, LISTENER_SETTLE_MS)
    // Up and waiting. The first step is still owed to the reader: handed back with the listener.
    if (early === 'timeout') return { listener, first }
    if (early !== 'failed' && !early.done) inBackground(listener.return({ code: null, signal: 'failed' }))
  }
  return undefined
}

/** Opens a URL in the person's browser: open on macOS, xdg-open then wslview elsewhere. False when none did. */
async function openInBrowser($: EngineInterface, url: string): Promise<boolean> {
  const system = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
  const openers = system === 'Darwin' ? ['open'] : ['xdg-open', 'wslview']
  for (const opener of openers) {
    const ran = await $.process.run([opener, url]).catch(() => undefined)
    if (ran?.exitCode === 0) return true
  }
  return false
}

/**
 * The sign-in under way: the browser's return must carry its state. It comes back to a listener, or
 * the person pastes the address it landed on; the first to come finishes it.
 */
let signIn: { verifier: string; state: string } | undefined
/** Listeners still waiting for the browser, this sign-in's or an earlier attempt's on the same port. */
let listening = 0

/** Trades the code Lichess gave the browser for a token, saves it and says who is signed in. Answers what to tell. */
async function finishSignIn($: EngineInterface, code: string, verifier: string, t: Strings): Promise<string> {
  const exchanged = await lichessRequest($, '/api/token', { method: 'POST', body: tokenRequestBody(code, verifier), isPublic: true })
  if (exchanged.kind !== 'ok') return t.lichessFailed(whyNot(exchanged, t))
  const token = (JSON.parse(exchanged.text) as { access_token?: string }).access_token
  if (!token) return t.lichessFailed('no token')
  const replaced = await readToken($)
  if (!(await saveToken($, token))) {
    // A token that cannot be kept could never be revoked from here: revoke it now.
    await revokeToken($, token)
    return t.lichessFailed('save')
  }
  // The token this one replaces is no longer of use: revoked, not left valid at Lichess.
  const isOldKept = replaced !== undefined && replaced !== token && !(await revokeToken($, replaced))
  const user = await lichessUser($, token)
  await $.store.set('lichessUser', user ?? null)
  const said = (user ? t.lichessConnected(user) : t.lichessFailed('account')) + (isOldKept ? `. ${t.oldTokenKept}` : '')
  $.ui.status(`♞ ${said}`)
  $.clock.after(NOTICE_MS, () => $.ui.status(undefined))
  return said
}

/**
 * Opens the Lichess consent page in the browser and, in the background, waits for the browser to
 * come back to a one-shot listener, trades the code for a token and saves it. The person may also
 * paste the address the browser lands on (`/chess connect <address>`): where nothing can listen, or
 * where the browser is on another machine. Answers what to tell the person.
 */
async function signInToLichess($: EngineInterface, t: Strings): Promise<string> {
  if (!(await tokenFolder($))) return t.lichessNoHome
  const { verifier, challenge, state } = await newSignIn()
  signIn = { verifier, state }
  const url = authorizeUrl(challenge, state)
  const page = callbackResponse(t.lichessPage)
  const started = await startListener($, page)
  if (started) waitForBrowser($, started, t, page)
  const isOpened = await openInBrowser($, url)
  // No listener, not even an earlier attempt's still holding the port: only the paste is left.
  if (listening === 0) return t.lichessPaste(url)
  return isOpened ? t.lichessOpened(url) : t.lichessOpenThis(url)
}

/** The most of a request the listener reads: the browser's first line is far shorter. */
const REQUEST_CAP = 8192

/**
 * Waits, in the background, for the browser's one request to a listener, up to SIGN_IN_WAIT_MS, and
 * finishes the sign-in under way with it: the latest one, so that a listener left by an earlier
 * attempt (the port is still its own) serves the new attempt. A request that is not the browser's
 * (another program's, one too long) does not end the sign-in: a new listener waits on.
 */
function waitForBrowser($: EngineInterface, { listener, first }: Started, t: Strings, page: string, deadline?: number) {
  listening += 1
  let timer: { cancel: () => void } | undefined
  inBackground(
    (async () => {
      const now = await $.clock.now()
      const end = deadline ?? now + SIGN_IN_WAIT_MS
      const timedOut = new Promise<'timeout'>(resolve => (timer = $.clock.after(Math.max(0, end - now), () => resolve('timeout'))))
      let request = ''
      let errors = ''
      let isCut = false
      try {
        for (let step = await Promise.race([first, timedOut]); ; step = await Promise.race([listener.next().catch(() => 'failed' as const), timedOut])) {
          if (step === 'timeout') {
            // Stopped here and now, not once its pending read ends: the port is free again.
            inBackground(listener.return({ code: null, signal: 'timeout' }))
            if (signIn && listening === 1) $.ui.toast(t.lichessFailed('timed out'))
            return
          }
          if (step === 'failed' || step.done) break
          if (step.value.stream === 'stdout') request += step.value.text
          else errors += step.value.text
          if (request.length > REQUEST_CAP) {
            isCut = true
            inBackground(listener.return({ code: null, signal: 'too-long' }))
            break
          }
        }
      } finally {
        listening -= 1
        timer?.cancel()
      }
      if (/in use/i.test(errors)) return $.ui.toast(t.lichessFailed(`port ${OAUTH_PORT} busy`))
      // Finished already (the person pasted the address, or signed out): nothing left for this request.
      const current = signIn
      if (!current) return
      const answer = isCut ? { error: 'no-request' } : readCallback(request, current.state)
      if ('error' in answer) {
        // Not the browser's answer (another program's request, the wrong address): listen again, same deadline.
        const isStray = ['no-request', 'wrong-address', 'state-mismatch', 'ambiguous'].includes(answer.error)
        if (isStray && (await $.clock.now()) < end) {
          const again = await startListener($, page)
          if (again) return waitForBrowser($, again, t, page, end)
        }
        return $.ui.toast(t.lichessFailed(answer.error))
      }
      signIn = undefined
      $.ui.toast(await finishSignIn($, answer.code, current.verifier, t))
    })().catch(() => $.ui.toast(t.lichessFailed('unexpected'))),
  )
}

/** The address the browser landed on, pasted by the person: finishes the sign-in it belongs to. */
async function finishPastedSignIn($: EngineInterface, address: string, t: Strings): Promise<string> {
  const current = signIn
  if (!current) return t.lichessFailed('no sign-in under way: /chess connect')
  const answer = readCallback(`GET ${address} HTTP/1.1`, current.state)
  if ('error' in answer) return t.lichessFailed(answer.error)
  signIn = undefined
  return finishSignIn($, answer.code, current.verifier, t)
}

/**
 * Revokes the token at Lichess and deletes it here: `revoked`, `local` when Lichess could not revoke it
 * (deleted here all the same; the person can revoke it on lichess.org), `none` when there was no token.
 */
async function signOutOfLichess($: EngineInterface): Promise<'revoked' | 'local' | 'none'> {
  // A sign-in under way ends too: the browser coming back afterwards signs nobody in.
  signIn = undefined
  const token = await readToken($)
  if (!token) return 'none'
  const isRevoked = await revokeToken($, token)
  // Deleted only if still that token: another session may have signed in while it was revoked.
  const folder = await tokenFolder($)
  const now = folder ? await $.fs.read(`${folder}/lichess-token`).then(text => text.trim(), () => undefined) : undefined
  if (folder && now === token) await $.process.run(['rm', '-f', `${folder}/lichess-token`]).catch(() => undefined)
  await $.store.delete('lichessUser')
  return isRevoked ? 'revoked' : 'local'
}

/** The games this module follows on Lichess right now, by id: one stream each. */
const following = new Set<string>()
/**
 * Per game: no new stream before `nextAt`, pushed back further each time a stream drops right after
 * opening (`drops`). A lease another session holds is no drop: it is tried again in a second.
 */
const retries = new Map<string, { nextAt: number; drops: number }>()

/**
 * Lichess keeps one stream per game and account, closing the older when another opens: so one
 * session follows each game, holding that game's lease and renewing it every second; the others read
 * the shared file.
 */
type Lease = { writer: string; until: number }
const LEASE_MS = 5000

async function leasePath($: EngineInterface, gameId: string): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/vibe-gambit/stream-lease-${gameId}.json`
}

/** Takes or renews the game's lease; false while another session holds it. */
async function holdLease($: EngineInterface, gameId: string): Promise<boolean> {
  try {
    const path = await leasePath($, gameId)
    const now = await $.clock.now()
    const held = await $.fs
      .read(path)
      .then(text => JSON.parse(text) as Lease)
      .catch(() => undefined)
    if (held && held.writer !== WRITER && held.until > now) return false
    await $.fs.write(path, JSON.stringify({ writer: WRITER, until: now + LEASE_MS }))
    // Two sessions writing at once: the file says which one won.
    await $.clock.sleep(150)
    const after = JSON.parse(await $.fs.read(path)) as Lease
    return after.writer === WRITER
  } catch {
    return true
  }
}

async function releaseLease($: EngineInterface, gameId: string) {
  try {
    const path = await leasePath($, gameId)
    const held = JSON.parse(await $.fs.read(path)) as Lease
    if (held.writer === WRITER) await $.fs.write(path, JSON.stringify({ writer: WRITER, until: 0 }))
  } catch {
    // Nothing held.
  }
}

/**
 * Follows a Lichess game through the Board API's stream, read by curl with the token on stdin,
 * taking in every line until the game ends or the stream drops (the ticker then follows it again).
 */
async function followLichessGame($: EngineInterface, gameId: string, scope: Scope, t: Strings) {
  const startedAt = await $.clock.now()
  const retry = retries.get(gameId) ?? { nextAt: 0, drops: 0 }
  if (following.has(gameId) || startedAt < retry.nextAt || startedAt < limitedUntil) return
  following.add(gameId)
  let isOpened = false
  let httpStatus = 0
  try {
    if (!(await holdLease($, gameId))) return
    const token = await readToken($)
    if (!token) return await markUnreachable($, gameId, scope, t)
    // -w adds the HTTP status as the last line: --fail would hide why a stream is refused.
    const stream = $.process.spawn({
      // -q first: no ~/.curlrc, which could add a host the token would go to.
      argv: ['curl', '-q', '-sN', '-w', '\n%{http_code}', '-K', '-', `${LICHESS}/api/board/game/stream/${gameId}`],
      input: `header = "Authorization: Bearer ${token}"\n`,
    })
    isOpened = true
    let buffer = ''
    let lines = 0
    for await (const chunk of stream) {
      if (chunk.stream !== 'stdout') continue
      buffer += chunk.text
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        let event: LichessEvent
        try {
          event = JSON.parse(line) as LichessEvent
        } catch {
          // Not JSON: an error page (a 429 from a proxy, say). The status line after it says why.
          continue
        }
        lines += 1
        if (!(await takeLichessEvent($, gameId, event, scope, t))) {
          // The board shows another game now: this stream has nothing more for it.
          await stream.return({ code: null, signal: 'superseded' })
          return
        }
      }
    }
    if (/^\d{3}$/.test(buffer.trim())) httpStatus = Number(buffer.trim())
    if (httpStatus === 401 || httpStatus === 403) return await markUnreachable($, gameId, scope, t)
    if (httpStatus === 429) limitedUntil = (await $.clock.now()) + RATE_LIMIT_MS
    // Unknown to Lichess, or not playable through the Board API: over here too.
    if (httpStatus === 404 || httpStatus === 400) return await endHere($, gameId, 'unknownFinish', undefined, scope)
    // Closed at once with nothing: Lichess closes a game's stream when the game is over.
    if (httpStatus === 200 && lines === 0) await readPublicRecord($, gameId, scope)
  } finally {
    following.delete(gameId)
    await releaseLease($, gameId)
    const now = await $.clock.now()
    if (httpStatus === 429) {
      // Too many requests: the docs ask for a minute's wait.
      retries.set(gameId, { nextAt: Math.max(now + RATE_LIMIT_MS, limitedUntil), drops: retry.drops })
    } else if (isOpened) {
      // A stream that closes at once is retried later and later (2 s, 4 s... up to 30 s), never in a loop.
      const drops = now - startedAt < 5000 ? retry.drops + 1 : 0
      retries.set(gameId, { nextAt: now + Math.min(30_000, 1000 * 2 ** drops), drops })
    } else {
      // The lease is another session's, or there is no token: look again in a second, no penalty.
      retries.set(gameId, { nextAt: now + 1000, drops: retry.drops })
    }
  }
}

/** Changes the board's Lichess game, if it is still `gameId`, and tells the other sessions. */
async function changeLichessGame($: EngineInterface, gameId: string, scope: Scope, change: (lichess: NonNullable<ChessGame['lichess']>) => NonNullable<ChessGame['lichess']>) {
  const now = await $.clock.now()
  await update($, game, current => {
    if (current.lichess?.gameId !== gameId) return current
    const changed = change(current.lichess)
    // Found over here: timed, for the line under the prompt.
    const endedAt = changed.status === 'started' ? undefined : (changed.endedAt ?? now)
    return { ...current, lichess: { ...changed, endedAt }, pending: undefined }
  })
  await saveGame($, scope)
}

/** The game is over as far as this session can tell (unknown to Lichess, say). */
async function endHere($: EngineInterface, gameId: string, status: string, winner: 'white' | 'black' | undefined, scope: Scope) {
  await changeLichessGame($, gameId, scope, lichess => ({ ...lichess, status, winner, drawOffer: undefined }))
}

/** No token, or one Lichess refuses: the game goes on on Lichess but not here; said once. */
async function markUnreachable($: EngineInterface, gameId: string, scope: Scope, t: Strings) {
  if ((await read($, game)).lichess?.unreachable) return
  await changeLichessGame($, gameId, scope, lichess => ({ ...lichess, unreachable: 'token' }))
  $.ui.toast(t.cannotFollow)
}

/** Reads a game's public record (no token needed) and, if it is over, ends it here as Lichess did. */
async function readPublicRecord($: EngineInterface, gameId: string, scope: Scope) {
  const reply = await lichessRequest($, `/game/export/${gameId}?moves=false&tags=false&clocks=false&evals=false&opening=false`, {
    isPublic: true,
    accept: 'application/json',
  })
  if (reply.kind === 'refused' && reply.status === 404) return endHere($, gameId, 'unknownFinish', undefined, scope)
  if (reply.kind !== 'ok') return
  const record = JSON.parse(reply.text) as { status?: string; winner?: 'white' | 'black' }
  if (record.status && record.status !== 'started' && record.status !== 'created') await endHere($, gameId, record.status, record.winner, scope)
}

/** The person's Lichess name: on record, else asked of Lichess and recorded. Undefined if Lichess cannot say. */
async function knownUser($: EngineInterface): Promise<string | undefined> {
  const held = await $.store.get('lichessUser')
  if (typeof held === 'string' && held) return held
  const reply = await lichessRequest($, '/api/account')
  if (reply.kind !== 'ok') return undefined
  const user = (JSON.parse(reply.text) as { username?: string }).username
  if (user) await $.store.set('lichessUser', user)
  return user
}

/**
 * One line of the stream: the game updated, and the person told when the opponent moved or the game
 * ended. False when the board shows another game now: the stream is then left.
 */
async function takeLichessEvent($: EngineInterface, gameId: string, event: LichessEvent, scope: Scope, t: Strings): Promise<boolean> {
  // Another game took the board (from another session, say): this one's lines change nothing.
  await adoptSaved($, scope)
  if ((await read($, game)).lichess?.gameId !== gameId) return false
  const now = await $.clock.now()
  // A game's first line names the players: the person's name is needed to tell their colour.
  const you = event.type === 'gameFull' ? await knownUser($) : ((await $.store.get('lichessUser')) as string | undefined)
  const before = await read($, game)
  const after = await update($, game, current => applyLichessEvent(current, event, now, you, t.stockfish))
  const lichess = after.lichess
  if (!lichess) return true
  const theirMove = after.moves.length > before.moves.length && replay(after.moves.slice(0, -1)).position.turn !== lichess.color
  // The opponent's move is recorded for every session (each tells it while its board is hidden), even
  // when this session's board shows it.
  let pending: ChessAlert | null = null
  if (theirMove && event.type === 'gameState') {
    pending = { mover: lichess.color === 'w' ? 'b' : 'w', san: replay(after.moves).sans.at(-1)! }
    await update($, alert, () => pending)
  }
  await announceChange($, before, after, pending)
  await saveGame($, scope)
  return true
}

export type AiColor = 'white' | 'black' | 'random'

/** The colour a word names, in English or French: white, black, random (blancs, noirs, hasard). */
export function colorOf(word: string): AiColor | undefined {
  const value = word.trim().toLowerCase()
  if (/^(white|blancs?)$/.test(value)) return 'white'
  if (/^(black|noirs?)$/.test(value)) return 'black'
  if (/^(random|hasard)$/.test(value)) return 'random'
  return undefined
}

/** Lichess's usual pools for a speed asked by name: rapid and classical, the speeds a random pairing takes. */
const SPEED_WORDS: Record<string, string> = {
  rapid: '10+0',
  rapide: '10+0',
  classical: '30+0',
  classic: '30+0',
  classique: '30+0',
}

/**
 * The game a shortcut names, from the words after `/chess`: `local 10+0`, `lichess rapid`,
 * `lichess 15+10`, `lichess stockfish 3 5+3 black`, `lichess friend magnus 5+3`, `new …` the same.
 * Undefined when the words name no game (`/chess new` alone, `/chess lichess` alone: the screen).
 */
export function formFromWords(words: readonly string[], base: SetupForm): SetupForm | undefined {
  let [head, ...rest] = words
  if (head === 'new') [head, ...rest] = rest
  let opponent: SetupForm['opponent']
  if (head === 'stockfish') opponent = 'stockfish'
  else if (head === 'lichess') {
    const [kind, ...after] = rest
    if (kind === 'stockfish' || kind === 'ai' || kind === 'ia') [opponent, rest] = ['stockfish', after]
    else if (kind === 'friend' || kind === 'ami') [opponent, rest] = ['friend', after]
    else if (rest.length > 0) opponent = 'random'
    else return undefined
  } else return undefined
  const level = Number(rest.find(word => /^[1-8]$/.test(word)))
  const speed = rest.map(word => SPEED_WORDS[word]).find(Boolean)
  const timeControl = rest.find(word => /^\d+(\.\d+)?\+\d+$/.test(word)) ?? speed
  const color = colorOf(rest.find(word => colorOf(word) !== undefined) ?? '')
  const isWord = (word: string) => colorOf(word) !== undefined || word in SPEED_WORDS || /^\d/.test(word) || /^(rated|casual|classée|amicale)$/.test(word)
  const friend = opponent === 'friend' ? rest.find(word => /^@?[a-z0-9][\w-]{1,29}$/i.test(word) && !isWord(word))?.replace(/^@/, '') : undefined
  return fitForm({
    ...base,
    opponent,
    level: level >= 1 ? level : base.level,
    timeControl: timeControl ?? (opponent === 'random' ? '10+0' : base.timeControl),
    color: color ?? 'random',
    rated: rest.includes('rated') || rest.includes('classée'),
    friend: friend ?? '',
  })
}

/** Starts a game against Lichess's AI and follows it. Answers what to tell the person. */
async function startAiGame($: EngineInterface, level: number, timeControl: string, color: AiColor, scope: Scope, t: Strings) {
  if (!(await readToken($))) return t.needLichess
  const reply = await lichessRequest($, '/api/challenge/ai', { method: 'POST', body: aiChallengeBody(level, timeControl, color) })
  if (reply.kind !== 'ok') return t.aiFailed(whyNot(reply, t))
  const gameId = (JSON.parse(reply.text) as { id?: string }).id
  if (!gameId) return t.aiFailed('no game id')
  if (!(await attachLichessGame($, gameId, t.stockfish(level), color, timeControl, scope, t))) return t.otherGameOn(lichessGameUrl(gameId))
  return t.aiStarted(level, timeControl)
}

/**
 * Shows a Lichess game that has just started and follows it; its stream's first line fixes colours
 * and clocks. Another live game on the board (this session's or another's) stands: the new one is not
 * shown, the person is told where it is. Answers whether it is shown.
 */
async function attachLichessGame(
  $: EngineInterface,
  gameId: string,
  opponent: string,
  color: AiColor,
  timeControl: string,
  scope: Scope,
  t: Strings,
): Promise<boolean> {
  await adoptSaved($, scope)
  const current = await read($, game)
  if (current.lichess && isLichessOn(current) && current.lichess.gameId !== gameId) {
    $.ui.toast(t.otherGameOn(lichessGameUrl(gameId)))
    return false
  }
  const placeholder: ChessGame = {
    moves: [],
    clock: newClock(timeControl),
    flipped: color === 'black',
    lichess: { gameId, color: color === 'black' ? 'b' : 'w', opponent, status: 'started' },
  }
  await update($, game, () => placeholder)
  await update($, alert, () => null)
  await update($, screen, () => 'board' as const)
  await saveGame($, scope, { replace: true })
  inBackground(followLichessGame($, gameId, scope, t))
  return true
}

/** Stops this session's search for an opponent: closing its connection cancels the seek or the challenge. */
let stopSearch: (() => void) | null = null

/** How long the resign button waits for its second press. */
const RESIGN_ASK_MS = 5000
/** The resign button was pressed once: it asks again until this cancels it. */
let resignAsk: { cancel: () => void } | null = null

type Playing = { gameId: string; color: 'white' | 'black'; speed: string; opponent?: { username?: string; rating?: number; ai?: number } }

/** The person's games under way on Lichess, most urgent first; undefined when Lichess cannot say. */
async function gamesPlaying($: EngineInterface): Promise<Playing[] | undefined> {
  const reply = await lichessRequest($, '/api/account/playing?nb=50')
  return reply.kind === 'ok' ? ((JSON.parse(reply.text) as { nowPlaying?: Playing[] }).nowPlaying ?? []) : undefined
}

/** How long, after pairing, the seek keeps looking for its game among the person's. */
const FIND_PAIRED_MS = 45_000

/**
 * Seeks a random opponent through the Board API: the connection stays open while Lichess looks
 * (closing it cancels the seek), and closes once paired or expired. The new game is then the one among
 * the person's games that was not there before, live, of the seek's speed and against a person; Lichess
 * may take a while to list it, so it is looked for up to FIND_PAIRED_MS. Answers what to tell the person.
 */
async function startSeek($: EngineInterface, setup: SetupForm, scope: Scope, t: Strings): Promise<string> {
  const token = await readToken($)
  if (!token) return t.needLichess
  if ((await $.clock.now()) < limitedUntil) return t.challengeFailed(t.rateLimited)
  const listed = await gamesPlaying($)
  if (!listed) return t.cannotReadGames
  const before = new Set(listed.map(one => one.gameId))
  const speed = speedOf(setup.timeControl)
  const stream = $.process.spawn({
    // -w adds the HTTP status as the last line: a 429 is waited out like any other.
    argv: ['curl', '-q', '-sN', '-w', '\n%{http_code}', '-K', '-', '-X', 'POST', '-d', seekBody(setup), `${LICHESS}/api/board/seek`],
    input: `header = "Authorization: Bearer ${token}"\n`,
  })
  let isCancelled = false
  stopSearch = () => {
    isCancelled = true
    void stream.return({ code: null, signal: 'cancelled' })
  }
  await update($, search, () => ({ kind: 'seek' as const, timeControl: setup.timeControl }))
  inBackground(
    (async () => {
      let answer = ''
      for await (const chunk of stream) if (chunk.stream === 'stdout') answer += chunk.text
      stopSearch = null
      await update($, search, () => null)
      if (isCancelled) return
      const status = Number(/(\d{3})\s*$/.exec(answer)?.[1] ?? 0)
      if (status === 429) limitedUntil = (await $.clock.now()) + RATE_LIMIT_MS
      const refused = /"error"\s*:\s*"([^"]*)"/.exec(answer)?.[1] ?? (status === 429 ? t.rateLimited : undefined)
      if (refused) return $.ui.toast(t.challengeFailed(refused))
      const isPaired = (one: Playing) => !before.has(one.gameId) && one.speed === speed && one.opponent?.ai === undefined
      const deadline = (await $.clock.now()) + FIND_PAIRED_MS
      for (let wait = 1000; (await $.clock.now()) < deadline; wait = Math.min(8000, wait * 2)) {
        // Not the game the board shows (another session may have started one meanwhile).
        await adoptSaved($, scope)
        const shown = (await read($, game)).lichess?.gameId
        const found = (await gamesPlaying($))?.find(one => isPaired(one) && one.gameId !== shown)
        if (found) {
          const name = `${found.opponent?.username ?? '?'}${found.opponent?.rating ? ` ${found.opponent.rating}` : ''}`
          if (!(await attachLichessGame($, found.gameId, name, found.color, setup.timeControl, scope, t))) return
          await $.ui.open({ id: PANE, title: t.paneTitle, columns: PANE_COLUMNS })
          return $.ui.toast(t.gameFound(name, setup.timeControl))
        }
        await $.clock.sleep(wait)
      }
      // The seek closed with no game listed: it expired, or Lichess has not caught up.
      $.ui.toast(`${t.searchEnded} ${t.searchLost}`)
    })().catch(() => update($, search, () => null)),
  )
  return t.searching(setup.timeControl)
}

/**
 * Challenges a friend, keeping the challenge open while waiting: Lichess ends the stream with
 * `{"done":"accepted"}` (the game's id is the challenge's) or a refusal. Answers what to tell the person.
 */
async function startChallenge($: EngineInterface, setup: SetupForm, scope: Scope, t: Strings): Promise<string> {
  const token = await readToken($)
  if (!token) return t.needLichess
  if (!isUsername(setup.friend)) return t.needFriend
  if ((await $.clock.now()) < limitedUntil) return t.challengeFailed(t.rateLimited)
  const friend = setup.friend.trim()
  // -w adds the HTTP status as the last line, for an answer that is no JSON (an error page).
  const stream = $.process.spawn({
    argv: [
      'curl',
      '-q',
      '-sN',
      '-w',
      '\n%{http_code}',
      '-K',
      '-',
      '-X',
      'POST',
      '-d',
      challengeBody(setup),
      `${LICHESS}/api/challenge/${encodeURIComponent(friend)}`,
    ],
    input: `header = "Authorization: Bearer ${token}"\n`,
  })
  let isCancelled = false
  stopSearch = () => {
    isCancelled = true
    void stream.return({ code: null, signal: 'cancelled' })
  }
  await update($, search, () => ({ kind: 'challenge' as const, timeControl: setup.timeControl, friend }))
  const settleChallenge = async () => {
    let buffer = ''
    let challengeId: string | undefined
    let done: string | undefined
    let error: string | undefined
    let isLimited = false
    const take = (line: string) => {
      if (/^\d{3}$/.test(line)) {
        if (Number(line) === 429) {
          isLimited = true
          error ??= t.rateLimited
        }
        if (Number(line) >= 400) error ??= line
        return
      }
      try {
        const data = JSON.parse(line) as { id?: string; challenge?: { id?: string }; done?: string; error?: string }
        challengeId ??= data.id ?? data.challenge?.id
        done ??= data.done
        error ??= data.error
      } catch {
        // Not JSON: an error page from a proxy, say. Its text is the reason.
        error ??= line.slice(0, 120)
      }
    }
    for await (const chunk of stream) {
      if (chunk.stream !== 'stdout') continue
      buffer += chunk.text
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line) take(line)
      }
    }
    if (buffer.trim()) take(buffer.trim())
    if (isLimited) limitedUntil = (await $.clock.now()) + RATE_LIMIT_MS
    stopSearch = null
    await update($, search, () => null)
    if (isCancelled) return
    if (done === 'declined') return $.ui.toast(t.declined(friend))
    if (done === 'canceled') return $.ui.toast(t.challengeCanceled(friend))
    // Accepted, or cut off with no word: if Lichess lists the game, it is on (its id is the challenge's).
    const isOn = done === 'accepted' || (challengeId !== undefined && (await gamesPlaying($))?.some(one => one.gameId === challengeId))
    if (challengeId && isOn) {
      if (!(await attachLichessGame($, challengeId, friend, setup.color, setup.timeControl, scope, t))) return
      await $.ui.open({ id: PANE, title: t.paneTitle, columns: PANE_COLUMNS })
      return $.ui.toast(t.gameFound(friend, setup.timeControl))
    }
    if (error) return $.ui.toast(t.challengeFailed(error))
    $.ui.toast(t.challengeLost(friend))
  }
  inBackground(
    settleChallenge().catch(async () => {
      stopSearch = null
      await update($, search, () => null)
      $.ui.toast(t.challengeLost(friend))
    }),
  )
  return t.challenging(friend, setup.timeControl)
}

/** The game's page on Lichess: to watch it, play it there, or analyse it once over. */
export const lichessGameUrl = (gameId: string) => `${LICHESS}/${gameId}`

/** Opens the Lichess game in the browser. Answers what to tell, or undefined with no Lichess game. */
async function openOnLichess($: EngineInterface, t: Strings): Promise<string | undefined> {
  const lichess = (await read($, game)).lichess
  if (!lichess) return undefined
  const url = lichessGameUrl(lichess.gameId)
  return (await openInBrowser($, url)) ? t.opening(url) : t.openYourself(url)
}

/** Seconds left before the person may claim (0: now), or undefined when the opponent is here. */
export function claimIn(current: ChessGame, now: number): number | undefined {
  const gone = current.lichess?.opponentGone
  if (!gone) return undefined
  return gone.claimAt === null ? 0 : Math.max(0, Math.ceil((gone.claimAt - now) / 1000))
}

/** Claims the win or a draw from an opponent who left. Answers what to tell the person. */
async function claimFromGone($: EngineInterface, kind: 'victory' | 'draw', t: Strings): Promise<string> {
  const current = await read($, game)
  if (!current.lichess || !isLichessOn(current)) return t.noLichessGame
  const seconds = claimIn(current, await $.clock.now())
  if (seconds === undefined) return t.nothingToClaim
  if (seconds > 0) return t.claimNotYet(seconds)
  const reply = await lichessRequest($, `/api/board/game/${current.lichess.gameId}/claim-${kind}`, { method: 'POST' })
  if (reply.kind === 'ok') return kind === 'victory' ? t.winClaimed : t.drawClaimed
  return t.moveRefused(reply.kind === 'refused' ? reply.error : reply.kind === 'limited' ? '429' : reply.reason)
}

/** Accepts (`yes`) or declines (`no`) the opponent's request to take back their last move. */
async function answerTakeback($: EngineInterface, accept: 'yes' | 'no', t: Strings): Promise<string> {
  const current = await read($, game)
  const lichess = current.lichess
  if (!lichess || !isLichessOn(current)) return t.noLichessGame
  if (!lichess.takebackOffer || lichess.takebackOffer === lichess.color) return t.noTakeback
  const reply = await lichessRequest($, `/api/board/game/${lichess.gameId}/takeback/${accept}`, { method: 'POST' })
  if (reply.kind !== 'ok') return t.notTaken(whyNot(reply, t))
  return accept === 'yes' ? t.takebackAccepted : t.takebackDeclined
}

/** Offers a draw, or accepts the one on offer (`yes`); declines the one on offer (`no`). */
async function answerDraw($: EngineInterface, accept: 'yes' | 'no', t: Strings): Promise<string> {
  const current = await read($, game)
  const lichess = current.lichess
  if (!lichess || !isLichessOn(current)) return t.noLichessGame
  const isTheirs = lichess.drawOffer !== undefined && lichess.drawOffer !== lichess.color
  const reply = await lichessRequest($, `/api/board/game/${lichess.gameId}/draw/${accept}`, { method: 'POST' })
  if (reply.kind !== 'ok') return t.notTaken(whyNot(reply, t))
  if (accept === 'no') return t.drawDeclined
  return isTheirs ? t.drawAccepted : t.drawOffered
}

/** How long a move may go unconfirmed before the pane says so. */
const UNCONFIRMED_MS = 5000
/** How long the person's command waits for the move request before going on in the background. */
const MOVE_TIMEOUT_MS = 15_000
/** How long a move request is waited for at all; past it, Lichess is asked where the game stands. */
const MOVE_REQUEST_CAP_MS = 60_000
/** Between two looks at the game on Lichess while a move's fate is unknown; doubled after each failure. */
const CHECK_EVERY_MS = 3000
const CHECK_AT_MOST_MS = 60_000
/** How long a move Lichess did not play stays explained under the status. */
const FAILED_SHOWN_MS = 6000
/** After a 429, the Lichess docs say: wait a minute. */
const RATE_LIMIT_MS = 60_000
/** No Lichess request before this: a 429 was answered. */
let limitedUntil = 0

/**
 * One request to Lichess, read as a LichessReply. Never rejects. While a 429 is fresh it sends
 * nothing and answers `limited`; a 429 answered starts that minute. The token goes in the header,
 * unless `isPublic`.
 */
async function lichessRequest(
  $: EngineInterface,
  path: string,
  init: { method?: string; body?: string; isPublic?: boolean; accept?: string; token?: string } = {},
): Promise<LichessReply> {
  try {
    if ((await $.clock.now()) < limitedUntil) return { kind: 'limited' }
    const token = init.isPublic ? undefined : (init.token ?? (await readToken($)))
    if (!init.isPublic && !token) return { kind: 'refused', status: 401, error: 'no Lichess token' }
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    if (init.body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    if (init.accept) headers.Accept = init.accept
    const response = await $.http.fetch(`${LICHESS}${path}`, { method: init.method ?? 'GET', headers, body: init.body })
    const reply = readReply(response.status, response.text)
    if (reply.kind === 'limited') limitedUntil = (await $.clock.now()) + RATE_LIMIT_MS
    return reply
  } catch {
    return { kind: 'failed', reason: 'network' }
  }
}

/** Why Lichess did not do it, in the person's words. */
function whyNot(reply: Exclude<LichessReply, { kind: 'ok' }>, t: Strings): string {
  if (reply.kind === 'refused') return reply.error
  if (reply.kind === 'limited') return t.rateLimited
  return reply.reason
}

/** The work's result, or `timeout` once `ms` have passed; the work itself goes on. */
async function within<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([work, $.clock.sleep(ms).then(() => 'timeout' as const)])
}

/** Is the pending move still this one, untouched by Lichess's stream? */
const isStillPending = (current: ChessGame, uci: string, index: number) =>
  current.pending?.uci === uci && current.pending.index === index && current.moves[index] === uci

/** The move is Lichess's: no longer pending. */
async function confirmMove($: EngineInterface, uci: string, index: number, scope: Scope) {
  await update($, game, g => (isStillPending(g, uci, index) ? { ...g, pending: undefined } : g))
  await saveGame($, scope)
}

/** Takes the person's move back from the board, if it is still the one pending. */
async function takeBack($: EngineInterface, uci: string, index: number, scope: Scope) {
  await update($, game, g => (isStillPending(g, uci, index) ? { ...g, moves: g.moves.slice(0, index), pending: undefined } : g))
  await saveGame($, scope)
}

/**
 * Where a game stands on Lichess: under way (and whose turn), over, or `unknown` when Lichess cannot
 * say right now. Read from the person's games under way, which Lichess keeps current.
 */
async function whereIsGame($: EngineInterface, gameId: string): Promise<{ isPlaying: true; isMyTurn: boolean } | { isPlaying: false } | 'unknown'> {
  const reply = await lichessRequest($, '/api/account/playing?nb=50')
  if (reply.kind !== 'ok') return 'unknown'
  const found = ((JSON.parse(reply.text) as { nowPlaying?: { gameId: string; isMyTurn: boolean }[] }).nowPlaying ?? []).find(
    one => one.gameId === gameId,
  )
  return found ? { isPlaying: true, isMyTurn: found.isMyTurn } : { isPlaying: false }
}

/**
 * Settles a move whose request got no clear answer. The request is waited for first (up to a
 * minute): Lichess's own answer decides. Failing that, Lichess is asked where the game stands until it
 * can say: still waiting for the person's move means it was not played, else it was. The export is
 * read only for a game over, when it is complete (for a game under way it leaves out the last moves).
 * Meanwhile the move stays pending, which keeps a second one from being sent; Lichess's stream may
 * settle it first.
 */
async function settleMove(
  $: EngineInterface,
  gameId: string,
  uci: string,
  index: number,
  scope: Scope,
  t: Strings,
  san: string,
  request?: Promise<LichessReply>,
) {
  if (request) {
    const reply = await within($, request, MOVE_REQUEST_CAP_MS)
    if (reply !== 'timeout' && reply.kind === 'ok') return confirmMove($, uci, index, scope)
    if (reply !== 'timeout' && reply.kind === 'refused') {
      await takeBack($, uci, index, scope)
      return showFailure($, san, reply.error)
    }
  }
  for (let wait = CHECK_EVERY_MS; ; wait = Math.min(CHECK_AT_MOST_MS, wait * 2)) {
    await $.clock.sleep(Math.max(wait, limitedUntil - (await $.clock.now())))
    if (!isStillPending(await read($, game), uci, index)) return
    const where = await whereIsGame($, gameId)
    if (where === 'unknown') continue
    if (where.isPlaying) {
      if (!where.isMyTurn) return confirmMove($, uci, index, scope)
      await takeBack($, uci, index, scope)
      return showFailure($, san, t.noAnswer)
    }
    const exported = await lichessRequest($, `/game/export/${gameId}?moves=true&tags=false&clocks=false&evals=false&opening=false`, {
      isPublic: true,
      accept: 'application/json',
    })
    if (exported.kind !== 'ok') continue
    const moves = ((JSON.parse(exported.text) as { moves?: string }).moves ?? '').split(' ').filter(Boolean)
    if (moves.length > index) return confirmMove($, uci, index, scope)
    await takeBack($, uci, index, scope)
    return showFailure($, san, t.noAnswer)
  }
}

async function showFailure($: EngineInterface, san: string, reason: string) {
  await update($, delivery, () => ({ san, reason }))
  $.clock.after(FAILED_SHOWN_MS, () => inBackground(update($, delivery, held => (held?.san === san && held.reason === reason ? null : held))))
}

/**
 * Plays the person's move in a Lichess game: on the board at once, marked pending, then sent. It
 * leaves the board only on Lichess's own word: a refusal, or Lichess still waiting for the person's
 * move once the request is over (settleMove). Answers the game after, the move, and Lichess's refusal if any.
 */
async function playLichessMove(
  $: EngineInterface,
  pick: (position: Position) => Move | undefined,
  scope: Scope,
  t: Strings,
): Promise<{ after: ChessGame; played: Move | undefined; refused?: string }> {
  const current = await read($, game)
  const lichess = current.lichess!
  const { position } = replay(current.moves)
  if (position.turn !== lichess.color || current.pending) return { after: current, played: undefined, refused: t.notYourTurn }
  const played = pick(position)
  if (played === undefined) return { after: current, played }
  const uci = toUci(played)
  const index = current.moves.length
  const san = figurine(replay([...current.moves, uci]).sans.at(-1)!)
  const since = await $.clock.now()
  const after = await update($, game, g => ({ ...g, moves: [...g.moves, uci], pending: { uci, index, since } }))
  await update($, alert, () => null)
  await update($, delivery, () => null)
  await saveGame($, scope)
  const request = lichessRequest($, `/api/board/game/${lichess.gameId}/move/${uci}`, { method: 'POST' })
  const reply = await within($, request, MOVE_TIMEOUT_MS)
  if (reply !== 'timeout' && reply.kind === 'ok') {
    await confirmMove($, uci, index, scope)
    return { after: await read($, game), played }
  }
  if (reply !== 'timeout' && reply.kind === 'refused') {
    await takeBack($, uci, index, scope)
    await showFailure($, san, reply.error)
    return { after: await read($, game), played: undefined, refused: t.moveRefused(reply.error) }
  }
  // No clear answer yet: the request is still waited for in the background.
  inBackground(settleMove($, lichess.gameId, uci, index, scope, t, san, reply === 'timeout' ? request : undefined))
  return { after, played }
}

/** Resigns the Lichess game, or aborts it before both sides have moved. */
async function resignLichessGame($: EngineInterface, t: Strings): Promise<string> {
  const current = await read($, game)
  if (!current.lichess || !isLichessOn(current)) return t.noLichessGame
  // /resign aborts a game still abortable (before both first moves): the wording follows.
  const reply = await lichessRequest($, `/api/board/game/${current.lichess.gameId}/resign`, { method: 'POST' })
  if (reply.kind !== 'ok') return t.notTaken(whyNot(reply, t))
  return current.moves.length < 2 ? t.aborted : t.youResigned
}

/**
 * Starts the game the New game screen describes. Answers what to tell the person, and whether the
 * game started (the pane then turns back to the board).
 */
async function startFromForm($: EngineInterface, setup: SetupForm, scope: Scope, t: Strings): Promise<{ text: string; isOn: boolean }> {
  if (isLichessOn(await read($, game))) return { text: t.lichessGameOn, isOn: false }
  if ((await read($, search)) !== null) return { text: t.searching((await read($, search))!.timeControl), isOn: false }
  if (!(await readToken($))) return { text: t.needLichess, isOn: false }
  try {
    if (setup.opponent === 'stockfish') {
      const text = await startAiGame($, setup.level, setup.timeControl, setup.color, scope, t)
      return { text, isOn: text === t.aiStarted(setup.level, setup.timeControl) }
    }
    // A search: the board comes once Lichess pairs the game.
    const text = setup.opponent === 'random' ? await startSeek($, setup, scope, t) : await startChallenge($, setup, scope, t)
    return { text, isOn: false }
  } catch {
    // Whatever failed on the way (curl missing, the network gone): a message, not an error.
    return { text: setup.opponent === 'stockfish' ? t.aiFailed('network') : t.challengeFailed('network'), isOn: false }
  }
}

// The hint line names the move in figurines, the same in every language.
/** How long, once a game is over, the line under the prompt still gives its result. */
export const RESULT_SHOWN_MS = 10_000

/**
 * The tail of the hint line under the prompt while the board is hidden, short since the row cuts
 * it: both clocks first (♔ White, ♚ Black), then the last move, whoever played it, then whose turn
 * it is. Once the game is over: the last move and the result, for RESULT_SHOWN_MS, then nothing.
 */
export function hintLine(current: ChessGame, pending: ChessAlert | null, t: Strings, locale: Locale, now: number) {
  const parts: string[] = []
  const clock = current.clock
  const { position, sans } = replay(current.moves)
  const side = (mover: 'w' | 'b') => (mover === 'w' ? t.white : t.black)
  // Both clocks while a game is on, even before they run (a Lichess game starts them after both first moves).
  if (clock && status(position) === 'playing' && isLichessOn(current)) {
    const left = (side: 'w' | 'b') => formatClock(timeLeft(clock, side, clockTurn(current), now))
    parts.push(`♔ ${left('w')}  ♚ ${left('b')}`)
    // The last move stays, seen or not: the board's last move, out of sight.
    const last = sans.at(-1)
    if (last) parts.push(`${side(sans.length % 2 === 1 ? 'w' : 'b')} ${figurine(last)}`)
  } else if (current.lichess && current.lichess.status !== 'started') {
    // Over: the result for a while, then the line is the prompt's own again.
    const endedAt = current.lichess.endedAt
    if (endedAt === undefined || now - endedAt > RESULT_SHOWN_MS) return undefined
    const last = sans.at(-1)
    if (last) parts.push(`${side(sans.length % 2 === 1 ? 'w' : 'b')} ${figurine(last)}`)
    parts.push(lichessResult(current, t) ?? statusLine(position, t, yourSide(current)))
    return parts.join(' · ')
  } else if (pending) {
    parts.push(`${side(pending.mover)} ${figurine(pending.san)}`)
  }
  // Then whose turn it is, or how the game ended.
  const result = lichessResult(current, t)
  if (parts.length > 0 && result) parts.push(result)
  else if (parts.length > 0 && status(position) === 'playing') parts.push(statusLine(position, t, yourSide(current)))
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export const register: Register = (on, options) => {
  const option = typeof options.language === 'string' ? options.language : undefined
  const scope: Scope = options.gameScope === 'conversation' ? 'conversation' : 'global'
  const hasHint = options.hintWhenHidden !== false
  let cached: Locale | undefined
  const remember = (locale: Locale) => {
    strings = stringsFor(locale)
    return (cached = locale)
  }

  on('session.start', async ($, e, next) => {
    const t = stringsFor(remember(cached ?? (await readLocale($, option))))
    await $.command.register({ name: 'chess', description: t.commandDescription })
    // An earlier version pinned its alert on the status line: take it down.
    $.ui.status(undefined)
    // A search left by an earlier load of the module, which this one cannot stop: gone.
    if (!stopSearch) await update($, search, () => null)
    await startSaved($, scope)
    // Every second: take in what other sessions played, and while a clock runs, redraw the pane
    // and the line under the prompt.
    $.clock.every(1000, () => {
      inBackground(
        adoptSaved($, scope)
        .then(() => read($, game))
        .then(async current => {
          // Running clocks tick; a move waiting for Lichess says so after a while; a game just over
          // redraws until its result has left the line under the prompt.
          const endedAt = current.lichess?.endedAt
          const isEnding = endedAt !== undefined && (await $.clock.now()) - endedAt <= RESULT_SHOWN_MS + 1000
          if (current.clock?.runningSince != null || current.pending || current.lichess?.opponentGone || isEnding) $.ui.invalidate('ui.render')
          if (current.lichess?.status === 'started') inBackground(followLichessGame($, current.lichess.gameId, scope, t))
          for (const gameId of following) inBackground(holdLease($, gameId))
        }),
      )
    })
    return next(e)
  })

  // /chess shows the board, or hides it when it is the pane on screen; the game is kept.
  on('command.run', { command: 'chess' }, async ($, e) => {
    const locale = remember(cached ?? (await readLocale($, option)))
    const t = stringsFor(locale)
    const words = e.args.trim().toLowerCase().split(/\s+/)
    // On a Lichess game under way, moves and game actions are the person's alone.
    const isGameAction = ['draw', 'nulle', 'resign', 'abandon', 'takeback', 'reprise', 'claim', 'réclamer'].includes(words[0] ?? '')
    const isMove = words[0] !== '' && !isGameAction && !['connect', 'disconnect', 'new', 'lichess', 'stockfish', 'cancel', 'annuler', 'open', 'ouvrir'].includes(words[0] ?? '')
    if ((isGameAction || isMove) && !isThePerson(e.origin) && isLichessOn(await read($, game))) return { text: t.onlyYou }
    if (words[0] === 'connect' || words[0] === 'disconnect') {
      // The address the browser landed on, pasted where nothing could listen (case kept: it holds a code).
      const pasted = e.args.trim().split(/\s+/).find(word => /^https?:\/\//i.test(word))
      if (words[0] === 'connect' && pasted) return { text: await finishPastedSignIn($, pasted, t) }
      // Lichess is the one service for now.
      if ((words[1] ?? 'lichess') !== 'lichess') return { text: t.cancelled }
      if (words[0] === 'disconnect') {
        const current = await read($, game)
        const outcome = await signOutOfLichess($)
        if (outcome === 'none') return { text: t.lichessNotConnected }
        const said = outcome === 'revoked' ? t.lichessDisconnected : t.signedOutLocally
        // A game under way goes on on Lichess: say where.
        const onGame = current.lichess && isLichessOn(current) ? `\n${t.signedOutDuringGame(lichessGameUrl(current.lichess.gameId))}` : ''
        return { text: `${said}${onGame}` }
      }
      const token = await readToken($)
      const account = token ? await lichessRequest($, '/api/account', { token }) : undefined
      // Lichess unreachable: the token may be fine; no new sign-in on a guess.
      if (account && account.kind !== 'ok' && !(account.kind === 'refused' && account.status === 401)) return { text: t.lichessUnreachable }
      const user = account?.kind === 'ok' ? (JSON.parse(account.text) as { username?: string }).username : undefined
      if (user) {
        // A sign-in whose account lookup failed left no name on record: this puts it there.
        await $.store.set('lichessUser', user)
        return { text: t.lichessAlready(user) }
      }
      return { text: await signInToLichess($, t) }
    }
    if (words[0] === 'new' || words[0] === 'lichess' || words[0] === 'stockfish') {
      // A shortcut (/chess lichess rapid, /chess stockfish 3) starts that game at once; /chess new and
      // /chess lichess alone open the New game screen.
      const shortcut = formFromWords(words, await read($, form))
      if (shortcut) {
        const started = await startFromForm($, shortcut, scope, t)
        if (started.isOn) {
          await update($, screen, () => 'board' as const)
          // The board does not take the keys: a prompt typed next must not press its buttons.
          await $.ui.open({ id: PANE, title: t.paneTitle, columns: PANE_COLUMNS })
        }
        return { text: started.text }
      }
      if (words[0] === 'lichess') await update($, form, setup => fitForm({ ...setup, opponent: 'random' }))
      await update($, screen, () => 'new' as const)
      await $.ui.open({ id: PANE, title: t.paneTitle, focus: true, columns: PANE_COLUMNS })
      return { text: t.newTitle }
    }
    if (words[0] === 'cancel' || words[0] === 'annuler') {
      if (stopSearch) stopSearch()
      else if ((await read($, search)) !== null) await update($, search, () => null)
      else return { text: t.noSearch }
      return { text: t.searchCancelled }
    }
    if (words[0] === 'draw' || words[0] === 'nulle') {
      return { text: await answerDraw($, 'yes', t) }
    }
    if (words[0] === 'takeback' || words[0] === 'reprise') {
      return { text: await answerTakeback($, words[1] === 'no' || words[1] === 'non' ? 'no' : 'yes', t) }
    }
    if (words[0] === 'claim' || words[0] === 'réclamer') {
      return { text: await claimFromGone($, words[1] === 'draw' || words[1] === 'nulle' ? 'draw' : 'victory', t) }
    }
    if (words[0] === 'open' || words[0] === 'ouvrir') {
      return { text: (await openOnLichess($, t)) ?? t.noLichessGame }
    }
    if (words[0] === 'resign' || words[0] === 'abandon') {
      return { text: await resignLichessGame($, t) }
    }
    const typed = e.args.trim()
    if (typed !== '') {
      const before = await read($, game)
      if (isLichessOn(before)) {
        const { after, played, refused } = await playLichessMove($, now => parseMove(now, typed, locale), scope, t)
        if (refused) return { text: refused }
        if (played === undefined) return { text: t.unknownMove(typed) }
        const sans = replay(after.moves).sans
        return { text: t.played(localSan(sans.at(-1)!, locale), statusLine(replay(after.moves).position, t, yourSide(after))) }
      }
      // A finished Lichess game stays as it ended until a new game.
      const ended = before.lichess && (lichessResult(before, t) ?? statusLine(replay(before.moves).position, t, yourSide(before)))
      return { text: ended || t.noGame }
    }
    // Show the game as the other sessions left it, not as of this session's last second.
    await adoptSaved($, scope)
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane?.isShown) {
      await $.ui.close({ id: PANE })
      await update($, screen, () => 'board' as const)
      return { text: t.hidden }
    }
    // No game under way: the pane opens on the New game screen.
    const now = await read($, game)
    const isUnderWay = isLichessOn(now)
    if (!isUnderWay) await update($, screen, () => 'new' as const)
    // The board shows the opponent's move: the alert under the prompt has done its job.
    if ((await read($, alert)) !== null) {
      await update($, alert, () => null)
      await saveGame($, scope)
    }
    // The New game screen takes the keys for its shortcuts; a game under way does not, so that a
    // prompt typed next (“refactor…”) does not press its buttons (r resigns).
    await $.ui.open({ id: PANE, title: t.paneTitle, columns: PANE_COLUMNS, ...(isUnderWay ? {} : { focus: true as const }) })
    return { text: t.opened }
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const data = e.data as { type?: string; from?: number; to?: number }
    if (data.type !== 'move') return {}
    const pick = (position: Position) =>
      legalMoves(position)
        .filter(m => m.from === data.from && m.to === data.to)
        .find(m => m.promotion === undefined || m.promotion === 'q')
    if (isLichessOn(await read($, game))) {
      // The board already shows the move: Lichess is told in the background, the pane says when it took it.
      const t = stringsFor(remember(cached ?? (await readLocale($, option))))
      inBackground(playLichessMove($, pick, scope, t).then(({ refused }) => refused && $.ui.toast(refused)))
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const locale = remember(cached ?? (await readLocale($, option)))
    const t = stringsFor(locale)
    if (e.surface === 'mobile' || e.surface === 'vscode') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{t.unavailable}</Text>
    }
    const { Box, Text, Button, Client, Input } = $.ui.resolve(e)
    const searching = await read($, search)
    const searchBlock = searching && (
      <Box key="search" flexDirection="column" marginTop={1}>
        <Text color="yellow" wrap="wrap">
          {searching.kind === 'seek' ? t.searching(searching.timeControl) : t.challenging(searching.friend ?? '?', searching.timeControl)}
        </Text>
        <Button
          key="cancel-search"
          plain
          hotkey="x"
          label={t.cancelSearch}
          onPress={() => (stopSearch ? stopSearch() : update($, search, () => null))}
        />
      </Box>
    )
    const current = await read($, game)
    // No Lichess game to show (none yet, or one from a version that had local games): the New game screen.
    if ((await read($, screen)) === 'new' || !current.lichess) {
      const setup = fitForm(await read($, form))
      const isOn = isLichessOn(current)
      const wants = asks(setup.opponent)
      const isConnected = Boolean(await $.store.get('lichessUser').catch(() => undefined))
      const change = (next: SetupForm) => update($, form, () => fitForm(next))
      const start = async (setupNow: SetupForm) => {
        const started = await startFromForm($, setupNow, scope, t)
        $.ui.toast(started.text)
        if (started.isOn) await update($, screen, () => 'board' as const)
      }
      return (
        <Box flexDirection="column" width={BOARD_COLUMNS}>
          <Text bold>{t.newTitle}</Text>
          {searchBlock}
          {OPPONENTS.map((opponent, i) => (
            <Button
              key={`opponent-${opponent}`}
              plain
              hotkey={String(i + 1)}
              dimColor={setup.opponent !== opponent}
              label={`${setup.opponent === opponent ? '●' : '○'} ${t.opponentNames[opponent]}`}
              onPress={() => change({ ...setup, opponent })}
            />
          ))}
          <Text dimColor>{isConnected ? t.onLichess : t.notConnectedHint}</Text>
          <Box flexDirection="column" marginTop={1}>
            {wants.level && (
              <Button key="level" plain hotkey="l" label={t.levelLabel(setup.level)} onPress={() => change({ ...setup, level: (setup.level % 8) + 1 })} />
            )}
            <Button
              key="time"
              plain
              hotkey="t"
              label={t.timeLabel(setup.timeControl, t.speeds[speedOf(setup.timeControl)])}
              onPress={() => change({ ...setup, timeControl: cycle(TIME_CONTROLS[setup.opponent], setup.timeControl) })}
            />
            {wants.color && (
              <Button key="color" plain hotkey="c" label={t.colorLabel(t.colorNames[setup.color])} onPress={() => change({ ...setup, color: cycle(COLORS, setup.color) })} />
            )}
            {wants.rated && (
              <Button key="rated" plain hotkey="r" label={t.ratedLabel(setup.rated)} onPress={() => change({ ...setup, rated: !setup.rated })} />
            )}
            {wants.friend && Input && (
              <Input
                key="friend"
                label={t.friendLabel}
                placeholder={t.friendPlaceholder}
                value={setup.friend}
                onInput={value => void change({ ...setup, friend: value.trim() })}
                onSubmit={value => void start({ ...setup, friend: value.trim() })}
              />
            )}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {/* A game on: said now, not once everything is set and Start refused. */}
            {isOn ? (
              <Text key="game-on" color="yellow" wrap="wrap">{t.lichessGameOn}</Text>
            ) : (
              <Button key="start" variant="primary" hotkey="g" label={t.start} onPress={() => start(setup)} />
            )}
            {current.lichess && (
              <Button key="back" plain hotkey="b" dimColor label={t.back} onPress={() => update($, screen, () => 'board' as const)} />
            )}
          </Box>
        </Box>
      )
    }
    const { position, sans, last } = replay(current.moves)
    const now = await $.clock.now()
    const clock = current.clock ?? newClock(current.timeControl ?? '10+0')
    const lichess = current.lichess
    const isOn = status(position) === 'playing' && isLichessOn(current)
    const canMove = isOn && position.turn === lichess.color
    const board: BoardProps = {
      pieces: position.board.map(p => p ?? '.').join(''),
      flipped: current.flipped,
      last: last ? [last.from, last.to] : null,
      check: inCheck(position) ? kingSquare(position, position.turn) : null,
      legal: canMove ? legalMap(position) : {},
    }

    const ticking = clockTurn(current)
    // One row per player: the name cut short if it must, the clock never.
    const player = (color: 'w' | 'b') => (
      <Box key={`player-${color}`} flexDirection="row" justifyContent="space-between" width={BOARD_COLUMNS}>
        <Box flexShrink={1}>
          <Text bold={position.turn === color} wrap="truncate-end">
            {position.turn === color ? '● ' : '○ '}
            {color === lichess.color ? t.you : lichess.opponent}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text bold={isOn && clock.runningSince !== null && ticking === color} dimColor={!isOn || ticking !== color}>
            {formatClock(timeLeft(clock, color, ticking, now))}
          </Text>
        </Box>
      </Box>
    )
    const failed = await read($, delivery)
    const claimSeconds = claimIn(current, now)
    const pendingSan = current.pending ? figurine(sans[current.pending.index] ?? '') : ''
    const isSlow = current.pending !== undefined && now - current.pending.since >= UNCONFIRMED_MS
    const lines = moveLines(sans.map(san => localSan(san, locale)))
    // Non-breaking spaces inside a move, plain ones between moves: lines break between moves only.
    const shown = lines
      .slice(-SHOWN_MOVES)
      .map(line => line.replace(/ /g, '\u00a0'))
      .join('  ')

    return (
      <Box flexDirection="column" width={BOARD_COLUMNS}>
        {player(current.flipped ? 'w' : 'b')}
        <Client key="board" module="./board.tsx" props={board} width={BOARD_COLUMNS} height={BOARD_ROWS} />
        {player(current.flipped ? 'b' : 'w')}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{lichessResult(current, t) ?? statusLine(position, t, yourSide(current))}</Text>
          {isSlow && <Text dimColor>{t.unconfirmed(pendingSan)}</Text>}
          {failed && <Text color="red">{t.notPlayed(failed.san, failed.reason)}</Text>}
          {lichess.unreachable && lichess.status === 'started' && <Text color="yellow" wrap="wrap">{t.cannotFollow}</Text>}
          {isOn && lichess.opponentGone && (
            <Text color="yellow" wrap="wrap">
              {lichess.opponentGone.claimAt === null
                ? t.opponentLeftNoDelay(lichess.opponent)
                : claimSeconds! > 0
                  ? t.opponentLeft(lichess.opponent, claimSeconds!)
                  : t.opponentLeftNow(lichess.opponent)}
            </Text>
          )}
          {isOn && lichess.drawOffer && lichess.drawOffer !== lichess.color && (
            <Text color="yellow">{t.drawOfferFrom(lichess.opponent)}</Text>
          )}
          {isOn && lichess.drawOffer === lichess.color && <Text dimColor>{t.drawOffered}</Text>}
          {isOn && lichess.takebackOffer && lichess.takebackOffer !== lichess.color && (
            <Text color="yellow" wrap="wrap">{t.takebackFrom(lichess.opponent)}</Text>
          )}
          {lines.length === 0 ? (
            <Text dimColor>{t.noMoves}</Text>
          ) : (
            <Text wrap="wrap">{(lines.length > SHOWN_MOVES ? '… ' : '') + shown}</Text>
          )}
        </Box>
        {isOn ? (
          <Box flexDirection="column" marginTop={1}>
            {lichess.drawOffer && lichess.drawOffer !== lichess.color ? (
              <>
                <Button key="draw-yes" plain hotkey="a" label={t.acceptDraw} onPress={async () => $.ui.toast(await answerDraw($, 'yes', t))} />
                <Button key="draw-no" plain hotkey="x" label={t.declineDraw} onPress={async () => $.ui.toast(await answerDraw($, 'no', t))} />
              </>
            ) : (
              lichess.drawOffer !== lichess.color &&
              current.moves.length >= 2 && (
                <Button key="draw" plain hotkey="d" label={t.offerDraw} onPress={async () => $.ui.toast(await answerDraw($, 'yes', t))} />
              )
            )}
            {lichess.takebackOffer && lichess.takebackOffer !== lichess.color && (
              <>
                <Button key="takeback-yes" plain hotkey="y" label={t.acceptTakeback} onPress={async () => $.ui.toast(await answerTakeback($, 'yes', t))} />
                <Button key="takeback-no" plain hotkey="n" label={t.declineTakeback} onPress={async () => $.ui.toast(await answerTakeback($, 'no', t))} />
              </>
            )}
            {claimSeconds === 0 && (
              <>
                <Button key="claim-win" plain hotkey="v" label={t.claimWin} onPress={async () => $.ui.toast(await claimFromGone($, 'victory', t))} />
                <Button key="claim-draw" plain hotkey="h" label={t.claimDraw} onPress={async () => $.ui.toast(await claimFromGone($, 'draw', t))} />
              </>
            )}
            {resignAsk ? (
              <Button
                key="resign-confirm"
                plain
                hotkey="r"
                label={current.moves.length < 2 ? t.confirmAbort : t.confirmResign}
                onPress={async () => {
                  resignAsk?.cancel()
                  resignAsk = null
                  $.ui.invalidate('ui.render')
                  $.ui.toast(await resignLichessGame($, t))
                }}
              />
            ) : (
              // One press asks again, as Lichess does: a stray r never resigns.
              <Button
                key="resign"
                plain
                hotkey="r"
                label={current.moves.length < 2 ? t.abort : t.resign}
                onPress={() => {
                  resignAsk = $.clock.after(RESIGN_ASK_MS, () => {
                    resignAsk = null
                    $.ui.invalidate('ui.render')
                  })
                  $.ui.invalidate('ui.render')
                }}
              />
            )}
            <Button key="open" plain hotkey="o" label={t.openOnLichess} onPress={async () => {
              const said = await openOnLichess($, t)
              if (said && !said.startsWith(t.opening(''))) $.ui.toast(said)
            }} />
            <Button key="flip" plain hotkey="f" label={t.flip} onPress={async () => {
                await update($, game, g => ({ ...g, flipped: !g.flipped }))
                await saveGame($, scope)
              }} />
          </Box>
        ) : (
        <Box flexDirection="column" marginTop={1}>
          {searchBlock}
          <Button key="new" plain hotkey="n" label={t.newGame} onPress={() => update($, screen, () => 'new' as const)} />
          <Button key="open" plain hotkey="o" label={t.openOnLichess} onPress={async () => {
              const said = await openOnLichess($, t)
              if (said && !said.startsWith(t.opening(''))) $.ui.toast(said)
            }} />
          <Button key="flip" plain hotkey="f" label={t.flip} onPress={async () => {
              await update($, game, g => ({ ...g, flipped: !g.flipped }))
              await saveGame($, scope)
            }} />
        </Box>
        )}
      </Box>
    )
  })

  // With the board hidden: the opponent's move and both clocks, dim at the end of the hint line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!hasHint) return next(e)
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (isShown) return next(e)
    const locale = remember(cached ?? (await readLocale($, option)))
    const t = stringsFor(locale)
    const searching = await read($, search)
    const tail = searching
      ? `${searching.kind === 'seek' ? t.searching(searching.timeControl) : t.challenging(searching.friend ?? '?', searching.timeControl)} · /chess cancel`
      : hintLine(await read($, game), await read($, alert), t, locale, await $.clock.now())
    return tail === undefined ? next(e) : next({ ...e, props: { ...e.props, tail } })
  })
}
