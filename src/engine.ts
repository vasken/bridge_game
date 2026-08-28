import { applyCall } from './auction.js'
import { applyPlay } from './play.js'
import type { Action, BoardState } from './types.js'

export function transition(state: BoardState, action: Action): BoardState {
	return action.type === 'call' ? applyCall(state, action.call) : applyPlay(state, action.card)
}

export class BoardHistory {
	readonly states: readonly BoardState[]

	constructor(initial: BoardState, states: readonly BoardState[] = [initial]) {
		this.states = states
	}

	get current(): BoardState {
		return this.states[this.states.length - 1]!
	}

	apply(action: Action): BoardHistory {
		return new BoardHistory(this.states[0]!, [...this.states, transition(this.current, action)])
	}

	undo(steps = 1): BoardHistory {
		if (!Number.isInteger(steps) || steps < 1) throw new Error('Undo steps must be a positive integer')
		return new BoardHistory(this.states[0]!, this.states.slice(0, Math.max(1, this.states.length - steps)))
	}
}
