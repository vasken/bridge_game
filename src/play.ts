import { nextSeat, partnership } from './board.js'
import { ranks, suits, type BoardState, type Card, type Seat, type Suit, type Trick } from './types.js'

function sameCard(left: Card, right: Card): boolean {
	return left.suit === right.suit && left.rank === right.rank
}

export function isPlayLegal(state: BoardState, card: Card): boolean {
	if (state.phase !== 'play' || !state.currentTrick) return false
	const hand = state.hands[state.currentTurn]
	if (!hand.some(held => sameCard(held, card))) return false
	const leadSuit = state.currentTrick.plays[0]?.card.suit
	return !leadSuit || card.suit === leadSuit || !hand.some(held => held.suit === leadSuit)
}

export function applyPlay(state: BoardState, card: Card): BoardState {
	if (!isPlayLegal(state, card)) throw new Error(`Illegal card play by ${state.currentTurn}`)
	const seat = state.currentTurn
	const hands = { ...state.hands, [seat]: state.hands[seat].filter(held => !sameCard(held, card)) }
	const plays = [...state.currentTrick!.plays, { seat, card }]
	const dummyVisible = state.dummyVisible || state.completedTricks.length === 0 && plays.length === 1
	if (plays.length < 4) return { ...state, hands, dummyVisible, currentTurn: nextSeat(seat), currentTrick: { ...state.currentTrick!, plays } }
	const trick: Trick = { ...state.currentTrick!, plays, winner: trickWinner({ ...state.currentTrick!, plays }, state.contract!.strain) }
	const side = partnership(trick.winner!)
	const tricksWon = { ...state.tricksWon, [side]: state.tricksWon[side] + 1 }
	const completedTricks = [...state.completedTricks, trick]
	if (completedTricks.length === 13) {
		const { currentTrick: finishedTrick, ...withoutCurrentTrick } = state
		return { ...withoutCurrentTrick, hands, dummyVisible, completedTricks, tricksWon, phase: 'complete', currentTurn: trick.winner! }
	}
	return { ...state, hands, dummyVisible, completedTricks, tricksWon, currentTurn: trick.winner!, currentTrick: { leader: trick.winner!, plays: [] } }
}

export function trickWinner(trick: Trick, strain: Suit | 'NT'): Seat {
	if (trick.plays.length !== 4) throw new Error('A complete trick must contain four cards')
	const leadSuit = trick.plays[0]!.card.suit
	const trump = strain === 'NT' ? undefined : strain
	return trick.plays.reduce((winner, play) => beats(play.card, winner.card, leadSuit, trump) ? play : winner).seat
}

function beats(candidate: Card, current: Card, leadSuit: Suit, trump?: Suit): boolean {
	if (candidate.suit === current.suit) return ranks.indexOf(candidate.rank) > ranks.indexOf(current.rank)
	if (trump && candidate.suit === trump) return current.suit !== trump
	if (trump && current.suit === trump) return false
	return candidate.suit === leadSuit && current.suit !== leadSuit
}

export function visibleHands(state: BoardState, viewer: Seat): Readonly<Partial<Record<Seat, readonly Card[]>>> {
	const visible: Partial<Record<Seat, readonly Card[]>> = { [viewer]: state.hands[viewer] }
	if (state.dummy && state.dummyVisible) visible[state.dummy] = state.hands[state.dummy]
	if (state.phase === 'complete' || state.phase === 'passed-out') return state.hands
	return visible
}
