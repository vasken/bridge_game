import { isCallLegal, isPlayLegal } from './index.js'
import { partnership } from './board.js'
import type { AuctionCall, BoardPhase, BoardState, Call, Card, Contract, Seat, Trick, Vulnerability } from './types.js'

export type ControlSide = 'NS' | 'EW'
export type SeatRole = Seat
export type PlayerRole = ControlSide | SeatRole | 'SPECTATOR'
export type BiddingSystem = 'natural' | 'sayc' | 'two-over-one' | 'blue-club-modified'
export type ClaimedPlayers = Readonly<Record<ControlSide | SeatRole, boolean>>
export type RoomConnections = Readonly<Record<ControlSide | SeatRole, boolean> & { spectators: number }>

export type AgreementRequest = Readonly<{
	id: string
	type: 'undo' | 'claim'
	requestingSide: ControlSide
	respondingSide: ControlSide
	createdAt: string
	revision: number
	undoDescription?: string
	claimTricks?: number
	claimRemaining?: number
	claimNote?: string
	claimScore?: Readonly<Record<ControlSide, number>>
}>

export type TableMessage = Readonly<{
	id: string
	time: string
	text: string
}>

export type SeatView = Readonly<{
	seat: Seat
	side: ControlSide
	controlled: boolean
	visible: boolean
	handCount: number
	hand?: readonly Card[]
}>

export type BoardHistorySummary = Readonly<{
	id: string
	boardNumber: number
	vulnerability: Vulnerability
	phase: BoardPhase
	contract?: Contract
	tricksWon: Readonly<Record<'NS' | 'EW', number>>
	current: boolean
}>

export type BoardView = Readonly<{
	roomId: string
	revision: number
	roomMeta?: Readonly<{
		label?: string
		archived: boolean
		biddingSystem: BiddingSystem
		spectatorSeeAll: boolean
		networkOrigin?: string
	}>
	persistence?: Readonly<{
		savedAt?: string
		restored: boolean
	}>
	currentBoardId: string
	boardHistory: readonly BoardHistorySummary[]
	boardNumber: number
	dealer: Seat
	vulnerability: Vulnerability
	phase: BoardPhase
	auction: readonly AuctionCall[]
	contract?: Contract
	dummy?: Seat
	dummyVisible: boolean
	currentTurn: Seat
	currentTrick?: Trick
	completedTricks: readonly Trick[]
	tricksWon: Readonly<Record<'NS' | 'EW', number>>
	seats: Readonly<Record<Seat, SeatView>>
	controlledSide: PlayerRole
	players: ClaimedPlayers
	connections: RoomConnections
	robots: Readonly<Record<Seat, boolean>>
	pendingAgreement?: AgreementRequest
	tableMessages: readonly TableMessage[]
	legalCalls: readonly string[]
	legalPlays: readonly string[]
	canUndo: boolean
}>

export function cardId(card: Card): string {
	return `${card.rank}${card.suit}`
}

export function controlledSeats(side: PlayerRole): readonly Seat[] {
	if (side === 'SPECTATOR') return []
	if (isSeatRole(side)) return [side]
	return side === 'NS' ? ['N', 'S'] : ['E', 'W']
}

export function controlsSeat(side: PlayerRole, seat: Seat): boolean {
	if (side === 'SPECTATOR') return false
	if (isSeatRole(side)) return side === seat
	return partnership(seat) === side
}

export function canPlaySeat(side: PlayerRole, state: BoardState, seat: Seat): boolean {
	if (state.phase !== 'play' || state.currentTurn !== seat) return false
	if (state.dummy === seat && state.contract) return controlsSeat(side, state.contract.declarer)
	return controlsSeat(side, seat)
}

export function isSeatRole(role: PlayerRole): role is SeatRole {
	return role === 'N' || role === 'E' || role === 'S' || role === 'W'
}

export function rolePartnership(role: PlayerRole): ControlSide | undefined {
	if (role === 'NS' || role === 'EW') return role
	if (isSeatRole(role)) return partnership(role)
	return undefined
}

export function projectBoard(
	state: BoardState,
	roomId: string,
	revision: number,
	currentBoardId: string,
	boardHistory: readonly BoardHistorySummary[],
	controlledSide: PlayerRole,
	players: ClaimedPlayers,
	canUndo: boolean,
	persistence?: Readonly<{ savedAt?: string, restored: boolean }>,
	roomMeta?: Readonly<{ label?: string, archived: boolean, biddingSystem: BiddingSystem, spectatorSeeAll?: boolean, networkOrigin?: string }>,
	agreement?: Readonly<{
		connections: RoomConnections
		robots?: Readonly<Record<Seat, boolean>>
		pendingAgreement?: AgreementRequest
		tableMessages: readonly TableMessage[]
	}>
): BoardView {
	const projectedRoomMeta = roomMeta ? { ...roomMeta, spectatorSeeAll: roomMeta.spectatorSeeAll === true } : undefined
	const seatEntries = (['N', 'E', 'S', 'W'] as const).map(seat => {
		const visible = isSeatVisible(state, controlledSide, seat, projectedRoomMeta?.spectatorSeeAll === true)
		const view: SeatView = {
			seat,
			side: partnership(seat),
			controlled: controlsSeat(controlledSide, seat),
			visible,
			handCount: state.hands[seat].length,
			...(visible ? { hand: state.hands[seat] } : {})
		}
		return [seat, view] as const
	})

	const legalCalls = possibleCalls().filter(call => isCallLegal(state, call)).map(callId)
	const legalPlays = canPlaySeat(controlledSide, state, state.currentTurn)
		? state.hands[state.currentTurn].filter(card => isPlayLegal(state, card)).map(cardId)
		: []

	return {
		roomId,
		revision,
		...(projectedRoomMeta ? { roomMeta: projectedRoomMeta } : {}),
		...(persistence ? { persistence } : {}),
		currentBoardId,
		boardHistory,
		boardNumber: state.boardNumber,
		dealer: state.dealer,
		vulnerability: state.vulnerability,
		phase: state.phase,
		auction: state.auction,
		...(state.contract ? { contract: state.contract } : {}),
		...(state.dummy ? { dummy: state.dummy } : {}),
		dummyVisible: state.dummyVisible,
		currentTurn: state.currentTurn,
		...(state.currentTrick ? { currentTrick: state.currentTrick } : {}),
		completedTricks: state.completedTricks,
		tricksWon: state.tricksWon,
		seats: Object.fromEntries(seatEntries) as Record<Seat, SeatView>,
		controlledSide,
		players,
		connections: agreement?.connections ?? { NS: false, EW: false, N: false, E: false, S: false, W: false, spectators: 0 },
		robots: agreement?.robots ?? { N: false, E: false, S: false, W: false },
		...(agreement?.pendingAgreement ? { pendingAgreement: agreement.pendingAgreement } : {}),
		tableMessages: agreement?.tableMessages ?? [],
		legalCalls,
		legalPlays,
		canUndo: controlledSide === 'SPECTATOR' ? false : canUndo
	}
}

export function callId(call: Call): string {
	if (call.type === 'bid') return `bid:${call.level}:${call.strain}`
	return call.type
}

function isSeatVisible(state: BoardState, controlledSide: PlayerRole, seat: Seat, spectatorSeeAll = false): boolean {
	return state.phase === 'complete'
		|| state.phase === 'passed-out'
		|| Boolean(spectatorSeeAll && controlledSide === 'SPECTATOR')
		|| controlsSeat(controlledSide, seat)
		|| Boolean(state.dummyVisible && state.dummy === seat)
}

function possibleCalls(): readonly Call[] {
	const calls: Call[] = [{ type: 'pass' }, { type: 'double' }, { type: 'redouble' }]
	for (const level of [1, 2, 3, 4, 5, 6, 7] as const) {
		for (const strain of ['C', 'D', 'H', 'S', 'NT'] as const) calls.push({ type: 'bid', level, strain })
	}
	return calls
}
