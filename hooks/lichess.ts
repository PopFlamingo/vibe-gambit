import type { ChessClock, LichessGame, PendingMove } from '../types'

// Lichess sign-in by OAuth with PKCE: no app to register, the browser asks the person, and the
// answer comes back to a one-shot listener on this machine.

export const LICHESS = 'https://lichess.org'
/**
 * Lichess takes any unique client id. Its consent page shows the redirect's origin, not this id: it
 * names the mod only in Lichess's records.
 */
export const OAUTH_CLIENT_ID = 'vibe-gambit'
/** Fixed, since the redirect URI must be the same in the authorization and the token requests. */
export const OAUTH_PORT = 53123
export const OAUTH_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`
/** Playing games through the Board API is all the mod asks for. */
export const OAUTH_SCOPE = 'board:play'

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function base64url(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    const chars = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63].map(k => BASE64URL[k]!)
    text += chars.slice(0, Math.min(4, bytes.length - i + 1)).join('')
  }
  return text
}

const randomText = (size: number) => base64url(crypto.getRandomValues(new Uint8Array(size)))

/** The S256 challenge of a PKCE verifier: its SHA-256, in base64url. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** A PKCE verifier, its challenge, and a state that ties the answer to this request. */
export async function newSignIn(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = randomText(32)
  return { verifier, challenge: await challengeFor(verifier), state: randomText(16) }
}

export function authorizeUrl(challenge: string, state: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: OAUTH_SCOPE,
    state,
  })
  return `${LICHESS}/oauth?${query}`
}

/** The body of the token request that trades the code for a token. */
export function tokenRequestBody(code: string, verifier: string): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: OAUTH_REDIRECT,
    client_id: OAUTH_CLIENT_ID,
  }).toString()
}

/**
 * What the browser's request to the listener says: the code, or why there is none (the person
 * said no, a state that is not ours, or no request at all).
 */
export function readCallback(request: string, state: string): { code: string } | { error: string } {
  const target = /^GET (\S+) HTTP/.exec(request)?.[1]
  if (!target) return { error: 'no-request' }
  let url: URL
  try {
    url = new URL(target, OAUTH_REDIRECT)
  } catch {
    return { error: 'no-request' }
  }
  // Only the redirect address itself: this origin and path, as Lichess was told (RFC 8252 §8.10).
  const redirect = new URL(OAUTH_REDIRECT)
  if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) return { error: 'wrong-address' }
  const query = url.searchParams
  const states = query.getAll('state')
  if (states.length !== 1 || states[0] !== state) return { error: 'state-mismatch' }
  // One answer: a code, or an error, never both (RFC 6749 §4.1.2).
  const codes = query.getAll('code')
  const errors = query.getAll('error')
  if (errors.length > 0) return { error: codes.length > 0 || errors.length > 1 ? 'ambiguous' : errors[0]! }
  return codes.length === 1 && codes[0] ? { code: codes[0] } : { error: 'no-code' }
}

/** What the page the browser comes back to says, in the person's language (HTML allowed). */
export type CallbackPage = {
  lang: string
  title: string
  connected: string
  connectedText: string
  /** Commands to start playing at once, each with what it does. */
  quickStart: readonly (readonly [string, string])[]
  cancelled: string
  cancelledText: string
  close: string
}

/**
 * The page the browser shows once it has come back: the listener's only answer, sent before the
 * request arrives, so the page itself reads its address (`?code=` or `?error=`) to say which.
 */
export function callbackResponse(page: CallbackPage): string {
  const body = `<!doctype html>
<html lang="${page.lang}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<style>
  :root { --bg: #f4efe8; --card: #fffdf9; --text: #2b2118; --muted: #7a6a5a; --light: #c49a6c; --dark: #8b5a33; --ok: #4f7a34; --no: #a0473c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1d1914; --card: #28221b; --text: #f2e9de; --muted: #b3a593; --ok: #8fbf6a; --no: #e08a7e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: var(--bg); color: var(--text); font: 17px/1.5 system-ui, -apple-system, sans-serif; }
  main { width: min(30rem, 100%); background: var(--card); border-radius: 18px; padding: 40px 32px 32px;
         text-align: center; box-shadow: 0 10px 40px rgb(0 0 0 / 0.12); }
  .board { display: inline-grid; grid-template-columns: repeat(4, 22px); border-radius: 6px; overflow: hidden; margin-bottom: 20px; }
  .board span { width: 22px; height: 22px; background: var(--light); }
  .board span:nth-child(8n + 2), .board span:nth-child(8n + 4), .board span:nth-child(8n + 5), .board span:nth-child(8n + 7) { background: var(--dark); }
  .badge { display: inline-flex; width: 44px; height: 44px; border-radius: 50%; align-items: center; justify-content: center;
           font-size: 24px; color: #fff; background: var(--ok); margin: -40px 0 12px; position: relative; top: -6px; }
  .cancelled .badge { background: var(--no); }
  h1 { font-size: 1.6rem; margin: 0 0 10px; }
  p { margin: 0 0 12px; }
  code { font: 600 0.95em ui-monospace, Menlo, monospace; background: var(--bg); padding: 2px 8px; border-radius: 6px; }
  .muted { color: var(--muted); font-size: 0.9rem; margin-top: 20px; }
  ul { list-style: none; padding: 0; margin: 16px 0 0; text-align: left; }
  li { display: grid; gap: 2px; padding: 10px 14px; border-radius: 10px; background: var(--bg); margin-top: 8px; }
  li span { color: var(--muted); font-size: 0.9rem; }
  .cancelled .ok, main:not(.cancelled) .no { display: none; }
</style>
<main>
  <div class="board">${'<span></span>'.repeat(16)}</div><br>
  <div class="badge"><span class="ok">✓</span><span class="no">✕</span></div>
  <h1><span class="ok">${page.connected}</span><span class="no">${page.cancelled}</span></h1>
  <p><span class="ok">${page.connectedText}</span><span class="no">${page.cancelledText}</span></p>
  <ul class="ok">${page.quickStart.map(([command, what]) => `<li><code>${command}</code><span>${what}</span></li>`).join('')}</ul>
  <p class="muted">${page.close}</p>
</main>
<script>
  if (!new URLSearchParams(location.search).has('code')) document.querySelector('main').classList.add('cancelled')
</script>
</html>`
  const length = new TextEncoder().encode(body).length
  return `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n${body}`
}


/** "5+3" as Lichess counts it: the base time in seconds, the increment in seconds. 5+3 when unreadable. */
export function lichessClock(timeControl: string): { limit: number; increment: number } {
  const match = /^\s*(\d+(?:\.\d+)?)\s*\+\s*(\d+)\s*$/.exec(timeControl)
  return match ? { limit: Math.round(Number(match[1]) * 60), increment: Number(match[2]) } : { limit: 300, increment: 3 }
}

/** The body of a challenge to Lichess's AI (Stockfish, levels 1 to 8), in the colour the person picked. */
export function aiChallengeBody(level: number, timeControl: string, color: 'white' | 'black' | 'random' = 'random'): string {
  const { limit, increment } = lichessClock(timeControl)
  return new URLSearchParams({
    level: String(Math.min(8, Math.max(1, Math.round(level)))),
    'clock.limit': String(limit),
    'clock.increment': String(increment),
    color,
  }).toString()
}

type LichessPlayer = { id?: string; name?: string; aiLevel?: number; rating?: number }
type LichessState = {
  moves?: string
  wtime?: number
  btime?: number
  winc?: number
  binc?: number
  status?: string
  winner?: 'white' | 'black'
  wdraw?: boolean
  bdraw?: boolean
  wtakeback?: boolean
  btakeback?: boolean
}
/** One line of the Board API's game stream: the whole game first, then each change. */
export type LichessEvent =
  | { type: 'gameFull'; id: string; white: LichessPlayer; black: LichessPlayer; clock?: { initial: number; increment: number }; state: LichessState }
  | ({ type: 'gameState' } & LichessState)
  | { type: 'opponentGone'; gone: boolean; claimWinInSeconds?: number }
  | { type: string }

/** How Lichess names a player: the AI by its level, a person by name. */
const playerName = (player: LichessPlayer, aiName: (level: number) => string) =>
  player.aiLevel !== undefined
    ? aiName(player.aiLevel)
    : `${player.name ?? player.id ?? '?'}${player.rating !== undefined ? ` ${player.rating}` : ''}`

/**
 * The game once a stream line is taken in: Lichess's moves and clocks replace this side's, the
 * clock of the side to move running from `now` once both sides have moved. Other lines change nothing.
 */
export function applyLichessEvent<G extends { moves: string[]; flipped: boolean; clock?: ChessClock; lichess?: LichessGame; pending?: PendingMove }>(
  current: G,
  event: LichessEvent,
  now: number,
  you: string | undefined,
  aiName: (level: number) => string,
): G {
  let lichess = current.lichess
  let state: LichessState
  let clock = current.clock
  if (event.type === 'gameFull' && 'white' in event) {
    // The person's colour: facing the AI, the other one; facing a person, the side whose id is theirs.
    // Without their name on record, the colour Lichess gave when the game was found stands.
    const youId = you?.toLowerCase()
    const color: 'w' | 'b' =
      event.black.aiLevel !== undefined
        ? 'w'
        : event.white.aiLevel !== undefined
          ? 'b'
          : youId !== undefined && event.white.id === youId
            ? 'w'
            : youId !== undefined && event.black.id === youId
              ? 'b'
              : (current.lichess?.color ?? 'w')
    const isWhite = color === 'w'
    lichess = {
      gameId: event.id,
      color,
      opponent: playerName(isWhite ? event.black : event.white, aiName),
      status: event.state.status ?? 'started',
    }
    if (event.clock) clock = { initialMs: event.clock.initial, incrementMs: event.clock.increment, whiteMs: 0, blackMs: 0, runningSince: null }
    state = event.state
    // A new game, or a colour the placeholder had wrong, turns the board; a reconnection keeps the
    // side the person put at the bottom.
    const isNew = current.lichess?.gameId !== event.id || current.lichess.color !== color
    if (isNew) current = { ...current, flipped: color === 'b' }
  } else if (event.type === 'gameState') {
    state = event as LichessState
  } else if (event.type === 'opponentGone' && 'gone' in event && current.lichess) {
    // The opponent left (or came back): from claimAt the person may claim the win or a draw.
    const seconds = event.claimWinInSeconds
    const opponentGone = event.gone ? { claimAt: seconds === undefined ? null : now + seconds * 1000 } : undefined
    return { ...current, lichess: { ...current.lichess, opponentGone } }
  } else {
    return current
  }
  if (!lichess) return current
  let moves = state.moves ? state.moves.split(' ').filter(Boolean) : []
  const status = state.status ?? lichess.status
  // Clocks run once both sides have moved, as Lichess counts: a move still in flight is not counted.
  const isRunning = status === 'started' && moves.length >= 2
  // Lichess's moves stand. A move of the person's still in flight stays shown after them while
  // Lichess has not reached it; once Lichess has it, or has gone another way, it is no longer pending.
  let pending = current.pending
  if (pending) {
    const isInFlight = status === 'started' && moves.length === pending.index
    if (isInFlight) moves = [...moves, pending.uci]
    else pending = undefined
  }
  if (clock && state.wtime !== undefined && state.btime !== undefined) {
    clock = { ...clock, whiteMs: state.wtime, blackMs: state.btime, runningSince: isRunning ? now : null }
  }
  // Each state says who offers a draw now; none named, none on offer.
  const drawOffer = state.wdraw ? 'w' : state.bdraw ? 'b' : undefined
  const takebackOffer = state.wtakeback ? 'w' : state.btakeback ? 'b' : undefined
  // An opponent who moves again, or a game over, is no longer gone.
  const isStill = status === 'started' && moves.length <= current.moves.length
  const opponentGone = isStill ? lichess.opponentGone : undefined
  return { ...current, moves, clock, pending, lichess: { ...lichess, status, winner: state.winner ?? lichess.winner, drawOffer, takebackOffer, opponentGone } }
}


/**
 * What a Lichess API answer means. `refused` is Lichess deciding no (a 4xx other than 429), with its
 * reason; `limited` is a 429 (wait a minute, the docs say); `failed` says nothing about the request
 * (a 5xx, no answer, no network) and must never be read as a no.
 */
export type LichessReply =
  | { kind: 'ok'; text: string }
  | { kind: 'refused'; status: number; error: string }
  | { kind: 'limited' }
  | { kind: 'failed'; reason: string }

export function readReply(status: number, text: string): LichessReply {
  if (status >= 200 && status < 300) return { kind: 'ok', text }
  if (status === 429) return { kind: 'limited' }
  if (status >= 400 && status < 500) {
    let error = `${status}`
    try {
      error = (JSON.parse(text) as { error?: string }).error ?? error
    } catch {
      if (text.trim()) error = `${status} ${text.trim().slice(0, 120)}`
    }
    return { kind: 'refused', status, error }
  }
  return { kind: 'failed', reason: `${status}` }
}
