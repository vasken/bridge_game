export const seats = ['N', 'E', 'S', 'W'] as const
export type Seat = typeof seats[number]

export const suits = ['C', 'D', 'H', 'S'] as const
export type Suit = typeof suits[number]

export const strains = ['C', 'D', 'H', 'S', 'NT'] as const
export type Strain = typeof strains[number]

export const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const
export type Rank = typeof ranks[number]

export type Card = Readonly<{ suit: Suit, rank: Rank }>
export type Hands = Readonly<Record<Seat, readonly Card[]>>
export type Vulnerability = 'none' | 'ns' | 'ew' | 'both'

export type Bid = Readonly<{ type: 'bid', level: 1 | 2 | 3 | 4 | 5 | 6 | 7, strain: Strain }>
export type Call = Bid | Readonly<{ type: 'pass' | 'double' | 'redouble' }>
export type AuctionAlert = Readonly<{
	explanation: string
	explainedBy: 'NS' | 'EW'
	updatedAt: string
	questions?: readonly Readonly<{
		id: string
		askedBy: 'NS' | 'EW'
		question: string
		askedAt: string
		answer?: string
		answeredBy?: 'NS' | 'EW'
		answeredAt?: string
	}>[]
}>
export type AuctionCall = Readonly<{ seat: Seat, call: Call, alert?: AuctionAlert }>
export type Doubling = 'undoubled' | 'doubled' | 'redoubled'
export type Contract = Readonly<{
	level: Bid['level']
	strain: Strain
	doubling: Doubling
	declarer: Seat
}>

export type PlayedCard = Readonly<{ seat: Seat, card: Card }>
export type Trick = Readonly<{ leader: Seat, plays: readonly PlayedCard[], winner?: Seat }>
export type BoardPhase = 'auction' | 'play' | 'complete' | 'passed-out'

export type BoardState = Readonly<{
	boardNumber: number
	dealer: Seat
	vulnerability: Vulnerability
	phase: BoardPhase
	hands: Hands
	auction: readonly AuctionCall[]
	contract?: Contract
	dummy?: Seat
	dummyVisible: boolean
	currentTurn: Seat
	currentTrick?: Trick
	completedTricks: readonly Trick[]
	tricksWon: Readonly<Record<'NS' | 'EW', number>>
}>

export type Action =
	| Readonly<{ type: 'call', call: Call }>
	| Readonly<{ type: 'play', card: Card }>

export type ScoringMethod = 'duplicate' | 'chicago'
