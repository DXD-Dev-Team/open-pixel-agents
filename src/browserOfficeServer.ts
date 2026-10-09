import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import * as path from 'node:path';

const BODY_LIMIT = 64 * 1024;
const STATIC_LIMIT = 32 * 1024 * 1024;
const EVENT_LIMIT = 32 * 1024 * 1024;
const BUFFER_LIMIT = 64 * 1024 * 1024;
const SESSION_LIMIT = 8;
const STREAM_LIMIT = 8;
const SOCKET_LIMIT = 32;
const REQUEST_LIMIT = 32;
const CAPABILITY_LIFETIME = 5 * 60_000;
const SESSION_LIFETIME = 30 * 60_000;
const BOOTSTRAP_TIMEOUT = 10_000;
const BODY_TIMEOUT = 10_000;
const HEARTBEAT_INTERVAL = 15_000;
const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
	'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
	'.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface BrowserOfficeServerOptions {
	assetsDirectory: string;
	connect(send: (message: unknown) => void): Promise<{ dispose(): void | Promise<void> }>;
	dispatch(message: unknown): Promise<void>;
}
interface BrowserSession { csrf: string; expiresAt: number; streams: Set<BrowserStream> }
interface BrowserStream {
	response: ServerResponse; session: BrowserSession; closed: boolean;
	heartbeat?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout>;
	subscription?: { dispose(): void | Promise<void> };
}
class RequestFailure extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}
const token = (): string => randomBytes(32).toString('base64url');
function equalSecret(actual: unknown, expected: string): boolean {
	if (typeof actual !== 'string' || actual.length !== expected.length) { return false; }
	const value = Buffer.from(actual);
	const secret = Buffer.from(expected);
	return value.length === secret.length && timingSafeEqual(value, secret);
}
function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Authenticated UI transport to the VS Code provider, never an OpenCode HTTP proxy. */
export class BrowserOfficeServer {
	private server?: Server;
	private starting?: Promise<void>;
	private closing?: Promise<void>;
	private disposed = false;
	private origin = '';
	private assetsRoot = '';
	private readonly cookieName = `office_session_${randomBytes(8).toString('hex')}`;
	private readonly capabilities = new Map<string, number>();
	private readonly sessions = new Map<string, BrowserSession>();
	private readonly streams = new Set<BrowserStream>();
	private readonly connecting = new Set<Promise<void>>();
	private readonly sockets = new Set<Socket>();
	private readonly cleanup = new Set<Promise<void>>();
	private requests = 0;

	constructor(private readonly options: BrowserOfficeServerOptions) {}

	async start(): Promise<{ url: string }> {
		if (this.disposed) { throw new Error('The browser office is closed. Open it from a running VS Code office.'); }
		this.starting ??= this.listen();
		await this.starting;
		if (this.disposed) { throw new Error('The browser office is closed.'); }
		this.expire();
		if (this.capabilities.size >= SESSION_LIMIT) { throw new Error('Too many browser office launch links are pending. Use a recent link or wait for it to expire.'); }
		const capability = token();
		this.capabilities.set(capability, Date.now() + CAPABILITY_LIFETIME);
		return { url: `${this.origin}/#office-token=${capability}` };
	}

	private async listen(): Promise<void> {
		this.assetsRoot = await realpath(this.options.assetsDirectory);
		if (!(await stat(this.assetsRoot)).isDirectory()) { throw new Error('The browser office assets are unavailable.'); }
		if (this.disposed) { throw new Error('The browser office is closed.'); }
		const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
			void this.handle(request, response).catch(() => {
				if (!response.headersSent) { this.json(response, 500, { error: 'The office request failed.' }); }
				else { response.destroy(); }
			});
		});
		this.server = server;
		server.maxHeadersCount = 32;
		server.headersTimeout = BODY_TIMEOUT;
		server.requestTimeout = 15_000;
		server.keepAliveTimeout = 5000;
		server.on('connection', socket => {
			if (this.disposed || this.sockets.size >= SOCKET_LIMIT) { socket.destroy(); return; }
			this.sockets.add(socket);
			socket.once('close', () => this.sockets.delete(socket));
		});
		server.on('clientError', (_error, socket) => { socket.destroy(); });
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', reject);
				server.on('error', () => { void this.dispose(); });
				const address = server.address();
				if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
					reject(new Error('The browser office could not bind to loopback.')); return;
				}
				this.origin = `http://127.0.0.1:${address.port}`;
				resolve();
			});
		});
	}

	private headers(response: ServerResponse): void {
		response.setHeader('Content-Security-Policy', CSP);
		response.setHeader('X-Content-Type-Options', 'nosniff');
		response.setHeader('X-Frame-Options', 'DENY');
		response.setHeader('Referrer-Policy', 'no-referrer');
		response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
		response.setHeader('Cache-Control', 'no-store');
	}
	private json(response: ServerResponse, status: number, value: unknown): void {
		if (response.destroyed || response.writableEnded) { return; }
		this.headers(response);
		response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
		response.end(JSON.stringify(value));
	}
	private requireOrigin(request: IncomingMessage): void {
		if (request.headers.origin !== this.origin) { throw new RequestFailure(403, 'This request must come from the browser office.'); }
	}
	private session(request: IncomingMessage): BrowserSession {
		const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim())
			.filter(value => value.startsWith(`${this.cookieName}=`));
		const value = cookies.length === 1 ? this.sessions.get(cookies[0].slice(this.cookieName.length + 1)) : undefined;
		if (!value || value.expiresAt <= Date.now()) { throw new RequestFailure(401, 'Open a new browser office link from VS Code.'); }
		return value;
	}
	private authorize(request: IncomingMessage): BrowserSession {
		const session = this.session(request);
		if (!equalSecret(request.headers['x-office-csrf'], session.csrf)) { throw new RequestFailure(403, 'The browser office request could not be verified.'); }
		if (request.headers.origin !== undefined) { this.requireOrigin(request); }
		return session;
	}
	private async body(request: IncomingMessage): Promise<unknown> {
		if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
			(request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')) {
			throw new RequestFailure(415, 'Use a JSON office request.');
		}
		const length = Number(request.headers['content-length']);
		if (Number.isFinite(length) && length > BODY_LIMIT) { throw new RequestFailure(413, 'The office request is too large.'); }
		return new Promise<unknown>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			const clear = (): void => {
				clearTimeout(timeout);
				request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', aborted);
			};
			const failed = (): void => { clear(); reject(new RequestFailure(400, 'The office request was interrupted.')); };
			const aborted = (): void => failed();
			const data = (value: Buffer): void => {
				size += value.byteLength;
				if (size > BODY_LIMIT) { request.pause(); clear(); reject(new RequestFailure(413, 'The office request is too large.')); return; }
				chunks.push(value);
			};
			const end = (): void => {
				clear();
				try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
				catch { reject(new RequestFailure(400, 'The office request is not valid JSON.')); }
			};
			const timeout = setTimeout(() => { request.destroy(); failed(); }, BODY_TIMEOUT);
			request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', aborted);
		});
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		this.headers(response);
		if (this.disposed) { this.json(response, 503, { error: 'The browser office is closed.' }); return; }
		if (request.headers.host !== new URL(this.origin).host || request.socket.remoteAddress !== '127.0.0.1' ||
			request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) {
			this.json(response, 403, { error: 'The browser office accepts only its loopback address.' }); return;
		}
		if (this.requests >= REQUEST_LIMIT) { this.json(response, 429, { error: 'Too many office requests are pending.' }); return; }
		this.requests++;
		try {
			this.expire();
			const raw = request.url ?? '';
			if (!raw.startsWith('/') || raw.startsWith('//')) { throw new RequestFailure(400, 'Invalid office path.'); }
			const url = new URL(raw, this.origin);
			if (url.origin !== this.origin || url.hash) { throw new RequestFailure(400, 'Invalid office path.'); }
			if (url.pathname.startsWith('/api/')) {
				if (url.search) { throw new RequestFailure(400, 'Office API parameters belong in the request body.'); }
				if (url.pathname === '/api/connect' && request.method === 'POST') {
					this.requireOrigin(request);
					const body = await this.body(request);
					if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'token')) {
						throw new RequestFailure(400, 'Invalid browser office connection.');
					}
					if (!Object.hasOwn(body, 'token')) { this.json(response, 200, { csrf: this.session(request).csrf }); return; }
					const capability = (body as { token?: unknown }).token;
					if (typeof capability !== 'string' || (this.capabilities.get(capability) ?? 0) <= Date.now()) {
						throw new RequestFailure(401, 'This launch link is invalid or expired. Open a new link from VS Code.');
					}
					let existing: BrowserSession | undefined;
					try { existing = this.session(request); } catch { /* A valid launch creates a fresh session when the old cookie expired. */ }
					if (existing) {
						this.capabilities.delete(capability);
						this.json(response, 200, { csrf: existing.csrf }); return;
					}
					if (this.sessions.size >= SESSION_LIMIT) { throw new RequestFailure(429, 'Too many browser office sessions are open.'); }
					this.capabilities.delete(capability);
					const id = token();
					const session: BrowserSession = { csrf: token(), expiresAt: Date.now() + SESSION_LIFETIME, streams: new Set() };
					this.sessions.set(id, session);
					response.setHeader('Set-Cookie', `${this.cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_LIFETIME / 1000}`);
					this.json(response, 200, { csrf: session.csrf }); return;
				}
				if (url.pathname === '/api/events' && request.method === 'GET') {
					await this.events(response, this.authorize(request)); return;
				}
				if (url.pathname === '/api/message' && request.method === 'POST') {
					this.requireOrigin(request); this.authorize(request);
					const message = await this.body(request);
					// Message authority and allowlisting live in the VS Code provider.
					await this.options.dispatch(message);
					this.json(response, 200, { ok: true }); return;
				}
				throw new RequestFailure(404, 'Unknown office endpoint.');
			}
			if (request.method !== 'GET' && request.method !== 'HEAD') { throw new RequestFailure(405, 'This asset supports GET only.'); }
			await this.asset(raw.split('?')[0], request.method === 'HEAD', response);
		} catch (error) {
			if (response.headersSent) { response.destroy(); return; }
			if (error instanceof RequestFailure) {
				if (error.status === 413) { response.setHeader('Connection', 'close'); }
				this.json(response, error.status, { error: error.message }); return;
			}
			this.json(response, 500, { error: 'The office request failed.' });
		} finally { this.requests--; }
	}

	private async asset(rawPath: string, head: boolean, response: ServerResponse): Promise<void> {
		let pathname: string;
		try { pathname = decodeURIComponent(rawPath); }
		catch { throw new RequestFailure(400, 'Invalid asset path.'); }
		if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) {
			throw new RequestFailure(400, 'Invalid asset path.');
		}
		const requested = path.resolve(this.assetsRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
		if (!inside(this.assetsRoot, requested)) { throw new RequestFailure(404, 'Office asset not found.'); }
		const type = CONTENT_TYPES[path.extname(requested).toLowerCase()];
		if (!type) { throw new RequestFailure(404, 'Office asset not found.'); }
		const canonical = await realpath(requested).catch(() => { throw new RequestFailure(404, 'Office asset not found.'); });
		if (!inside(this.assetsRoot, canonical)) { throw new RequestFailure(404, 'Office asset not found.'); }
		const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new RequestFailure(404, 'Office asset not found.'); });
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > STATIC_LIMIT || !inside(this.assetsRoot, await realpath(canonical))) {
				throw new RequestFailure(404, 'Office asset not found.');
			}
			response.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
			if (head) { response.end(); return; }
			await new Promise<void>((resolve, reject) => {
				const stream = file.createReadStream({ autoClose: false });
				const closed = (): void => { stream.destroy(); resolve(); };
				response.once('close', closed);
				stream.once('error', reject);
				stream.once('end', () => { response.off('close', closed); resolve(); });
				stream.pipe(response);
			});
		} finally { await file.close(); }
	}

	private release(subscription: { dispose(): void | Promise<void> }): void {
		const operation = Promise.resolve().then(() => subscription.dispose()).then(() => undefined, () => undefined);
		this.cleanup.add(operation);
		void operation.finally(() => this.cleanup.delete(operation));
	}
	private closeStream(stream: BrowserStream, destroy = false): void {
		if (stream.closed) { return; }
		stream.closed = true;
		clearInterval(stream.heartbeat); clearTimeout(stream.timeout);
		this.streams.delete(stream); stream.session.streams.delete(stream);
		if (stream.subscription) { this.release(stream.subscription); }
		if (!stream.response.destroyed) { if (destroy) { stream.response.destroy(); } else { stream.response.end(); } }
	}
	private send(stream: BrowserStream, message: unknown): void {
		if (stream.closed || stream.response.destroyed || this.disposed) { return; }
		let serialized: string | undefined;
		try { serialized = JSON.stringify(message); } catch { this.closeStream(stream); return; }
		if (serialized === undefined) { return; }
		const frame = `data: ${serialized}\n\n`;
		const size = Buffer.byteLength(frame);
		if (size > EVENT_LIMIT || stream.response.writableLength + size > BUFFER_LIMIT) { this.closeStream(stream, true); return; }
		stream.response.write(frame);
	}
	private async events(response: ServerResponse, session: BrowserSession): Promise<void> {
		if (this.streams.size >= STREAM_LIMIT || this.connecting.size >= STREAM_LIMIT || session.streams.size >= 2) { throw new RequestFailure(429, 'Too many browser office event streams are open.'); }
		response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
		response.flushHeaders();
		const stream: BrowserStream = { response, session, closed: false };
		this.streams.add(stream); session.streams.add(stream);
		response.once('close', () => this.closeStream(stream));
		stream.heartbeat = setInterval(() => {
			if (session.expiresAt <= Date.now()) { this.send(stream, { type: 'officeBrowserSessionExpired' }); this.closeStream(stream); return; }
			if (response.writableLength > BUFFER_LIMIT) { this.closeStream(stream, true); return; }
			response.write(': keep-alive\n\n');
		}, HEARTBEAT_INTERVAL);
		stream.heartbeat.unref();
		stream.timeout = setTimeout(() => this.closeStream(stream), BOOTSTRAP_TIMEOUT);
		stream.timeout.unref();
		const connection = Promise.resolve().then(() => this.options.connect(message => this.send(stream, message))).then(subscription => {
			clearTimeout(stream.timeout);
			if (stream.closed || this.disposed) { this.release(subscription); }
			else { stream.subscription = subscription; }
		}).catch(() => this.closeStream(stream)).finally(() => this.connecting.delete(connection));
		this.connecting.add(connection);
		await connection;
	}
	private expire(): void {
		const now = Date.now();
		for (const [id, expiresAt] of this.capabilities) { if (expiresAt <= now) { this.capabilities.delete(id); } }
		for (const [id, session] of this.sessions) {
			if (session.expiresAt > now) { continue; }
			this.sessions.delete(id);
			for (const stream of session.streams) { this.send(stream, { type: 'officeBrowserSessionExpired' }); this.closeStream(stream); }
		}
	}

	dispose(): Promise<void> {
		if (this.closing) { return this.closing; }
		for (const stream of this.streams) { this.send(stream, { type: 'officeBrowserClosed' }); }
		this.disposed = true;
		this.capabilities.clear(); this.sessions.clear();
		for (const stream of this.streams) { this.closeStream(stream); }
		this.closing = (async () => {
			await this.starting?.catch(() => undefined);
			if (this.server?.listening) {
				const closed = new Promise<void>(resolve => { this.server!.close(() => resolve()); });
				for (const socket of this.sockets) { socket.destroy(); }
				await closed;
			}
			for (const socket of this.sockets) { socket.destroy(); }
			await Promise.allSettled(this.cleanup);
		})();
		return this.closing;
	}
}
