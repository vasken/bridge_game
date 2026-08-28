import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { BoardHistory, analyzeBoardWithDds, createBoard, exportBoardPbn, importPbnHistory, isCallLegal, isPlayLegal, partnership, scoreContract } from './dist/index.js'
import { canPlaySeat, controlsSeat, projectBoard } from './dist/multiplayer.js'

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 5173)
const rooms = new Map()
const persistenceVersion = 1
const roomRetentionMs = 30 * 24 * 60 * 60 * 1000
const agreementExpiryMs = 10 * 60 * 1000
const robotTrickPauseMs = 1500
const storageFile = join(dirname(fileURLToPath(import.meta.url)), '.bridge-rooms.json')

loadRooms()

const vite = await createViteServer({
	server: { middlewareMode: true },
	appType: 'spa'
})

const server = createServer(async (req, res) => {
	const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)
	if (url.pathname.startsWith('/api/')) {
		await handleApi(req, res, url)
		return
	}
	vite.middlewares(req, res)
})

server.listen(port, host, () => {
	const networkHost = host === '0.0.0.0' ? localNetworkAddress() : host
	console.log(`Bridge multiplayer server local: http://127.0.0.1:${port}/`)
	if (networkHost && networkHost !== '127.0.0.1') console.log(`Bridge multiplayer server network: http://${networkHost}:${port}/`)
})

async function handleApi(req, res, url) {
	try {
		if (req.method === 'GET' && url.pathname === '/api/status') {
			sendJson(res, 200, { ok: true })
			return
		}
		if (req.method === 'GET' && url.pathname === '/api/rooms') {
			sendJson(res, 200, { rooms: [...rooms.values()].map(roomSummary) })
			return
		}
		if (req.method === 'POST' && url.pathname === '/api/rooms/cleanup') {
			const body = await readJson(req)
			const days = Math.max(0, Math.trunc(Number(body.days) || 0))
			const removed = forgetArchivedRooms(days)
			sendJson(res, 200, { removed })
			return
		}
		if (req.method === 'POST' && url.pathname === '/api/rooms/import') {
			const body = await readJson(req)
			const imported = importSavedRoom(body)
			persistRooms(imported)
			sendJson(res, 201, { roomId: imported.id })
			return
		}
		if (req.method === 'POST' && url.pathname === '/api/rooms') {
			const body = await readJson(req)
			const side = parseSide(body.side || 'NS')
			const room = createRoom()
			const token = claimSide(room, side)
			persistRooms(room)
			sendJson(res, 201, { roomId: room.id, token, side })
			broadcast(room)
			return
		}
		const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?$/)
		if (!match) {
			sendJson(res, 404, { error: 'Not found' })
			return
		}
		const room = rooms.get(match[1])
		if (!room) {
			sendJson(res, 404, { error: 'Room not found' })
			return
		}
		const action = match[2]
		if (req.method === 'POST' && action === 'claim') {
			const body = await readJson(req)
			const side = parseSide(body.side)
			const token = claimSide(room, side, typeof body.token === 'string' ? body.token : undefined, body.force === true)
			persistRooms(room)
			sendJson(res, 200, { roomId: room.id, token, side })
			broadcast(room)
			scheduleRobotAdvance(room)
			return
		}
		if (req.method === 'GET' && action === 'view') {
			const session = requireSession(room, url)
			sendJson(res, 200, viewFor(room, session.token))
			return
		}
		if (req.method === 'POST' && action === 'save') {
			requireSession(room, url)
			persistRooms(room)
			sendJson(res, 200, { ok: true, savedAt: room.savedAt })
			broadcast(room)
			return
		}
		if (req.method === 'GET' && action === 'backup') {
			requireSessionIfProvided(room, url)
			sendJson(res, 200, { version: persistenceVersion, room: serializeRoom(room) })
			return
		}
		if (req.method === 'POST' && action === 'rename') {
			requireSession(room, url)
			const body = await readJson(req)
			room.label = sanitizeRoomLabel(body.label)
			room.revision += 1
			persistRooms(room)
			sendJson(res, 200, { ok: true, label: room.label })
			broadcast(room)
			return
		}
		if (req.method === 'POST' && action === 'bidding-system') {
			requireSession(room, url)
			const body = await readJson(req)
			room.biddingSystem = parseBiddingSystem(body.system)
			room.revision += 1
			addTableMessage(room, `Bidding system set to ${biddingSystemLabel(room.biddingSystem)}.`)
			persistRooms(room)
			sendJson(res, 200, { ok: true, system: room.biddingSystem })
			broadcast(room)
			return
		}
		if (req.method === 'POST' && action === 'archive') {
			requireSession(room, url)
			room.archived = true
			room.revision += 1
			persistRooms(room)
			sendJson(res, 200, { ok: true })
			broadcast(room)
			return
		}
		if (req.method === 'POST' && action === 'unarchive') {
			requireSession(room, url)
			room.archived = false
			room.revision += 1
			persistRooms(room)
			sendJson(res, 200, { ok: true })
			broadcast(room)
			return
		}
		if (req.method === 'POST' && action === 'duplicate') {
			requireSessionIfProvided(room, url)
			const duplicate = duplicateRoom(room)
			persistRooms(duplicate)
			sendJson(res, 201, { roomId: duplicate.id })
			return
		}
		if (req.method === 'DELETE' && !action) {
			requireSession(room, url)
			forgetRoom(room)
			sendJson(res, 200, { ok: true })
			return
		}
		if (req.method === 'GET' && action === 'analysis') {
			requireSession(room, url)
			sendJson(res, 200, await analyzeBoardWithDds(room.history.current, room.history.states[0].hands, room.history.states))
			return
		}
		if (req.method === 'POST' && action === 'call-preview') {
			const session = requireSession(room, url)
			const body = await readJson(req)
			sendJson(res, 200, previewCallExplanation(room, session.side, body))
			return
		}
		if (req.method === 'GET' && action === 'pbn') {
			requireSession(room, url)
			const pbnBody = url.searchParams.get('scope') === 'room'
				? room.boards.map(board => exportBoardPbn(board.history.current, board.history.states[0].hands)).join('\n')
				: exportBoardPbn(room.history.current, room.history.states[0].hands)
			const pbn = `[BridgeCoreSystem "${biddingSystemLabel(room.biddingSystem || 'natural')}"]\n${pbnBody}`
			sendJson(res, 200, { pbn })
			return
		}
		if (req.method === 'GET' && action === 'events') {
			const session = requireSession(room, url)
			openEvents(room, session.token, res)
			return
		}
		if (req.method === 'POST' && action === 'actions') {
			const session = requireSession(room, url)
			const body = await readJson(req)
			const result = applyClientAction(room, session.side, body)
			if (result?.advanceRobots !== false) await advanceRobots(room)
			persistRooms(room)
			sendJson(res, 200, { ok: true })
			broadcast(room)
			return
		}
		sendJson(res, 404, { error: 'Not found' })
	} catch (error) {
		sendJson(res, error.statusCode || 400, { error: error.message || String(error) })
	}
}

function createRoom() {
	const id = randomId(8)
	const seed = randomInt()
	const history = new BoardHistory(createBoard(1, seed))
	const board = createBoardEntry(history, seed, 'deal')
	const room = {
		id,
		revision: 0,
		boardNumber: 1,
		seed,
		history,
		currentBoardId: board.id,
		boards: [board],
		players: new Map(),
		clients: new Set(),
		createdAt: new Date().toISOString(),
		savedAt: undefined,
		restored: false,
		label: undefined,
		archived: false,
		biddingSystem: 'natural',
		spectatorSeeAll: false,
		robots: { N: false, E: false, S: false, W: false },
		pendingAgreement: undefined,
		robotAdvanceTimer: undefined,
		tableMessages: []
	}
	rooms.set(id, room)
	return room
}

function loadRooms() {
	if (!existsSync(storageFile)) return
	try {
		const parsed = JSON.parse(readFileSync(storageFile, 'utf8'))
		if (!parsed || parsed.version !== persistenceVersion || !Array.isArray(parsed.rooms)) return
		let pruned = false
		for (const saved of parsed.rooms) {
			if (savedRoomExpired(saved)) {
				pruned = true
				continue
			}
			const boards = Array.isArray(saved.boards)
				? saved.boards.map(restoreBoardEntry).filter(Boolean)
				: []
			if (!saved.id || !boards.length) continue
			rooms.set(saved.id, restoreRoom({ ...saved, boards }, true))
		}
		console.log(`Restored ${rooms.size} Bridge room${rooms.size === 1 ? '' : 's'} from ${storageFile}`)
		if (pruned) persistRooms()
	} catch (error) {
		console.warn(`Could not restore Bridge rooms: ${error.message || String(error)}`)
	}
}

function savedRoomExpired(saved) {
	if (saved?.archived === true) return false
	const timestamp = Date.parse(typeof saved.savedAt === 'string' ? saved.savedAt : saved.createdAt)
	return Number.isFinite(timestamp) && Date.now() - timestamp > roomRetentionMs
}

function restoreBoardEntry(saved) {
	if (!saved || !saved.id || !saved.history || !Array.isArray(saved.history.states) || !saved.history.states.length) return undefined
	const history = new BoardHistory(saved.history.states[0], saved.history.states)
	return {
		id: saved.id,
		history,
		seed: Number.isInteger(saved.seed) ? saved.seed : 0,
		source: saved.source === 'pbn' ? 'pbn' : 'deal'
	}
}

function restoreRoom(saved, restored) {
	const currentBoardId = saved.boards.some(board => board.id === saved.currentBoardId)
		? saved.currentBoardId
		: saved.boards[saved.boards.length - 1].id
	const current = saved.boards.find(board => board.id === currentBoardId) ?? saved.boards[saved.boards.length - 1]
	return {
		id: saved.id,
		revision: Number.isInteger(saved.revision) ? saved.revision : 0,
		boardNumber: current.history.current.boardNumber,
		seed: current.seed,
		history: current.history,
		currentBoardId,
		boards: saved.boards,
		players: new Map(Array.isArray(saved.players) ? saved.players : []),
		clients: new Set(),
		createdAt: typeof saved.createdAt === 'string' ? saved.createdAt : new Date().toISOString(),
		savedAt: typeof saved.savedAt === 'string' ? saved.savedAt : undefined,
		restored,
		label: sanitizeRoomLabel(saved.label),
		archived: saved.archived === true,
		biddingSystem: parseBiddingSystem(saved.biddingSystem || 'natural'),
		spectatorSeeAll: saved.spectatorSeeAll === true,
		robots: parseRobots(saved.robots),
		pendingAgreement: undefined,
		robotAdvanceTimer: undefined,
		tableMessages: Array.isArray(saved.tableMessages) ? saved.tableMessages.slice(-30).filter(isTableMessage) : []
	}
}

function importSavedRoom(body) {
	const saved = body?.room ?? body
	if (!saved || typeof saved.id !== 'string') throw httpError(400, 'Backup does not contain a room')
	const boards = Array.isArray(saved.boards)
		? saved.boards.map(restoreBoardEntry).filter(Boolean)
		: []
	if (!boards.length) throw httpError(400, 'Backup does not contain playable boards')
	const room = restoreRoom({ ...saved, boards }, true)
	rooms.set(room.id, room)
	return room
}

function forgetRoom(room) {
	clearRobotAdvance(room)
	for (const client of room.clients) {
		sendEvent(client, { error: 'This saved room was forgotten.' })
		client.res.end()
	}
	room.clients.clear()
	rooms.delete(room.id)
	persistRooms()
}

function forgetArchivedRooms(days) {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
	let removed = 0
	for (const room of [...rooms.values()]) {
		if (room.archived !== true) continue
		const timestamp = Date.parse(room.savedAt || room.createdAt)
		if (!Number.isFinite(timestamp) || timestamp > cutoff) continue
		forgetRoom(room)
		removed += 1
	}
	if (removed) persistRooms()
	return removed
}

function persistRooms(changedRoom) {
	if (changedRoom) changedRoom.savedAt = new Date().toISOString()
	const payload = {
		version: persistenceVersion,
		savedAt: new Date().toISOString(),
		rooms: [...rooms.values()].map(serializeRoom)
	}
	const tempFile = `${storageFile}.tmp`
	writeFileSync(tempFile, `${JSON.stringify(payload)}\n`, 'utf8')
	renameSync(tempFile, storageFile)
}

function serializeRoom(room) {
	return {
		id: room.id,
		revision: room.revision,
		currentBoardId: room.currentBoardId,
		createdAt: room.createdAt,
		savedAt: room.savedAt,
		label: room.label,
		archived: room.archived === true,
		biddingSystem: room.biddingSystem || 'natural',
		spectatorSeeAll: room.spectatorSeeAll === true,
		robots: room.robots ?? { N: false, E: false, S: false, W: false },
		tableMessages: room.tableMessages,
		players: [...room.players.entries()],
		boards: room.boards.map(board => ({
			id: board.id,
			seed: board.seed,
			source: board.source,
			history: { states: board.history.states }
		}))
	}
}

function roomSummary(room) {
	const current = room.history.current
	return {
		id: room.id,
		boardNumber: current.boardNumber,
		phase: current.phase,
		boards: room.boards.length,
		players: playersFor(room),
		savedAt: room.savedAt,
		createdAt: room.createdAt,
		restored: room.restored === true,
		label: room.label,
		archived: room.archived === true,
		biddingSystem: room.biddingSystem || 'natural',
		spectatorSeeAll: room.spectatorSeeAll === true,
		robots: room.robots ?? { N: false, E: false, S: false, W: false }
	}
}

function duplicateRoom(room) {
	const boardIdMap = new Map()
	const boards = room.boards.map(board => {
		const id = randomId(6)
		boardIdMap.set(board.id, id)
		return {
			id,
			history: new BoardHistory(board.history.states[0], board.history.states),
			seed: board.seed,
			source: board.source
		}
	})
	const currentBoardId = boardIdMap.get(room.currentBoardId) ?? boards[boards.length - 1].id
	const current = boards.find(board => board.id === currentBoardId) ?? boards[boards.length - 1]
	const duplicate = {
		id: randomId(8),
		revision: 0,
		boardNumber: current.history.current.boardNumber,
		seed: current.seed,
		history: current.history,
		currentBoardId,
		boards,
		players: new Map(),
		clients: new Set(),
		createdAt: new Date().toISOString(),
		savedAt: undefined,
		restored: false,
		label: room.label ? `${room.label} copy` : `Copy of ${room.id}`,
		archived: false,
		biddingSystem: room.biddingSystem || 'natural',
		spectatorSeeAll: room.spectatorSeeAll === true,
		robots: { N: false, E: false, S: false, W: false },
		pendingAgreement: undefined,
		robotAdvanceTimer: undefined,
		tableMessages: room.tableMessages.slice(-30)
	}
	rooms.set(duplicate.id, duplicate)
	return duplicate
}

function claimSide(room, side, existingToken, force = false) {
	if (existingToken) {
		const current = room.players.get(existingToken)
		if (current === side) return existingToken
	}
	if (side !== 'SPECTATOR') {
		for (const [token, claimedSide] of room.players) {
			if (roleConflicts(side, claimedSide) && token !== existingToken) {
				if (!force) throw httpError(409, `${side} is already claimed`)
				room.players.delete(token)
				for (const client of room.clients) {
					if (client.token === token) {
						sendEvent(client, { error: `${side} was taken over in another browser.` })
						client.res.end()
						room.clients.delete(client)
					}
				}
			}
		}
	}
	const token = existingToken || randomId(16)
	room.players.set(token, side)
	return token
}

function applyClientAction(room, side, body) {
	if (side === 'SPECTATOR') throw httpError(403, 'Spectators can watch but cannot change the room')
	expirePendingAgreement(room)
	if (body?.type === 'respondAgreement') {
		return respondToAgreement(room, side, body)
	}
	if (room.pendingAgreement) throw httpError(409, 'A table request is waiting for a response')
	if (body?.type === 'explainCall') return explainAuctionCall(room, side, body)
	if (body?.type === 'askAlertQuestion') return askAlertQuestion(room, side, body)
	if (body?.type === 'answerAlertQuestion') return answerAlertQuestion(room, side, body)
	if (body?.type === 'setSpectatorSeeAll') return setSpectatorSeeAll(room, side, body)
	if (body?.type === 'setRobotSeat') return setRobotSeat(room, side, body)
	if (body?.type === 'undo' || body?.type === 'requestUndo') return requestUndo(room, side)
	if (body?.type === 'requestClaim') return requestClaim(room, side, body)
	if (body?.type === 'nextBoard') {
		room.boardNumber += 1
		room.seed = randomInt()
		setCurrentBoard(room, createBoardEntry(new BoardHistory(createBoard(room.boardNumber, room.seed)), room.seed, 'deal'))
		room.revision += 1
		addTableMessage(room, `Dealt board ${room.boardNumber}.`)
		return
	}
	if (body?.type === 'deal') {
		const boardNumber = Math.max(1, Math.trunc(Number(body.boardNumber) || 1))
		const seed = Math.trunc(Number(body.seed) || randomInt())
		room.boardNumber = boardNumber
		room.seed = seed
		setCurrentBoard(room, createBoardEntry(new BoardHistory(createBoard(boardNumber, seed)), seed, 'deal'))
		room.revision += 1
		addTableMessage(room, `Dealt board ${boardNumber}.`)
		return
	}
	if (body?.type === 'importPbn') {
		if (typeof body.pbn !== 'string' || !body.pbn.trim()) throw httpError(400, 'Paste a PBN deal first')
		const boardIndex = Math.max(0, Math.trunc(Number(body.boardIndex) || 0))
		setCurrentBoard(room, createBoardEntry(importPbnHistory(body.pbn, boardIndex, { replayRecord: body.replayRecord === true }), 0, 'pbn'))
		room.boardNumber = room.history.current.boardNumber
		room.seed = 0
		room.revision += 1
		addTableMessage(room, `Imported board ${room.boardNumber} from PBN.`)
		return
	}
	if (body?.type === 'jumpBoard') {
		if (typeof body.boardId !== 'string') throw httpError(400, 'Choose a board')
		const board = room.boards.find(entry => entry.id === body.boardId)
		if (!board) throw httpError(404, 'Board not found')
		room.currentBoardId = board.id
		room.history = board.history
		room.boardNumber = board.history.current.boardNumber
		room.seed = board.seed
		room.revision += 1
		return
	}
	const state = room.history.current
	if (body?.type === 'call' && !controlsSeat(side, state.currentTurn)) {
		throw httpError(403, `It is ${state.currentTurn}'s turn`)
	}
	if (body?.type === 'play' && !canPlaySeat(side, state, state.currentTurn)) {
		throw httpError(403, `It is ${state.currentTurn}'s turn`)
	}
	if (body?.type === 'call') {
		const seat = state.currentTurn
		const explanation = humanCallExplanation(state, body.call, room.biddingSystem || 'natural')
		room.history = room.history.apply({ type: 'call', call: body.call })
		annotateLastCall(room, seat, explanation)
		currentBoard(room).history = room.history
		room.revision += 1
		return
	}
	if (body?.type === 'play') {
		room.history = room.history.apply({ type: 'play', card: body.card })
		currentBoard(room).history = room.history
		room.revision += 1
		return
	}
	throw httpError(400, 'Unknown action')
}

function previewCallExplanation(room, side, body) {
	const state = room.history.current
	if (state.phase !== 'auction') throw httpError(400, 'Auction is not active')
	if (!body?.call || body.call.type !== 'bid') throw httpError(400, 'Choose a bid')
	if (!controlsSeat(side, state.currentTurn)) throw httpError(403, `It is ${state.currentTurn}'s turn`)
	if (!isCallLegal(state, body.call)) throw httpError(400, `${formatCall(body.call)} is not legal now`)
	return { explanation: humanCallExplanation(state, body.call, room.biddingSystem || 'natural') }
}

function explainAuctionCall(room, side, body) {
	const state = room.history.current
	const index = Math.trunc(Number(body.index))
	if (!Number.isInteger(index) || index < 0 || index >= state.auction.length) throw httpError(400, 'Choose an auction call to explain')
	const entry = state.auction[index]
	const sidePartnership = rolePartnership(side)
	if (partnership(entry.seat) !== sidePartnership) throw httpError(403, 'Only the bidder side can explain that call')
	const explanation = sanitizeExplanation(body.explanation)
	const auction = state.auction.map((call, callIndex) => {
		if (callIndex !== index) return call
		return explanation
			? { ...call, alert: { explanation, explainedBy: sidePartnership, updatedAt: new Date().toISOString(), questions: call.alert?.questions ?? [] } }
			: { seat: call.seat, call: call.call }
	})
	const updated = { ...state, auction }
	room.history = new BoardHistory(room.history.states[0], [...room.history.states.slice(0, -1), updated])
	currentBoard(room).history = room.history
	room.revision += 1
	addTableMessage(room, explanation
		? `${sidePartnership} explained ${entry.seat} ${formatCall(entry.call)}: ${explanation}.`
		: `${sidePartnership} cleared the explanation for ${entry.seat} ${formatCall(entry.call)}.`
	)
}

function askAlertQuestion(room, side, body) {
	const state = room.history.current
	const index = Math.trunc(Number(body.index))
	if (!Number.isInteger(index) || index < 0 || index >= state.auction.length) throw httpError(400, 'Choose an auction call to ask about')
	const entry = state.auction[index]
	if (!entry.alert?.explanation) throw httpError(400, 'That call does not have an explanation yet')
	const sidePartnership = rolePartnership(side)
	if (partnership(entry.seat) === sidePartnership) throw httpError(403, 'Ask questions about opponent explanations')
	const question = sanitizeQuestion(body.question)
	if (!question) throw httpError(400, 'Enter a question first')
	const item = { id: randomId(6), askedBy: sidePartnership, question, askedAt: new Date().toISOString() }
	const alert = { ...entry.alert, questions: [...(entry.alert.questions ?? []), item].slice(-12), updatedAt: new Date().toISOString() }
	updateAuctionEntry(room, index, { ...entry, alert })
	addTableMessage(room, `${sidePartnership} asked about ${entry.seat} ${formatCall(entry.call)}: ${question}.`)
}

function answerAlertQuestion(room, side, body) {
	const state = room.history.current
	const index = Math.trunc(Number(body.index))
	if (!Number.isInteger(index) || index < 0 || index >= state.auction.length) throw httpError(400, 'Choose an auction call to answer')
	const entry = state.auction[index]
	if (!entry.alert?.questions?.length) throw httpError(400, 'That call has no questions')
	const sidePartnership = rolePartnership(side)
	if (partnership(entry.seat) !== sidePartnership) throw httpError(403, 'Only the bidder side can answer that question')
	const questionId = typeof body.questionId === 'string' ? body.questionId : ''
	const answer = sanitizeExplanation(body.answer)
	if (!answer) throw httpError(400, 'Enter an answer first')
	let found = false
	const questions = entry.alert.questions.map(question => {
		if (question.id !== questionId) return question
		found = true
		return { ...question, answer, answeredBy: sidePartnership, answeredAt: new Date().toISOString() }
	})
	if (!found) throw httpError(404, 'Question not found')
	const alert = { ...entry.alert, questions, updatedAt: new Date().toISOString() }
	updateAuctionEntry(room, index, { ...entry, alert })
	addTableMessage(room, `${sidePartnership} answered ${entry.seat} ${formatCall(entry.call)}: ${answer}.`)
}

function updateAuctionEntry(room, index, entry) {
	const state = room.history.current
	const auction = state.auction.map((call, callIndex) => callIndex === index ? entry : call)
	const updated = { ...state, auction }
	room.history = new BoardHistory(room.history.states[0], [...room.history.states.slice(0, -1), updated])
	currentBoard(room).history = room.history
	room.revision += 1
}

function setRobotSeat(room, side, body) {
	requirePartnership(side)
	const seat = body.seat
	if (seat !== 'N' && seat !== 'E' && seat !== 'S' && seat !== 'W') throw httpError(400, 'Robot seat must be N, E, S, or W')
	const enabled = body.enabled === true
	const robots = { N: false, E: false, S: false, W: false, ...(room.robots ?? {}) }
	if (robots[seat] === enabled) return
	if (enabled && !canRobotControlSeat(room, side, seat)) throw httpError(400, `${seat} is already controlled by a human browser`)
	room.robots = { ...robots, [seat]: enabled }
	room.revision += 1
	addTableMessage(room, `${seat} robot ${enabled ? 'enabled' : 'disabled'}.`)
	if (room.history.current.phase === 'auction' && room.history.current.auction.length === 0 && robotSetupStillOpen(room, side)) {
		return { advanceRobots: false }
	}
}

function canRobotControlSeat(room, requesterRole, seat) {
	if (controlsSeat(requesterRole, seat)) return false
	const players = playersFor(room)
	return !players[seat] && !players[partnership(seat)]
}

function robotSetupStillOpen(room, requesterRole) {
	const players = playersFor(room)
	const robots = { N: false, E: false, S: false, W: false, ...(room.robots ?? {}) }
	return ['N', 'E', 'S', 'W'].some(seat => !controlsSeat(requesterRole, seat) && !players[seat] && !players[partnership(seat)] && !robots[seat])
}

function setSpectatorSeeAll(room, side, body) {
	requirePartnership(side)
	const enabled = body.enabled === true
	if (room.spectatorSeeAll === enabled) return
	room.spectatorSeeAll = enabled
	room.revision += 1
	addTableMessage(room, `Spectator hand view set to ${enabled ? 'all hands' : 'public only'}.`)
}

async function advanceRobots(room) {
	let guard = 0
	while (!room.pendingAgreement && guard < 80) {
		guard += 1
		const state = room.history.current
		const seat = state.currentTurn
		if (!room.robots?.[seat]) return
		if (state.phase === 'auction') {
			const decision = await robotCallDecision(room, state)
			room.history = room.history.apply({ type: 'call', call: decision.call })
			annotateLastCall(room, seat, decision.explanation)
			currentBoard(room).history = room.history
			room.revision += 1
			addTableMessage(room, `${seat} robot called ${formatCall(decision.call)}${decision.explanation ? `: ${decision.explanation}` : ''}.`)
			continue
		}
		if (state.phase === 'play') {
			const play = await robotCard(room, state)
			if (!play) return
			if (!isPlayLegal(room.history.current, play.card)) {
				room.revision += 1
				addTableMessage(room, `Robot play stopped: ${seat} tried illegal ${formatCard(play.card)}. Lead suit must be followed when possible.`)
				return
			}
			const completedBefore = state.completedTricks.length
			room.history = room.history.apply({ type: 'play', card: play.card })
			currentBoard(room).history = room.history
			room.revision += 1
			addTableMessage(room, robotPlayMessage(seat, play))
			if (room.history.current.completedTricks.length > completedBefore) {
				scheduleRobotAdvance(room)
				return { pausedAfterCompletedTrick: true }
			}
			continue
		}
		return
	}
	if (guard >= 80) throw httpError(500, 'Robot turn limit reached')
}

function scheduleRobotAdvance(room, delay = robotTrickPauseMs) {
	if (!shouldAdvanceRobots(room) || room.robotAdvanceTimer) return
	room.robotAdvanceTimer = setTimeout(async () => {
		room.robotAdvanceTimer = undefined
		if (!rooms.has(room.id) || !shouldAdvanceRobots(room)) return
		try {
			await advanceRobots(room)
			persistRooms(room)
			broadcast(room)
		} catch (error) {
			room.revision += 1
			addTableMessage(room, `Robot play stopped: ${error.message || String(error)}.`)
			persistRooms(room)
			broadcast(room)
		}
	}, delay)
}

function clearRobotAdvance(room) {
	if (!room.robotAdvanceTimer) return
	clearTimeout(room.robotAdvanceTimer)
	room.robotAdvanceTimer = undefined
}

function shouldAdvanceRobots(room) {
	if (room.pendingAgreement) return false
	const state = room.history.current
	return (state.phase === 'auction' || state.phase === 'play') && room.robots?.[state.currentTurn] === true
}

async function robotCall(room, state) {
	return (await robotCallDecision(room, state)).call
}

async function robotCallDecision(room, state) {
	const system = room.biddingSystem || 'natural'
	const preferred = naturalRobotCall(state, system)
	if (preferred?.call && isCallLegal(state, preferred.call)) return await ddsAuctionDecision(room, state, preferred, system)
	for (const call of naturalFallbackCalls(state, system)) {
		if (isCallLegal(state, call)) return await ddsAuctionDecision(room, state, { call, explanation: robotFallbackCallExplanation(state, call, system) }, system)
	}
	throw httpError(500, 'Robot has no legal call')
}

async function ddsAuctionDecision(room, state, decision, system) {
	const dds = await auctionDdsHint(room, state)
	if (!dds) return decision
	const side = partnership(state.currentTurn)
	const lastBid = lastBidEntry(state.auction)
	const sideOwnsLastBid = lastBid && partnership(lastBid.seat) === side
	if (lastBid?.call.type === 'bid' && partnership(lastBid.seat) !== side) {
		const opponentSide = partnership(lastBid.seat)
		const opponentRequired = lastBid.call.level + 6
		if (opponentRequired > dds.opponentBest.tricks && isCallLegal(state, { type: 'double' })) {
			return {
				call: { type: 'double' },
				explanation: `${decision.explanation} DDS makeable hint says ${opponentSide} is limited to about ${dds.opponentBest.tricks} trick${dds.opponentBest.tricks === 1 ? '' : 's'} double-dummy, below ${formatCall(lastBid.call)}, so robot doubles.`
			}
		}
	}
	if (decision.call.type === 'bid') {
		const required = decision.call.level + 6
		if (required > dds.best.tricks) {
			return {
				call: { type: 'pass' },
				explanation: `${decision.explanation} DDS makeable hint says ${side} is limited to about ${dds.best.tricks} trick${dds.best.tricks === 1 ? '' : 's'} double-dummy, so robot stops instead of bidding ${formatCall(decision.call)}.`
			}
		}
	}
	if (decision.call.type === 'pass' && sideOwnsLastBid && lastBid.call.type === 'bid') {
		const currentRequired = lastBid.call.level + 6
		const raise = ddsRaiseCall(state, lastBid.call, dds.best.tricks)
		if (raise && dds.best.tricks > currentRequired) {
			const hand = state.hands[state.currentTurn]
			return robotDecision(
				raise,
				hand,
				handHcp(hand),
				handShape(hand),
				`${decision.explanation} DDS makeable hint shows room for about ${dds.best.tricks} trick${dds.best.tricks === 1 ? '' : 's'}, so robot raises partner's ${strainName(lastBid.call.strain)} cautiously.`,
				system
			)
		}
	}
	return {
		...decision,
		explanation: `${decision.explanation} DDS makeable hint: best ${side} strain is ${dds.best.tricks} trick${dds.best.tricks === 1 ? '' : 's'} in ${strainName(dds.best.strain)}.`
	}
}

async function auctionDdsHint(room, state) {
	try {
		const analysis = await analyzeBoardWithDds(state, room.history.states[0].hands, room.history.states)
		const makeable = analysis.dds.makeable
		if (analysis.dds.status !== 'solved' || !makeable) return undefined
		const side = partnership(state.currentTurn)
		const best = bestMakeableForSide(makeable, side)
		const opponentBest = bestMakeableForSide(makeable, side === 'NS' ? 'EW' : 'NS')
		return best && opponentBest ? { best, opponentBest } : undefined
	} catch {
		return undefined
	}
}

function bestMakeableForSide(makeable, side) {
	const seats = side === 'NS' ? ['N', 'S'] : ['E', 'W']
	let best
	for (const strain of ['NT', 'S', 'H', 'D', 'C']) {
		for (const seat of seats) {
			const tricks = makeable[strain][seat]
			if (!best || tricks > best.tricks || tricks === best.tricks && strainValue(strain) > strainValue(best.strain)) best = { strain, seat, tricks }
		}
	}
	return best
}

function ddsRaiseCall(state, lastCall, makeableTricks) {
	const maxLevel = Math.max(1, Math.min(7, makeableTricks - 6))
	if (maxLevel <= lastCall.level) return undefined
	const nextLevel = Math.min(maxLevel, lastCall.level + 1)
	const call = { type: 'bid', level: nextLevel, strain: lastCall.strain }
	return isCallLegal(state, call) ? call : undefined
}

function annotateLastCall(room, seat, explanation) {
	if (!explanation) return
	const state = room.history.current
	const index = state.auction.length - 1
	const entry = state.auction[index]
	if (!entry || entry.seat !== seat) return
	const side = partnership(seat)
	const auction = state.auction.map((call, callIndex) => callIndex === index
		? { ...call, alert: { explanation, explainedBy: side, updatedAt: new Date().toISOString(), questions: call.alert?.questions ?? [] } }
		: call
	)
	const updated = { ...state, auction }
	room.history = new BoardHistory(room.history.states[0], [...room.history.states.slice(0, -1), updated])
}

function humanCallExplanation(state, call, system = 'natural') {
	const hand = state.hands[state.currentTurn]
	const hcp = handHcp(hand)
	const shape = handShape(hand)
	const blackwood = blackwoodCallExplanation(state, call)
	if (blackwood) return `${biddingSystemLabel(system)}: ${blackwood} Actual hand: ${hcp} HCP, ${shapeText(shape)}.`
	const blueClub = system === 'blue-club-modified' ? blueClubHumanCallExplanation(state, call) : undefined
	if (blueClub) return `${blueClub} Actual hand: ${hcp} HCP, ${shapeText(shape)}.`
	const natural = naturalRobotCall(state, system)
	const naturalLabel = natural?.call ? formatCall(natural.call) : 'Pass'
	if (natural?.call && sameCall(call, natural.call)) return natural.explanation
	if (call.type === 'pass') {
		return `${biddingSystemLabel(system)}: Human pass. Actual hand: ${hcp} HCP, ${shapeText(shape)}. Natural suggestion was ${naturalLabel}.`
	}
	if (call.type === 'double') {
		return `${biddingSystemLabel(system)}: Human double. Actual hand: ${hcp} HCP, ${shapeText(shape)}. Natural suggestion was ${naturalLabel}.`
	}
	if (call.type === 'redouble') {
		return `${biddingSystemLabel(system)}: Human redouble. Actual hand: ${hcp} HCP, ${shapeText(shape)}. Natural suggestion was ${naturalLabel}.`
	}
	return `${biddingSystemLabel(system)}: Human bid ${formatCall(call)}. Actual hand: ${hcp} HCP, ${shapeText(shape)}. Natural suggestion was ${naturalLabel}.`
}

function naturalRobotCall(state, system = 'natural') {
	const hand = state.hands[state.currentTurn]
	const hcp = handHcp(hand)
	const shape = handShape(hand)
	const lastBid = lastBidEntry(state.auction)
	const lastNonPass = [...state.auction].reverse().find(entry => entry.call.type !== 'pass')
	const side = partnership(state.currentTurn)
	const partnerBid = [...state.auction].reverse().find(entry => partnership(entry.seat) === side && entry.call.type === 'bid')
	const opponentBid = [...state.auction].reverse().find(entry => partnership(entry.seat) !== side && entry.call.type === 'bid')

	if (!lastBid) return naturalOpeningCall(hand, hcp, shape, system)
	if (lastNonPass?.call.type === 'double' && partnership(lastBid.seat) === side && hcp >= 10) return robotDecision({ type: 'redouble' }, hand, hcp, shape, '10+ HCP after opponents doubled partner; shows values and willingness to play redoubled.', system)
	if (lastNonPass?.call.type === 'bid' && partnership(lastNonPass.seat) !== side && !partnerBid) return naturalOvercall(hand, hcp, shape, lastNonPass.call, system)
	if (lastBid.call.type === 'bid' && lastBid.call.level === 4 && lastBid.call.strain === 'NT' && partnership(lastBid.seat) === side) {
		return blackwoodRobotResponse(hand, hcp, shape, system)
	}
	if (partnerBid && partnership(lastBid.seat) === side) return naturalConstructivePass(hand, hcp, shape, 'Partner made the last bid; no extra values to continue.', system)
	if (partnerBid) return naturalResponseOrCompetition(hand, hcp, shape, partnerBid.call, opponentBid?.call, system)
	return naturalConstructivePass(hand, hcp, shape, `No descriptive legal action selected by the ${biddingSystemLabel(system)} profile.`, system)
}

function naturalOpeningCall(hand, hcp, shape, system = 'natural') {
	if (hcp >= 22) return robotDecision({ type: 'bid', level: 2, strain: 'C' }, hand, hcp, shape, `${systemShortName(system)} strong artificial 2C opening, 22+ HCP or equivalent strength.`, system)
	if (isBalancedShape(shape)) {
		if (hcp >= 20 && hcp <= 21) return robotDecision({ type: 'bid', level: 2, strain: 'NT' }, hand, hcp, shape, `${systemShortName(system)} 2NT opening: 20-21 HCP balanced.`, system)
		if (hcp >= 15 && hcp <= 17) return robotDecision({ type: 'bid', level: 1, strain: 'NT' }, hand, hcp, shape, `${systemShortName(system)} 1NT opening: 15-17 HCP balanced.`, system)
	}
	const longest = preferredOpeningSuit(shape)
	if (hcp >= 12) return robotDecision({ type: 'bid', level: 1, strain: longest }, hand, hcp, shape, openingSuitMeaning(longest, system), system)
	const preemptSuit = preferredPreemptSuit(shape)
	if (preemptSuit && hcp >= 6 && hcp <= 10) {
		if (shape[preemptSuit] >= 7) return robotDecision({ type: 'bid', level: 3, strain: preemptSuit }, hand, hcp, shape, `${systemShortName(system)} weak preempt, 6-10 HCP with 7+ ${strainName(preemptSuit)}.`, system)
		if (shape[preemptSuit] >= 6 && preemptSuit !== 'C') return robotDecision({ type: 'bid', level: 2, strain: preemptSuit }, hand, hcp, shape, `${systemShortName(system)} weak two, 6-10 HCP with 6+ ${strainName(preemptSuit)}.`, system)
	}
	return naturalConstructivePass(hand, hcp, shape, 'Below opening strength and no suitable preempt.', system)
}

function naturalOvercall(hand, hcp, shape, opponentCall, system = 'natural') {
	if (isBalancedShape(shape) && hcp >= 15 && hcp <= 18 && hasStopper(hand, opponentCall.strain)) {
		const nt = { type: 'bid', level: opponentCall.level, strain: 'NT' }
		if (opponentCall.strain !== 'NT') return robotDecision(nt, hand, hcp, shape, `15-18 HCP balanced with stopper in opponents' ${strainName(opponentCall.strain)}.`, system)
	}
	const suit = preferredOvercallSuit(shape)
	if (suit && shape[suit] >= 5 && hcp >= 8) return robotDecision({ type: 'bid', level: opponentCall.level, strain: suit }, hand, hcp, shape, `${systemShortName(system)} natural overcall, 8+ HCP with 5+ ${strainName(suit)}.`, system)
	if (hcp >= 13 && takeoutShape(shape, opponentCall.strain)) return robotDecision({ type: 'double' }, hand, hcp, shape, `${systemShortName(system)} takeout double, 13+ HCP, short ${strainName(opponentCall.strain)}, support for unbid suits.`, system)
	return naturalConstructivePass(hand, hcp, shape, `No suitable overcall: needs 5+ suit, stopper for NT, or takeout shape.`, system)
}

function naturalResponseOrCompetition(hand, hcp, shape, partnerCall, opponentCall, system = 'natural') {
	if (partnerCall.strain === 'NT') {
		if (hcp >= 10) return robotDecision({ type: 'bid', level: 3, strain: 'NT' }, hand, hcp, shape, `${systemShortName(system)} raise opposite 1NT/2NT: invitational or game-going values, 10+ HCP.`, system)
		if (hcp >= 8) return robotDecision({ type: 'bid', level: 2, strain: 'NT' }, hand, hcp, shape, `${systemShortName(system)} invitational notrump raise, about 8-9 HCP.`, system)
		const major = longerMajor(shape)
		if (major && shape[major] >= 5 && hcp <= 7) return robotDecision({ type: 'bid', level: 2, strain: major }, hand, hcp, shape, `${systemShortName(system)} weak natural runout, 0-7 HCP with 5+ ${strainName(major)}.`, system)
		return naturalConstructivePass(hand, hcp, shape, 'No game interest opposite partner NT.', system)
	}

	const support = shape[partnerCall.strain] ?? 0
	if (support >= 4 && hcp >= 13) return robotDecision({ type: 'bid', level: Math.min(4, partnerCall.level + 3), strain: partnerCall.strain }, hand, hcp, shape, `${systemShortName(system)} strong raise, 13+ HCP with 4+ card support for ${strainName(partnerCall.strain)}.`, system)
	if (support >= 3 && hcp >= 10) return robotDecision({ type: 'bid', level: Math.min(3, partnerCall.level + 2), strain: partnerCall.strain }, hand, hcp, shape, `${systemShortName(system)} limit raise, about 10-12 HCP with 3+ card support for ${strainName(partnerCall.strain)}.`, system)
	if (support >= 3 && hcp >= 6) return robotDecision({ type: 'bid', level: Math.min(2, partnerCall.level + 1), strain: partnerCall.strain }, hand, hcp, shape, `${systemShortName(system)} simple raise, 6-9 HCP with 3+ card support for ${strainName(partnerCall.strain)}.`, system)

	const newSuit = preferredResponseSuit(shape, partnerCall.strain)
	if (system === 'two-over-one' && !opponentCall && partnerCall.level === 1 && isMajor(partnerCall.strain) && hcp >= 6 && hcp <= 12 && isBalancedShape(shape)) {
		return robotDecision({ type: 'bid', level: 1, strain: 'NT' }, hand, hcp, shape, '2/1 forcing 1NT response to a one-major opening: about 6-12 HCP, denies a clear raise or game-forcing two-over-one.', system)
	}
	if (newSuit && hcp >= 6) {
		const level = suggestedResponseLevel(partnerCall, newSuit, opponentCall)
		const call = { type: 'bid', level, strain: newSuit }
		const twoOverOne = partnerCall.level === 1 && level === 2 && !opponentCall
		return robotDecision(call, hand, hcp, shape, newSuitMeaning(newSuit, hcp, twoOverOne, system), system)
	}
	if (isBalancedShape(shape)) {
		if (hcp >= 13) return robotDecision({ type: 'bid', level: 3, strain: 'NT' }, hand, hcp, shape, `${systemShortName(system)} balanced game force, 13+ HCP.`, system)
		if (hcp >= 10) return robotDecision({ type: 'bid', level: 2, strain: 'NT' }, hand, hcp, shape, `${systemShortName(system)} balanced invitational response, about 10-12 HCP.`, system)
		if (hcp >= 6) return robotDecision({ type: 'bid', level: 1, strain: 'NT' }, hand, hcp, shape, oneNotrumpResponseMeaning(partnerCall, system), system)
	}
	return naturalConstructivePass(hand, hcp, shape, 'Insufficient support, no 4+ new suit, and not enough balanced values.', system)
}

function naturalConstructivePass(hand, hcp, shape, reason, system = 'natural') {
	return robotDecision({ type: 'pass' }, hand, hcp, shape, reason, system)
}

function robotDecision(call, hand, hcp, shape, reason, system = 'natural') {
	return {
		call,
		explanation: `${biddingSystemLabel(system)}: ${reason} Actual hand: ${hcp} HCP, ${shapeText(shape)}.`
	}
}

function blackwoodRobotResponse(hand, hcp, shape, system = 'natural') {
	const aces = handAceCount(hand)
	const call = blackwoodResponseCall(aces)
	return robotDecision(call, hand, hcp, shape, `Blackwood response to partner's 4NT: ${aces} ace${aces === 1 ? '' : 's'}, so ${formatCall(call)} shows ${blackwoodResponseMeaning(call)}.`, system)
}

function blackwoodCallExplanation(state, call) {
	if (call.type !== 'bid') return undefined
	if (call.level === 4 && call.strain === 'NT') return 'Blackwood 4NT: asks partner for aces.'
	const meaning = blackwoodResponseMeaning(call)
	if (!meaning) return undefined
	const lastBid = lastBidEntry(state.auction)
	if (!lastBid || lastBid.call.type !== 'bid' || lastBid.call.level !== 4 || lastBid.call.strain !== 'NT') return undefined
	if (partnership(lastBid.seat) !== partnership(state.currentTurn)) return undefined
	const aces = handAceCount(state.hands[state.currentTurn])
	return `Blackwood response ${formatCall(call)}: shows ${meaning}. Actual hand has ${aces} ace${aces === 1 ? '' : 's'}.`
}

function blackwoodResponseCall(aces) {
	if (aces === 0 || aces === 3) return { type: 'bid', level: 5, strain: 'D' }
	if (aces === 2) return { type: 'bid', level: 5, strain: 'H' }
	return { type: 'bid', level: 5, strain: 'C' }
}

function blackwoodResponseMeaning(call) {
	if (sameCall(call, { type: 'bid', level: 5, strain: 'C' })) return '4 or 1 aces'
	if (sameCall(call, { type: 'bid', level: 5, strain: 'D' })) return '3 or 0 aces'
	if (sameCall(call, { type: 'bid', level: 5, strain: 'H' })) return '2 aces'
	return undefined
}

function robotFallbackCallExplanation(state, call, system = 'natural') {
	const hand = state.hands[state.currentTurn]
	const hcp = handHcp(hand)
	const shape = handShape(hand)
	return `${biddingSystemLabel(system)}: fallback legal ${formatCall(call)}. Actual hand: ${hcp} HCP, ${shapeText(shape)}.`
}

const blueClubOneSpadeResponses = [
	{ call: { type: 'pass' }, meaning: 'Up to 7 HCP, no attractive alternative' },
	{ call: { type: 'bid', level: 1, strain: 'NT' }, meaning: '7-10 HCP, non-forcing; denies a biddable hearts suit' },
	{ call: { type: 'bid', level: 1, strain: 'H' }, meaning: '6-11 HCP, 5+ hearts, forcing one round' },
	{ call: { type: 'bid', level: 2, strain: 'C' }, meaning: '11+ HCP, natural/forcing; may be 4+ clubs' },
	{ call: { type: 'bid', level: 2, strain: 'D' }, meaning: '11+ HCP, natural/forcing; may be 4+ diamonds' },
	{ call: { type: 'bid', level: 2, strain: 'H' }, meaning: 'Natural, 5+ hearts; normally 10-bad 12 if single-suited' },
	{ call: { type: 'bid', level: 2, strain: 'S' }, meaning: '6-10 HCP, 4+ spades, simple raise' },
	{ call: { type: 'bid', level: 2, strain: 'NT' }, meaning: '11-12 HCP, non-forcing; dead centre' },
	{ call: { type: 'bid', level: 3, strain: 'C' }, meaning: '12+ HCP, semi-solid 6+ clubs, immediate jump-shift; game-forcing' },
	{ call: { type: 'bid', level: 3, strain: 'D' }, meaning: '12+ HCP, semi-solid 6+ diamonds, immediate jump-shift; game-forcing' },
	{ call: { type: 'bid', level: 3, strain: 'H' }, meaning: '12+ HCP, semi-solid 6+ hearts, immediate jump-shift; game-forcing' },
	{ call: { type: 'bid', level: 3, strain: 'S' }, meaning: 'Good 9-bad 12 HCP, 4+ spades, non-forcing double raise' },
	{ call: { type: 'bid', level: 4, strain: 'S' }, meaning: '5-8 HCP, 5+ spades + singleton/void, preemptive' }
]

const blueClubOneSpadeOpenerContinuations = new Map([
	['1NT', [
		[{ type: 'bid', level: 1, strain: 'NT' }, 'Lower Range, balanced/semi-balanced'],
		[{ type: 'bid', level: 2, strain: 'C' }, '11-14, Simple Canape: spades + clubs; normally clubs >= spades'],
		[{ type: 'bid', level: 2, strain: 'D' }, '11-14, Simple Canape: spades + diamonds; normally diamonds >= spades'],
		[{ type: 'bid', level: 2, strain: 'H' }, '11-14, Simple Canape: spades + hearts; normally hearts >= spades, subject to the major-suit exceptions'],
		[{ type: 'bid', level: 2, strain: 'S' }, '11-14, generally 5+ spades'],
		[{ type: 'bid', level: 2, strain: 'NT' }, '15-16, strong single-suiter; normally good 6+ spades'],
		[{ type: 'bid', level: 3, strain: 'C' }, '15-16, Jump Canape/strong 6+ clubs, with spades as first suit'],
		[{ type: 'bid', level: 3, strain: 'D' }, '15-16, Jump Canape/strong 6+ diamonds, with spades as first suit'],
		[{ type: 'bid', level: 3, strain: 'H' }, '15-16, Jump Canape/strong 6+ hearts, with spades as first suit'],
		[{ type: 'bid', level: 3, strain: 'S' }, '15-16, strong 6+ spades single-suiter']
	]],
	['1H', [
		[{ type: 'bid', level: 1, strain: 'NT' }, 'Lower Range, balanced/semi-balanced'],
		[{ type: 'bid', level: 2, strain: 'C' }, '11-14, Simple Canape: spades + clubs'],
		[{ type: 'bid', level: 2, strain: 'D' }, '11-14, Simple Canape: spades + diamonds'],
		[{ type: 'bid', level: 2, strain: 'H' }, 'Minimum/major-fit continuation; exact meaning depends on the 5-5/major configuration'],
		[{ type: 'bid', level: 2, strain: 'S' }, 'Minimum, generally 5+ spades'],
		[{ type: 'bid', level: 2, strain: 'NT' }, '15-16, balanced/strong NT-type'],
		[{ type: 'bid', level: 3, strain: 'C' }, '15-16, strong 6+ clubs / Jump Canape'],
		[{ type: 'bid', level: 3, strain: 'D' }, '15-16, strong 6+ diamonds / Jump Canape'],
		[{ type: 'bid', level: 3, strain: 'H' }, '15-16, strong 6+ hearts / Jump Canape'],
		[{ type: 'bid', level: 3, strain: 'S' }, '15-16, strong 6+ spades single-suiter']
	]],
	['2C', [
		[{ type: 'bid', level: 2, strain: 'D' }, 'Lower Range, Simple Canape: spades + diamonds'],
		[{ type: 'bid', level: 2, strain: 'H' }, '15-16 reverse, spades + 5+ hearts, strong second suit'],
		[{ type: 'bid', level: 2, strain: 'S' }, 'Minimum, generally 5+ spades'],
		[{ type: 'bid', level: 2, strain: 'NT' }, 'Minimum balanced/semi-balanced'],
		[{ type: 'bid', level: 3, strain: 'C' }, 'Strong clubs continuation; exact shape-dependent'],
		[{ type: 'bid', level: 3, strain: 'D' }, '15-16, strong diamonds continuation'],
		[{ type: 'bid', level: 3, strain: 'H' }, '15-16, strong 5+/6+ hearts second suit'],
		[{ type: 'bid', level: 3, strain: 'S' }, '15-16, strong 6+ spades single-suiter']
	]],
	['2D', [
		[{ type: 'bid', level: 2, strain: 'H' }, '15-16 reverse, spades + 5+ hearts'],
		[{ type: 'bid', level: 2, strain: 'S' }, 'Minimum, generally 5+ spades'],
		[{ type: 'bid', level: 2, strain: 'NT' }, 'Minimum balanced/semi-balanced'],
		[{ type: 'bid', level: 3, strain: 'C' }, 'Forcing Canape, spades + clubs'],
		[{ type: 'bid', level: 3, strain: 'D' }, 'Minimum/diamonds continuation'],
		[{ type: 'bid', level: 3, strain: 'H' }, '15-16, strong 5+/6+ hearts'],
		[{ type: 'bid', level: 3, strain: 'S' }, '15-16, strong 6+ spades single-suiter']
	]],
	['2H', [
		[{ type: 'bid', level: 2, strain: 'S' }, 'Minimum/5+ spades continuation'],
		[{ type: 'bid', level: 2, strain: 'NT' }, 'Minimum balanced/semi-balanced'],
		[{ type: 'bid', level: 3, strain: 'C' }, 'Forcing continuation / Canape'],
		[{ type: 'bid', level: 3, strain: 'D' }, 'Forcing continuation / Canape'],
		[{ type: 'bid', level: 3, strain: 'H' }, 'Stronger hearts continuation']
	]],
	['2S', [
		[{ type: 'pass' }, 'Minimum opener; 2 spades is a 6-10 HCP simple raise and non-forcing'],
		[{ type: 'bid', level: 2, strain: 'NT' }, 'Natural minimum/shape description when appropriate'],
		[{ type: 'bid', level: 3, strain: 'C' }, 'Natural Canape/rebid showing the second suit; Upper Range (15-16) if it is a jump/reverse according to the Canape rules'],
		[{ type: 'bid', level: 3, strain: 'D' }, 'Natural Canape/rebid showing the second suit; Upper Range (15-16) if it is a jump/reverse according to the Canape rules'],
		[{ type: 'bid', level: 3, strain: 'H' }, 'Natural Canape/rebid showing the second suit; Upper Range (15-16) if it is a jump/reverse according to the Canape rules'],
		[{ type: 'bid', level: 4, strain: 'S' }, 'With a suitable hand, game; responder 2 spades itself is not forcing']
	]],
	['2NT', [
		[{ type: 'bid', level: 3, strain: 'C' }, 'Singleton/void, 11-14; suit immediately below the short suit'],
		[{ type: 'bid', level: 3, strain: 'D' }, 'Singleton/void, 11-14; suit immediately below the short suit'],
		[{ type: 'bid', level: 3, strain: 'H' }, 'Singleton/void, 11-14; suit immediately below the short suit'],
		[{ type: 'bid', level: 3, strain: 'S' }, '6+ spades, 14-16'],
		[{ type: 'bid', level: 3, strain: 'NT' }, '5-3-3-2, 14-16'],
		[{ type: 'bid', level: 4, strain: 'C' }, '5+ cards in the suit bid, 15-16 Upper Range two-suiter'],
		[{ type: 'bid', level: 4, strain: 'D' }, '5+ cards in the suit bid, 15-16 Upper Range two-suiter'],
		[{ type: 'bid', level: 4, strain: 'H' }, '5+ cards in the suit bid, 15-16 Upper Range two-suiter'],
		[{ type: 'bid', level: 4, strain: 'S' }, 'Weak/minimum 1 spade opening']
	]],
	['3C', [
		[{ type: 'bid', level: 3, strain: 'S' }, 'Opener raises with Qx, xxx or better; establishes clubs/spades for further cue-bidding'],
		[{ type: 'bid', level: 3, strain: 'D' }, 'Descriptive continuation when opener cannot/does not raise; the auction remains game-forcing'],
		[{ type: 'bid', level: 3, strain: 'H' }, 'Descriptive continuation when opener cannot/does not raise; the auction remains game-forcing'],
		[{ type: 'bid', level: 3, strain: 'NT' }, 'Descriptive continuation when opener cannot/does not raise; the auction remains game-forcing']
	]],
	['3D', [
		[{ type: 'bid', level: 3, strain: 'S' }, 'Same principle: raise with adequate support; establishes the major'],
		[{ type: 'bid', level: 3, strain: 'H' }, 'Descriptive/cue continuation as appropriate'],
		[{ type: 'bid', level: 3, strain: 'NT' }, 'Descriptive/cue continuation as appropriate'],
		[{ type: 'bid', level: 4, strain: 'D' }, 'Descriptive/cue continuation as appropriate']
	]],
	['3H', [
		[{ type: 'bid', level: 3, strain: 'S' }, 'Raise with adequate support; establishes the major'],
		[{ type: 'bid', level: 4, strain: 'H' }, 'Depending on fit and controls'],
		[{ type: 'bid', level: 4, strain: 'S' }, 'Depending on fit and controls']
	]],
	['3S', [
		[{ type: 'bid', level: 4, strain: 'S' }, 'Game with a suitable minimum/normal hand'],
		[{ type: 'bid', level: 4, strain: 'C' }, 'Cue-bid/slam try with suitable controls'],
		[{ type: 'bid', level: 4, strain: 'D' }, 'Cue-bid/slam try with suitable controls'],
		[{ type: 'bid', level: 4, strain: 'H' }, 'Cue-bid/slam try with suitable controls']
	]]
])

const blueClubOneHeartResponses = [
	{ call: { type: 'pass' }, meaning: 'Up to 7 HCP, no attractive alternative' },
	{ call: { type: 'bid', level: 1, strain: 'S' }, meaning: '4+ spades, forcing one round; wide range; 1 heart does not deny 4 spades' },
	{ call: { type: 'bid', level: 1, strain: 'NT' }, meaning: '7-10 HCP, non-forcing; denies 4+ spades' },
	{ call: { type: 'bid', level: 2, strain: 'C' }, meaning: '11+ HCP, natural/forcing; may be 4+ clubs and may be preparation for a reverse' },
	{ call: { type: 'bid', level: 2, strain: 'D' }, meaning: '11+ HCP, natural/forcing; may be 4+ diamonds' },
	{ call: { type: 'bid', level: 2, strain: 'H' }, meaning: '6-10 HCP, 4+ hearts, simple raise' },
	{ call: { type: 'bid', level: 2, strain: 'S' }, meaning: '12+ HCP, semi-solid 6+ spades, immediate jump-shift; game-forcing' },
	{ call: { type: 'bid', level: 2, strain: 'NT' }, meaning: '11-12 HCP, non-forcing; dead centre' },
	{ call: { type: 'bid', level: 3, strain: 'C' }, meaning: '12+ HCP, semi-solid 6+ clubs, immediate jump-shift; game-forcing' },
	{ call: { type: 'bid', level: 3, strain: 'D' }, meaning: '12+ HCP, semi-solid 6+ diamonds, immediate jump-shift; game-forcing' },
	{ call: { type: 'bid', level: 3, strain: 'H' }, meaning: 'Good 9-bad 12 HCP, 4+ hearts, non-forcing double raise' },
	{ call: { type: 'bid', level: 3, strain: 'S' }, meaning: '10-11 HCP, semi-solid 6+ spades' },
	{ call: { type: 'bid', level: 4, strain: 'H' }, meaning: '5-8 HCP, 5+ hearts + singleton/void, preemptive' }
]

const blueClubOneHeartOpenerContinuations = new Map([
	['1S', conventionOptions([
		[[{ type: 'bid', level: 1, strain: 'NT' }], 'Lower Range, balanced/semi-balanced'],
		[[{ type: 'bid', level: 2, strain: 'C' }], '11-14, Simple Canape: hearts + clubs; normally clubs >= hearts'],
		[[{ type: 'bid', level: 2, strain: 'D' }], '11-14, Simple Canape: hearts + diamonds; normally diamonds >= hearts'],
		[[{ type: 'bid', level: 2, strain: 'H' }], '11-14, generally 5+ hearts / one-suiter'],
		[[{ type: 'bid', level: 2, strain: 'S' }], 'Upper/strong fit or SuperFit sequence, depending on the exact hand; see note below'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '15-16, balanced/5332-type hand when appropriate'],
		[[{ type: 'bid', level: 3, strain: 'C' }], '15-16, Jump Canape: 4+ hearts + 5+/6+ clubs, strong clubs suit'],
		[[{ type: 'bid', level: 3, strain: 'D' }], '15-16, Jump Canape: 4+ hearts + 5+/6+ diamonds, strong diamonds suit'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '15-16, strong 6+ hearts single-suiter'],
		[[{ type: 'bid', level: 3, strain: 'S' }], "Upper Range SuperFit: responder's 1 spade has found opener's strong second suit"]
	])],
	['1NT', conventionOptions([
		[[{ type: 'pass' }], '11-14, minimum balanced/semi-balanced'],
		[[{ type: 'bid', level: 2, strain: 'C' }], '11-14, fit-searching; Canape suspended after 1NT'],
		[[{ type: 'bid', level: 2, strain: 'D' }], '11-14, fit-searching; Canape suspended'],
		[[{ type: 'bid', level: 2, strain: 'H' }], '11-14, generally 5+ hearts'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '15-16, 5332/strong NT-type hand; in particular, a 5-card major with 15-16'],
		[[{ type: 'bid', level: 3, strain: 'C' }], '15-16, strong 6+ clubs hand / strong second suit'],
		[[{ type: 'bid', level: 3, strain: 'D' }], '15-16, strong 6+ diamonds hand / strong second suit'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '15-16, strong 6+ hearts single-suiter']
	])],
	['2C', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'D' }], 'Lower Range, Simple Canape; hearts + diamonds, normally diamonds >= hearts'],
		[[{ type: 'bid', level: 2, strain: 'H' }], 'Minimum, generally 5+ hearts'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], 'Minimum balanced/semi-balanced'],
		[[{ type: 'bid', level: 3, strain: 'C' }], 'Strong clubs continuation / jump Canape as appropriate'],
		[[{ type: 'bid', level: 3, strain: 'D' }], 'Upper Range/reverse-type hearts + diamonds'],
		[[{ type: 'bid', level: 3, strain: 'H' }], 'Stronger hearts hand; generally 6+ if jumping']
	])],
	['2D', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'H' }], 'Minimum, generally 5+ hearts'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], 'Minimum balanced/semi-balanced'],
		[[{ type: 'bid', level: 3, strain: 'C' }], 'Forcing Canape: hearts + clubs, normally clubs >= hearts'],
		[[{ type: 'bid', level: 3, strain: 'D' }], 'Minimum/diamonds continuation'],
		[[{ type: 'bid', level: 3, strain: 'H' }], 'Stronger hearts hand; generally 6+ if jumping']
	])],
	['2H', conventionOptions([
		[[{ type: 'pass' }], 'Minimum opener; 2 hearts is the simple 6-10 HCP raise'],
		[[{ type: 'bid', level: 3, strain: 'H' }], 'Competitive/invitational continuation with extra values'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], 'Natural/minimum description where appropriate'],
		[[{ type: 'bid', level: 2, strain: 'S' }, { type: 'bid', level: 3, strain: 'C' }, { type: 'bid', level: 3, strain: 'D' }], "Canape/reverse continuation according to opener's distribution"],
		[[{ type: 'bid', level: 3, strain: 'H' }, { type: 'bid', level: 4, strain: 'H' }], 'Stronger heart continuation']
	])],
	['2S', conventionOptions([
		[[{ type: 'bid', level: 3, strain: 'C' }, { type: 'bid', level: 3, strain: 'D' }], "Opener's normal descriptive continuation; this is a game-forcing sequence"],
		[[{ type: 'bid', level: 3, strain: 'H' }], 'Strong heart support / fit'],
		[[{ type: 'bid', level: 3, strain: 'S' }], 'Strong spade fit/SuperFit when appropriate'],
		[[{ type: 'bid', level: 4, strain: 'C' }, { type: 'bid', level: 4, strain: 'D' }], 'Special SuperFit treatment; see below']
	])],
	['2NT', conventionOptions([
		[[{ type: 'bid', level: 3, strain: 'C' }, { type: 'bid', level: 3, strain: 'D' }, { type: 'bid', level: 3, strain: 'S' }], 'Singleton/void; suit below shortness'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '6+ hearts, 14-16'],
		[[{ type: 'bid', level: 3, strain: 'NT' }], '5-3-3-2, 14-16'],
		[[{ type: 'bid', level: 4, strain: 'C' }, { type: 'bid', level: 4, strain: 'D' }, { type: 'bid', level: 4, strain: 'S' }], '5+ cards in suit bid, 15-16 Upper Range'],
		[[{ type: 'bid', level: 4, strain: 'H' }], 'Weak/minimum opening']
	])],
	['3C', conventionOptions([
		[[{ type: 'bid', level: 3, strain: 'H' }], 'Raise with Qx, xxx or better; establishes hearts for cue-bidding'],
		[[{ type: 'bid', level: 3, strain: 'D' }, { type: 'bid', level: 3, strain: 'S' }, { type: 'bid', level: 3, strain: 'NT' }], 'Descriptive continuation; game-forcing']
	])],
	['3D', conventionOptions([
		[[{ type: 'bid', level: 3, strain: 'H' }], 'Raise with adequate heart support'],
		[[{ type: 'bid', level: 3, strain: 'S' }, { type: 'bid', level: 3, strain: 'NT' }, { type: 'bid', level: 4, strain: 'D' }], 'Descriptive/cue continuation']
	])],
	['3H', conventionOptions([
		[[{ type: 'pass' }], 'Minimum 1 heart opening; declines invitation'],
		[[{ type: 'bid', level: 4, strain: 'H' }], 'Accepts the invitation; enough values/distribution for game'],
		[[{ type: 'bid', level: 3, strain: 'NT' }], 'Exceptional/descriptive choice with a suitable balanced hand and no heart-game preference']
	])],
	['3S', conventionOptions([
		[[{ type: 'pass' }], 'if no useful fit/extra values'],
		[[{ type: 'bid', level: 3, strain: 'NT' }], 'A suitable balanced hand and wants to play NT'],
		[[{ type: 'bid', level: 4, strain: 'S' }], 'Good 3+ spades support and wants to play the spade game'],
		[[{ type: 'bid', level: 4, strain: 'H' }], 'Strong heart preference/extra heart length'],
		[[{ type: 'bid', level: 4, strain: 'C' }, { type: 'bid', level: 4, strain: 'D' }], 'if appropriate as a control/fit-showing continuation']
	])]
])

const blueClubOneDiamondResponses = [
	{ call: { type: 'pass' }, meaning: 'Usually 0-7 HCP, no good support or biddable suit' },
	{ call: { type: 'bid', level: 1, strain: 'H' }, meaning: '6-11 HCP, 5+ hearts, forcing one round' },
	{ call: { type: 'bid', level: 1, strain: 'S' }, meaning: '6-11 HCP, 5+ spades, forcing one round' },
	{ call: { type: 'bid', level: 1, strain: 'NT' }, meaning: '7-10 HCP, non-forcing; may contain one or two 4-card majors' },
	{ call: { type: 'bid', level: 2, strain: 'C' }, meaning: '11+ HCP, natural, forcing to at least 2NT' },
	{ call: { type: 'bid', level: 2, strain: 'D' }, meaning: '12+ HCP, 5+ diamonds; Inverted Minor, forcing to 3NT or 4 diamonds' },
	{ call: { type: 'bid', level: 2, strain: 'H' }, meaning: '11+ HCP, 5+ hearts, natural; may be start of reverse' },
	{ call: { type: 'bid', level: 2, strain: 'S' }, meaning: '11+ HCP, 5+ spades, natural; may be start of reverse' },
	{ call: { type: 'bid', level: 2, strain: 'NT' }, meaning: '11-12 HCP, non-forcing; dead centre' },
	{ call: { type: 'bid', level: 3, strain: 'C' }, meaning: 'Immediate jump-shift: semi-solid 6+ clubs, <=12 HCP; game-forcing' },
	{ call: { type: 'bid', level: 3, strain: 'D' }, meaning: 'Preemptive raise: 5+ diamonds, <9 HCP' },
	{ call: { type: 'bid', level: 3, strain: 'H' }, meaning: 'Immediate jump-shift: semi-solid 6+ hearts, <=12 HCP; game-forcing' },
	{ call: { type: 'bid', level: 3, strain: 'S' }, meaning: 'Immediate jump-shift: semi-solid 6+ spades, <=12 HCP; game-forcing' },
	{ call: { type: 'bid', level: 3, strain: 'NT' }, meaning: '13-15 HCP, balanced 4-3-3-3, weak in controls, no 4+ clubs' },
	{ call: { type: 'bid', level: 4, strain: 'D' }, meaning: 'Preemptive raise: 5+ diamonds, 5-8 HCP, singleton/void' }
]

const blueClubOneDiamondOpenerContinuations = new Map([
	['1H', conventionOptions([
		[[{ type: 'bid', level: 1, strain: 'NT' }], '12-14, balanced/semi-balanced'],
		[[{ type: 'bid', level: 2, strain: 'C' }], '11-14, diamonds + clubs, canape tendency; clubs normally >= diamonds'],
		[[{ type: 'bid', level: 2, strain: 'D' }], '11-14, 5+ diamonds, minimum one-suiter'],
		[[{ type: 'bid', level: 2, strain: 'H' }], '11-14, 4+ diamonds + 5+ hearts, lower-range canape/rebid; exact shape depends on auction'],
		[[{ type: 'bid', level: 2, strain: 'S' }], '15-16 reverse/strong two-suiter, 4+ diamonds + 5+ spades'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '15-16, strong balanced/NT type'],
		[[{ type: 'bid', level: 3, strain: 'C' }], '15-16, strong canape / 6+ clubs, with diamonds as first suit'],
		[[{ type: 'bid', level: 3, strain: 'D' }], '15-16, strong 6+ diamonds single-suiter'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '15-16, strong 6+ hearts Jump Canape, normally 4+ diamonds']
	])],
	['1S', conventionOptions([
		[[{ type: 'bid', level: 1, strain: 'NT' }], '12-14, balanced/semi-balanced'],
		[[{ type: 'bid', level: 2, strain: 'C' }], '11-14, diamonds + clubs, canape tendency'],
		[[{ type: 'bid', level: 2, strain: 'D' }], '11-14, 5+ diamonds, minimum one-suiter'],
		[[{ type: 'bid', level: 2, strain: 'H' }], '15-16 reverse, diamonds + 5+ hearts'],
		[[{ type: 'bid', level: 2, strain: 'S' }], '11-14, 5+ diamonds / minimum continuation, depending on fit'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '15-16, strong balanced/NT type'],
		[[{ type: 'bid', level: 3, strain: 'C' }], '15-16, strong 6+ clubs / Jump Canape type'],
		[[{ type: 'bid', level: 3, strain: 'D' }], '15-16, strong 6+ diamonds single-suiter'],
		[[{ type: 'bid', level: 3, strain: 'S' }], '15-16, strong 6+ spades Jump Canape, normally 4+ diamonds']
	])],
	['1NT', conventionOptions([
		[[{ type: 'pass' }], '11-14, minimum balanced/semi-balanced'],
		[[{ type: 'bid', level: 2, strain: 'C' }], '11-14, fit-searching diamonds + clubs; canape suspended'],
		[[{ type: 'bid', level: 2, strain: 'D' }], '11-14, 5+ diamonds; may be one-suited'],
		[[{ type: 'bid', level: 2, strain: 'H' }], '11-14, fit-searching; hearts may be 4+'],
		[[{ type: 'bid', level: 2, strain: 'S' }], '11-14, fit-searching; spades may be 4+'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '15-16, 5332/strong NT-type hand'],
		[[{ type: 'bid', level: 3, strain: 'C' }], '15-16, strong 6+ clubs hand / Jump Canape type'],
		[[{ type: 'bid', level: 3, strain: 'D' }], '15-16, strong 6+ diamonds hand'],
		[[{ type: 'bid', level: 3, strain: 'H' }, { type: 'bid', level: 3, strain: 'S' }], '15-16, strong Jump Canape / strong major suit']
	])],
	['2C', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'D' }], 'Minimum, 3+ diamonds; simple rebid does not necessarily promise a bare minimum'],
		[[{ type: 'bid', level: 2, strain: 'H' }], 'Canape/reverse continuation; 15-16 if a reverse'],
		[[{ type: 'bid', level: 2, strain: 'S' }], 'Canape/reverse continuation; 15-16 if a reverse'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '12-14, minimum balanced/semi-balanced'],
		[[{ type: 'bid', level: 3, strain: 'C' }], 'Strong clubs continuation / support depending on shape'],
		[[{ type: 'bid', level: 3, strain: 'D' }], '15-16, strong 6+ diamonds suit'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '15-16, strong 5+/6+ hearts second suit']
	])],
	['2D', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'H' }], 'Heart stopper'],
		[[{ type: 'bid', level: 2, strain: 'S' }], 'Spade stopper, denies heart stopper'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '15-16, 6+ diamonds, Upper Range'],
		[[{ type: 'bid', level: 3, strain: 'C' }], '11-14, only 3 diamonds + 5+ clubs'],
		[[{ type: 'bid', level: 3, strain: 'D' }], '11-14, no major-suit stopper'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '15-16, 5+ hearts'],
		[[{ type: 'bid', level: 3, strain: 'S' }], '15-16, 5+ spades'],
		[[{ type: 'bid', level: 3, strain: 'NT' }], '15-16, 4+ clubs + 5+ diamonds']
	])],
	['2H', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'S' }], '15-16 reverse, 4+ diamonds + 5+ spades'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '12-14, minimum balanced/semi-balanced'],
		[[{ type: 'bid', level: 3, strain: 'C' }], 'Canape/forcing continuation'],
		[[{ type: 'bid', level: 3, strain: 'D' }], 'Minimum/fit continuation'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '15-16, strong 6+ hearts']
	])],
	['2S', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'NT' }], '12-14, minimum balanced/semi-balanced'],
		[[{ type: 'bid', level: 3, strain: 'C' }], 'Canape/forcing continuation'],
		[[{ type: 'bid', level: 3, strain: 'D' }], 'Minimum/fit continuation'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '15-16 reverse/strong hearts'],
		[[{ type: 'bid', level: 3, strain: 'S' }], '15-16, strong 6+ spades']
	])],
	['2NT', conventionOptions([
		[[{ type: 'pass' }], 'Minimum/flat hand'],
		[[{ type: 'bid', level: 3, strain: 'C' }, { type: 'bid', level: 3, strain: 'D' }, { type: 'bid', level: 3, strain: 'H' }, { type: 'bid', level: 3, strain: 'S' }], 'Shape/fit-dependent; 2NT leaves opener responsible for further description']
	])],
	['3C', conventionOptions([
		[[{ type: 'bid', level: 3, strain: 'D' }], 'Minimum diamonds support/fit'],
		[[{ type: 'bid', level: 3, strain: 'NT' }], 'With suitable stoppers; otherwise describe shape']
	])]
])

const blueClubOneClubControlResponses = [
	{ call: { type: 'bid', level: 1, strain: 'D' }, meaning: '0 controls (No A or K) or 1 Control (just 1 K) (<=15 HCP) max HCP if having 4Q+4J=12 HCP' },
	{ call: { type: 'bid', level: 1, strain: 'H' }, meaning: '2 controls (1A or 2K) (4-18 HCP)' },
	{ call: { type: 'bid', level: 1, strain: 'S' }, meaning: '3 controls (1A+1K or 3K) (7-21 HCP)' },
	{ call: { type: 'bid', level: 1, strain: 'NT' }, meaning: '4 controls (2A or 1A+2K or 4K) (8-24 HCP)' },
	{ call: { type: 'bid', level: 2, strain: 'C' }, meaning: '5 controls (2A+1K/1A+3K) (>11 HCP)' },
	{ call: { type: 'bid', level: 2, strain: 'D' }, meaning: '6 controls (3A or 2A+2K) (>12 HCP)' },
	{ call: { type: 'bid', level: 2, strain: 'H' }, meaning: '7 controls (3A+1K or 2A+3K) (>15 HCP)' }
]

const blueClubOneClubOpenerAsks = [
	{ call: { type: 'bid', level: 2, strain: 'D' }, meaning: 'Ask for distribution slam territory' },
	{ call: { type: 'bid', level: 2, strain: 'H' }, meaning: 'Ask for points slam territory' },
	{ call: { type: 'bid', level: 3, strain: 'D' }, meaning: 'Ask for color with most HCP' },
	{ call: { type: 'bid', level: 3, strain: 'H' }, meaning: 'Ask for points' },
	{ call: { type: 'bid', level: 4, strain: 'NT' }, meaning: 'Ask for aces' },
	{ call: { type: 'pass' }, meaning: "Game decision: pass leaves partner's last bid as the contract" },
	{ call: { type: 'bid', level: 4, strain: 'H' }, meaning: 'Game decision' },
	{ call: { type: 'bid', level: 4, strain: 'S' }, meaning: 'Game decision' },
	{ call: { type: 'bid', level: 5, strain: 'C' }, meaning: 'Game decision' },
	{ call: { type: 'bid', level: 5, strain: 'D' }, meaning: 'Game decision' },
	{ call: { type: 'bid', level: 4, strain: 'C' }, meaning: 'Slam decision' }
]

const blueClubOneClubDistributionResponses = [
	{ call: { type: 'bid', level: 2, strain: 'H' }, meaning: 'XXX(0 / 1) distribution' },
	{ call: { type: 'bid', level: 2, strain: 'S' }, meaning: 'XXX2 distribution, doubleton' },
	{ call: { type: 'bid', level: 2, strain: 'NT' }, meaning: '4-3-3-3 distribution' }
]

const blueClubOneClubShortOrLongResponses = [
	{ call: { type: 'bid', level: 3, strain: 'C' }, meaning: 'Clubs' },
	{ call: { type: 'bid', level: 3, strain: 'D' }, meaning: 'Diamonds' },
	{ call: { type: 'bid', level: 3, strain: 'H' }, meaning: 'Hearts' },
	{ call: { type: 'bid', level: 3, strain: 'S' }, meaning: 'Spades' },
	{ call: { type: 'bid', level: 3, strain: 'NT' }, meaning: '2 assorted suits (clubs+hearts or diamonds+spades); not available for 4-3-3-3' },
	{ call: { type: 'bid', level: 4, strain: 'C' }, meaning: '2 majors (hearts+spades); not available for 4-3-3-3' },
	{ call: { type: 'bid', level: 4, strain: 'D' }, meaning: '2 minors (clubs+diamonds); not available for 4-3-3-3' }
]

const blueClubOneClubMostHcpResponses = [
	{ call: { type: 'bid', level: 3, strain: 'H' }, meaning: 'Clubs have the most HCP' },
	{ call: { type: 'bid', level: 3, strain: 'S' }, meaning: 'Diamonds have the most HCP' },
	{ call: { type: 'bid', level: 3, strain: 'NT' }, meaning: 'Hearts have the most HCP' },
	{ call: { type: 'bid', level: 4, strain: 'C' }, meaning: 'Spades have the most HCP' }
]

const blueClubOneClubAceResponses = [
	{ call: { type: 'bid', level: 5, strain: 'C' }, meaning: '4 or 1 aces' },
	{ call: { type: 'bid', level: 5, strain: 'D' }, meaning: '3 or 0 aces' },
	{ call: { type: 'bid', level: 5, strain: 'H' }, meaning: '2 aces' }
]

const blueClubOneClubHcpResponsesAfterThreeHearts = new Map([
	['1D', [
		[{ type: 'bid', level: 3, strain: 'S' }, '0-2 HCP'],
		[{ type: 'bid', level: 3, strain: 'NT' }, '3-4 HCP'],
		[{ type: 'bid', level: 4, strain: 'C' }, '5-7 HCP'],
		[{ type: 'bid', level: 4, strain: 'D' }, '8-9 HCP'],
		[{ type: 'bid', level: 4, strain: 'H' }, '10-12 HCP'],
		[{ type: 'bid', level: 4, strain: 'S' }, '14-15 HCP']
	]],
	['1H', [
		[{ type: 'bid', level: 3, strain: 'S' }, '4-5 HCP'],
		[{ type: 'bid', level: 3, strain: 'NT' }, '6-7 HCP'],
		[{ type: 'bid', level: 4, strain: 'C' }, '8-9 HCP'],
		[{ type: 'bid', level: 4, strain: 'D' }, '10-11 HCP'],
		[{ type: 'bid', level: 4, strain: 'H' }, '12-14 HCP'],
		[{ type: 'bid', level: 4, strain: 'S' }, '15-18 HCP']
	]],
	['1S', [
		[{ type: 'bid', level: 3, strain: 'S' }, '7-8 HCP'],
		[{ type: 'bid', level: 3, strain: 'NT' }, '9-10 HCP'],
		[{ type: 'bid', level: 4, strain: 'C' }, '11-12 HCP'],
		[{ type: 'bid', level: 4, strain: 'D' }, '13-14 HCP'],
		[{ type: 'bid', level: 4, strain: 'H' }, '15-16 HCP'],
		[{ type: 'bid', level: 4, strain: 'S' }, '17-21 HCP']
	]],
	['1NT', [
		[{ type: 'bid', level: 3, strain: 'S' }, '8-9 HCP'],
		[{ type: 'bid', level: 3, strain: 'NT' }, '10-11 HCP'],
		[{ type: 'bid', level: 4, strain: 'C' }, '12-13 HCP'],
		[{ type: 'bid', level: 4, strain: 'D' }, '15-16 HCP'],
		[{ type: 'bid', level: 4, strain: 'H' }, '16-17 HCP'],
		[{ type: 'bid', level: 4, strain: 'S' }, '18-24 HCP']
	]]
])

const blueClubOneClubHcpResponsesAfterTwoHearts = new Map([
	['1D', [
		[{ type: 'bid', level: 2, strain: 'S' }, '0-2 HCP'],
		[{ type: 'bid', level: 2, strain: 'NT' }, '3-4 HCP'],
		[{ type: 'bid', level: 3, strain: 'C' }, '5-7 HCP'],
		[{ type: 'bid', level: 3, strain: 'D' }, '8-9 HCP'],
		[{ type: 'bid', level: 3, strain: 'H' }, '10-12 HCP'],
		[{ type: 'bid', level: 3, strain: 'S' }, '14-15 HCP']
	]],
	['1H', [
		[{ type: 'bid', level: 2, strain: 'S' }, '4-5 HCP'],
		[{ type: 'bid', level: 2, strain: 'NT' }, '6-7 HCP'],
		[{ type: 'bid', level: 3, strain: 'C' }, '8-9 HCP'],
		[{ type: 'bid', level: 3, strain: 'D' }, '10-11 HCP'],
		[{ type: 'bid', level: 3, strain: 'H' }, '12-14 HCP'],
		[{ type: 'bid', level: 3, strain: 'S' }, '15-18 HCP']
	]],
	['1S', [
		[{ type: 'bid', level: 2, strain: 'S' }, '7-8 HCP'],
		[{ type: 'bid', level: 2, strain: 'NT' }, '9-10 HCP'],
		[{ type: 'bid', level: 3, strain: 'C' }, '11-12 HCP'],
		[{ type: 'bid', level: 3, strain: 'D' }, '13-14 HCP'],
		[{ type: 'bid', level: 3, strain: 'H' }, '15-16 HCP'],
		[{ type: 'bid', level: 3, strain: 'S' }, '17-21 HCP']
	]],
	['1NT', [
		[{ type: 'bid', level: 2, strain: 'S' }, '8-9 HCP'],
		[{ type: 'bid', level: 2, strain: 'NT' }, '10-11 HCP'],
		[{ type: 'bid', level: 3, strain: 'C' }, '12-13 HCP'],
		[{ type: 'bid', level: 3, strain: 'D' }, '15-16 HCP'],
		[{ type: 'bid', level: 3, strain: 'H' }, '16-17 HCP'],
		[{ type: 'bid', level: 3, strain: 'S' }, '18-24 HCP']
	]]
])

const blueClubOneNtResponses = [
	{ call: { type: 'bid', level: 2, strain: 'C' }, meaning: '>8 HCP relay' },
	{ call: { type: 'bid', level: 2, strain: 'D' }, meaning: 'Transfer to hearts, or 12+ HCP with a very uneven but helpful distribution' },
	{ call: { type: 'bid', level: 2, strain: 'H' }, meaning: 'Transfer to spades, <8 HCP' },
	{ call: { type: 'bid', level: 2, strain: 'S' }, meaning: 'Minor-oriented artificial bid, <8 HCP' },
	{ call: { type: 'bid', level: 2, strain: 'NT' }, meaning: 'Explore 3NT' },
	{ call: { type: 'bid', level: 3, strain: 'NT' }, meaning: 'Play; just play 3NT' }
]

const blueClubOneNtOpenerContinuations = new Map([
	['2C', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'D' }], '1 of clubs/diamonds minor in 4'],
		[[{ type: 'bid', level: 2, strain: 'H' }], '4 hearts, may also be spades'],
		[[{ type: 'bid', level: 2, strain: 'S' }], 'Bid spades if opener has 4 spades'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], '15+ HCP, best two suits are hearts and spades']
	])],
	['2D', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'H' }], 'Accepts the heart transfer: 13-15 HCP with 3+ hearts; otherwise opener bids naturally']
	])],
	['2H', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'S' }], 'Accepts the spade transfer; opener already knows partner has <8 HCP, then continues naturally if needed']
	])],
	['2NT', conventionOptions([
		[[{ type: 'pass' }], '13-14 HCP, declines the 3NT invitation'],
		[[{ type: 'bid', level: 3, strain: 'NT' }], '15-17 HCP, accepts the 3NT invitation']
	])],
	['3NT', conventionOptions([
		[[{ type: 'pass' }], 'Accepts 3NT as the final contract'],
		[[{ type: 'bid', level: 4, strain: 'C' }], 'Gerber: asks for aces, responses are 4/1, 3/0, 2']
	])]
])

const blueClubOneNtResponderContinuations = new Map([
	['2D', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'H' }], '5+ hearts, invitational, 9-11 HCP'],
		[[{ type: 'bid', level: 2, strain: 'S' }], '5+ spades, forcing/invitational, 9-11 HCP'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], 'Invitational balanced, 9-11 HCP'],
		[[{ type: 'bid', level: 3, strain: 'H' }], '5+ hearts, invitational, >11 HCP'],
		[[{ type: 'bid', level: 3, strain: 'S' }], '5+ spades, forcing/invitational, >11 HCP'],
		[[{ type: 'bid', level: 3, strain: 'NT' }], 'Invitational balanced, >11 HCP']
	])],
	['2H', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'S' }], 'Asks for spade fit after opener shows 4 hearts, may also have spades'],
		[[{ type: 'bid', level: 3, strain: 'C' }], '6+ clubs/diamonds, no support for opener major'],
		[[{ type: 'bid', level: 2, strain: 'NT' }], 'Invitational to 3NT'],
		[[{ type: 'bid', level: 3, strain: 'S' }], 'Heart fit, invitational to game/slam'],
		[[{ type: 'bid', level: 4, strain: 'S' }], 'Heart fit, stop in game']
	])],
	['2S', conventionOptions([
		[[{ type: 'bid', level: 2, strain: 'NT' }], 'Invitational to 3NT'],
		[[{ type: 'bid', level: 3, strain: 'S' }], 'Heart fit, invitational to game/slam'],
		[[{ type: 'bid', level: 4, strain: 'S' }], 'Heart fit, stop in game']
	])],
	['2NT', conventionOptions([
		[[{ type: 'bid', level: 3, strain: 'C' }], 'Weak 4-card spade holding, 4- HCP, may include A/K/Q/J/Q+J'],
		[[{ type: 'bid', level: 3, strain: 'D' }], 'Strong 4-card spade holding, 4+ HCP, minimum A+10']
	])]
])

const blueClubOneMajorProfiles = {
	D: {
		name: '1 diamond',
		opening: '11-16 HCP, 3+ diamonds',
		responses: blueClubOneDiamondResponses,
		continuations: blueClubOneDiamondOpenerContinuations
	},
	H: {
		name: '1 heart',
		opening: '11-16 HCP, 4+ hearts',
		responses: blueClubOneHeartResponses,
		continuations: blueClubOneHeartOpenerContinuations
	},
	S: {
		name: '1 spade',
		opening: '11-16 HCP, 4+ spades',
		responses: blueClubOneSpadeResponses,
		continuations: blueClubOneSpadeOpenerContinuations
	}
}

function blueClubHumanCallExplanation(state, call) {
	const oneNt = blueClubOneNtHumanCallExplanation(state, call)
	if (oneNt) return oneNt
	const oneClub = blueClubOneClubHumanCallExplanation(state, call)
	if (oneClub) return oneClub
	const openingProfile = call.type === 'bid' ? blueClubOneMajorProfiles[call.strain] : undefined
	if (!lastBidEntry(state.auction) && openingProfile && call.level === 1) {
		return `Modified Blue Club: ${openingProfile.name} opening: ${openingProfile.opening}.`
	}
	const path = blueClubOneMajorPath(state)
	if (!path) return undefined
	const profile = blueClubOneMajorProfiles[path.opener.call.strain]
	if (path.opener && partnership(state.currentTurn) === partnership(path.opener.seat) && state.currentTurn !== path.opener.seat) {
		const response = matchingConventionCall(state, call, profile.responses)
		if (response) return `Modified Blue Club: ${formatCall(call)} response to ${profile.name}: ${response.meaning}.`
	}
	if (path.opener && state.currentTurn === path.opener.seat && path.firstResponse?.call.type === 'bid') {
		const options = profile.continuations.get(callKey(path.firstResponse.call))
		const continuation = options ? matchingConventionCall(state, call, options.map(([optionCall, meaning]) => ({ call: optionCall, meaning }))) : undefined
		if (continuation) return `Modified Blue Club: ${formatCall(call)} opener continuation after partner ${formatCall(path.firstResponse.call)}: ${continuation.meaning}.`
	}
	return undefined
}

function blueClubOneNtHumanCallExplanation(state, call) {
	if (call.type === 'bid' && call.level === 1 && call.strain === 'NT' && !lastBidEntry(state.auction)) {
		return `Modified Blue Club: 1NT opening: ${blueClubOneNtOpeningRange(state)} HCP, always 4-3-3-3 distribution.`
	}
	const path = blueClubOneNtPath(state)
	if (!path) return undefined
	if (!path.firstResponse && partnership(state.currentTurn) === path.openerSide && state.currentTurn !== path.opener.seat) {
		const response = matchingConventionCall(state, call, blueClubOneNtResponses)
		if (response) return `Modified Blue Club: ${formatCall(call)} response to 1NT: ${response.meaning}.`
	}
	if (state.currentTurn === path.opener.seat && path.firstResponse?.call.type === 'bid') {
		const options = blueClubOneNtOpenerContinuations.get(callKey(path.firstResponse.call))
		const continuation = options ? matchingConventionCall(state, call, options.map(([optionCall, meaning]) => ({ call: optionCall, meaning }))) : undefined
		if (continuation) return `Modified Blue Club: ${formatCall(call)} opener continuation after partner ${formatCall(path.firstResponse.call)}: ${continuation.meaning}.`
	}
	if (partnership(state.currentTurn) === path.openerSide && state.currentTurn !== path.opener.seat) {
		const lastOpener = [...state.auction].reverse().find(entry => entry.seat === path.opener.seat)
		if (!lastOpener?.call || lastOpener.call.type !== 'bid') return undefined
		const options = blueClubOneNtResponderContinuations.get(callKey(lastOpener.call))
		const continuation = options ? matchingConventionCall(state, call, options.map(([optionCall, meaning]) => ({ call: optionCall, meaning }))) : undefined
		if (continuation) return `Modified Blue Club: ${formatCall(call)} responder continuation after opener ${formatCall(lastOpener.call)}: ${continuation.meaning}.`
	}
	return undefined
}

function blueClubOneNtOpeningRange(state) {
	const hand = state.hands[state.currentTurn]
	const shape = handShape(hand)
	const partnerPassed = partnerPassedBeforeCurrentCall(state)
	const majorBest = bestTwoSuitsAreMajors(shape)
	if (majorBest && partnerPassed) return '15-18'
	if (majorBest) return '13-17'
	if (partnerPassed) return '16-18'
	return '15-17'
}

function partnerPassedBeforeCurrentCall(state) {
	const side = partnership(state.currentTurn)
	return state.auction.some(entry => partnership(entry.seat) === side && entry.seat !== state.currentTurn && entry.call.type === 'pass')
}

function bestTwoSuitsAreMajors(shape) {
	return shape.H >= shape.C && shape.H >= shape.D && shape.S >= shape.C && shape.S >= shape.D
}

function blueClubOneNtPath(state) {
	const opener = state.auction.find(entry => entry.call.type === 'bid')
	if (!opener || opener.call.level !== 1 || opener.call.strain !== 'NT') return undefined
	const openerSide = partnership(opener.seat)
	const openerIndex = state.auction.indexOf(opener)
	const firstResponse = state.auction.slice(openerIndex + 1).find(entry => partnership(entry.seat) === openerSide && entry.seat !== opener.seat)
	return { opener, openerSide, firstResponse }
}

function blueClubOneClubHumanCallExplanation(state, call) {
	if (!lastBidEntry(state.auction) && sameCall(call, { type: 'bid', level: 1, strain: 'C' })) {
		return 'Modified Blue Club: 1 club opening: 17+ TP, asks for controls (A=2, K=1).'
	}
	const path = blueClubOneClubPath(state)
	if (!path) return undefined
	if (!path.firstResponse && partnership(state.currentTurn) === path.openerSide && state.currentTurn !== path.opener.seat) {
		const response = matchingConventionCall(state, call, blueClubOneClubControlResponses)
		if (response) return `Modified Blue Club: ${formatCall(call)} response to 1 club: ${response.meaning}.`
	}
	if (state.currentTurn === path.opener.seat) {
		const ask = matchingConventionCall(state, call, blueClubOneClubOpenerAsks)
		if (ask) return `Modified Blue Club: ${formatCall(call)} by opener: ${ask.meaning}.`
	}
	if (partnership(state.currentTurn) === path.openerSide && state.currentTurn !== path.opener.seat) {
		const lastOpener = [...state.auction].reverse().find(entry => entry.seat === path.opener.seat)
		if (!lastOpener) return undefined
		if (sameCall(lastOpener.call, { type: 'bid', level: 2, strain: 'D' })) {
			const distribution = matchingConventionCall(state, call, blueClubOneClubDistributionResponses)
			if (distribution) return `Modified Blue Club: ${formatCall(call)} distribution response: ${distribution.meaning}.`
		}
		if (sameCall(lastOpener.call, { type: 'bid', level: 2, strain: 'NT' })) {
			const short = matchingConventionCall(state, call, blueClubOneClubShortOrLongResponses)
			if (short) return `Modified Blue Club: ${formatCall(call)} short-color response: ${short.meaning}.`
		}
		if (sameCall(lastOpener.call, { type: 'bid', level: 3, strain: 'C' })) {
			const longest = matchingConventionCall(state, call, blueClubOneClubShortOrLongResponses)
			if (longest) return `Modified Blue Club: ${formatCall(call)} longest-color response: ${longest.meaning}.`
		}
		if (sameCall(lastOpener.call, { type: 'bid', level: 3, strain: 'D' })) {
			const mostHcp = matchingConventionCall(state, call, blueClubOneClubMostHcpResponses)
			if (mostHcp) return `Modified Blue Club: ${formatCall(call)} most-HCP-color response: ${mostHcp.meaning}.`
		}
		if (sameCall(lastOpener.call, { type: 'bid', level: 3, strain: 'H' })) {
			const points = blueClubOneClubHcpResponse(state, call, path.firstResponse, blueClubOneClubHcpResponsesAfterThreeHearts)
			if (points) return `Modified Blue Club: ${formatCall(call)} points response: ${points.meaning}.`
		}
		if (sameCall(lastOpener.call, { type: 'bid', level: 2, strain: 'H' })) {
			const points = blueClubOneClubHcpResponse(state, call, path.firstResponse, blueClubOneClubHcpResponsesAfterTwoHearts)
			if (points) return `Modified Blue Club: ${formatCall(call)} points response: ${points.meaning}.`
		}
		if (sameCall(lastOpener.call, { type: 'bid', level: 4, strain: 'NT' })) {
			const aces = matchingConventionCall(state, call, blueClubOneClubAceResponses)
			if (aces) return `Modified Blue Club: ${formatCall(call)} Blackwood response: ${aces.meaning}.`
		}
	}
	return undefined
}

function blueClubOneClubHcpResponse(state, call, firstResponse, table) {
	if (!firstResponse?.call || firstResponse.call.type !== 'bid') return undefined
	const options = table.get(callKey(firstResponse.call))
	return options ? matchingConventionCall(state, call, options.map(([optionCall, meaning]) => ({ call: optionCall, meaning }))) : undefined
}

function blueClubOneClubPath(state) {
	const opener = state.auction.find(entry => entry.call.type === 'bid')
	if (!opener || opener.call.level !== 1 || opener.call.strain !== 'C') return undefined
	const openerSide = partnership(opener.seat)
	const openerIndex = state.auction.indexOf(opener)
	const firstResponse = state.auction.slice(openerIndex + 1).find(entry => partnership(entry.seat) === openerSide && entry.seat !== opener.seat)
	return { opener, openerSide, firstResponse }
}

function conventionOptions(rows) {
	return rows.flatMap(([calls, meaning]) => calls.map(call => [call, meaning]))
}

function blueClubOneMajorPath(state) {
	const opener = state.auction.find(entry => entry.call.type === 'bid')
	if (!opener || opener.call.level !== 1 || !blueClubOneMajorProfiles[opener.call.strain]) return undefined
	const openerSide = partnership(opener.seat)
	const openerIndex = state.auction.indexOf(opener)
	const firstResponse = state.auction.slice(openerIndex + 1).find(entry => partnership(entry.seat) === openerSide && entry.seat !== opener.seat)
	const laterOpenerBid = firstResponse
		? state.auction.slice(openerIndex + 1).find(entry => entry !== firstResponse && partnership(entry.seat) === openerSide && entry.call.type === 'bid')
		: undefined
	if (laterOpenerBid) return undefined
	return { opener, firstResponse }
}

function matchingConventionCall(state, actualCall, options) {
	for (let index = 0; index < options.length; index++) {
		const option = options[index]
		if (sameCall(actualCall, option.call)) return option
		const levelCall = conventionLevelCall(state, index + 1)
		if (levelCall && sameCall(actualCall, levelCall)) {
			return { ...option, meaning: `${option.meaning} Lvl +${index + 1} after opponent interference.` }
		}
	}
	return undefined
}

function conventionLevelCall(state, step) {
	const last = state.auction.at(-1)
	if (!last || partnership(last.seat) === partnership(state.currentTurn) || last.call.type === 'pass') return undefined
	if (step === 1) return { type: 'pass' }
	if (last.call.type === 'double') return step === 2 ? { type: 'redouble' } : legalBidAtStep(state, step - 2)
	if (last.call.type === 'bid') return step === 2 ? { type: 'double' } : legalBidAtStep(state, step - 2)
	return legalBidAtStep(state, step - 1)
}

function legalBidAtStep(state, bidStep) {
	const bids = []
	for (let level = 1; level <= 7; level++) {
		for (const strain of ['C', 'D', 'H', 'S', 'NT']) {
			const bid = { type: 'bid', level, strain }
			if (isCallLegal(state, bid)) bids.push(bid)
		}
	}
	return bids[bidStep - 1]
}

function callKey(call) {
	return call.type === 'bid' ? `${call.level}${call.strain}` : call.type === 'double' ? 'X' : call.type === 'redouble' ? 'XX' : 'Pass'
}

function shapeText(shape) {
	return `shape S-${shape.S} H-${shape.H} D-${shape.D} C-${shape.C}`
}

function strainName(strain) {
	return strain === 'NT' ? 'notrump' : { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[strain] ?? String(strain)
}

function systemShortName(system) {
	if (system === 'sayc') return 'SAYC'
	if (system === 'two-over-one') return '2/1'
	if (system === 'blue-club-modified') return 'Natural'
	return 'Natural'
}

function openingSuitMeaning(strain, system) {
	if (system === 'sayc') {
		if (isMajor(strain)) return `SAYC one-${strainName(strain)} opening: 12+ HCP and usually 5+ ${strainName(strain)}.`
		return `SAYC better-minor opening: 12+ HCP, longest minor or better minor when balanced.`
	}
	if (system === 'two-over-one') {
		if (isMajor(strain)) return `2/1 one-${strainName(strain)} opening: 12+ HCP and 5+ ${strainName(strain)}.`
		return `2/1 minor opening: 12+ HCP, natural/better minor, may be shorter when balanced.`
	}
	return `12+ HCP opening in ${strainName(strain)}; normally longest suit, with 5+ majors preferred.`
}

function newSuitMeaning(strain, hcp, twoOverOne, system) {
	if (system === 'two-over-one' && twoOverOne) return `2/1 game-forcing response, 13+ HCP expected with 4+ ${strainName(strain)}.`
	if (system === 'sayc' && twoOverOne) return `SAYC two-over-one response, usually 10+ HCP and forcing one round with 4+ ${strainName(strain)}.`
	if (system === 'two-over-one') return `2/1 natural new-suit response, 6+ HCP with 4+ ${strainName(strain)}.`
	if (system === 'sayc') return `SAYC natural new-suit response, 6+ HCP with 4+ ${strainName(strain)}.`
	return `Natural new suit, 6+ HCP with 4+ ${strainName(strain)}.`
}

function oneNotrumpResponseMeaning(partnerCall, system) {
	if (system === 'two-over-one' && partnerCall.level === 1 && isMajor(partnerCall.strain)) return '2/1 forcing 1NT response to a one-major opening: about 6-12 HCP.'
	if (system === 'sayc' && partnerCall.level === 1 && isMajor(partnerCall.strain)) return 'SAYC 1NT response to a one-major opening: about 6-10 HCP, non-forcing.'
	return `${systemShortName(system)} balanced minimum response, about 6-9 HCP.`
}

function isMajor(strain) {
	return strain === 'H' || strain === 'S'
}

function naturalFallbackCalls(state, system = 'natural') {
	const calls = []
	const preferred = naturalRobotCall(state, system)
	if (preferred?.call?.type === 'bid') {
		for (const level of [preferred.call.level, preferred.call.level + 1, preferred.call.level + 2, preferred.call.level + 3, preferred.call.level + 4, preferred.call.level + 5, preferred.call.level + 6]) {
			if (level >= 1 && level <= 7) calls.push({ type: 'bid', level, strain: preferred.call.strain })
		}
	}
	calls.push({ type: 'pass' }, { type: 'double' }, { type: 'redouble' })
	for (const level of [1, 2, 3, 4, 5, 6, 7]) {
		for (const strain of ['C', 'D', 'H', 'S', 'NT']) calls.push({ type: 'bid', level, strain })
	}
	return calls
}

function lastBidEntry(auction) {
	return [...auction].reverse().find(entry => entry.call.type === 'bid')
}

function handHcp(hand) {
	const values = { A: 4, K: 3, Q: 2, J: 1 }
	return hand.reduce((total, card) => total + (values[card.rank] ?? 0), 0)
}

function handAceCount(hand) {
	return hand.filter(card => card.rank === 'A').length
}

function handShape(hand) {
	return {
		C: hand.filter(card => card.suit === 'C').length,
		D: hand.filter(card => card.suit === 'D').length,
		H: hand.filter(card => card.suit === 'H').length,
		S: hand.filter(card => card.suit === 'S').length
	}
}

function isBalancedShape(shape) {
	const lengths = Object.values(shape).sort((left, right) => right - left)
	return lengths[0] <= 5 && lengths[3] >= 2 && !(lengths[0] === 5 && lengths[1] === 4 && lengths[2] === 2 && lengths[3] === 2)
}

function preferredOpeningSuit(shape) {
	if (shape.S >= 5 || shape.H >= 5) return shape.S >= shape.H ? 'S' : 'H'
	const minors = shape.D >= shape.C ? 'D' : 'C'
	const best = ['S', 'H', 'D', 'C'].reduce((current, suit) => shape[suit] > shape[current] ? suit : current, minors)
	if (shape[best] >= 5) return best
	return minors
}

function preferredPreemptSuit(shape) {
	return ['S', 'H', 'D', 'C'].reduce((best, suit) => shape[suit] > shape[best] ? suit : best, 'S')
}

function preferredOvercallSuit(shape) {
	return ['S', 'H', 'D', 'C'].reduce((best, suit) => shape[suit] > shape[best] ? suit : best, 'S')
}

function preferredResponseSuit(shape, partnerStrain) {
	const candidates = ['S', 'H', 'D', 'C'].filter(suit => suit !== partnerStrain && shape[suit] >= 4)
	if (!candidates.length) return undefined
	return candidates.sort((left, right) => shape[right] - shape[left] || strainValue(right) - strainValue(left))[0]
}

function longerMajor(shape) {
	if (shape.S < 5 && shape.H < 5) return undefined
	return shape.S >= shape.H ? 'S' : 'H'
}

function suggestedResponseLevel(partnerCall, strain, opponentCall) {
	const targetLevel = Math.max(partnerCall.level, opponentCall?.level ?? 1)
	return strainValue(strain) > strainValue(partnerCall.strain) && targetLevel === partnerCall.level
		? targetLevel
		: Math.min(7, targetLevel + 1)
}

function strainValue(strain) {
	return { C: 0, D: 1, H: 2, S: 3, NT: 4 }[strain] ?? 0
}

function hasStopper(hand, strain) {
	if (strain === 'NT') return false
	const cards = hand.filter(card => card.suit === strain)
	const ranks = new Set(cards.map(card => card.rank))
	return ranks.has('A') || ranks.has('K') && cards.length >= 2 || ranks.has('Q') && cards.length >= 3
}

function takeoutShape(shape, strain) {
	if (strain === 'NT') return false
	return shape[strain] <= 2 && ['S', 'H', 'D', 'C'].filter(suit => suit !== strain && shape[suit] >= 3).length >= 3
}

async function robotCard(room, state) {
	const legalCards = state.hands[state.currentTurn].filter(card => isPlayLegal(state, card))
	if (!legalCards.length) return undefined
	const fourthHandWinner = robotFourthHandWinner(state, legalCards)
	if (fourthHandWinner) return { card: fourthHandWinner, source: 'tactical' }
	const ddsPlay = await robotDdsPlay(room, state, legalCards)
	return ddsPlay
		? { card: ddsPlay.card, source: 'dds', label: ddsPlay.label, explanation: ddsPlay.explanation, projectedDeclarerTricks: ddsPlay.projectedDeclarerTricks }
		: { card: robotFallbackCard(state, legalCards), source: 'fallback' }
}

function robotFourthHandWinner(state, legalCards) {
	const trick = state.currentTrick
	if (!trick || trick.plays.length !== 3) return undefined
	const currentWinner = currentTrickLeader(state, trick.plays)
	if (partnership(currentWinner.seat) === partnership(state.currentTurn)) return undefined
	const winners = legalCards.filter(card => wouldWinCurrentTrick(state, card))
	return winners.length ? cheapestWinningCard(state, winners) : undefined
}

async function robotDdsPlay(room, state, legalCards) {
	try {
		const analysis = await analyzeBoardWithDds(state, room.history.states[0].hands, room.history.states)
		const guidance = analysis.dds.playGuidance
		if (analysis.dds.status !== 'solved' || !guidance || guidance.seat !== state.currentTurn) return undefined
		const bestPlays = guidance.plays.filter(play => play.best && legalCards.some(card => sameCard(card, play.card)))
		const preferred = robotPreferredCard(state, bestPlays.map(play => play.card))
		const selected = bestPlays.find(play => sameCard(play.card, preferred)) ?? bestPlays[0]
		return selected
			? cheaperEquivalentDiscard(state, guidance.plays, selected, legalCards)
				?? lowerSameSuitDiscard(state, guidance.plays, selected, legalCards)
				?? lowerFollowSuitCard(state, guidance.plays, selected, legalCards)
				?? selected
			: undefined
	} catch {
		return undefined
	}
}

function cheaperEquivalentDiscard(state, plays, selected, legalCards) {
	const leadSuit = state.currentTrick?.plays[0]?.card.suit
	if (!leadSuit || selected.card.suit === leadSuit) return undefined
	const sameResult = plays.filter(play =>
		play.projectedDeclarerTricks === selected.projectedDeclarerTricks &&
		play.card.suit !== leadSuit &&
		legalCards.some(card => sameCard(card, play.card))
	)
	const preferred = cheapestDiscard(state, sameResult.map(play => play.card))
	if (!preferred || discardCost(preferred, state.contract?.strain === 'NT' ? undefined : state.contract?.strain) >= discardCost(selected.card, state.contract?.strain === 'NT' ? undefined : state.contract?.strain)) return undefined
	return sameResult.find(play => sameCard(play.card, preferred))
}

function lowerSameSuitDiscard(state, plays, selected, legalCards) {
	const leadSuit = state.currentTrick?.plays[0]?.card.suit
	if (!leadSuit || selected.card.suit === leadSuit || wouldWinCurrentTrick(state, selected.card)) return undefined
	if (!['A', 'K', 'Q', 'J'].includes(selected.card.rank)) return undefined
	const lowerCards = legalCards.filter(card =>
		card.suit === selected.card.suit &&
		rankValue(card.rank) < rankValue(selected.card.rank) &&
		!wouldWinCurrentTrick(state, card)
	)
	const preferred = cheapestDiscard(state, lowerCards)
	if (!preferred) return undefined
	const guided = plays.find(play => sameCard(play.card, preferred))
	return guided ?? {
		...selected,
		card: preferred,
		explanation: `${selected.explanation} Robot preserved the honor because a lower same-suit discard was available.`
	}
}

function lowerFollowSuitCard(state, plays, selected, legalCards) {
	const leadSuit = state.currentTrick?.plays[0]?.card.suit
	if (!leadSuit || selected.card.suit !== leadSuit || wouldWinCurrentTrick(state, selected.card)) return undefined
	if (!['A', 'K', 'Q', 'J'].includes(selected.card.rank)) return undefined
	const lowerCards = legalCards.filter(card =>
		card.suit === leadSuit &&
		rankValue(card.rank) < rankValue(selected.card.rank) &&
		!wouldWinCurrentTrick(state, card)
	)
	const preferred = lowestCard(lowerCards)
	if (!preferred) return undefined
	const guided = plays.find(play => sameCard(play.card, preferred))
	return guided ?? {
		...selected,
		card: preferred,
		explanation: `${selected.explanation} Robot played low while following suit because the honor could not win.`
	}
}

function robotFallbackCard(state, legalCards) {
	return robotPreferredCard(state, legalCards) ?? legalCards[0]
}

function robotPreferredCard(state, cards) {
	if (!cards.length) return undefined
	const trick = state.currentTrick
	if (!trick?.plays.length) return lowestCard(cards)
	const currentWinner = currentTrickLeader(state, trick.plays)
	const partnerWinning = currentWinner && partnership(currentWinner.seat) === partnership(state.currentTurn)
	const winners = cards.filter(card => wouldWinCurrentTrick(state, card))
	if (trick.plays.length === 3) {
		if (!partnerWinning && winners.length) return cheapestWinningCard(state, winners)
		return cheapestDiscard(state, cards)
	}
	if (!partnerWinning && winners.length) return cheapestWinningCard(state, winners)
	return cheapestDiscard(state, cards)
}

function wouldWinCurrentTrick(state, card) {
	const plays = [...state.currentTrick.plays, { seat: state.currentTurn, card }]
	return currentTrickLeader(state, plays).seat === state.currentTurn
}

function currentTrickLeader(state, plays = state.currentTrick?.plays ?? []) {
	const leadSuit = plays[0]?.card.suit
	const trump = state.contract?.strain === 'NT' ? undefined : state.contract?.strain
	return plays.reduce((winner, play) => cardBeats(play.card, winner.card, leadSuit, trump) ? play : winner)
}

function cardBeats(candidate, current, leadSuit, trump) {
	if (candidate.suit === current.suit) return rankValue(candidate.rank) > rankValue(current.rank)
	if (trump && candidate.suit === trump) return current.suit !== trump
	if (trump && current.suit === trump) return false
	return candidate.suit === leadSuit && current.suit !== leadSuit
}

function cheapestWinningCard(state, cards) {
	return [...cards].sort((left, right) => winningCardCost(state, left) - winningCardCost(state, right) || rankValue(left.rank) - rankValue(right.rank))[0]
}

function cheapestDiscard(state, cards) {
	const trump = state.contract?.strain === 'NT' ? undefined : state.contract?.strain
	return [...cards].sort((left, right) => discardCost(left, trump) - discardCost(right, trump) || rankValue(left.rank) - rankValue(right.rank))[0]
}

function lowestCard(cards) {
	return [...cards].sort((left, right) => rankValue(left.rank) - rankValue(right.rank) || suitSortValue(left.suit) - suitSortValue(right.suit))[0]
}

function winningCardCost(state, card) {
	const trump = state.contract?.strain === 'NT' ? undefined : state.contract?.strain
	return rankValue(card.rank) + (trump && card.suit === trump ? 0 : 20)
}

function discardCost(card, trump) {
	const honorCost = { A: 40, K: 28, Q: 18, J: 10 }[card.rank] ?? rankValue(card.rank)
	const trumpCost = trump && card.suit === trump ? 24 : 0
	return honorCost + trumpCost
}

function rankValue(rank) {
	return { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 }[rank] ?? 0
}

function suitSortValue(suit) {
	return { C: 0, D: 1, H: 2, S: 3 }[suit] ?? 0
}

function robotPlayMessage(seat, play) {
	if (play.source === 'tactical') return `${seat} robot won with ${formatCard(play.card)}.`
	if (play.source !== 'dds') return `${seat} robot played ${formatCard(play.card)}.`
	const detail = play.explanation ? ` ${play.explanation}` : ''
	const tricks = Number.isInteger(play.projectedDeclarerTricks) ? ` Declarer projection: ${play.projectedDeclarerTricks}.` : ''
	return `${seat} robot played DDS best card ${formatCard(play.card)}.${detail}${tricks}`
}

function sameCard(left, right) {
	return left.rank === right.rank && left.suit === right.suit
}

function sameCall(left, right) {
	if (!left || !right || left.type !== right.type) return false
	if (left.type === 'bid') return left.level === right.level && left.strain === right.strain
	return true
}

function requestUndo(room, side) {
	if (room.history.states.length <= 1) throw httpError(400, 'Nothing to undo')
	const requester = requirePartnership(side)
	const responder = otherSide(requester)
	const undoDescription = describeUndoAction(room)
	if (!hasConnectedSide(room, responder)) {
		return applyUndo(room, `${requester} undid ${undoDescription}.`)
	}
	room.pendingAgreement = {
		id: randomId(6),
		type: 'undo',
		requestingSide: requester,
		respondingSide: responder,
		createdAt: new Date().toISOString(),
		revision: room.revision,
		undoDescription
	}
	room.revision += 1
	addTableMessage(room, `${requester} requested Undo for ${undoDescription}. Waiting for ${responder}.`)
	return { advanceRobots: false }
}

function requestClaim(room, side, body) {
	const state = room.history.current
	if (state.phase !== 'play' || !state.contract) throw httpError(400, 'Claims are available only while playing a contract')
	const declarerSide = partnership(state.contract.declarer)
	if (rolePartnership(side) !== declarerSide) throw httpError(403, 'Only declarer side can claim')
	const claimTricks = Math.trunc(Number(body.claimTricks))
	const claimNote = sanitizeClaimNote(body.note)
	const currentDeclarerTricks = state.tricksWon[declarerSide]
	const playedCards = state.completedTricks.length * 4 + (state.currentTrick?.plays.length ?? 0)
	const remainingTricks = Math.ceil((52 - playedCards) / 4)
	const maxDeclarerTricks = Math.min(13, currentDeclarerTricks + remainingTricks)
	if (!Number.isInteger(claimTricks) || claimTricks < currentDeclarerTricks || claimTricks > 13) {
		throw httpError(400, `Claim must be between ${currentDeclarerTricks} and 13 declarer tricks`)
	}
	if (claimTricks > maxDeclarerTricks) throw httpError(400, `Claim cannot exceed ${maxDeclarerTricks} declarer tricks with the cards still to play`)
	const claimRemaining = claimTricks - currentDeclarerTricks
	const score = scoreContract(state.contract, claimTricks, state.vulnerability)
	const responder = otherSide(declarerSide)
	if (!hasConnectedSide(room, responder)) {
		completeBoardByClaim(room, declarerSide, claimTricks, claimMessage(declarerSide, claimTricks, claimRemaining, claimNote))
		return
	}
	room.pendingAgreement = {
		id: randomId(6),
		type: 'claim',
		requestingSide: declarerSide,
		respondingSide: responder,
		createdAt: new Date().toISOString(),
		revision: room.revision,
		claimTricks,
		claimRemaining,
		...(claimNote ? { claimNote } : {}),
		claimScore: { NS: score.ns, EW: score.ew }
	}
	room.revision += 1
	addTableMessage(room, `${claimMessage(declarerSide, claimTricks, claimRemaining, claimNote)} Waiting for ${responder}.`)
}

function respondToAgreement(room, side, body) {
	const request = room.pendingAgreement
	if (!request) throw httpError(400, 'No table request is waiting')
	if (body.requestId !== request.id) throw httpError(409, 'That table request is no longer current')
	if (body.accept !== true && body.accept !== false && body.cancel !== true) throw httpError(400, 'Choose Accept or Reject')
	const sidePartnership = requirePartnership(side)
	if (body.cancel === true) {
		if (sidePartnership !== request.requestingSide) throw httpError(403, 'Only the requesting side can cancel this request')
		room.pendingAgreement = undefined
		room.revision += 1
		addTableMessage(room, `${sidePartnership} cancelled the ${request.type} request.`)
		return
	}
	if (sidePartnership !== request.respondingSide) throw httpError(403, `${request.respondingSide} must answer this request`)
	room.pendingAgreement = undefined
	if (body.accept === false) {
		room.revision += 1
		addTableMessage(room, `${sidePartnership} rejected the ${request.type} request.`)
		return
	}
	if (request.type === 'undo') {
		return applyUndo(room, `${sidePartnership} accepted Undo for ${request.undoDescription ?? 'the last action'}.`)
	}
	completeBoardByClaim(room, request.requestingSide, request.claimTricks, `${sidePartnership} accepted the claim for ${request.claimTricks} trick${request.claimTricks === 1 ? '' : 's'}.`)
}

function applyUndo(room, message) {
	if (room.history.states.length <= 1) throw httpError(400, 'Nothing to undo')
	room.pendingAgreement = undefined
	room.history = room.history.undo()
	currentBoard(room).history = room.history
	room.revision += 1
	addTableMessage(room, message)
	return { advanceRobots: false }
}

function completeBoardByClaim(room, declarerSide, claimTricks, message) {
	const state = room.history.current
	const tricksWon = declarerSide === 'NS'
		? { NS: claimTricks, EW: 13 - claimTricks }
		: { NS: 13 - claimTricks, EW: claimTricks }
	const { currentTrick, ...withoutCurrentTrick } = state
	const completed = { ...withoutCurrentTrick, phase: 'complete', tricksWon, currentTurn: state.currentTurn, dummyVisible: true }
	room.pendingAgreement = undefined
	room.history = new BoardHistory(room.history.states[0], [...room.history.states, completed])
	currentBoard(room).history = room.history
	room.revision += 1
	addTableMessage(room, message)
}

function describeUndoAction(room) {
	const before = room.history.states.at(-2)
	const after = room.history.states.at(-1)
	if (!before || !after) return 'the last action'
	const lastCall = after.auction.length > before.auction.length ? after.auction.at(-1) : undefined
	if (lastCall) return `last call: ${lastCall.seat} ${formatCall(lastCall.call)}`
	const beforePlays = playCount(before)
	const afterPlays = playCount(after)
	if (afterPlays > beforePlays) {
		const play = after.currentTrick?.plays.at(-1) ?? after.completedTricks.at(-1)?.plays.at(-1)
		if (play) return `last card: ${play.seat} ${formatCard(play.card)}`
		return 'the last card'
	}
	return 'the last action'
}

function playCount(state) {
	return state.completedTricks.reduce((count, trick) => count + trick.plays.length, 0) + (state.currentTrick?.plays.length ?? 0)
}

function formatCall(call) {
	if (call.type === 'bid') return `${call.level}${call.strain}`
	if (call.type === 'double') return 'X'
	if (call.type === 'redouble') return 'XX'
	return 'Pass'
}

function formatCard(card) {
	return `${card.rank}${card.suit}`
}

function claimMessage(side, claimTricks, claimRemaining, note) {
	const base = `${side} claimed ${claimRemaining} remaining trick${claimRemaining === 1 ? '' : 's'} for ${claimTricks} total`
	return note ? `${base}: ${note}.` : `${base}.`
}

function viewFor(room, token) {
	const side = room.players.get(token)
	if (!side) throw httpError(401, 'Unknown session')
	expirePendingAgreement(room)
	return projectBoard(room.history.current, room.id, room.revision, room.currentBoardId, boardHistory(room), side, playersFor(room), room.history.states.length > 1, { savedAt: room.savedAt, restored: room.restored === true }, {
		label: room.label,
		archived: room.archived === true,
		biddingSystem: room.biddingSystem || 'natural',
		spectatorSeeAll: room.spectatorSeeAll === true,
		networkOrigin: publicOrigin()
	}, {
		connections: connectedPlayers(room),
		robots: { N: false, E: false, S: false, W: false, ...(room.robots ?? {}) },
		...(room.pendingAgreement ? { pendingAgreement: room.pendingAgreement } : {}),
		tableMessages: room.tableMessages
	})
}

function createBoardEntry(history, seed, source) {
	return { id: randomId(6), history, seed, source }
}

function currentBoard(room) {
	const board = room.boards.find(entry => entry.id === room.currentBoardId)
	if (!board) throw httpError(500, 'Current board is missing')
	return board
}

function setCurrentBoard(room, board) {
	room.boards.push(board)
	room.currentBoardId = board.id
	room.history = board.history
	room.boardNumber = board.history.current.boardNumber
	room.seed = board.seed
}

function boardHistory(room) {
	return room.boards.map(board => {
		const state = board.history.current
		return {
			id: board.id,
			boardNumber: state.boardNumber,
			vulnerability: state.vulnerability,
			phase: state.phase,
			...(state.contract ? { contract: state.contract } : {}),
			tricksWon: state.tricksWon,
			current: board.id === room.currentBoardId
		}
	})
}

function openEvents(room, token, res) {
	const client = { token, side: room.players.get(token), res }
	room.clients.add(client)
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no'
	})
	sendEvent(client, viewFor(room, token))
	broadcast(room)
	scheduleRobotAdvance(room)
	res.on('close', () => {
		room.clients.delete(client)
		broadcast(room)
	})
}

function broadcast(room) {
	for (const client of room.clients) sendEvent(client, viewFor(room, client.token))
}

function sendEvent(client, payload) {
	client.res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`)
}

function playersFor(room) {
	return {
		NS: hasRole(room, 'NS'),
		EW: hasRole(room, 'EW'),
		N: hasRole(room, 'N'),
		E: hasRole(room, 'E'),
		S: hasRole(room, 'S'),
		W: hasRole(room, 'W')
	}
}

function hasSide(room, side) {
	for (const claimed of room.players.values()) {
		if (rolePartnership(claimed) === side) return true
	}
	return false
}

function hasRole(room, role) {
	for (const claimed of room.players.values()) {
		if (claimed === role) return true
	}
	return false
}

function hasConnectedSide(room, side) {
	for (const client of room.clients) {
		if (rolePartnership(client.side) === side) return true
	}
	return false
}

function hasConnectedRole(room, role) {
	for (const client of room.clients) {
		if (client.side === role) return true
	}
	return false
}

function connectedPlayers(room) {
	return {
		NS: hasConnectedSide(room, 'NS'),
		EW: hasConnectedSide(room, 'EW'),
		N: hasConnectedRole(room, 'N'),
		E: hasConnectedRole(room, 'E'),
		S: hasConnectedRole(room, 'S'),
		W: hasConnectedRole(room, 'W'),
		spectators: [...room.clients].filter(client => client.side === 'SPECTATOR').length
	}
}

function otherSide(side) {
	return side === 'NS' ? 'EW' : 'NS'
}

function rolePartnership(role) {
	if (role === 'NS' || role === 'EW') return role
	if (role === 'N' || role === 'S') return 'NS'
	if (role === 'E' || role === 'W') return 'EW'
	return undefined
}

function requirePartnership(role) {
	const side = rolePartnership(role)
	if (!side) throw httpError(403, 'Spectators can watch but cannot change the room')
	return side
}

function isSeatRole(role) {
	return role === 'N' || role === 'E' || role === 'S' || role === 'W'
}

function isSideRole(role) {
	return role === 'NS' || role === 'EW'
}

function roleConflicts(left, right) {
	if (left === 'SPECTATOR' || right === 'SPECTATOR') return false
	if (left === right) return true
	if (isSideRole(left) && isSeatRole(right)) return rolePartnership(right) === left
	if (isSideRole(right) && isSeatRole(left)) return rolePartnership(left) === right
	return false
}

function addTableMessage(room, text) {
	room.tableMessages = [...(room.tableMessages ?? []), {
		id: randomId(6),
		time: new Date().toISOString(),
		text
	}].slice(-30)
}

function expirePendingAgreement(room) {
	const request = room.pendingAgreement
	if (!request) return
	const createdAt = Date.parse(request.createdAt)
	if (!Number.isFinite(createdAt) || Date.now() - createdAt <= agreementExpiryMs) return
	room.pendingAgreement = undefined
	room.revision += 1
	addTableMessage(room, `The ${request.type} request expired.`)
}

function isTableMessage(value) {
	return value && typeof value.id === 'string' && typeof value.time === 'string' && typeof value.text === 'string'
}

function requireSession(room, url) {
	const token = url.searchParams.get('token')
	if (!token || !room.players.has(token)) throw httpError(401, 'Missing or invalid token')
	return { token, side: room.players.get(token) }
}

function requireSessionIfProvided(room, url) {
	const token = url.searchParams.get('token')
	if (!token) return undefined
	if (!room.players.has(token)) throw httpError(401, 'Missing or invalid token')
	return { token, side: room.players.get(token) }
}

function parseSide(value) {
	if (value === 'NS' || value === 'EW' || value === 'N' || value === 'E' || value === 'S' || value === 'W' || value === 'SPECTATOR') return value
	throw httpError(400, 'Seat must be N, E, S, W, NS, EW, or SPECTATOR')
}

function parseBiddingSystem(value) {
	if (value === 'natural' || value === 'sayc' || value === 'two-over-one' || value === 'blue-club-modified') return value
	throw httpError(400, 'Bidding system must be Natural, SAYC, 2/1, or Modified Blue Club')
}

function parseRobots(value) {
	return {
		N: Boolean(value?.N),
		E: Boolean(value?.E),
		S: Boolean(value?.S),
		W: Boolean(value?.W)
	}
}

function biddingSystemLabel(value) {
	if (value === 'sayc') return 'SAYC'
	if (value === 'two-over-one') return '2/1'
	if (value === 'blue-club-modified') return 'Modified Blue Club'
	return 'Natural / Manual'
}

function sanitizeRoomLabel(value) {
	if (typeof value !== 'string') return undefined
	const label = value.replace(/\s+/g, ' ').trim().slice(0, 60)
	return label || undefined
}

function sanitizeClaimNote(value) {
	if (typeof value !== 'string') return undefined
	const note = value.replace(/\s+/g, ' ').trim().slice(0, 140)
	return note || undefined
}

function sanitizeExplanation(value) {
	if (typeof value !== 'string') return undefined
	const explanation = value.replace(/\s+/g, ' ').trim().slice(0, 240)
	return explanation || undefined
}

function roleLabel(role) {
	if (role === 'SPECTATOR') return 'Spectator'
	if (role === 'NS' || role === 'EW') return `${role} side`
	return `Seat ${role}`
}

function localNetworkAddress() {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && !entry.internal) return entry.address
		}
	}
	return undefined
}

function publicOrigin() {
	const address = host === '0.0.0.0' ? localNetworkAddress() : host
	return address ? `http://${address}:${port}` : undefined
}

function sanitizeQuestion(value) {
	if (typeof value !== 'string') return undefined
	const question = value.replace(/\s+/g, ' ').trim().slice(0, 180)
	return question || undefined
}

function sendJson(res, statusCode, payload) {
	res.writeHead(statusCode, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify(payload))
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let body = ''
		req.on('data', chunk => {
			body += chunk
			if (body.length > 1_000_000) reject(httpError(413, 'Request body too large'))
		})
		req.on('end', () => {
			if (!body) {
				resolve({})
				return
			}
			try {
				resolve(JSON.parse(body))
			} catch {
				reject(httpError(400, 'Invalid JSON'))
			}
		})
		req.on('error', reject)
	})
}

function randomId(bytes) {
	return randomBytes(bytes).toString('base64url')
}

function randomInt() {
	return randomBytes(4).readUInt32BE(0)
}

function httpError(statusCode, message) {
	const error = new Error(message)
	error.statusCode = statusCode
	return error
}
