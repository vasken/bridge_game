import { partnership } from './board.js'
import { isPlayLegal } from './play.js'
import { scoreContract, type ScoreResult } from './scoring.js'
import type { AuctionCall, BoardPhase, BoardState, Card, Contract, Hands, Seat, Strain, Suit, Trick, Vulnerability } from './types.js'
import { Dds, Direction, Trump, loadDds, Vulnerable, type DdTableResults, type FutureTricks, type ParResultsDealer } from 'bridge-dds'

export type HcpSummary = Readonly<{
	seats: Readonly<Record<Seat, number>>
	sides: Readonly<Record<'NS' | 'EW', number>>
}>

export type TrickSummary = Readonly<{
	number: number
	leader: Seat
	winner?: Seat
	side?: 'NS' | 'EW'
	cards: readonly string[]
}>

export type ContractAnalysis = Readonly<{
	contract: Contract
	requiredTricks: number
	declarerTricks: number
	result: string
	score: ScoreResult
}>

export type MakeableTable = Readonly<Record<Strain, Readonly<Record<Seat, number>>>>

export type DdsAnalysis = Readonly<{
	status: 'solved' | 'error'
	message: string
	pbn: string
	makeable?: MakeableTable
	contract?: DdsContractExplanation
	par?: Readonly<{
		score: number
		contracts: readonly string[]
	}>
	playGuidance?: PlayGuidance
	playReview?: readonly PlayReview[]
}>

export type DdsContractExplanation = Readonly<{
	makeableTricks: number
	requiredTricks: number
	result: string
	explanation: string
}>

export type PlayGuidance = Readonly<{
	seat: Seat
	side: 'NS' | 'EW'
	strain: Strain
	bestScore: number
	scoreMeaning: string
	explanation: string
	plays: readonly PlayOption[]
}>

export type PlayOption = Readonly<{
	card: Card
	score: number
	projectedSideTricks: number
	projectedDeclarerTricks: number
	best: boolean
	label: string
	explanation: string
}>

export type PlayReview = Readonly<{
	trickNumber: number
	playNumber: number
	seat: Seat
	side: 'NS' | 'EW'
	card: Card
	bestCards: readonly Card[]
	actualScore: number
	bestScore: number
	projectedDeclarerTricks: number
	label: string
	explanation: string
}>

export type BoardAnalysis = Readonly<{
	boardNumber: number
	phase: BoardPhase
	dealer: Seat
	vulnerability: Vulnerability
	hcp: HcpSummary
	auction: readonly AuctionCall[]
	contractAnalysis?: ContractAnalysis
	tricks: readonly TrickSummary[]
	dds: DdsAnalysis
}>

const hcpValues = new Map([
	['A', 4],
	['K', 3],
	['Q', 2],
	['J', 1]
])

let ddsPromise: Promise<Dds> | undefined

export function analyzeBoard(state: BoardState, originalHands: Hands = state.hands): BoardAnalysis {
	const hcp = hcpSummary(originalHands)
	const contractAnalysis = state.contract ? analyzeContract(state) : undefined
	return {
		boardNumber: state.boardNumber,
		phase: state.phase,
		dealer: state.dealer,
		vulnerability: state.vulnerability,
		hcp,
		auction: state.auction,
		...(contractAnalysis ? { contractAnalysis } : {}),
		tricks: state.completedTricks.map((trick, index) => summarizeTrick(trick, index + 1)),
		dds: {
			status: 'error',
			message: 'DDS analysis was not requested.',
			pbn: handsToPbn(originalHands)
		}
	}
}

export async function analyzeBoardWithDds(state: BoardState, originalHands: Hands = state.hands, history: readonly BoardState[] = [state]): Promise<BoardAnalysis> {
	const base = analyzeBoard(state, originalHands)
	const pbn = handsToPbn(originalHands)
	try {
		const dds = await getDds()
		const table = dds.CalcDDTablePBN({ cards: pbn })
		const makeable = makeableTable(table)
		const par = dds.DealerPar(table, directionForSeat(state.dealer), vulnerableForDds(state.vulnerability))
		const playGuidance = solveCurrentPlay(state, dds)
		const playReview = solvePlayReview(history, dds)
		return {
			...base,
			dds: {
				status: 'solved',
				message: 'DDS solved the original full deal double-dummy.',
				pbn,
				makeable,
				...(state.contract ? { contract: explainContractDds(state.contract, makeable) } : {}),
				par: parResult(par),
				...(playGuidance ? { playGuidance } : {}),
				...(playReview.length ? { playReview } : {})
			}
		}
	} catch (error) {
		return {
			...base,
			dds: {
				status: 'error',
				message: error instanceof Error ? error.message : String(error),
				pbn
			}
		}
	}
}

function solvePlayReview(history: readonly BoardState[], dds: Dds): readonly PlayReview[] {
	const reviews: PlayReview[] = []
	for (let index = 0; index < history.length - 1; index++) {
		const before = history[index]!
		const after = history[index + 1]!
		if (before.phase !== 'play' || !before.contract || !before.currentTrick) continue
		const card = removedCard(before.hands[before.currentTurn], after.hands[before.currentTurn])
		if (!card) continue
		const guidance = solveCurrentPlay(before, dds)
		const actual = guidance?.plays.find(play => sameCard(play.card, card))
		if (!guidance || !actual) continue
		const bestCards = guidance.plays.filter(play => play.best).map(play => play.card)
		reviews.push(reviewForPlay(before, card, actual, guidance, bestCards))
	}
	return reviews
}

function reviewForPlay(before: BoardState, card: Card, actual: PlayOption, guidance: PlayGuidance, bestCards: readonly Card[]): PlayReview {
	const side = partnership(before.currentTurn)
	const currentSideIsDeclarer = side === partnership(before.contract!.declarer)
	const bestDeclarerTricks = currentSideIsDeclarer
		? Math.max(...guidance.plays.map(play => play.projectedDeclarerTricks))
		: Math.min(...guidance.plays.map(play => play.projectedDeclarerTricks))
	const delta = currentSideIsDeclarer
		? bestDeclarerTricks - actual.projectedDeclarerTricks
		: actual.projectedDeclarerTricks - bestDeclarerTricks
	return {
		trickNumber: before.completedTricks.length + 1,
		playNumber: before.currentTrick!.plays.length + 1,
		seat: before.currentTurn,
		side,
		card,
		bestCards,
		actualScore: actual.score,
		bestScore: guidance.bestScore,
		projectedDeclarerTricks: actual.projectedDeclarerTricks,
		label: reviewLabel(delta, currentSideIsDeclarer),
		explanation: reviewExplanation(before.currentTurn, card, delta, actual.projectedDeclarerTricks, currentSideIsDeclarer)
	}
}

function reviewLabel(delta: number, currentSideIsDeclarer: boolean): string {
	if (delta === 0) return 'no loss'
	return currentSideIsDeclarer ? `lost ${delta}` : `gave ${delta}`
}

function reviewExplanation(seat: Seat, card: Card, delta: number, projectedDeclarerTricks: number, currentSideIsDeclarer: boolean): string {
	const cardText = `${card.rank}${card.suit}`
	if (delta === 0) return `${seat}'s ${cardText} preserved the double-dummy result. Declarer remains on ${projectedDeclarerTricks} trick${plural(projectedDeclarerTricks)}.`
	if (currentSideIsDeclarer) return `${seat}'s ${cardText} cost declarer ${delta} trick${plural(delta)} double-dummy. Declarer is now held to ${projectedDeclarerTricks}.`
	return `${seat}'s ${cardText} gave declarer ${delta} extra trick${plural(delta)} double-dummy. Declarer can now take ${projectedDeclarerTricks}.`
}

function removedCard(before: readonly Card[], after: readonly Card[]): Card | undefined {
	return before.find(card => !after.some(candidate => sameCard(candidate, card)))
}

function sameCard(left: Card, right: Card): boolean {
	return left.rank === right.rank && left.suit === right.suit
}

function analyzeContract(state: BoardState): ContractAnalysis {
	const contract = state.contract!
	const requiredTricks = contract.level + 6
	const declarerTricks = state.tricksWon[partnership(contract.declarer)]
	const delta = declarerTricks - requiredTricks
	return {
		contract,
		requiredTricks,
		declarerTricks,
		result: delta === 0 ? '=' : delta > 0 ? `+${delta}` : String(delta),
		score: scoreContract(contract, declarerTricks, state.vulnerability)
	}
}

function hcpSummary(hands: Hands): HcpSummary {
	const seats = Object.fromEntries((['N', 'E', 'S', 'W'] as const).map(seat => [seat, hcpForHand(hands[seat])])) as Record<Seat, number>
	return {
		seats,
		sides: {
			NS: seats.N + seats.S,
			EW: seats.E + seats.W
		}
	}
}

function hcpForHand(hand: readonly Card[]): number {
	return hand.reduce((total, card) => total + (hcpValues.get(card.rank) ?? 0), 0)
}

function summarizeTrick(trick: Trick, number: number): TrickSummary {
	return {
		number,
		leader: trick.leader,
		...(trick.winner ? { winner: trick.winner, side: partnership(trick.winner) } : {}),
		cards: trick.plays.map(play => `${play.seat}:${play.card.rank}${play.card.suit}`)
	}
}

function getDds(): Promise<Dds> {
	ddsPromise ??= loadDds().then(module => new Dds(module))
	return ddsPromise
}

function solveCurrentPlay(state: BoardState, dds: Dds): PlayGuidance | undefined {
	if (state.phase !== 'play' || !state.contract || !state.currentTrick) return undefined
	const legalCards = state.hands[state.currentTurn].filter(card => isPlayLegal(state, card))
	if (!legalCards.length) return undefined
	const future = dds.SolveBoardPBN({
		trump: trumpForStrain(state.contract.strain),
		first: directionForSeat(state.currentTrick.leader),
		currentTrickSuit: state.currentTrick.plays.map(play => suitForDds(play.card.suit)),
		currentTrickRank: state.currentTrick.plays.map(play => rankForDds(play.card.rank)),
		remainCards: handsToPbn(state.hands)
	}, -1, 3, 0)
	const side = partnership(state.currentTurn)
	const declarerSide = partnership(state.contract.declarer)
	const scoreSide = partnership(state.currentTrick.leader)
	const options = legalCards.map(card => {
		const score = scoreForCard(future, card)
		const projectedScoreSideTricks = state.tricksWon[scoreSide] + score
		const projectedSideTricks = side === scoreSide ? projectedScoreSideTricks : 13 - projectedScoreSideTricks
		const projectedDeclarerTricks = declarerSide === scoreSide ? projectedScoreSideTricks : 13 - projectedScoreSideTricks
		return {
			card,
			score,
			projectedSideTricks,
			projectedDeclarerTricks,
			best: false,
			label: '',
			explanation: ''
		}
	})
	const bestDeclarerTricks = side === declarerSide
		? Math.max(...options.map(option => option.projectedDeclarerTricks))
		: Math.min(...options.map(option => option.projectedDeclarerTricks))
	const bestScore = options.find(option => option.projectedDeclarerTricks === bestDeclarerTricks)!.score
	const bestCards = options.filter(option => option.projectedDeclarerTricks === bestDeclarerTricks).length
	return {
		seat: state.currentTurn,
		side,
		strain: state.contract.strain,
		bestScore,
		scoreMeaning: `Future tricks for ${side} from this position`,
		explanation: playGuidanceSummary(state, side, bestDeclarerTricks, bestCards),
		plays: options
			.map(option => explainPlayOption(option, bestDeclarerTricks, side === declarerSide))
			.sort((left, right) => {
				const trickDelta = side === declarerSide
					? right.projectedDeclarerTricks - left.projectedDeclarerTricks
					: left.projectedDeclarerTricks - right.projectedDeclarerTricks
				return trickDelta || cardSortKey(left.card).localeCompare(cardSortKey(right.card))
			})
	}
}

function explainPlayOption<T extends Omit<PlayOption, 'label' | 'explanation' | 'best'>>(option: T, bestDeclarerTricks: number, currentSideIsDeclarer: boolean): PlayOption {
	const lost = currentSideIsDeclarer
		? bestDeclarerTricks - option.projectedDeclarerTricks
		: option.projectedDeclarerTricks - bestDeclarerTricks
	if (lost === 0) {
		return {
			...option,
			best: true,
			label: 'best',
			explanation: currentSideIsDeclarer
				? `Keeps declarer on ${option.projectedDeclarerTricks} trick${plural(option.projectedDeclarerTricks)} double-dummy.`
				: `Keeps declarer to ${option.projectedDeclarerTricks} trick${plural(option.projectedDeclarerTricks)} double-dummy.`
		}
	}
	return {
		...option,
		best: false,
		label: currentSideIsDeclarer ? `loses ${lost}` : `gives ${lost}`,
		explanation: currentSideIsDeclarer
			? `Costs declarer ${lost} trick${plural(lost)} double-dummy.`
			: `Gives declarer ${lost} extra trick${plural(lost)} double-dummy.`
	}
}

function playGuidanceSummary(state: BoardState, side: 'NS' | 'EW', bestDeclarerTricks: number, bestCards: number): string {
	const declarerSide = partnership(state.contract!.declarer)
	const cardText = `${bestCards} card${plural(bestCards)}`
	if (side === declarerSide) return `${cardText} keep declarer on ${bestDeclarerTricks} trick${plural(bestDeclarerTricks)} double-dummy.`
	return `${cardText} keep declarer to ${bestDeclarerTricks} trick${plural(bestDeclarerTricks)} double-dummy.`
}

function explainContractDds(contract: Contract, makeable: MakeableTable): DdsContractExplanation {
	const makeableTricks = makeable[contract.strain][contract.declarer]
	const requiredTricks = contract.level + 6
	const delta = makeableTricks - requiredTricks
	const result = delta === 0 ? '=' : delta > 0 ? `+${delta}` : String(delta)
	return {
		makeableTricks,
		requiredTricks,
		result,
		explanation: delta >= 0
			? `Double-dummy, this contract can make with ${makeableTricks} trick${plural(makeableTricks)} (${result}).`
			: `Double-dummy, this contract is down ${Math.abs(delta)} with best play.`
	}
}

function plural(value: number): string {
	return value === 1 ? '' : 's'
}

function scoreForCard(future: FutureTricks, card: Card): number {
	for (let index = 0; index < future.cards; index++) {
		if (future.suit[index] === suitForDds(card.suit) && rankMatches(future.rank[index]!, future.equals[index]!, card.rank)) {
			return future.score[index]!
		}
	}
	throw new Error(`DDS did not return a score for ${card.rank}${card.suit}`)
}

function rankMatches(primaryRank: number, equalsMask: number, rank: Card['rank']): boolean {
	const value = rankForDds(rank)
	return primaryRank === value || (equalsMask & (1 << value)) !== 0
}

function cardSortKey(card: Card): string {
	return `${suitForDds(card.suit)}:${15 - rankForDds(card.rank)}`
}

function handsToPbn(hands: Hands): string {
	return `N:${seatPbn(hands.N)} ${seatPbn(hands.E)} ${seatPbn(hands.S)} ${seatPbn(hands.W)}`
}

function seatPbn(hand: readonly Card[]): string {
	return (['S', 'H', 'D', 'C'] as const).map(suit => suitPbn(hand, suit)).join('.')
}

function suitPbn(hand: readonly Card[], suit: Suit): string {
	const ranks = hand
		.filter(card => card.suit === suit)
		.map(card => card.rank)
		.sort((left, right) => pbnRankValue(right) - pbnRankValue(left))
		.join('')
	return ranks || '-'
}

function pbnRankValue(rank: Card['rank']): number {
	return '23456789TJQKA'.indexOf(rank)
}

function rankForDds(rank: Card['rank']): number {
	if (rank === 'T') return 10
	if (rank === 'J') return 11
	if (rank === 'Q') return 12
	if (rank === 'K') return 13
	if (rank === 'A') return 14
	return Number(rank)
}

function suitForDds(suit: Suit): number {
	return {
		S: 0,
		H: 1,
		D: 2,
		C: 3
	}[suit]
}

function trumpForStrain(strain: Strain): number {
	return {
		S: Trump.Spades,
		H: Trump.Hearts,
		D: Trump.Diamonds,
		C: Trump.Clubs,
		NT: Trump.NoTrump
	}[strain]
}

function makeableTable(table: DdTableResults): MakeableTable {
	return Object.fromEntries(([
		['S', 0],
		['H', 1],
		['D', 2],
		['C', 3],
		['NT', 4]
	] as const).map(([strain, row]) => [strain, {
		N: table.resTable[row]![0]!,
		E: table.resTable[row]![1]!,
		S: table.resTable[row]![2]!,
		W: table.resTable[row]![3]!
	}])) as Record<Strain, Record<Seat, number>>
}

function parResult(par: ParResultsDealer): { score: number, contracts: readonly string[] } {
	return {
		score: par.score,
		contracts: par.contracts
	}
}

function directionForSeat(seat: Seat): number {
	return {
		N: Direction.North,
		E: Direction.East,
		S: Direction.South,
		W: Direction.West
	}[seat]
}

function vulnerableForDds(vulnerability: Vulnerability): number {
	return {
		none: Vulnerable.None,
		ns: Vulnerable.NorthSouth,
		ew: Vulnerable.EastWest,
		both: Vulnerable.Both
	}[vulnerability]
}
