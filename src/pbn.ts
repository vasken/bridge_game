import { applyCall } from './auction.js'
import { nextSeat, partnership, vulnerabilityForBoard } from './board.js'
import { BoardHistory } from './engine.js'
import { applyPlay } from './play.js'
import {
	seats,
	type AuctionCall,
	type BoardState,
	type Call,
	type Card,
	type Hands,
	type Rank,
	type Seat,
	type Strain,
	type Suit,
	type Vulnerability
} from './types.js'

type ParsedPbn = Readonly<{
	tags: ReadonlyMap<string, string>
	sections: ReadonlyMap<string, readonly string[]>
}>

export type PbnBoardSummary = Readonly<{
	index: number
	boardNumber: number
	dealer: Seat
	vulnerability: Vulnerability
	event?: string
}>

export type PbnImportOptions = Readonly<{
	replayRecord?: boolean
}>

const pbnSuitOrder: readonly Suit[] = ['S', 'H', 'D', 'C']
const pbnRanks = 'AKQJT98765432'

export function listPbnBoards(pbn: string): PbnBoardSummary[] {
	return splitPbnRecords(pbn).map((record, index) => {
		const parsed = parsePbn(record)
		const boardNumber = parsePositiveInteger(parsed.tags.get('board') ?? String(index + 1), 'Board')
		const summary: PbnBoardSummary = {
			index,
			boardNumber,
			dealer: parseSeat(parsed.tags.get('dealer') ?? seats[(boardNumber - 1) % 4]!, 'Dealer'),
			vulnerability: parseVulnerability(parsed.tags.get('vulnerable') ?? formatVulnerability(vulnerabilityForBoard(boardNumber)))
		}
		const event = parsed.tags.get('event')
		return event ? { ...summary, event } : summary
	})
}

export function importPbnHistory(pbn: string, boardIndex = 0, options: PbnImportOptions = {}): BoardHistory {
	const record = pbnRecordAt(pbn, boardIndex)
	const parsed = parsePbn(record)
	const initial = createInitialBoardFromPbn(parsed)
	let history = new BoardHistory(initial)
	if (options.replayRecord === false) return history
	const alerts = parseBridgeCoreAlerts(parsed)
	for (const [index, call] of parseAuction(parsed, initial.dealer).entries()) {
		history = history.apply({ type: 'call', call })
		const alert = alerts.get(index)
		if (alert) history = applyAlert(history, index, alert)
	}
	for (const card of parsePlay(parsed)) history = history.apply({ type: 'play', card })
	return history
}

export function createBoardFromPbn(pbn: string, boardIndex = 0, options: PbnImportOptions = {}): BoardState {
	return importPbnHistory(pbn, boardIndex, options).current
}

export function exportBoardPbn(state: BoardState, originalHands: Hands = state.hands): string {
	const lines = [
		'[Event "Bridge Core"]',
		'[Site "Local"]',
		`[Board "${state.boardNumber}"]`,
		`[Dealer "${state.dealer}"]`,
		`[Vulnerable "${formatVulnerability(state.vulnerability)}"]`,
		`[Deal "N:${seats.map(seat => formatHand(originalHands[seat])).join(' ')}"]`
	]
	if (state.auction.length) {
		lines.push(`[Auction "${state.dealer}"]`)
		lines.push(formatAuction(state.auction))
		for (const [index, entry] of state.auction.entries()) {
			if (entry.alert?.explanation) lines.push(`[BridgeCoreAlert${index + 1} "${entry.seat}:${formatCall(entry.call)}:${escapeTag(entry.alert.explanation)}"]`)
			for (const [questionIndex, question] of entry.alert?.questions?.entries() ?? []) {
				lines.push(`[BridgeCoreAlertQ${index + 1}_${questionIndex + 1} "${question.askedBy}:${escapeTag(question.question)}:${escapeTag(question.answer ?? '')}"]`)
			}
		}
	}
	if (state.contract) {
		const double = state.contract.doubling === 'doubled' ? 'X' : state.contract.doubling === 'redoubled' ? 'XX' : ''
		lines.push(`[Contract "${state.contract.level}${state.contract.strain}${double}"]`)
		lines.push(`[Declarer "${state.contract.declarer}"]`)
		lines.push(`[Result "${state.tricksWon[state.contract.declarer === 'N' || state.contract.declarer === 'S' ? 'NS' : 'EW']}"]`)
	}
	const tricks = [...state.completedTricks, ...(state.currentTrick?.plays.length ? [state.currentTrick] : [])]
	if (tricks.length) {
		lines.push(`[Play "${tricks[0]!.leader}"]`)
		for (const trick of tricks) lines.push(trick.plays.map(play => formatCard(play.card)).join(' '))
	}
	return `${lines.join('\n')}\n`
}

function pbnRecordAt(pbn: string, boardIndex: number): string {
	const records = splitPbnRecords(pbn)
	if (!records.length) throw new Error('PBN text does not contain a board')
	if (!Number.isInteger(boardIndex) || boardIndex < 0 || boardIndex >= records.length) throw new Error('Selected PBN board is not available')
	return records[boardIndex]!
}

function splitPbnRecords(pbn: string): string[] {
	const records: string[] = []
	let current: string[] = []
	let hasDeal = false
	for (const rawLine of pbn.replace(/\r\n?/g, '\n').split('\n')) {
		const line = rawLine.trim()
		const tag = line.match(/^\[([A-Za-z][A-Za-z0-9_]*)\s+"([^"]*)"\]$/)
		const tagName = tag?.[1]?.toLowerCase()
		if ((tagName === 'event' || tagName === 'board') && hasDeal && current.length) {
			records.push(current.join('\n'))
			current = []
			hasDeal = false
		}
		if (tagName === 'deal') hasDeal = true
		current.push(rawLine)
	}
	if (current.some(line => line.trim())) records.push(current.join('\n'))
	return records.filter(record => parsePbn(record).tags.has('deal'))
}

function escapeTag(value: string): string {
	return value.replace(/["\\]/g, "'")
}

function parsePbn(pbn: string): ParsedPbn {
	const tags = new Map<string, string>()
	const sections = new Map<string, string[]>()
	let section: string | undefined
	for (const rawLine of pbn.replace(/\r\n?/g, '\n').split('\n')) {
		const line = rawLine.trim()
		if (!line || line.startsWith('%') || line.startsWith(';')) continue
		const tag = line.match(/^\[([A-Za-z][A-Za-z0-9_]*)\s+"([^"]*)"\]$/)
		if (tag) {
			section = tag[1]!.toLowerCase()
			tags.set(section, tag[2]!)
			continue
		}
		if (section) {
			const lines = sections.get(section) ?? []
			lines.push(line)
			sections.set(section, lines)
		}
	}
	return { tags, sections }
}

type ParsedBridgeCoreAlert = Readonly<{
	explanation: string
	questions: readonly Readonly<{
		id: string
		askedBy: 'NS' | 'EW'
		question: string
		askedAt: string
		answer?: string
		answeredBy?: 'NS' | 'EW'
		answeredAt?: string
	}>[]
}>

function parseBridgeCoreAlerts(parsed: ParsedPbn): Map<number, ParsedBridgeCoreAlert> {
	const explanations = new Map<number, string>()
	const questions = new Map<number, ParsedBridgeCoreAlert['questions']>()
	for (const [tag, value] of parsed.tags) {
		const alertMatch = tag.match(/^bridgecorealert([1-9][0-9]*)$/)
		const questionMatch = tag.match(/^bridgecorealertq([1-9][0-9]*)_[1-9][0-9]*$/)
		if (alertMatch) {
			const index = Number(alertMatch[1]) - 1
			const parts = value.split(':')
			const explanation = parts.slice(2).join(':').trim()
			if (explanation) explanations.set(index, explanation)
			continue
		}
		if (!questionMatch) continue
		const index = Number(questionMatch[1]) - 1
		const parts = value.split(':')
		const askedBy = parseSide(parts[0])
		const question = parts[1]?.trim()
		const answer = parts.slice(2).join(':').trim()
		if (!askedBy || !question) continue
		const now = new Date().toISOString()
		const existing = questions.get(index) ?? []
		questions.set(index, [
			...existing,
			{
				id: `pbn-${index + 1}-${existing.length + 1}`,
				askedBy,
				question,
				askedAt: now,
				...(answer ? { answer, answeredBy: askedBy === 'NS' ? 'EW' : 'NS', answeredAt: now } : {})
			}
		])
	}
	const alerts = new Map<number, ParsedBridgeCoreAlert>()
	for (const [index, explanation] of explanations) alerts.set(index, { explanation, questions: questions.get(index) ?? [] })
	return alerts
}

function applyAlert(history: BoardHistory, index: number, alert: ParsedBridgeCoreAlert): BoardHistory {
	const state = history.current
	const entry = state.auction[index]
	if (!entry) return history
	const auction = state.auction.map((call, callIndex) => callIndex === index
		? { ...call, alert: { explanation: alert.explanation, explainedBy: partnership(entry.seat), updatedAt: new Date().toISOString(), questions: alert.questions } }
		: call
	)
	return new BoardHistory(history.states[0]!, [...history.states.slice(0, -1), { ...state, auction }])
}

function parseSide(value: string | undefined): 'NS' | 'EW' | undefined {
	return value === 'NS' || value === 'EW' ? value : undefined
}

function createInitialBoardFromPbn(parsed: ParsedPbn): BoardState {
	const boardNumber = parsePositiveInteger(parsed.tags.get('board') ?? '1', 'Board')
	const dealer = parseSeat(parsed.tags.get('dealer') ?? seats[(boardNumber - 1) % 4]!, 'Dealer')
	const vulnerability = parseVulnerability(parsed.tags.get('vulnerable') ?? formatVulnerability(vulnerabilityForBoard(boardNumber)))
	const hands = parseDeal(parsed.tags.get('deal'))
	return {
		boardNumber,
		dealer,
		vulnerability,
		phase: 'auction',
		hands,
		auction: [],
		dummyVisible: false,
		currentTurn: dealer,
		completedTricks: [],
		tricksWon: { NS: 0, EW: 0 }
	}
}

function parseDeal(value: string | undefined): Hands {
	if (!value) throw new Error('PBN Deal tag is required')
	const match = value.trim().match(/^([NESW]):(.+)$/i)
	if (!match) throw new Error('PBN Deal must look like N:AKQ.JT9... ... ... ...')
	let seat = parseSeat(match[1]!, 'Deal seat')
	const chunks = match[2]!.trim().split(/\s+/)
	if (chunks.length !== 4) throw new Error('PBN Deal must contain four hands')
	const mutable: Record<Seat, Card[]> = { N: [], E: [], S: [], W: [] }
	for (const chunk of chunks) {
		mutable[seat] = parseHand(chunk)
		seat = nextSeat(seat)
	}
	validateHands(mutable)
	return mutable
}

function parseHand(value: string): Card[] {
	const suits = value.split('.')
	if (suits.length !== 4) throw new Error(`PBN hand must contain four suits: ${value}`)
	const cards: Card[] = []
	for (const [index, holding] of suits.entries()) {
		const suit = pbnSuitOrder[index]!
		const ranks = holding === '-' ? '' : holding
		for (const rank of ranks.toUpperCase()) {
			if (!pbnRanks.includes(rank)) throw new Error(`Invalid PBN rank: ${rank}`)
			cards.push({ suit, rank: rank as Rank })
		}
	}
	if (cards.length !== 13) throw new Error(`PBN hand has ${cards.length} cards instead of 13`)
	return cards
}

function validateHands(hands: Hands): void {
	const seen = new Set<string>()
	for (const seat of seats) {
		if (hands[seat].length !== 13) throw new Error(`${seat} has ${hands[seat].length} cards instead of 13`)
		for (const card of hands[seat]) {
			const id = formatCard(card)
			if (seen.has(id)) throw new Error(`Duplicate PBN card: ${id}`)
			seen.add(id)
		}
	}
	if (seen.size !== 52) throw new Error('PBN Deal must contain all 52 unique cards')
}

function parseAuction(parsed: ParsedPbn, dealer: Seat): Call[] {
	if (!parsed.tags.has('auction')) return []
	const tokens = tokensForSection(parsed, 'auction')
	const calls: Call[] = []
	let seat = parseSeat(parsed.tags.get('auction') || dealer, 'Auction')
	for (const token of tokens) {
		if (token === '*' || token.includes('=')) continue
		if (/^\d+$/.test(token)) continue
		if (/^AP$/i.test(token)) {
			do {
				calls.push({ type: 'pass' })
				seat = nextSeat(seat)
			} while (!auctionWouldBeClosed(dealer, calls))
			continue
		}
		calls.push(parseCall(token))
		seat = nextSeat(seat)
	}
	return calls
}

function parseCall(token: string): Call {
	const normalized = token.toUpperCase()
	if (normalized === 'P' || normalized === 'PASS') return { type: 'pass' }
	if (normalized === 'X' || normalized === 'DBL' || normalized === 'DOUBLE') return { type: 'double' }
	if (normalized === 'XX' || normalized === 'RDBL' || normalized === 'REDOUBLE') return { type: 'redouble' }
	const bid = normalized.match(/^([1-7])(C|D|H|S|N|NT)$/)
	if (!bid) throw new Error(`Invalid PBN call: ${token}`)
	return {
		type: 'bid',
		level: Number(bid[1]) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
		strain: bid[2] === 'N' ? 'NT' : bid[2] as Strain
	}
}

function auctionWouldBeClosed(dealer: Seat, calls: readonly Call[]): boolean {
	let state = {
		boardNumber: 1,
		dealer,
		vulnerability: 'none',
		phase: 'auction',
		hands: { N: [], E: [], S: [], W: [] },
		auction: [],
		dummyVisible: false,
		currentTurn: dealer,
		completedTricks: [],
		tricksWon: { NS: 0, EW: 0 }
	} as BoardState
	for (const call of calls) state = applyCall(state, call)
	return state.phase !== 'auction'
}

function parsePlay(parsed: ParsedPbn): Card[] {
	if (!parsed.tags.has('play')) return []
	return tokensForSection(parsed, 'play')
		.filter(token => token !== '*')
		.map(parseCard)
}

function parseCard(token: string): Card {
	const normalized = token.toUpperCase()
	const suitFirst = normalized.match(/^(C|D|H|S)([2-9TJQKA])$/)
	if (suitFirst) return { suit: suitFirst[1] as Suit, rank: suitFirst[2] as Rank }
	const rankFirst = normalized.match(/^([2-9TJQKA])(C|D|H|S)$/)
	if (rankFirst) return { rank: rankFirst[1] as Rank, suit: rankFirst[2] as Suit }
	throw new Error(`Invalid PBN card: ${token}`)
}

function tokensForSection(parsed: ParsedPbn, tag: string): string[] {
	const lines = parsed.sections.get(tag) ?? []
	return lines.flatMap(line => line.split(/\s+/)).filter(Boolean)
}

function formatAuction(auction: readonly AuctionCall[]): string {
	return auction.map(entry => formatCall(entry.call)).join(' ')
}

function formatCall(call: Call): string {
	if (call.type === 'bid') return `${call.level}${call.strain}`
	if (call.type === 'double') return 'X'
	if (call.type === 'redouble') return 'XX'
	return 'Pass'
}

function formatHand(cards: readonly Card[]): string {
	return pbnSuitOrder.map(suit => {
		const ranks = cards
			.filter(card => card.suit === suit)
			.sort((left, right) => pbnRanks.indexOf(left.rank) - pbnRanks.indexOf(right.rank))
			.map(card => card.rank)
			.join('')
		return ranks || '-'
	}).join('.')
}

function formatCard(card: Card): string {
	return `${card.suit}${card.rank}`
}

function parsePositiveInteger(value: string, label: string): number {
	const number = Number(value)
	if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`)
	return number
}

function parseSeat(value: string, label: string): Seat {
	const seat = value.toUpperCase()
	if (seat === 'N' || seat === 'E' || seat === 'S' || seat === 'W') return seat
	throw new Error(`${label} must be N, E, S, or W`)
}

function parseVulnerability(value: string): Vulnerability {
	const normalized = value.trim().toUpperCase()
	if (normalized === 'NONE' || normalized === 'LOVE' || normalized === '-') return 'none'
	if (normalized === 'NS' || normalized === 'N-S') return 'ns'
	if (normalized === 'EW' || normalized === 'E-W') return 'ew'
	if (normalized === 'ALL' || normalized === 'BOTH') return 'both'
	throw new Error('Vulnerable must be None, NS, EW, or All')
}

function formatVulnerability(value: Vulnerability): string {
	if (value === 'ns') return 'NS'
	if (value === 'ew') return 'EW'
	if (value === 'both') return 'All'
	return 'None'
}
