import { nextSeat, partnership } from './board.js'
import { strains, type AuctionCall, type Bid, type BoardState, type Call, type Contract, type Seat } from './types.js'

function bidValue(bid: Bid): number {
	return (bid.level - 1) * 5 + strains.indexOf(bid.strain)
}

export function isCallLegal(state: BoardState, call: Call): boolean {
	if (state.phase !== 'auction') return false
	if (call.type === 'pass') return true
	const lastBid = [...state.auction].reverse().find(entry => entry.call.type === 'bid')
	if (call.type === 'bid') return !lastBid || bidValue(call) > bidValue(lastBid.call as Bid)
	if (!lastBid) return false
	const callsAfterBid = state.auction.slice(state.auction.indexOf(lastBid) + 1)
	const lastNonPass = [...state.auction].reverse().find(entry => entry.call.type !== 'pass')
	if (call.type === 'double') {
		return lastNonPass?.call.type === 'bid' && partnership(lastBid.seat) !== partnership(state.currentTurn)
	}
	return lastNonPass?.call.type === 'double' && callsAfterBid.some(entry => entry.call.type === 'double') && partnership(lastBid.seat) === partnership(state.currentTurn)
}

export function applyCall(state: BoardState, call: Call): BoardState {
	if (!isCallLegal(state, call)) throw new Error(`Illegal ${call.type} by ${state.currentTurn}`)
	const auction = [...state.auction, { seat: state.currentTurn, call } satisfies AuctionCall]
	const lastBid = [...auction].reverse().find(entry => entry.call.type === 'bid')
	const trailingPasses = countTrailingPasses(auction)
	if (!lastBid && auction.length === 4 && trailingPasses === 4) {
		return { ...state, auction, phase: 'passed-out', currentTurn: nextSeat(state.currentTurn) }
	}
	if (lastBid && trailingPasses === 3) {
		const contract = determineContract(auction)
		const dummy = partnerOf(contract.declarer)
		return {
			...state,
			auction,
			phase: 'play',
			contract,
			dummy,
			currentTurn: nextSeat(contract.declarer),
			currentTrick: { leader: nextSeat(contract.declarer), plays: [] }
		}
	}
	return { ...state, auction, currentTurn: nextSeat(state.currentTurn) }
}

export function determineContract(auction: readonly AuctionCall[]): Contract {
	const lastBidIndex = auction.map(entry => entry.call.type).lastIndexOf('bid')
	if (lastBidIndex < 0) throw new Error('A passed-out auction has no contract')
	const finalBidEntry = auction[lastBidIndex]!
	const finalBid = finalBidEntry.call as Bid
	const lastNonPass = [...auction].reverse().find(entry => entry.call.type !== 'pass')!
	const doubling = lastNonPass.call.type === 'redouble' ? 'redoubled' : lastNonPass.call.type === 'double' ? 'doubled' : 'undoubled'
	const declaringSide = partnership(finalBidEntry.seat)
	const firstBidder = auction.find(entry => entry.call.type === 'bid' && (entry.call as Bid).strain === finalBid.strain && partnership(entry.seat) === declaringSide)!
	return { level: finalBid.level, strain: finalBid.strain, doubling, declarer: firstBidder.seat }
}

function countTrailingPasses(auction: readonly AuctionCall[]): number {
	let count = 0
	let index = auction.length - 1
	while (index >= 0 && auction[index]!.call.type === 'pass') {
		count++
		index--
	}
	return count
}

function partnerOf(seat: Seat): Seat {
	return nextSeat(nextSeat(seat))
}
