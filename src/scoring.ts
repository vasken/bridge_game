import { partnership } from './board.js'
import type { Contract, ScoringMethod, Vulnerability } from './types.js'

export type ScoreResult = Readonly<{
	ns: number
	ew: number
	declarerScore: number
	made: boolean
}>

export function scoreContract(contract: Contract, declarerTricks: number, vulnerability: Vulnerability, method: ScoringMethod = 'duplicate'): ScoreResult {
	if (!Number.isInteger(declarerTricks) || declarerTricks < 0 || declarerTricks > 13) throw new Error('Declarer tricks must be from 0 to 13')
	const vulnerable = vulnerability === 'both' || vulnerability === 'ns' && partnership(contract.declarer) === 'NS' || vulnerability === 'ew' && partnership(contract.declarer) === 'EW'
	const required = contract.level + 6
	const made = declarerTricks >= required
	const declarerScore = made ? madeScore(contract, declarerTricks - required, vulnerable) : -undertrickPenalty(required - declarerTricks, contract.doubling, vulnerable)
	const ns = partnership(contract.declarer) === 'NS' ? declarerScore : -declarerScore
	return { ns, ew: -ns, declarerScore, made }
}

function madeScore(contract: Contract, overtricks: number, vulnerable: boolean): number {
	const multiplier = contract.doubling === 'redoubled' ? 4 : contract.doubling === 'doubled' ? 2 : 1
	const base = contract.strain === 'NT' ? 40 + (contract.level - 1) * 30 : contract.level * (contract.strain === 'C' || contract.strain === 'D' ? 20 : 30)
	const trickScore = base * multiplier
	const gameOrPartscore = trickScore >= 100 ? vulnerable ? 500 : 300 : 50
	const slam = contract.level === 6 ? vulnerable ? 750 : 500 : contract.level === 7 ? vulnerable ? 1500 : 1000 : 0
	const insult = contract.doubling === 'redoubled' ? 100 : contract.doubling === 'doubled' ? 50 : 0
	const overtrickScore = contract.doubling === 'undoubled'
		? overtricks * (contract.strain === 'C' || contract.strain === 'D' ? 20 : 30)
		: overtricks * (vulnerable ? 200 : 100) * (contract.doubling === 'redoubled' ? 2 : 1)
	return trickScore + gameOrPartscore + slam + insult + overtrickScore
}

function undertrickPenalty(undertricks: number, doubling: Contract['doubling'], vulnerable: boolean): number {
	if (doubling === 'undoubled') return undertricks * (vulnerable ? 100 : 50)
	let penalty = 0
	let index = 1
	while (index <= undertricks) {
		if (vulnerable) penalty += index === 1 ? 200 : 300
		else penalty += index === 1 ? 100 : index <= 3 ? 200 : 300
		index++
	}
	return penalty * (doubling === 'redoubled' ? 2 : 1)
}

// Chicago uses duplicate-style board scoring. Its four-deal vulnerability schedule is
// represented by chicagoVulnerability. Cumulative totals are the sum of board scores.
export function chicagoVulnerability(dealNumber: number): Vulnerability {
	const cycle = ['none', 'ns', 'ew', 'both'] as const
	if (!Number.isInteger(dealNumber) || dealNumber < 1) throw new Error('Deal number must be positive')
	return cycle[(dealNumber - 1) % 4]!
}
