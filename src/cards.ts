import { ranks, seats, suits, type Card, type Hands, type Seat } from './types.js'

export function createDeck(): readonly Card[] {
	return suits.flatMap(suit => ranks.map(rank => ({ suit, rank } as const)))
}

export function seededRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state += 0x6d2b79f5
		let value = state
		value = Math.imul(value ^ value >>> 15, value | 1)
		value ^= value + Math.imul(value ^ value >>> 7, value | 61)
		return ((value ^ value >>> 14) >>> 0) / 4294967296
	}
}

export function shuffle(deck: readonly Card[], random: () => number = Math.random): readonly Card[] {
	const result = [...deck]
	let index = result.length - 1
	while (index > 0) {
		const other = Math.floor(random() * (index + 1))
		const card = result[index]!
		result[index] = result[other]!
		result[other] = card
		index--
	}
	return result
}

export function deal(deck: readonly Card[], dealer: Seat): Hands {
	if (deck.length !== 52) throw new Error('A bridge deck must contain 52 cards')
	const unique = new Set(deck.map(card => `${card.rank}${card.suit}`))
	if (unique.size !== 52) throw new Error('A bridge deck must contain 52 unique cards')
	const hands: Record<Seat, Card[]> = { N: [], E: [], S: [], W: [] }
	const start = seats.indexOf(dealer)
	deck.forEach((card, index) => hands[seats[(start + 1 + index) % 4]!]!.push(card))
	return hands
}
