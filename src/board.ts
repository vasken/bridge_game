import { createDeck, deal, seededRandom, shuffle } from './cards.js'
import { seats, type BoardState, type Seat, type Vulnerability } from './types.js'

const vulnerabilityCycle: readonly Vulnerability[] = [
	'none', 'ns', 'ew', 'both', 'ns', 'ew', 'both', 'none',
	'ew', 'both', 'none', 'ns', 'both', 'none', 'ns', 'ew'
]

export function nextSeat(seat: Seat): Seat {
	return seats[(seats.indexOf(seat) + 1) % 4]!
}

export function partnership(seat: Seat): 'NS' | 'EW' {
	return seat === 'N' || seat === 'S' ? 'NS' : 'EW'
}

export function dealerForBoard(boardNumber: number): Seat {
	validateBoardNumber(boardNumber)
	return seats[(boardNumber - 1) % 4]!
}

export function vulnerabilityForBoard(boardNumber: number): Vulnerability {
	validateBoardNumber(boardNumber)
	return vulnerabilityCycle[(boardNumber - 1) % 16]!
}

export function createBoard(boardNumber: number, seed = boardNumber): BoardState {
	const dealer = dealerForBoard(boardNumber)
	return {
		boardNumber,
		dealer,
		vulnerability: vulnerabilityForBoard(boardNumber),
		phase: 'auction',
		hands: deal(shuffle(createDeck(), seededRandom(seed)), dealer),
		auction: [],
		dummyVisible: false,
		currentTurn: dealer,
		completedTricks: [],
		tricksWon: { NS: 0, EW: 0 }
	}
}

function validateBoardNumber(boardNumber: number): void {
	if (!Number.isInteger(boardNumber) || boardNumber < 1) throw new Error('Board number must be a positive integer')
}
