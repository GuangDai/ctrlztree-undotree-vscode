import * as vscode from 'vscode'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off'

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0, info: 1, warn: 2, error: 3, off: 4,
}

export interface LogContext {
	traceId?: string
	docId?: string
}

export interface ILogger {
	setLevel(level: LogLevel): void
	debug(msg: string): void
	info(msg: string): void
	warn(msg: string): void
	error(msg: string): void
	withContext(ctx: LogContext): ILogger
}

interface LogEntry {
	ts: string
	level: LogLevel
	module: string
	msg: string
	traceId?: string
	docId?: string
}

function formatEntry(entry: LogEntry): string {
	return JSON.stringify(entry)
}

export class Logger implements ILogger {
	private level: LogLevel = 'info'
	private module: string
	private context: LogContext = {}

	constructor(
		private channel: vscode.OutputChannel,
		module: string = 'extension',
	) {
		this.module = module
	}

	setLevel(level: LogLevel): void {
		if (!(level in LEVEL_ORDER)) {
			this.emit('warn', `invalid log level "${level}", falling back to info`)
			this.level = 'info'
			return
		}
		this.level = level
		if (level !== 'off') {
			this.emit('info', `log level set to ${level}`)
		}
	}

	debug(msg: string): void {
		if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.debug) {
			this.emit('debug', msg)
		}
	}

	info(msg: string): void {
		if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.info) {
			this.emit('info', msg)
		}
	}

	warn(msg: string): void {
		if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.warn) {
			this.emit('warn', msg)
		}
	}

	error(msg: string): void {
		if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.error) {
			this.emit('error', msg)
		}
	}

	getChannel(): vscode.OutputChannel {
		return this.channel
	}

	withContext(ctx: LogContext): ILogger {
		const child = new Logger(this.channel, this.module)
		child.level = this.level
		child.context = { ...this.context, ...ctx }
		return child
	}

	private emit(level: LogLevel, msg: string): void {
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			level,
			module: this.module,
			msg,
			...this.context,
		}
		this.channel.appendLine(formatEntry(entry))
	}
}
