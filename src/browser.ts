import {
	cardId,
	callId,
	controlsSeat,
	isSeatRole,
	rolePartnership,
	type BiddingSystem,
	type BoardHistorySummary,
	type BoardView,
	type ControlSide,
	type PlayerRole
} from './multiplayer.js'
import type { BoardAnalysis, PlayReview } from './analysis.js'
import {
	listPbnBoards,
	partnership,
	scoreContract,
	type Bid,
	type Call,
	type Contract,
	type Card,
	type PbnBoardSummary,
	type PlayedCard,
	type Seat,
	type Strain
} from './index.js'

const seats: readonly Seat[] = ['N', 'E', 'S', 'W']
const privateSeatRoles: readonly Seat[] = ['N', 'E', 'S', 'W']
const tableControlRoles: readonly PlayerRole[] = ['NS', 'EW', 'SPECTATOR']
const strains: readonly Strain[] = ['C', 'D', 'H', 'S', 'NT']
const biddingSystems: readonly BiddingSystem[] = ['natural', 'sayc', 'two-over-one', 'blue-club-modified']
const explanationTemplates = [
	'Artificial',
	'Forcing',
	'Game forcing',
	'Transfer',
	'Stayman',
	'Weak',
	'May be short',
	'15-17 balanced'
] as const
const suitSymbols: Record<Card['suit'], string> = { C: '\u2663', D: '\u2666', H: '\u2665', S: '\u2660' }
const rankOrder = new Map('23456789TJQKA'.split('').map((rank, index) => [rank, index]))
const suitOrder = new Map<Card['suit'], number>([
	['C', 0],
	['D', 1],
	['H', 2],
	['S', 3]
])

type PanelTab = 'now' | 'deal' | 'match' | 'room'

let view: BoardView | undefined
let errorMessage = ''
let claimConflictSide: PlayerRole | undefined
let eventSource: EventSource | undefined
let analysis: BoardAnalysis | undefined
let analysisRevision: number | undefined
let analysisVisible = false
let tricksVisible = false
let statsVisible = false
let boardHistoryVisible = false
let resultsVisible = true
let reviewMode = false
let selectedReviewTrick = 0
let pbnText = ''
let pbnVisible = false
let pbnBoardIndex = 0
let pbnMessage = ''
let pbnReplayRecord = false
let pbnExportScope: PbnExportScope = 'board'
let connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle'
let switchConflictSide: PlayerRole | undefined
let seatMode: 'fixed' | 'you-bottom' = loadSeatMode()
let savedRooms: SavedRoomSummary[] = []
let savedRoomsLoaded = false
let savedRoomFilter = ''
let showArchivedRooms = false
let pendingSeatJoin: Seat | undefined
let selectedSeatJoinRoomId = ''
let pendingSpectatorJoin = false
let selectedSpectatorJoinRoomId = ''
let roomNameDraft: string | undefined
let archivedCleanupDays = 30
let tableMessagesVisible = false
let claimNoteDraft = ''
let selectedAlertIndex: number | undefined
let alertExplanationDraft = ''
let selectedCallIndex: number | undefined
let selectedAlertQuestionIndex: number | undefined
let alertQuestionDraft = ''
let activePanelTab: PanelTab = 'now'
let lastNowPhase: BoardView['phase'] | undefined
const alertAnswerDrafts = new Map<string, string>()
const bidPreviewCache = new Map<string, string>()

type ReviewTrick = Readonly<{
	number: number
	leader: Seat
	plays: readonly PlayedCard[]
	winner?: Seat
	complete: boolean
}>

type PbnExportScope = 'board' | 'room'
type SavedRoomSummary = Readonly<{
	id: string
	boardNumber: number
	phase: string
	boards: number
	players: Readonly<Record<ControlSide | Seat, boolean>>
	savedAt?: string
	createdAt?: string
	restored: boolean
	label?: string
	archived: boolean
	biddingSystem: BiddingSystem
	spectatorSeeAll?: boolean
}>

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Missing app root')
const appRoot = app

function roomIdFromUrl(): string | undefined {
	const value = new URLSearchParams(location.search).get('room')
	return value || undefined
}

function preferredSeatFromUrl(): Seat | undefined {
	const value = new URLSearchParams(location.search).get('seat')
	return value === 'N' || value === 'E' || value === 'S' || value === 'W' ? value : undefined
}

function sessionKey(roomId: string): string {
	return `bridge-room:${roomId}:token`
}

function storedToken(roomId: string): string | undefined {
	return sessionStorage.getItem(sessionKey(roomId)) || undefined
}

function storeToken(roomId: string, token: string): void {
	sessionStorage.setItem(sessionKey(roomId), token)
	localStorage.removeItem(sessionKey(roomId))
}

function forgetToken(roomId: string): void {
	sessionStorage.removeItem(sessionKey(roomId))
	localStorage.removeItem(sessionKey(roomId))
}

function loadSeatMode(): 'fixed' | 'you-bottom' {
	return localStorage.getItem('bridge-seat-mode') === 'you-bottom' ? 'you-bottom' : 'fixed'
}

function storeSeatMode(value: 'fixed' | 'you-bottom'): void {
	seatMode = value
	localStorage.setItem('bridge-seat-mode', value)
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: { 'Content-Type': 'application/json', ...init?.headers }
	})
	const payload = await response.json() as unknown
	if (!response.ok) {
		const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
			? payload.error
			: `HTTP ${response.status}`
		throw new Error(message)
	}
	return payload as T
}

async function createRoom(side: PlayerRole): Promise<void> {
	const session = await requestJson<{ roomId: string, token: string, side: PlayerRole }>('/api/rooms', {
		method: 'POST',
		body: JSON.stringify({ side })
	})
	savedRoomsLoaded = false
	storeToken(session.roomId, session.token)
	history.replaceState(null, '', `?room=${encodeURIComponent(session.roomId)}`)
	switchConflictSide = undefined
	pendingSeatJoin = undefined
	selectedSeatJoinRoomId = ''
	pendingSpectatorJoin = false
	selectedSpectatorJoinRoomId = ''
	roomNameDraft = undefined
	connect(session.roomId, session.token)
}

async function claimRoom(side: PlayerRole, force = false): Promise<void> {
	const roomId = roomIdFromUrl()
	if (!roomId) return
	await claimSpecificRoom(roomId, side, force)
}

async function claimSpecificRoom(roomId: string, side: PlayerRole, force = false): Promise<void> {
	const session = await requestJson<{ roomId: string, token: string, side: PlayerRole }>(`/api/rooms/${roomId}/claim`, {
		method: 'POST',
		body: JSON.stringify({ side, token: storedToken(roomId), force })
	})
	claimConflictSide = undefined
	switchConflictSide = undefined
	pendingSeatJoin = undefined
	selectedSeatJoinRoomId = ''
	pendingSpectatorJoin = false
	selectedSpectatorJoinRoomId = ''
	storeToken(session.roomId, session.token)
	history.replaceState(null, '', `?room=${encodeURIComponent(session.roomId)}`)
	roomNameDraft = undefined
	connect(session.roomId, session.token)
}

async function chooseLobbySeat(side: Seat, roomId: string | undefined): Promise<void> {
	if (roomId) {
		await claimSpecificRoom(roomId, side)
		return
	}
	await ensureSavedRooms(true)
	const rooms = partnerRoomsFor(side)
	if (rooms.length) {
		pendingSeatJoin = side
		pendingSpectatorJoin = false
		selectedSeatJoinRoomId = rooms.some(room => room.id === selectedSeatJoinRoomId) ? selectedSeatJoinRoomId : rooms[0]!.id
		errorMessage = ''
		renderLobby()
		return
	}
	await createRoom(side)
}

async function chooseLobbyControl(side: PlayerRole, roomId: string | undefined): Promise<void> {
	if (roomId) {
		await claimRoom(side)
		return
	}
	if (side === 'SPECTATOR') {
		await ensureSavedRooms(true)
		const rooms = spectatorRooms()
		if (rooms.length) {
			pendingSeatJoin = undefined
			pendingSpectatorJoin = true
			selectedSpectatorJoinRoomId = rooms.some(room => room.id === selectedSpectatorJoinRoomId)
				? selectedSpectatorJoinRoomId
				: rooms[0]!.id
			errorMessage = ''
			renderLobby()
			return
		}
	}
	pendingSeatJoin = undefined
	pendingSpectatorJoin = false
	await createRoom(side)
}

async function switchSide(side: PlayerRole, force = false): Promise<void> {
	if (!view) return
	try {
		const session = await requestJson<{ roomId: string, token: string, side: PlayerRole }>(`/api/rooms/${view.roomId}/claim`, {
			method: 'POST',
			body: JSON.stringify({ side, token: storedToken(view.roomId), force })
		})
		switchConflictSide = undefined
		storeToken(session.roomId, session.token)
		connect(session.roomId, session.token)
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		switchConflictSide = side !== 'SPECTATOR' && errorMessage === `${side} is already claimed` ? side : undefined
		render()
	}
}

function reconnectRoom(): void {
	const roomId = view?.roomId ?? roomIdFromUrl()
	if (!roomId) return
	const token = storedToken(roomId)
	if (!token) {
		view = undefined
		connectionStatus = 'idle'
		errorMessage = 'Choose a side to rejoin this room.'
		renderLobby()
		return
	}
	void resumeRoom(roomId, token)
}

async function resumeRoom(roomId: string, token: string): Promise<void> {
	try {
		connectionStatus = 'connecting'
		errorMessage = ''
		const payload = await requestJson<BoardView>(`/api/rooms/${roomId}/view?token=${encodeURIComponent(token)}`)
		if (view?.roomId !== payload.roomId) roomNameDraft = undefined
		view = payload
		selectedReviewTrick = clampReviewTrickIndex(payload, selectedReviewTrick)
		connect(roomId, token)
	} catch (error) {
		eventSource?.close()
		view = undefined
		connectionStatus = 'disconnected'
		const message = error instanceof Error ? error.message : String(error)
		if (message === 'Missing or invalid token') {
			forgetToken(roomId)
			errorMessage = 'Your saved room session expired. Choose a side to rejoin.'
		} else if (message === 'Room not found') {
			forgetToken(roomId)
			errorMessage = 'That room is no longer available. Create a new room or use a fresh link.'
		} else {
			errorMessage = `Could not reconnect: ${message}`
		}
		renderLobby()
	}
}

function connect(roomId: string, token: string): void {
	eventSource?.close()
	connectionStatus = 'connecting'
	eventSource = new EventSource(`/api/rooms/${roomId}/events?token=${encodeURIComponent(token)}`)
	eventSource.addEventListener('state', event => {
		const payload = JSON.parse((event as MessageEvent).data) as BoardView | { error: string }
		if ('error' in payload) {
			errorMessage = payload.error
			if (payload.error.includes('was taken over')) {
				forgetToken(roomId)
				view = undefined
				connectionStatus = 'disconnected'
				eventSource?.close()
				renderLobby()
				return
			}
			render()
			return
		}
		if (analysisRevision !== undefined && analysisRevision !== payload.revision) {
			analysis = undefined
			analysisRevision = undefined
		}
		if (view?.roomId !== payload.roomId) roomNameDraft = undefined
		view = payload
		connectionStatus = 'connected'
		switchConflictSide = undefined
		selectedReviewTrick = clampReviewTrickIndex(payload, selectedReviewTrick)
		errorMessage = ''
		render()
	})
	eventSource.onerror = () => {
		connectionStatus = 'disconnected'
		errorMessage = view ? 'Connection lost. Use Reconnect or create a new room.' : 'Could not connect to this room.'
		render()
	}
}

async function submitAction(action: unknown): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		await requestJson(`/api/rooms/${view.roomId}/actions?token=${encodeURIComponent(token)}`, {
			method: 'POST',
			body: JSON.stringify(action)
		})
		analysis = undefined
		analysisRevision = undefined
		reviewMode = false
		errorMessage = ''
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function respondAgreement(accept: boolean, cancel = false): Promise<void> {
	if (!view?.pendingAgreement) return
	await submitAction({
		type: 'respondAgreement',
		requestId: view.pendingAgreement.id,
		accept,
		cancel
	})
}

async function requestClaim(claimTricks: number, note: string): Promise<void> {
	await submitAction({ type: 'requestClaim', claimTricks, note })
}

async function explainAuctionCall(index: number, explanation: string): Promise<void> {
	await submitAction({ type: 'explainCall', index, explanation })
	selectedAlertIndex = undefined
	alertExplanationDraft = ''
}

async function askAlertQuestion(index: number, question: string): Promise<void> {
	await submitAction({ type: 'askAlertQuestion', index, question })
	selectedAlertQuestionIndex = undefined
	alertQuestionDraft = ''
}

async function answerAlertQuestion(index: number, questionId: string, answer: string): Promise<void> {
	await submitAction({ type: 'answerAlertQuestion', index, questionId, answer })
	alertAnswerDrafts.delete(questionId)
}

async function refreshAnalysis(): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		analysis = await requestJson<BoardAnalysis>(`/api/rooms/${view.roomId}/analysis?token=${encodeURIComponent(token)}`)
		analysisRevision = view.revision
		analysisVisible = false
		errorMessage = ''
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function exportPbn(scope: PbnExportScope = 'board'): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		const result = await requestJson<{ pbn: string }>(`/api/rooms/${view.roomId}/pbn?token=${encodeURIComponent(token)}${scope === 'room' ? '&scope=room' : ''}`)
		pbnText = result.pbn
		pbnExportScope = scope
		pbnVisible = true
		pbnBoardIndex = 0
		pbnMessage = scope === 'room' ? 'Exported room history.' : 'Exported current board.'
		errorMessage = ''
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function importPbn(): Promise<void> {
	if (!pbnText.trim()) {
		errorMessage = 'Paste a PBN deal first.'
		render()
		return
	}
	try {
		if (!view) return
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		await requestJson(`/api/rooms/${view.roomId}/actions?token=${encodeURIComponent(token)}`, {
			method: 'POST',
			body: JSON.stringify({ type: 'importPbn', pbn: pbnText, boardIndex: pbnBoardIndex, replayRecord: pbnReplayRecord })
		})
		const boards = pbnSummaries(pbnText)
		const imported = boards[pbnBoardIndex]
		pbnMessage = imported
			? `Imported board ${imported.boardNumber}${pbnReplayRecord ? ' with saved auction/play.' : ' from the beginning.'}`
			: 'Imported PBN board.'
		analysis = undefined
		analysisRevision = undefined
		reviewMode = false
		errorMessage = ''
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function loadSavedRooms(): Promise<void> {
	try {
		await ensureSavedRooms(true)
		renderLobby()
	} catch (error) {
		savedRooms = []
		savedRoomsLoaded = true
		errorMessage = error instanceof Error ? error.message : String(error)
		renderLobby()
	}
}

async function ensureSavedRooms(force = false): Promise<void> {
	if (savedRoomsLoaded && !force) return
	const result = await requestJson<{ rooms: SavedRoomSummary[] }>('/api/rooms')
	savedRooms = result.rooms
	savedRoomsLoaded = true
}

async function saveRoomNow(): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		const result = await requestJson<{ savedAt: string }>(`/api/rooms/${view.roomId}/save?token=${encodeURIComponent(token)}`, { method: 'POST' })
		errorMessage = `Saved room locally ${new Date(result.savedAt).toLocaleString()}.`
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function backupRoom(): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		const backup = await fetchRoomBackup(view.roomId, token)
		downloadText(roomBackupFilename(view), JSON.stringify(backup, null, 2), 'application/json;charset=utf-8')
		errorMessage = `Downloaded backup for ${roomDisplayName(view)}.`
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function copyRoomBackup(): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		const backup = await fetchRoomBackup(view.roomId, token)
		await navigator.clipboard.writeText(JSON.stringify(backup, null, 2))
		errorMessage = `Copied backup for ${roomDisplayName(view)}.`
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function renameRoom(): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		const label = roomNameDraft ?? view.roomMeta?.label ?? ''
		await requestJson(`/api/rooms/${view.roomId}/rename?token=${encodeURIComponent(token)}`, {
			method: 'POST',
			body: JSON.stringify({ label })
		})
		savedRoomsLoaded = false
		errorMessage = label.trim() ? 'Saved room name.' : 'Cleared room name.'
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function setBiddingSystem(system: BiddingSystem): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		await requestJson(`/api/rooms/${view.roomId}/bidding-system?token=${encodeURIComponent(token)}`, {
			method: 'POST',
			body: JSON.stringify({ system })
		})
		savedRoomsLoaded = false
		errorMessage = `Bidding system set to ${biddingSystemLabel(system)}.`
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function fetchCallPreview(state: BoardView, call: Call): Promise<string> {
	const token = storedToken(state.roomId)
	if (!token) throw new Error('Missing room session')
	const result = await requestJson<{ explanation: string }>(`/api/rooms/${state.roomId}/call-preview?token=${encodeURIComponent(token)}`, {
		method: 'POST',
		body: JSON.stringify({ call })
	})
	return result.explanation
}

async function setSpectatorSeeAll(enabled: boolean): Promise<void> {
	await submitAction({ type: 'setSpectatorSeeAll', enabled })
}

async function setRobotSeat(seat: Seat, enabled: boolean): Promise<void> {
	await submitAction({ type: 'setRobotSeat', seat, enabled })
}

async function archiveCurrentRoom(archived: boolean): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		await requestJson(`/api/rooms/${view.roomId}/${archived ? 'archive' : 'unarchive'}?token=${encodeURIComponent(token)}`, { method: 'POST' })
		savedRoomsLoaded = false
		errorMessage = archived ? 'Archived this room. It stays in Saved Rooms.' : 'Moved this room back to active rooms.'
		render()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function duplicateCurrentRoom(): Promise<void> {
	if (!view) return
	try {
		const token = storedToken(view.roomId)
		if (!token) throw new Error('Missing room session')
		const result = await requestJson<{ roomId: string }>(`/api/rooms/${view.roomId}/duplicate?token=${encodeURIComponent(token)}`, { method: 'POST' })
		eventSource?.close()
		view = undefined
		connectionStatus = 'idle'
		savedRoomsLoaded = false
		roomNameDraft = undefined
		history.replaceState(null, '', `?room=${encodeURIComponent(result.roomId)}`)
		errorMessage = 'Created a duplicate room. Choose a side to enter it.'
		renderLobby()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function duplicateSavedRoom(room: SavedRoomSummary): Promise<void> {
	try {
		const result = await requestJson<{ roomId: string }>(`/api/rooms/${room.id}/duplicate`, { method: 'POST' })
		savedRoomsLoaded = false
		history.replaceState(null, '', `?room=${encodeURIComponent(result.roomId)}`)
		errorMessage = `Created a duplicate of ${roomDisplayName(room)}. Choose a side to enter it.`
		renderLobby()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		renderLobby()
	}
}

async function downloadSavedRoomBackup(room: SavedRoomSummary): Promise<void> {
	try {
		const backup = await fetchRoomBackup(room.id)
		downloadText(roomBackupFilename(room), JSON.stringify(backup, null, 2), 'application/json;charset=utf-8')
		errorMessage = `Downloaded backup for ${roomDisplayName(room)}.`
		renderLobby()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		renderLobby()
	}
}

async function copySavedRoomBackup(room: SavedRoomSummary): Promise<void> {
	try {
		const backup = await fetchRoomBackup(room.id)
		await navigator.clipboard.writeText(JSON.stringify(backup, null, 2))
		errorMessage = `Copied backup for ${roomDisplayName(room)}.`
		renderLobby()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		renderLobby()
	}
}

async function cleanupArchivedRooms(): Promise<void> {
	try {
		const days = Math.max(0, Math.trunc(archivedCleanupDays))
		const result = await requestJson<{ removed: number }>('/api/rooms/cleanup', {
			method: 'POST',
			body: JSON.stringify({ days })
		})
		savedRoomsLoaded = false
		errorMessage = result.removed
			? `Forgot ${result.removed} archived room${result.removed === 1 ? '' : 's'} older than ${days} day${days === 1 ? '' : 's'}.`
			: `No archived rooms older than ${days} day${days === 1 ? '' : 's'} were found.`
		renderLobby()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		renderLobby()
	}
}

async function forgetCurrentRoom(): Promise<void> {
	if (!view) return
	try {
		const roomId = view.roomId
		const token = storedToken(roomId)
		if (!token) throw new Error('Missing room session')
		await requestJson(`/api/rooms/${roomId}?token=${encodeURIComponent(token)}`, { method: 'DELETE' })
		eventSource?.close()
		forgetToken(roomId)
		view = undefined
		connectionStatus = 'idle'
		savedRoomsLoaded = false
		history.replaceState(null, '', location.pathname)
		errorMessage = 'Forgot that saved room.'
		renderLobby()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		render()
	}
}

async function importRoomBackup(file: File): Promise<void> {
	try {
		const backup = JSON.parse(await file.text()) as unknown
		const result = await requestJson<{ roomId: string }>('/api/rooms/import', {
			method: 'POST',
			body: JSON.stringify(backup)
		})
		savedRoomsLoaded = false
		history.replaceState(null, '', `?room=${encodeURIComponent(result.roomId)}`)
		errorMessage = 'Imported room backup. Choose a side to enter it.'
		renderLobby()
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error)
		renderLobby()
	}
}

function downloadText(filename: string, text: string, type: string): void {
	const blob = new Blob([text], { type })
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	link.click()
	URL.revokeObjectURL(url)
}

function fetchRoomBackup(roomId: string, token?: string): Promise<unknown> {
	const query = token ? `?token=${encodeURIComponent(token)}` : ''
	return requestJson<unknown>(`/api/rooms/${roomId}/backup${query}`)
}

function roomBackupFilename(room: Pick<SavedRoomSummary, 'id' | 'label'> | Pick<BoardView, 'roomId' | 'roomMeta'>): string {
	const id = 'roomId' in room ? room.roomId : room.id
	const name = slugify(roomDisplayName(room))
	return `bridge-room-${name || id}-${id}.json`
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
}

function roomDisplayName(room: Pick<SavedRoomSummary, 'id' | 'label'> | Pick<BoardView, 'roomId' | 'roomMeta'>): string {
	if ('roomId' in room) return room.roomMeta?.label || room.roomId
	return room.label || room.id
}

function formatDateTime(value: string | undefined): string {
	return value ? new Date(value).toLocaleString() : 'Not saved yet'
}

function formatRelativeAge(value: string | undefined): string {
	if (!value) return 'unknown age'
	const timestamp = Date.parse(value)
	if (!Number.isFinite(timestamp)) return 'unknown age'
	const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes} min ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours} hr ago`
	const days = Math.floor(hours / 24)
	return `${days} day${days === 1 ? '' : 's'} ago`
}

function confirmForgetRoom(state: BoardView): boolean {
	const savedAt = formatDateTime(state.persistence?.savedAt)
	const name = roomDisplayName(state)
	return confirm(
		`Forget saved room "${name}"?\n\n` +
		`Room: ${state.roomId}\n` +
		`Boards: ${state.boardHistory.length}\n` +
		`Last saved: ${savedAt}\n\n` +
		'This removes it from Saved Rooms on this computer. Use Backup first if you want a file copy.'
	)
}

function pbnSummaries(text: string): PbnBoardSummary[] {
	if (!text.trim()) return []
	try {
		return listPbnBoards(text)
	} catch {
		return []
	}
}

function pbnValidationMessage(text: string): string {
	if (!text.trim()) return 'Export, paste, or choose a PBN file.'
	try {
		const boards = listPbnBoards(text)
		if (!boards.length) return 'No PBN Deal tag found.'
		if (boards.length === 1) return `Ready: board ${boards[0]!.boardNumber}.`
		return `Ready: ${boards.length} boards found.`
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

function downloadPbn(): void {
	if (!pbnText.trim()) return
	const blob = new Blob([pbnText], { type: 'application/x-pbn;charset=utf-8' })
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = pbnExportScope === 'room' ? `bridge-room-${view?.roomId ?? 'export'}.pbn` : `bridge-board-${view?.boardNumber ?? 1}.pbn`
	link.click()
	URL.revokeObjectURL(url)
}

function contractSummary(contract: Contract | undefined): string {
	if (!contract) return ''
	const double = contract.doubling === 'doubled' ? 'X' : contract.doubling === 'redoubled' ? 'XX' : ''
	return `${contract.level}${strainLabel(contract.strain)}${double} by ${contract.declarer}`
}

function boardScore(board: BoardHistorySummary): { ns: number, ew: number } | undefined {
	if (board.phase === 'passed-out') return { ns: 0, ew: 0 }
	if (board.phase !== 'complete' || !board.contract) return undefined
	const declarerTricks = board.tricksWon[partnership(board.contract.declarer)]
	const score = scoreContract(board.contract, declarerTricks, board.vulnerability)
	return { ns: score.ns, ew: score.ew }
}

function boardDeclarerSide(board: BoardHistorySummary): string {
	return board.contract ? partnership(board.contract.declarer) : '-'
}

function boardResultText(board: BoardHistorySummary): string {
	if (board.phase === 'passed-out') return 'Passed out'
	if (!board.contract) return board.phase
	if (board.phase !== 'complete') return board.phase
	const declarerTricks = board.tricksWon[partnership(board.contract.declarer)]
	const delta = declarerTricks - (board.contract.level + 6)
	if (delta === 0) return 'Made exactly (=)'
	return delta > 0 ? `Made +${delta}` : `Down ${Math.abs(delta)}`
}

function matchTotals(state: BoardView): { ns: number, ew: number, scored: number } {
	return state.boardHistory.reduce((total, board) => {
		const score = boardScore(board)
		if (!score) return total
		return { ns: total.ns + score.ns, ew: total.ew + score.ew, scored: total.scored + 1 }
	}, { ns: 0, ew: 0, scored: 0 })
}

function matchLeaderText(totals: { ns: number, ew: number, scored: number }): string {
	if (!totals.scored) return 'No scored boards yet'
	if (totals.ns === totals.ew) return 'Tied'
	return `${totals.ns > totals.ew ? 'NS' : 'EW'} leads by ${Math.abs(totals.ns - totals.ew)}`
}

function matchResultsTooltip(state: BoardView): string {
	const totals = matchTotals(state)
	if (!state.boardHistory.length) return 'No boards yet.'
	const rows = [`Total: NS ${totals.ns} / EW ${totals.ew}`, matchLeaderText(totals)]
	for (const board of state.boardHistory) {
		const score = boardScore(board)
		rows.push(resultTooltip(board, score))
	}
	return rows.join('\n')
}

function csvCell(value: string | number): string {
	const text = String(value)
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvRow(values: readonly (string | number)[]): string {
	return values.map(csvCell).join(',')
}

function resultTooltip(board: BoardHistorySummary, score = boardScore(board)): string {
	return [
		`Board ${board.boardNumber}${board.current ? ' (current)' : ''}`,
		`Status: ${board.phase}`,
		`Vulnerable: ${board.vulnerability.toUpperCase()}`,
		`Contract: ${contractSummary(board.contract) || '-'}`,
		`Declarer side: ${boardDeclarerSide(board)}`,
		`Result: ${boardResultText(board)}`,
		`Tricks: NS ${board.tricksWon.NS} / EW ${board.tricksWon.EW}`,
		score ? `Score: NS ${score.ns} / EW ${score.ew}` : 'Score: not available yet'
	].join('\n')
}

function matchResultsCsv(state: BoardView): string {
	const totals = matchTotals(state)
	const lines = [
		csvRow(['Board', 'Status', 'Vulnerable', 'Declarer Side', 'Contract', 'Result', 'Tricks NS', 'Tricks EW', 'Score NS', 'Score EW'])
	]
	for (const board of state.boardHistory) {
		const score = boardScore(board)
		lines.push(csvRow([
			board.boardNumber,
			board.phase,
			board.vulnerability.toUpperCase(),
			boardDeclarerSide(board),
			contractSummary(board.contract) || '-',
			boardResultText(board),
			board.tricksWon.NS,
			board.tricksWon.EW,
			score?.ns ?? '',
			score?.ew ?? ''
		]))
	}
	lines.push(csvRow(['TOTAL', `${totals.scored}/${state.boardHistory.length} scored`, '', '', matchLeaderText(totals), '', '', '', totals.ns, totals.ew]))
	return lines.join('\n')
}

function copyMatchResults(state: BoardView): void {
	void navigator.clipboard.writeText(matchResultsCsv(state)).then(() => {
		errorMessage = 'Copied match results CSV.'
		render()
	}).catch(() => {
		errorMessage = 'Could not copy match results.'
		render()
	})
}

function downloadMatchResults(state: BoardView): void {
	const blob = new Blob([matchResultsCsv(state)], { type: 'text/csv;charset=utf-8' })
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = `bridge-results-${state.roomId}.csv`
	link.click()
	URL.revokeObjectURL(url)
}

function formatParContract(value: string): string {
	return value.replace(/([1-7])([CDHS])(?=(?:X{0,2})?[-\s,]|(?:X{0,2})?$)/g, (_match, level: string, strain: Card['suit']) => `${level}${suitSymbols[strain]}`)
}

function formatParContracts(values: readonly string[]): string {
	return values.length ? values.map(formatParContract).join(', ') : '-'
}

function analysisTooltip(value: BoardAnalysis | undefined): string {
	if (!value) return 'Refresh analysis first.'
	const lines = [
		`Board: ${value.boardNumber}`,
		`Phase: ${value.phase}`,
		`HCP: NS ${value.hcp.sides.NS}, EW ${value.hcp.sides.EW}`,
		value.dds.message
	]
	if (value.contractAnalysis) {
		const contract = value.contractAnalysis
		lines.push(
			`Contract: ${contract.contract.level}${strainLabel(contract.contract.strain)}${contract.contract.doubling === 'doubled' ? 'X' : contract.contract.doubling === 'redoubled' ? 'XX' : ''} by ${contract.contract.declarer}`,
			`Declarer tricks: ${contract.declarerTricks} (${contract.result})`,
			`Score: NS ${contract.score.ns} / EW ${contract.score.ew}`
		)
	}
	if (value.dds.contract) lines.push(value.dds.contract.explanation)
	if (value.dds.par) lines.push(`Par ${value.dds.par.score}: ${formatParContracts(value.dds.par.contracts)}`)
	if (value.dds.playGuidance) lines.push(`Best Plays for ${value.dds.playGuidance.seat}: ${value.dds.playGuidance.explanation}`)
	if (value.dds.playReview?.length) lines.push(`Play review: ${value.dds.playReview.length} reviewed plays`)
	return lines.filter(Boolean).join('\n')
}

function callLabel(call: Call): string {
	if (call.type === 'bid') return `${call.level}${strainLabel(call.strain)}`
	if (call.type === 'double') return 'X'
	if (call.type === 'redouble') return 'XX'
	return 'Pass'
}

function auctionCallAlertLabel(entry: BoardView['auction'][number]): string {
	if (!entry.alert?.explanation) return ''
	const questions = entry.alert.questions?.length ? ` (${entry.alert.questions.length} Q/A)` : ''
	return `Alert: ${entry.alert.explanation}${questions}`
}

function auctionCallTitle(state: BoardView, entry: BoardView['auction'][number]): string {
	const base = `${entry.seat} ${callLabel(entry.call)}`
	const alert = auctionCallAlertLabel(entry)
	if (!alert) return base
	const questions = entry.alert!.questions?.map(question =>
		`Q ${question.askedBy}: ${question.question}${question.answer ? `\nA ${question.answeredBy}: ${question.answer}` : '\nA: waiting'}`
	) ?? []
	return `${base}\n${alert}\nExplained by ${entry.alert!.explainedBy}.${questions.length ? `\n${questions.join('\n')}` : ''}`
}

function canExplainAuctionCall(state: BoardView, entry: BoardView['auction'][number]): boolean {
	return canEditRoom(state) && !state.pendingAgreement && partnership(entry.seat) === rolePartnership(state.controlledSide)
}

function canAskAlertQuestion(state: BoardView, entry: BoardView['auction'][number]): boolean {
	const side = rolePartnership(state.controlledSide)
	return canEditRoom(state) && !state.pendingAgreement && Boolean(entry.alert?.explanation) && Boolean(side) && partnership(entry.seat) !== side
}

function canAnswerAlertQuestion(state: BoardView, entry: BoardView['auction'][number]): boolean {
	return canExplainAuctionCall(state, entry) && Boolean(entry.alert?.questions?.some(question => !question.answer))
}

type AlertSuggestion = Readonly<{ label: string, explanation: string }>

function alertSuggestionForCall(state: BoardView, index: number): AlertSuggestion | undefined {
	const system = state.roomMeta?.biddingSystem ?? 'natural'
	if (system === 'natural') return undefined
	const entry = state.auction[index]
	if (!entry || entry.call.type !== 'bid') return undefined
	const call = entry.call
	const previousBids = state.auction.slice(0, index).filter(auctionCall => auctionCall.call.type === 'bid')
	const partnerBids = previousBids.filter(auctionCall => partnership(auctionCall.seat) === partnership(entry.seat))
	const opponentBids = previousBids.filter(auctionCall => partnership(auctionCall.seat) !== partnership(entry.seat))
	const partnerLastBid = partnerBids.at(-1)?.call
	const isOpeningBid = !previousBids.length

	if (system === 'sayc' || system === 'two-over-one') {
		if (isOpeningBid && call.level === 2 && call.strain === 'C') return { label: 'Suggested alert', explanation: 'Strong artificial 2\u2663 opening.' }
		if (isOpeningBid && call.level === 2 && ['D', 'H', 'S'].includes(call.strain)) return { label: 'Suggested explanation', explanation: `Weak two in ${strainLabel(call.strain)}.` }
		if (partnerLastBid?.type === 'bid' && partnerLastBid.level === 1 && partnerLastBid.strain === 'NT') {
			if (call.level === 2 && call.strain === 'C') return { label: 'Suggested explanation', explanation: 'Stayman.' }
			if (call.level === 2 && call.strain === 'D') return { label: 'Suggested alert', explanation: 'Transfer to hearts.' }
			if (call.level === 2 && call.strain === 'H') return { label: 'Suggested alert', explanation: 'Transfer to spades.' }
			if (call.level === 2 && call.strain === 'S') return { label: 'Suggested alert', explanation: 'Minor-suit relay or transfer.' }
		}
	}

	if (system === 'two-over-one') {
		if (
			partnerLastBid?.type === 'bid'
			&& partnerLastBid.level === 1
			&& (partnerLastBid.strain === 'H' || partnerLastBid.strain === 'S')
			&& call.level === 1
			&& call.strain === 'NT'
		) return { label: 'Suggested alert', explanation: 'Forcing or semi-forcing 1NT.' }
		if (
			partnerLastBid?.type === 'bid'
			&& partnerLastBid.level === 1
			&& call.level === 2
			&& call.strain !== partnerLastBid.strain
			&& opponentBids.length === 0
		) return { label: 'Suggested explanation', explanation: '2/1 game forcing response.' }
	}

	return undefined
}

function latestExplainableCallIndex(state: BoardView): number | undefined {
	for (let index = state.auction.length - 1; index >= 0; index--) {
		if (canExplainAuctionCall(state, state.auction[index]!)) return index
	}
	return undefined
}

function lastCallLabel(state: BoardView): string {
	const last = state.auction.at(-1)
	return last ? `${last.seat} ${callLabel(last.call)}` : 'None'
}

function lastSeatCallLabel(state: BoardView, seat: Seat): string | undefined {
	const entry = [...state.auction].reverse().find(call => call.seat === seat)
	return entry ? callLabel(entry.call) : undefined
}

function currentBidLabel(state: BoardView): string {
	const bid = currentAuctionBid(state)
	return bid ? `${bid.seat} ${callLabel(bid.call)}${bid.suffix}` : 'None'
}

function currentContractText(state: BoardView): string {
	const bid = currentAuctionBid(state)
	return bid ? `${callLabel(bid.call)}${bid.suffix} by ${bid.seat}` : 'No contract yet'
}

function currentAuctionBid(state: BoardView): { seat: Seat, call: Bid, suffix: string } | undefined {
	let current: { seat: Seat, call: Bid, suffix: string } | undefined
	for (const entry of state.auction) {
		if (entry.call.type === 'bid') current = { seat: entry.seat, call: entry.call, suffix: '' }
		else if (entry.call.type === 'double' && current) current = { ...current, suffix: 'X' }
		else if (entry.call.type === 'redouble' && current) current = { ...current, suffix: 'XX' }
	}
	return current
}

function legalNonBidLabels(state: BoardView): string {
	const labels = [
		state.legalCalls.includes(callId({ type: 'pass' })) ? 'Pass' : '',
		state.legalCalls.includes(callId({ type: 'double' })) ? 'X' : '',
		state.legalCalls.includes(callId({ type: 'redouble' })) ? 'XX' : ''
	].filter(Boolean)
	return labels.length ? labels.join('/') : 'none'
}

function illegalBidMessage(state: BoardView, attempted: Call): string {
	const current = currentAuctionBid(state)
	const attemptedLabel = callLabel(attempted)
	if (!current) return `${attemptedLabel} is not a legal opening bid. Legal action now: Pass.`
	return `${attemptedLabel} is illegal. Current bid is ${current.seat} ${callLabel(current.call)}${current.suffix}. Choose a higher bid, or use ${legalNonBidLabels(state)}.`
}

function auctionTurnText(state: BoardView, ownsTurn: boolean): string {
	if (state.controlledSide === 'SPECTATOR') return `${state.currentTurn} to call. Spectator view is watch-only.`
	return ownsTurn ? `${state.currentTurn} to call. Your side acts now.` : `${state.currentTurn} to call. Waiting for ${partnership(state.currentTurn)}.`
}

function canOfferRobotForCurrentTurn(state: BoardView): boolean {
	if (state.controlledSide === 'SPECTATOR' || state.phase !== 'auction' || state.pendingAgreement || state.robots[state.currentTurn]) return false
	if (controlsSeat(state.controlledSide, state.currentTurn)) return false
	return !state.players[state.currentTurn] && !state.players[partnership(state.currentTurn)]
}

function auctionActionTitle(state: BoardView, call: Call, legal: boolean): string {
	if (legal) {
		if (call.type === 'pass') return 'Pass this turn.'
		if (call.type === 'double') return `Double the current bid: ${currentBidLabel(state)}.`
		if (call.type === 'redouble') return `Redouble the current doubled bid: ${currentBidLabel(state)}.`
		return `Bid ${callLabel(call)}.`
	}
	if (state.controlledSide === 'SPECTATOR') return 'Spectators cannot call.'
	if (call.type === 'double') return 'X is legal only after the opponents make an undoubled bid.'
	if (call.type === 'redouble') return 'XX is legal only after the opponents double your side.'
	return 'Not legal now.'
}

function selectedBidPreviewKey(state: BoardView, call: Call): string {
	return `${state.roomId}:${state.revision}:${state.roomMeta?.biddingSystem ?? 'natural'}:${callId(call)}`
}

function selectedBidTitle(state: BoardView, call: Call, ownsTurn: boolean): string {
	if (state.pendingAgreement) return 'Answer the pending table request first.'
	if (!ownsTurn) return auctionTurnText(state, ownsTurn)
	if (!state.legalCalls.includes(callId(call))) return illegalBidMessage(state, call)
	return bidPreviewCache.get(selectedBidPreviewKey(state, call)) ?? `Loading explanation for ${callLabel(call)}...`
}

async function refreshSelectedBidPreview(state: BoardView, call: Call, button?: HTMLButtonElement): Promise<void> {
	if (call.type !== 'bid' || !state.legalCalls.includes(callId(call))) return
	const key = selectedBidPreviewKey(state, call)
	const cached = bidPreviewCache.get(key)
	if (cached) {
		if (button) button.title = cached
		return
	}
	try {
		const explanation = await fetchCallPreview(state, call)
		bidPreviewCache.set(key, explanation)
		if (button && view?.roomId === state.roomId && view.revision === state.revision) button.title = explanation
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (button) button.title = message
	}
}

function strainLabel(strain: Strain): string {
	return strain === 'NT' ? strain : suitSymbols[strain]
}

function contractLabel(state: BoardView): string {
	if (state.phase === 'passed-out') return 'Passed out'
	if (!state.contract) return 'Auction'
	const double = state.contract.doubling === 'doubled' ? 'X' : state.contract.doubling === 'redoubled' ? 'XX' : ''
	return `${state.contract.level}${strainLabel(state.contract.strain)}${double} by ${state.contract.declarer}`
}

function formatCard(card: Card): string {
	return `${rankLabel(card.rank)}${suitSymbols[card.suit]}`
}

function winningPlay(plays: readonly PlayedCard[], strain: Strain): PlayedCard | undefined {
	if (!plays.length) return undefined
	const leadSuit = plays[0]!.card.suit
	const trump = strain === 'NT' ? undefined : strain
	return plays.reduce((winner, play) => cardBeats(play.card, winner.card, leadSuit, trump) ? play : winner)
}

function cardBeats(candidate: Card, current: Card, leadSuit: Card['suit'], trump?: Card['suit']): boolean {
	if (candidate.suit === current.suit) return rankOrder.get(candidate.rank)! > rankOrder.get(current.rank)!
	if (trump && candidate.suit === trump) return current.suit !== trump
	if (trump && current.suit === trump) return false
	return candidate.suit === leadSuit && current.suit !== leadSuit
}

function playStatusText(state: BoardView): string {
	if (state.phase !== 'play' || !state.contract) return ''
	if (state.pendingAgreement) return 'A table request is waiting for a response.'
	if (state.controlledSide === 'SPECTATOR') return `${state.currentTurn} to play. Spectator view is watch-only.`
	if (state.robots[state.currentTurn]) return `${state.currentTurn} robot is playing.`
	const side = partnership(state.currentTurn)
	return canPlayCurrentSeat(state)
		? `${state.currentTurn} to play. Your browser acts now.`
		: `${state.currentTurn} to play. Waiting for ${side}.`
}

function tableRoleText(state: BoardView): string {
	if (!state.contract) return ''
	const declarer = state.contract.declarer
	const dummy = state.dummy
	if (state.controlledSide === 'SPECTATOR') return `Declarer ${declarer}${dummy ? `, dummy ${dummy}` : ''}.`
	const controlled = seats.filter(seat => controlsSeat(state.controlledSide, seat))
	const roles = controlled.map(seat => {
		if (seat === declarer) return `${seat} declarer`
		if (seat === dummy) return `${seat} dummy`
		return `${seat} defender`
	})
	return roles.length ? `You control ${roles.join(' and ')}.` : ''
}

function currentTrickText(state: BoardView): string {
	if (state.phase !== 'play' || !state.currentTrick || !state.contract) return ''
	const plays = state.currentTrick.plays
	if (!plays.length) {
		const last = state.completedTricks.at(-1)
		if (last?.winner) return `Last trick won by ${last.winner}. ${state.currentTrick.leader} leads trick ${state.completedTricks.length + 1}.`
		return `Trick ${state.completedTricks.length + 1}. ${state.currentTrick.leader} leads.`
	}
	const leadSuit = plays[0]!.card.suit
	const winning = winningPlay(plays, state.contract.strain)
	return `Trick ${state.completedTricks.length + 1}. Lead ${suitSymbols[leadSuit]}. ${plays.length}/4 played. Winning: ${winning ? `${winning.seat} ${formatCard(winning.card)}` : '-'}.`
}

function cardTitle(state: BoardView, seat: Seat, card: Card, legal: boolean, best: boolean): string {
	if (best) return `DDS best: play ${formatCard(card)}.`
	if (state.pendingAgreement) return 'A table request is waiting for a response.'
	if (legal) return `Play ${formatCard(card)}.`
	if (reviewMode) return 'Review mode is read-only.'
	if (state.phase !== 'play') return 'Card play starts after the auction.'
	if (state.currentTurn !== seat) return `Waiting for ${state.currentTurn} to play.`
	if (state.dummy === seat && state.contract && !controlsSeat(state.controlledSide, state.contract.declarer)) return `Dummy is played by declarer ${state.contract.declarer}.`
	const leadSuit = state.currentTrick?.plays[0]?.card.suit
	if (leadSuit && card.suit !== leadSuit) return `Not legal now. Follow ${suitSymbols[leadSuit]} if you can.`
	return 'Not legal now.'
}

function rankLabel(rank: Card['rank']): string {
	return rank === 'T' ? '10' : rank
}

function sameCard(left: Card, right: Card): boolean {
	return left.rank === right.rank && left.suit === right.suit
}

function isDdsBestPlay(state: BoardView, seat: Seat, card: Card): boolean {
	const guidance = analysis?.dds.playGuidance
	return Boolean(!reviewMode && guidance && state.phase === 'play' && guidance.seat === seat && guidance.plays.some(play => play.best && sameCard(play.card, card)))
}

function reviewForPlayedCard(trickNumber: number, play: PlayedCard): PlayReview | undefined {
	return analysis?.dds.playReview?.find(review =>
		review.trickNumber === trickNumber
		&& review.seat === play.seat
		&& sameCard(review.card, play.card)
	)
}

function reviewClass(review: PlayReview | undefined): string {
	if (!review) return ''
	return review.label === 'no loss' ? 'review-ok' : 'review-mistake'
}

function formatAnalysisCard(value: string): string {
	const [seat, card] = value.split(':')
	const rank = card?.slice(0, -1)
	const suit = card?.slice(-1) as Card['suit'] | undefined
	return seat && rank && suit && suit in suitSymbols ? `${seat}:${rankLabel(rank as Card['rank'])}${suitSymbols[suit]}` : value
}

function sortHand(cards: readonly Card[]): Card[] {
	return [...cards].sort((left, right) => {
		const suitDelta = suitOrder.get(left.suit)! - suitOrder.get(right.suit)!
		return suitDelta || rankOrder.get(right.rank)! - rankOrder.get(left.rank)!
	})
}

function isRed(card: Card): boolean {
	return card.suit === 'D' || card.suit === 'H'
}

function roleLabel(role: PlayerRole): string {
	if (role === 'SPECTATOR') return 'Spectator'
	if (isSeatRole(role)) return `Seat ${role}`
	return `${role} side`
}

function playerSummary(state: BoardView): string {
	const ns = state.players.NS ? 'NS' : ['N', 'S'].filter(seat => state.players[seat as Seat]).join('+') || '--'
	const ew = state.players.EW ? 'EW' : ['E', 'W'].filter(seat => state.players[seat as Seat]).join('+') || '--'
	return `${ns} / ${ew}`
}

function robotSummary(state: BoardView): string {
	const robots = seats.filter(seat => state.robots[seat])
	return robots.length ? robots.join('+') : '--'
}

function robotSeatsFor(state: BoardView): readonly Seat[] {
	if (state.controlledSide === 'SPECTATOR') return []
	return seats.filter(seat => !controlsSeat(state.controlledSide, seat) && !state.players[seat] && !state.players[partnership(seat)])
}

function biddingSystemLabel(system: BiddingSystem): string {
	if (system === 'sayc') return 'SAYC'
	if (system === 'two-over-one') return '2/1'
	if (system === 'blue-club-modified') return 'Modified Blue Club'
	return 'Natural / Manual'
}

function canEditRoom(state: BoardView): boolean {
	return state.controlledSide !== 'SPECTATOR'
}

function canActNow(state: BoardView): boolean {
	return canEditRoom(state) && !state.pendingAgreement
}

function canPlayCurrentSeat(state: BoardView): boolean {
	if (state.phase !== 'play') return false
	if (state.dummy === state.currentTurn && state.contract) return controlsSeat(state.controlledSide, state.contract.declarer)
	return controlsSeat(state.controlledSide, state.currentTurn)
}

function agreementText(state: BoardView): string {
	const request = state.pendingAgreement
	if (!request) return 'No table request is waiting.'
	if (request.type === 'undo') return `${request.requestingSide} requested Undo for ${formatUndoDescription(request.undoDescription)}. ${request.respondingSide} must accept or reject.`
	return `${request.requestingSide} claimed ${request.claimRemaining ?? '?'} remaining trick${request.claimRemaining === 1 ? '' : 's'} for ${request.claimTricks} total. ${request.respondingSide} must accept or reject.`
}

function agreementTooltip(state: BoardView): string {
	const request = state.pendingAgreement
	if (!request) return tableMessagesTooltip(state)
	const lines = [agreementText(state)]
	if (request.claimNote) lines.push(`Note: ${request.claimNote}`)
	if (request.claimScore) lines.push(`Score if accepted: NS ${request.claimScore.NS} / EW ${request.claimScore.EW}`)
	return lines.join('\n')
}

/* The full seat-by-seat readout is a tooltip; the heading gets the count. */
function connectionSummary(state: BoardView): string {
	const seated = seats.filter(seat => state.connections[seat]).length
	const sides = (state.connections.NS ? 1 : 0) + (state.connections.EW ? 1 : 0)
	const parts = [`${seated + sides === 0 ? 'No one' : `${seated} of 4`} connected`]
	if (sides) parts.push(`${sides} side ${sides === 1 ? 'control' : 'controls'}`)
	if (state.connections.spectators) parts.push(`${state.connections.spectators} watching`)
	return parts.join(' · ')
}

function connectionText(state: BoardView): string {
	return `Connected seats: N ${state.connections.N ? 'yes' : 'no'}, E ${state.connections.E ? 'yes' : 'no'}, S ${state.connections.S ? 'yes' : 'no'}, W ${state.connections.W ? 'yes' : 'no'}. Full-side controls: NS ${state.connections.NS ? 'yes' : 'no'}, EW ${state.connections.EW ? 'yes' : 'no'}. Spectators ${state.connections.spectators}.`
}

function claimRange(state: BoardView): { min: number, max: number, value: number, current: number, remaining: number } | undefined {
	if (state.phase !== 'play' || !state.contract || rolePartnership(state.controlledSide) !== partnership(state.contract.declarer)) return undefined
	const declarerSide = partnership(state.contract.declarer)
	const min = state.tricksWon[declarerSide]
	const remainingCards = seats.reduce((total, seat) => total + state.seats[seat].handCount, 0)
	const remainingTricks = Math.ceil(remainingCards / 4)
	const max = Math.min(13, min + remainingTricks)
	const value = max
	return { min, max, value, current: min, remaining: remainingTricks }
}

function claimPreviewText(state: BoardView, total: number): string {
	if (!state.contract) return ''
	const declarerSide = partnership(state.contract.declarer)
	const alreadyWon = state.tricksWon[declarerSide]
	const remaining = Math.max(0, total - alreadyWon)
	const score = scoreContract(state.contract, total, state.vulnerability)
	return `${remaining} remaining, ${total} total. Score if accepted: NS ${score.ns} / EW ${score.ew}.`
}

function tableMessagesTooltip(state: BoardView): string {
	if (!state.tableMessages.length) return 'No table messages yet.'
	return state.tableMessages.slice(-8).map(message => `${new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${message.text}`).join('\n')
}

function firstUrl(text: string): string | undefined {
	return text.match(/https?:\/\/\S+/)?.[0]
}

function renderMessageText(text: string): DocumentFragment {
	const fragment = document.createDocumentFragment()
	const url = firstUrl(text)
	if (!url) {
		fragment.append(document.createTextNode(text))
		return fragment
	}
	const [before, ...after] = text.split(url)
	fragment.append(document.createTextNode(before ?? ''))
	const link = document.createElement('a')
	link.href = url
	link.textContent = url
	link.target = '_blank'
	link.rel = 'noreferrer'
	link.title = 'Open this room link.'
	fragment.append(link, document.createTextNode(after.join(url)))
	return fragment
}

function formatUndoDescription(value: string | undefined): string {
	if (!value) return 'the last action'
	return value.replace(/\b([1-7])([CDHS])\b/g, (_match, level: string, strain: Card['suit']) => `${level}${suitSymbols[strain]}`)
}

function visualSeatMap(state: BoardView): Record<Seat, 'north' | 'east' | 'south' | 'west'> {
	const bottom: Seat = seatMode === 'you-bottom'
		? isSeatRole(state.controlledSide) ? state.controlledSide : state.controlledSide === 'EW' ? 'E' : 'S'
		: 'S'
	const clockwise: readonly Seat[] = ['N', 'E', 'S', 'W']
	const bottomIndex = clockwise.indexOf(bottom)
	const at = (offset: number) => clockwise[(bottomIndex + offset + 4) % 4]!
	const map: Record<Seat, 'north' | 'east' | 'south' | 'west'> = { N: 'north', E: 'east', S: 'south', W: 'west' }
	map[at(0)] = 'south'
	map[at(1)] = 'west'
	map[at(2)] = 'north'
	map[at(3)] = 'east'
	return map
}

function gridPosition(area: 'north' | 'east' | 'south' | 'west'): Partial<CSSStyleDeclaration> {
	if (area === 'north') return { gridColumn: '2', gridRow: '1' }
	if (area === 'east') return { gridColumn: '3', gridRow: '2' }
	if (area === 'south') return { gridColumn: '2', gridRow: '3' }
	return { gridColumn: '1', gridRow: '2' }
}

function makeButton(label: string, className = ''): HTMLButtonElement {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = label
	if (className) button.className = className
	return button
}

/* A real card: corner index you can read when the hand is fanned, and a
   large pip so the suit reads at a glance on the fully exposed card. */
function appendCardFace(parent: HTMLElement, card: Card): void {
	const face = document.createElement('span')
	face.className = 'card-face'
	const index = document.createElement('span')
	index.className = 'card-index'
	const rank = document.createElement('span')
	rank.className = `card-rank ${card.rank === 'T' ? 'ten-rank' : ''}`
	rank.textContent = rankLabel(card.rank)
	const suit = document.createElement('span')
	suit.className = 'card-suit'
	suit.textContent = suitSymbols[card.suit]
	index.append(rank, suit)
	const pip = document.createElement('span')
	pip.className = 'card-pip'
	pip.textContent = suitSymbols[card.suit]
	pip.setAttribute('aria-hidden', 'true')
	face.append(index, pip)
	parent.append(face)
}

function renderCard(state: BoardView, seat: Seat, card: Card): HTMLButtonElement {
	const legal = !reviewMode && canActNow(state) && state.currentTurn === seat && state.legalPlays.includes(cardId(card))
	const best = isDdsBestPlay(state, seat, card)
	/* Only grey a card when it is this seat's turn and the card cannot be
	   played — that is the follow-suit cue. Never grey a hand at rest. */
	const barred = state.phase === 'play' && state.currentTurn === seat && !reviewMode && !legal
	const button = makeButton('', `card-button ${isRed(card) ? 'red' : ''} ${legal ? 'legal' : ''} ${barred ? 'barred' : ''} ${best ? 'dds-best' : ''}`)
	appendCardFace(button, card)
	button.disabled = !legal
	button.title = cardTitle(state, seat, card, legal, best)
	button.addEventListener('click', () => {
		void submitAction({ type: 'play', card })
	})
	return button
}

function renderSeat(state: BoardView, seat: Seat, area: 'north' | 'east' | 'south' | 'west'): HTMLElement {
	const seatView = state.seats[seat]
	const section = document.createElement('section')
	const hasLegalCards = state.phase === 'play' && state.currentTurn === seat && seatView.visible && Boolean(seatView.hand?.some(card => state.legalPlays.includes(cardId(card))))
	const isCurrentTurn = state.currentTurn === seat && state.phase !== 'complete' && state.phase !== 'passed-out'
	section.className = `seat ${area} ${hasLegalCards ? 'current playable-seat' : isCurrentTurn ? 'waiting-turn' : ''}`
	section.style.gridArea = area
	section.setAttribute('aria-label', `${seat} hand`)

	const header = document.createElement('div')
	header.className = 'seat-header'
	header.innerHTML = `<span class="seat-name">${seat}</span><span class="badge">${partnership(seat)}</span>`
	if (seat === state.dealer) header.lastElementChild!.textContent += ' dealer'
	if (seat === state.contract?.declarer) header.lastElementChild!.textContent += ' declarer'
	if (seat === state.dummy) header.lastElementChild!.textContent += ' dummy'
	if (seatView.controlled) header.lastElementChild!.textContent += ' you'

	const hand = document.createElement('div')
	hand.className = 'hand'
	if (seatView.visible && seatView.hand) {
		hand.setAttribute('aria-label', 'Hand ordered clubs, diamonds, hearts, spades')
		for (const card of sortHand(seatView.hand)) hand.append(renderCard(state, seat, card))
	} else {
		hand.classList.add('hidden-hand-grid')
		for (let index = 0; index < seatView.handCount; index++) {
			const back = document.createElement('span')
			back.className = 'hidden-hand'
			hand.append(back)
		}
	}

	section.append(header, hand)
	return section
}

function renderPlayedSlot(state: BoardView, play: PlayedCard | undefined, seat: Seat, area: 'north' | 'east' | 'south' | 'west', winner?: Seat, review?: PlayReview, liveWinner?: Seat): HTMLElement {
	const slot = document.createElement('div')
	slot.className = `played-slot ${area} ${winner === seat ? 'winner' : ''} ${liveWinner === seat ? 'live-winner' : ''}`
	Object.assign(slot.style, gridPosition(area))
	const lastCall = lastSeatCallLabel(state, seat)
	if (lastCall) {
		const bid = document.createElement('span')
		bid.className = 'seat-last-call'
		bid.textContent = lastCall
		bid.title = `${seat}'s last call: ${lastCall}`
		slot.append(bid)
	}
	if (play) {
		const card = document.createElement('span')
		card.className = `played-card ${isRed(play.card) ? 'red' : ''} ${reviewClass(review)}`
		card.title = review?.explanation ?? `${seat} played ${formatCard(play.card)}${liveWinner === seat ? ' and is currently winning this trick' : ''}.`
		const face = document.createElement('span')
		appendCardFace(face, play.card)
		card.append(face)
		if (review) {
			const label = document.createElement('small')
			label.className = 'review-card-label'
			label.textContent = review.label
			card.append(label)
		}
		slot.append(card)
	} else {
		const marker = document.createElement('span')
		marker.className = 'seat-marker'
		marker.textContent = seat
		slot.append(marker)
	}
	return slot
}

function reviewTricks(state: BoardView): ReviewTrick[] {
	const completed: ReviewTrick[] = state.completedTricks.map((trick, index) => ({
		number: index + 1,
		leader: trick.leader,
		plays: trick.plays,
		...(trick.winner ? { winner: trick.winner } : {}),
		complete: true
	}))
	if (state.currentTrick?.plays.length) {
		completed.push({
			number: completed.length + 1,
			leader: state.currentTrick.leader,
			plays: state.currentTrick.plays,
			complete: false
		})
	}
	return completed
}

function clampReviewTrickIndex(state: BoardView, index: number): number {
	const count = reviewTricks(state).length
	return count ? Math.min(Math.max(index, 0), count - 1) : 0
}

function renderCenter(state: BoardView): HTMLElement {
	const center = document.createElement('section')
	center.className = 'center'

	const contract = document.createElement('div')
	contract.className = 'contract'
	const tricks = reviewTricks(state)
	const reviewed = reviewMode ? tricks[selectedReviewTrick] : undefined
	const lastCompleted = !reviewed && state.phase === 'play' && !state.currentTrick?.plays.length ? state.completedTricks.at(-1) : undefined
	const subtitle = reviewed
		? `Review trick ${reviewed.number}${reviewed.complete ? '' : ' current'}`
		: lastCompleted
			? `Last trick ${state.completedTricks.length}`
		/* "Auction / auction" said nothing twice; show the standing bid.
		   In other phases the bare phase name repeats the line above it. */
		: state.phase === 'auction'
			? currentContractText(state)
		: ''
	contract.innerHTML = `<strong>${contractLabel(state)}</strong><span class="muted">${subtitle}</span>`

	if (reviewed) {
		const reviewNote = document.createElement('div')
		reviewNote.className = 'review-note'
		reviewNote.textContent = reviewed.winner ? `Winner: ${reviewed.winner}` : `Leader: ${reviewed.leader}`
		center.append(contract, reviewNote)
	} else if (lastCompleted?.winner) {
		const lastNote = document.createElement('div')
		lastNote.className = 'review-note'
		lastNote.textContent = `Winner: ${lastCompleted.winner}`
		center.append(contract, lastNote)
	} else {
		center.append(contract)
	}

	const playedGrid = document.createElement('div')
	playedGrid.className = 'played-grid'
	const seatMap = visualSeatMap(state)
	const liveWinner = !reviewed && state.currentTrick && state.contract ? winningPlay(state.currentTrick.plays, state.contract.strain)?.seat : undefined
	for (const seat of seats) {
		const play = reviewed
			? reviewed.plays.find(entry => entry.seat === seat)
			: lastCompleted
				? lastCompleted.plays.find(entry => entry.seat === seat)
			: state.currentTrick?.plays.find(entry => entry.seat === seat)
		const review = reviewed && play ? reviewForPlayedCard(reviewed.number, play) : undefined
		playedGrid.append(renderPlayedSlot(state, play, seat, seatMap[seat], reviewed?.winner ?? lastCompleted?.winner, review, liveWinner))
	}

	center.append(playedGrid)
	if (!reviewed && state.phase === 'play') {
		const playSummary = document.createElement('div')
		playSummary.className = 'play-summary'
		/* Whose turn it is is stated once, in the panel head. */
		const rows = [tableRoleText(state), currentTrickText(state)].filter(Boolean)
		for (const rowText of rows) {
			const row = document.createElement('div')
			row.textContent = rowText
			playSummary.append(row)
		}
		center.append(playSummary)
	}
	if (reviewed) {
		const reviews = reviewed.plays
			.map(play => reviewForPlayedCard(reviewed.number, play))
			.filter(review => review !== undefined)
		if (reviews.length) {
			const detail = document.createElement('div')
			detail.className = 'review-detail'
			const swing = reviews.find(review => review.label !== 'no loss')
			detail.textContent = swing
				? swing.explanation
				: reviews.map(review => `${review.seat}:${formatCard(review.card)} ${review.label}`).join('  |  ')
			detail.title = reviews.map(review => review.explanation).join('\n')
			center.append(detail)
		}
	}
	return center
}

function renderStats(state: BoardView): HTMLElement {
	const stats = document.createElement('section')
	stats.className = 'section stats'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Room Info'
	const rows = statsRows(state)
	const visibility = makeButton(statsVisible ? 'Hide' : 'Show')
	visibility.title = statsVisible ? 'Hide room details.' : rows.map(([label, value]) => `${label}: ${value}`).join('\n')
	visibility.addEventListener('click', () => {
		statsVisible = !statsVisible
		render()
	})
	header.append(title, visibility)
	stats.append(header)
	if (!statsVisible) return stats
	for (const [label, value] of rows) {
		const row = document.createElement('div')
		row.className = 'stat-row'
		row.innerHTML = `<span>${label}</span><strong>${value}</strong>`
		stats.append(row)
	}
	return stats
}

function statsRows(state: BoardView): [string, string][] {
	const rows: [string, string][] = [
		['Room', state.roomId],
		['You', roleLabel(state.controlledSide)],
		['Players', playerSummary(state)],
		['Robots', robotSummary(state)],
		['Board', String(state.boardNumber)],
		['Dealer', state.dealer],
		['Vulnerable', state.vulnerability.toUpperCase()],
		['Turn', state.phase === 'complete' || state.phase === 'passed-out' ? '-' : state.currentTurn],
		['Tricks NS', String(state.tricksWon.NS)],
		['Tricks EW', String(state.tricksWon.EW)]
	]
	if (state.phase === 'complete' && state.contract) {
		const declarerTricks = state.tricksWon[partnership(state.contract.declarer)]
		const score = scoreContract(state.contract, declarerTricks, state.vulnerability)
		rows.push(['Score NS', String(score.ns)], ['Score EW', String(score.ew)])
	}
	return rows
}

function renderBoardHistory(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section board-history-panel'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Boards'
	const count = document.createElement('span')
	count.className = 'muted board-count'
	count.textContent = `${state.boardHistory.length}`
	const visibility = makeButton(boardHistoryVisible ? 'Hide' : 'Show')
	visibility.title = boardHistoryVisible ? 'Hide board history.' : boardHistoryTooltip(state)
	visibility.addEventListener('click', () => {
		boardHistoryVisible = !boardHistoryVisible
		render()
	})
	header.append(title, count, visibility)
	section.append(header)
	if (!boardHistoryVisible) return section
	const list = document.createElement('div')
	list.className = 'history-list'
	for (const board of state.boardHistory) {
		const row = document.createElement('button')
		row.type = 'button'
		row.className = `trick-row board-history-row ${board.current ? 'active-board' : ''}`
		const summary = contractSummary(board.contract) || board.phase
		row.innerHTML = `<span>${board.current ? 'Current ' : ''}Board ${board.boardNumber}</span><strong>${summary} ${board.tricksWon.NS}-${board.tricksWon.EW}</strong>`
		row.disabled = board.current || !canEditRoom(state)
		row.title = board.current ? 'This board is already active.' : canEditRoom(state) ? 'Make this the active room board.' : 'Spectators cannot change the active board.'
		row.addEventListener('click', () => void submitAction({ type: 'jumpBoard', boardId: board.id }))
		list.append(row)
	}
	section.append(list)
	return section
}

function boardHistoryTooltip(state: BoardView): string {
	if (!state.boardHistory.length) return 'No boards yet.'
	return state.boardHistory.map(board => {
		const summary = contractSummary(board.contract) || board.phase
		return `${board.current ? 'Current ' : ''}Board ${board.boardNumber}: ${summary}, tricks ${board.tricksWon.NS}-${board.tricksWon.EW}`
	}).join('\n')
}

function renderMatchResults(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section results-panel'
	const totals = matchTotals(state)

	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Results'
	const copy = makeButton('Copy')
	copy.title = 'Copy room results as CSV for Excel or Google Sheets.'
	copy.disabled = !state.boardHistory.length
	copy.addEventListener('click', () => copyMatchResults(state))
	const download = makeButton('CSV')
	download.title = 'Download room results as a .csv file.'
	download.disabled = !state.boardHistory.length
	download.addEventListener('click', () => downloadMatchResults(state))
	const visibility = makeButton(resultsVisible ? 'Hide' : 'Show')
	visibility.title = resultsVisible ? 'Hide match results.' : matchResultsTooltip(state)
	visibility.addEventListener('click', () => {
		resultsVisible = !resultsVisible
		render()
	})
	header.append(title, copy, download, visibility)
	section.append(header)

	if (!resultsVisible) return section

	const totalGrid = document.createElement('div')
	totalGrid.className = 'results-totals'
	for (const [label, value] of [
		['NS', String(totals.ns)],
		['EW', String(totals.ew)],
		['Scored', `${totals.scored}/${state.boardHistory.length}`]
	]) {
		const item = document.createElement('div')
		item.innerHTML = `<span>${label}</span><strong>${value}</strong>`
		totalGrid.append(item)
	}
	const leader = document.createElement('p')
	leader.className = 'muted result-leader'
	leader.textContent = matchLeaderText(totals)
	section.append(totalGrid, leader)

	const list = document.createElement('div')
	list.className = 'results-list'
	for (const board of state.boardHistory) {
		const row = document.createElement('button')
		row.type = 'button'
		const score = boardScore(board)
		row.className = `result-row ${board.current ? 'active-board' : ''} ${score && score.ns !== 0 ? score.ns > 0 ? 'ns-win' : 'ew-win' : ''}`
		row.disabled = board.current || !canEditRoom(state)
		row.title = resultTooltip(board, score)
		row.addEventListener('click', () => void submitAction({ type: 'jumpBoard', boardId: board.id }))

		const boardLabel = document.createElement('span')
		boardLabel.textContent = `${board.current ? 'Current ' : ''}Board ${board.boardNumber}`
		const contract = document.createElement('strong')
		contract.textContent = contractSummary(board.contract) || board.phase
		const result = document.createElement('span')
		result.textContent = boardResultText(board)
		const meta = document.createElement('span')
		meta.textContent = `${boardDeclarerSide(board)} ${board.vulnerability.toUpperCase()} ${board.tricksWon.NS}-${board.tricksWon.EW}`
		meta.title = `Declarer side, vulnerability, tricks: ${boardDeclarerSide(board)} ${board.vulnerability.toUpperCase()} ${board.tricksWon.NS}-${board.tricksWon.EW}`
		const scoreText = document.createElement('strong')
		scoreText.textContent = score ? `${score.ns > 0 ? '+' : ''}${score.ns}` : '-'
		scoreText.title = score ? `NS ${score.ns} / EW ${score.ew}` : 'Board is not scored yet.'
		row.append(boardLabel, contract, result, meta, scoreText)
		list.append(row)
	}
	section.append(list)
	return section
}

/* Playing a board and administering the room are different jobs, so they
   live in different groups. This one is only the room's own settings. */
function renderRoomAdmin(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section session-panel'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Session'
	const status = document.createElement('span')
	status.className = `connection-status ${connectionStatus}`
	status.textContent = connectionStatus
	header.append(title, status)

	const nameForm = document.createElement('div')
	nameForm.className = 'room-name-form'
	const nameLabel = document.createElement('label')
	nameLabel.textContent = 'Room name'
	const nameInput = document.createElement('input')
	nameInput.maxLength = 60
	nameInput.placeholder = 'Optional name'
	nameInput.value = roomNameDraft ?? state.roomMeta?.label ?? ''
	nameInput.title = 'Give this saved room a friendly name.'
	nameInput.addEventListener('input', () => {
		roomNameDraft = nameInput.value
	})
	nameLabel.append(nameInput)
	const saveName = makeButton('Save Name')
	saveName.title = 'Save this friendly room name.'
	saveName.addEventListener('click', () => void renameRoom())
	nameForm.append(nameLabel, saveName)

	const sides = document.createElement('div')
	sides.className = 'side-choice'
	for (const side of privateSeatRoles) {
		const button = makeButton(roleLabel(side))
		button.className = side === state.controlledSide ? 'active-side' : ''
		button.title = side === state.controlledSide
			? `You are sitting ${side}. Only this browser can see ${side}'s hand.`
			: `Sit ${side}. This browser will see only ${side}'s hand until dummy or the end.`
		button.disabled = side === state.controlledSide
		button.addEventListener('click', () => void switchSide(side))
		sides.append(button)
	}

	const tableControls = document.createElement('div')
	tableControls.className = 'side-choice compact-side-choice'
	for (const side of tableControlRoles) {
		const button = makeButton(roleLabel(side))
		button.className = side === state.controlledSide ? 'active-side' : ''
		button.title = side === state.controlledSide
			? side === 'SPECTATOR' ? 'You are watching without controlling cards or calls.' : `You control both ${side} hands for testing or solo review.`
			: side === 'SPECTATOR' ? 'Watch this room without controlling cards or calls.' : `Switch this browser to full ${side} side control for testing or solo review.`
		button.disabled = side === state.controlledSide
		button.addEventListener('click', () => void switchSide(side))
		tableControls.append(button)
	}

	const conflict = document.createElement('div')
	conflict.className = 'session-actions'
	if (switchConflictSide) {
		const takeover = makeButton(`Take over ${switchConflictSide}`)
		takeover.title = `Move ${switchConflictSide} control to this browser.`
		takeover.addEventListener('click', () => void switchSide(switchConflictSide!, true))
		conflict.append(takeover)
	}

	const roomActions = document.createElement('div')
	roomActions.className = 'session-actions'
	const reconnect = makeButton('Reconnect')
	reconnect.title = 'Reconnect this browser to the current room.'
	reconnect.addEventListener('click', reconnectRoom)
	const newSouth = makeButton('New Seat S')
	newSouth.title = 'Create a new private room sitting South.'
	newSouth.addEventListener('click', () => void createRoom('S'))
	const newSpectator = makeButton('New Watch')
	newSpectator.title = 'Create a new private room as a spectator.'
	newSpectator.addEventListener('click', () => void createRoom('SPECTATOR'))
	roomActions.append(reconnect, newSouth, newSpectator)

	if (state.controlledSide === 'SPECTATOR') {
		const note = document.createElement('p')
		note.className = 'muted session-note'
		note.textContent = 'Spectator mode is watch-only. Switch to a seat to bid, play, deal, import, or undo.'
		section.append(header, nameForm)
		section.append(sides, tableControls, conflict, roomActions, note)
	} else {
		section.append(header, nameForm)
		section.append(sides, tableControls, conflict, roomActions)
	}

	const saveStatus = document.createElement('p')
	saveStatus.className = 'muted session-note'
	const savedAt = state.persistence?.savedAt
	saveStatus.textContent = savedAt
		? `${state.roomMeta?.archived ? 'Archived' : state.persistence?.restored ? 'Restored and saved locally' : 'Saved locally'} ${new Date(savedAt).toLocaleString()}.`
		: 'Room will be saved locally after the next change.'
	const persistenceActions = document.createElement('div')
	persistenceActions.className = 'session-actions'
	const saveNow = makeButton('Save Now')
	saveNow.title = 'Write this room to local storage now.'
	saveNow.addEventListener('click', () => void saveRoomNow())
	const backup = makeButton('Backup')
	backup.title = 'Download a full JSON backup of this room.'
	backup.addEventListener('click', () => void backupRoom())
	const copyBackup = makeButton('Copy Backup')
	copyBackup.title = 'Copy a full JSON backup of this room to the clipboard.'
	copyBackup.addEventListener('click', () => void copyRoomBackup())
	const duplicate = makeButton('Duplicate')
	duplicate.title = 'Create a separate copy of this room. Nobody is seated in the new copy yet.'
	duplicate.addEventListener('click', () => void duplicateCurrentRoom())
	const archive = makeButton(state.roomMeta?.archived ? 'Restore' : 'Archive')
	archive.title = state.roomMeta?.archived
		? 'Move this room back to the active saved-room list.'
		: 'Hide this room from the active saved-room list without deleting it.'
	archive.addEventListener('click', () => void archiveCurrentRoom(!state.roomMeta?.archived))
	const forget = makeButton('Forget')
	forget.title = 'Remove this room from saved local rooms.'
	forget.addEventListener('click', () => {
		if (confirmForgetRoom(state)) void forgetCurrentRoom()
	})
	persistenceActions.append(saveNow, backup, copyBackup, duplicate, archive, forget)
	section.append(saveStatus, persistenceActions)

	const viewLabel = document.createElement('label')
	viewLabel.className = 'seat-mode'
	const toggle = document.createElement('input')
	toggle.type = 'checkbox'
	toggle.checked = seatMode === 'you-bottom'
	toggle.addEventListener('change', () => {
		storeSeatMode(toggle.checked ? 'you-bottom' : 'fixed')
		render()
	})
	viewLabel.append(toggle, document.createTextNode(' Seat me at bottom'))

	section.append(viewLabel)
	return section
}

function renderBiddingSystemControl(state: BoardView): HTMLElement {
	const systemForm = document.createElement('label')
	systemForm.className = 'system-profile'
	systemForm.textContent = 'Bidding system'
	const systemSelect = document.createElement('select')
	systemSelect.disabled = !canEditRoom(state) || state.auction.length > 0
	systemSelect.title = state.auction.length > 0
		? 'Bidding system is locked after the first call.'
		: canEditRoom(state) ? 'Choose the profile used for bid explanations.' : 'Spectators can see the profile but cannot change it.'
	for (const system of biddingSystems) {
		const option = document.createElement('option')
		option.value = system
		option.textContent = biddingSystemLabel(system)
		systemSelect.append(option)
	}
	systemSelect.value = state.roomMeta?.biddingSystem ?? 'natural'
	systemSelect.addEventListener('change', () => void setBiddingSystem(systemSelect.value as BiddingSystem))
	systemForm.append(systemSelect)
	return systemForm
}

function renderSpectatorVisibilityControl(state: BoardView): HTMLElement {
	const label = document.createElement('label')
	label.className = 'system-profile'
	label.textContent = 'Spectator hands'
	const select = document.createElement('select')
	select.disabled = !canEditRoom(state)
	select.title = canEditRoom(state)
		? 'Choose whether spectators see only public cards or all four hands.'
		: 'Spectators can see this setting but cannot change it.'
	const publicOption = document.createElement('option')
	publicOption.value = 'public'
	publicOption.textContent = 'Public only'
	const allOption = document.createElement('option')
	allOption.value = 'all'
	allOption.textContent = 'All hands'
	select.append(publicOption, allOption)
	select.value = state.roomMeta?.spectatorSeeAll ? 'all' : 'public'
	select.addEventListener('change', () => void setSpectatorSeeAll(select.value === 'all'))
	label.append(select)
	return label
}

function renderSetupPanel(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section session-panel'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Setup'
	header.append(title)
	section.append(header)
	section.append(renderBiddingSystemControl(state))
	if (!state.auction.length && !allIndividualSeatsClaimed(state)) {
		section.append(renderRobotControls(state))
		const robotNote = document.createElement('p')
		robotNote.className = 'muted session-note'
		robotNote.textContent = 'Robot seats bid and play automatically for that seat using the room bidding system and DDS-guided play.'
		section.append(robotNote)
	}
	section.append(renderSpectatorVisibilityControl(state))
	const spectatorNote = document.createElement('p')
	spectatorNote.className = 'muted session-note'
	spectatorNote.textContent = 'Spectator hands controls what watchers can see: public cards only, or all four hands for review/testing.'
	section.append(spectatorNote)
	return section
}

function renderRobotControls(state: BoardView): HTMLElement {
	const robotControls = document.createElement('div')
	robotControls.className = 'robot-controls'
	const robotSeats = robotSeatsFor(state)
	if (!robotSeats.length) {
		const note = document.createElement('p')
		note.className = 'muted session-note'
		note.textContent = 'Switch to a seat to choose robot partners or opponents.'
		robotControls.append(note)
		return robotControls
	}
	for (const seat of robotSeats) {
		const label = document.createElement('label')
		label.className = 'robot-toggle'
		const checkbox = document.createElement('input')
		checkbox.type = 'checkbox'
		checkbox.checked = state.robots[seat]
		checkbox.disabled = !canEditRoom(state)
		checkbox.title = canEditRoom(state)
			? `${state.robots[seat] ? 'Disable' : 'Enable'} robot ${seat}. Robot ${seat} bids using the room bidding system and plays automatically with DDS-guided play.`
			: 'Spectators cannot change robot seats.'
		checkbox.addEventListener('change', () => void setRobotSeat(seat, checkbox.checked))
		label.append(checkbox, document.createTextNode(` Robot ${seat}`))
		robotControls.append(label)
	}
	return robotControls
}

function allIndividualSeatsClaimed(state: BoardView): boolean {
	return seats.every(seat => state.players[seat])
}

function renderAgreementPanel(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section agreement-panel'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Table'
	const status = document.createElement('span')
	status.className = 'muted table-status'
	status.textContent = connectionSummary(state)
	status.title = connectionText(state)
	const messagesToggle = makeButton(tableMessagesVisible ? 'Hide' : 'Show')
	messagesToggle.title = tableMessagesVisible ? 'Hide table messages.' : tableMessagesTooltip(state)
	messagesToggle.addEventListener('click', () => {
		tableMessagesVisible = !tableMessagesVisible
		render()
	})
	header.append(title, status, messagesToggle)
	section.append(header)

	if (state.pendingAgreement) {
		const request = state.pendingAgreement
		const box = document.createElement('div')
		box.className = 'agreement-request'
		const text = document.createElement('p')
		text.textContent = agreementText(state)
		text.title = agreementTooltip(state)
		if (request.type === 'claim') {
			const detail = document.createElement('p')
			detail.className = 'muted agreement-detail'
			detail.textContent = [
				request.claimNote ? `Note: ${request.claimNote}` : '',
				request.claimScore ? `Score if accepted: NS ${request.claimScore.NS} / EW ${request.claimScore.EW}` : ''
			].filter(Boolean).join('  ')
			if (detail.textContent) box.append(detail)
		}
		const actions = document.createElement('div')
		actions.className = 'session-actions'
		const controlledPartnership = rolePartnership(state.controlledSide)
		if (controlledPartnership === request.respondingSide) {
			const accept = makeButton('Accept')
			accept.title = request.type === 'undo' ? 'Accept and undo the last action.' : 'Accept the claim and score the board.'
			accept.addEventListener('click', () => void respondAgreement(true))
			const reject = makeButton('Reject')
			reject.title = request.type === 'undo' ? 'Reject the Undo request.' : 'Reject the claim and continue playing.'
			reject.addEventListener('click', () => void respondAgreement(false))
			actions.append(accept, reject)
		} else if (controlledPartnership === request.requestingSide) {
			const cancel = makeButton('Cancel')
			cancel.title = 'Cancel your table request.'
			cancel.addEventListener('click', () => void respondAgreement(false, true))
			actions.append(cancel)
		} else {
			const waiting = document.createElement('p')
			waiting.className = 'muted'
			waiting.textContent = 'Spectator view: waiting for the seated side to answer.'
			actions.append(waiting)
		}
		box.prepend(text)
		box.append(actions)
		section.append(box)
	}

	const claim = claimRange(state)
	if (claim) {
		const claimForm = document.createElement('div')
		claimForm.className = 'claim-form'
		const label = document.createElement('label')
		label.textContent = 'Final declarer tricks'
		const input = document.createElement('input')
		input.type = 'number'
		input.min = String(claim.min)
		input.max = String(claim.max)
		input.value = String(claim.value)
		input.disabled = Boolean(state.pendingAgreement)
		input.title = `Claim a final total between ${claim.min} and ${claim.max} declarer tricks.`
		label.append(input)
		const noteLabel = document.createElement('label')
		noteLabel.textContent = 'Claim note'
		const note = document.createElement('input')
		note.maxLength = 140
		note.placeholder = 'Optional'
		note.value = claimNoteDraft
		note.disabled = Boolean(state.pendingAgreement)
		note.title = 'Optional claim explanation, for example: drawing trumps, conceding one club.'
		note.addEventListener('input', () => {
			claimNoteDraft = note.value
		})
		noteLabel.append(note)
		const preview = document.createElement('p')
		preview.className = 'muted claim-preview'
		const updatePreview = () => {
			const value = Math.max(claim.min, Math.min(claim.max, Math.trunc(Number(input.value) || claim.value)))
			preview.textContent = `Already won ${claim.current}. ${claimPreviewText(state, value)}`
		}
		input.addEventListener('input', updatePreview)
		updatePreview()
		const button = makeButton('Claim')
		button.disabled = Boolean(state.pendingAgreement)
		button.title = state.pendingAgreement ? 'Answer the pending table request first.' : 'Ask defenders to accept this claim.'
		button.addEventListener('click', () => void requestClaim(Number(input.value), claimNoteDraft))
		claimForm.append(label, noteLabel, preview, button)
		section.append(claimForm)
	}

	if (state.tableMessages.length && tableMessagesVisible) {
		const list = document.createElement('div')
		list.className = 'table-message-list'
		for (const message of state.tableMessages.slice(-6).reverse()) {
			const row = document.createElement('div')
			row.className = 'table-message'
			const time = document.createElement('span')
			time.textContent = new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			const text = document.createElement('strong')
			text.append(renderMessageText(message.text))
			row.append(time, text)
			const url = firstUrl(message.text)
			if (url) {
				const copyUrl = makeButton('Copy')
				copyUrl.className = 'message-copy'
				copyUrl.title = 'Copy this link.'
				copyUrl.addEventListener('click', () => {
					void navigator.clipboard.writeText(url).catch(() => {
						errorMessage = 'Could not copy link.'
						render()
					})
				})
				row.append(copyUrl)
			}
			list.append(row)
		}
		section.append(list)
	}

	return section
}

function renderAuctionControls(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section auction-controls'
	const ownsTurn = state.phase === 'auction' && controlsSeat(state.controlledSide, state.currentTurn) && !state.pendingAgreement

	/* Whose turn and what the contract stands at are stated once, in the
	   panel head. Here we only carry what the bid buttons need for context. */
	const context = document.createElement('div')
	context.className = 'auction-context'
	const currentLabel = document.createElement('span')
	currentLabel.textContent = `Standing bid: ${currentBidLabel(state)}`
	const lastLabel = document.createElement('strong')
	lastLabel.textContent = `Last call: ${lastCallLabel(state)}`
	context.append(currentLabel, lastLabel)

	/* A bidding box, the way it sits on a real table: every call laid out
	   in the grid, one click to make it, illegal calls left in the box. */
	const box = document.createElement('div')
	box.className = 'bidding-box'
	const ladder = document.createElement('div')
	ladder.className = 'bid-ladder'
	for (let level = 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7; level <= 7; level++) {
		for (const strain of strains) {
			const call: Call = { type: 'bid', level, strain }
			const legal = state.legalCalls.includes(callId(call))
			const button = document.createElement('button')
			button.type = 'button'
			button.className = `bid-card ${strain === 'H' || strain === 'D' ? 'red' : ''} ${strain === 'NT' ? 'notrump' : ''}`
			const number = document.createElement('span')
			number.className = 'bid-level'
			number.textContent = String(level)
			const mark = document.createElement('span')
			mark.className = 'bid-strain'
			mark.textContent = strainLabel(strain)
			button.append(number, mark)
			button.disabled = !ownsTurn || !legal
			button.setAttribute('aria-label', `Bid ${level} ${strain === 'NT' ? 'no trump' : strain}`)
			button.title = ownsTurn && legal ? selectedBidTitle(state, call, ownsTurn) : auctionActionTitle(state, call, legal)
			if (ownsTurn && legal) {
				const preview = (): void => void refreshSelectedBidPreview(state, call, button)
				button.addEventListener('pointerenter', preview)
				button.addEventListener('focus', preview)
			}
			button.addEventListener('click', () => void submitAction({ type: 'call', call }))
			ladder.append(button)
		}
	}
	box.append(ladder)

	const callButtons = document.createElement('div')
	callButtons.className = 'call-buttons'
	/* Pass green, double red, redouble blue — the bidding box's own colours. */
	const otherCalls = [
		{ call: { type: 'pass' } as const, tone: 'pass' },
		{ call: { type: 'double' } as const, tone: 'double' },
		{ call: { type: 'redouble' } as const, tone: 'redouble' }
	]
	for (const { call, tone } of otherCalls) {
		const button = document.createElement('button')
		button.type = 'button'
		button.className = `bid-call bid-call-${tone}`
		button.textContent = callLabel(call)
		const legal = state.legalCalls.includes(callId(call))
		button.disabled = !ownsTurn || !legal
		button.title = state.pendingAgreement ? 'Answer the pending table request first.' : auctionActionTitle(state, call, legal)
		button.addEventListener('click', () => void submitAction({ type: 'call', call }))
		callButtons.append(button)
	}
	box.append(callButtons)

	const inlineError = document.createElement('div')
	inlineError.className = 'error auction-error'
	inlineError.setAttribute('role', 'status')
	inlineError.textContent = errorMessage

	const rescue = document.createElement('div')
	rescue.className = 'latest-alert-panel'
	if (canOfferRobotForCurrentTurn(state)) {
		const note = document.createElement('p')
		note.className = 'muted'
		note.textContent = `${state.currentTurn} is not connected and is not a robot.`
		const button = makeButton(`Make ${state.currentTurn} Robot`)
		button.title = `Let robot ${state.currentTurn} bid and play automatically from now on.`
		button.addEventListener('click', () => void setRobotSeat(state.currentTurn, true))
		rescue.append(note, button)
	}

	section.append(context, box, renderLatestAlertPrompt(state), rescue, inlineError)
	return section
}

function renderLatestAlertPrompt(state: BoardView): HTMLElement {
	const panel = document.createElement('div')
	panel.className = 'latest-alert-panel'
	const index = latestExplainableCallIndex(state)
	if (index === undefined) {
		const note = document.createElement('p')
		note.className = 'muted'
		note.textContent = state.auction.length
			? 'Alerts for opponent calls appear in the Auction list.'
			: 'After your side makes a call, its Alert/Explain control appears here.'
		panel.append(note)
		return panel
	}
	const entry = state.auction[index]!
	const suggestion = alertSuggestionForCall(state, index)
	const heading = document.createElement('div')
	heading.className = 'auction-context'
	const label = document.createElement('span')
	label.textContent = entry.alert
		? `Explained: ${entry.seat} ${callLabel(entry.call)}`
		: suggestion ? `${suggestion.label}: ${entry.seat} ${callLabel(entry.call)}` : `Latest call from your side: ${entry.seat} ${callLabel(entry.call)}`
	const button = makeButton(entry.alert ? 'Edit Explanation' : 'Alert / Explain')
	button.title = entry.alert ? 'Edit the explanation shown to opponents and spectators.' : 'Add an explanation shown to opponents and spectators.'
	button.addEventListener('click', () => {
		selectedAlertIndex = selectedAlertIndex === index ? undefined : index
		alertExplanationDraft = entry.alert?.explanation ?? suggestion?.explanation ?? ''
		render()
	})
	heading.append(label, button)
	panel.append(heading)
	if (entry.alert?.explanation) {
		const current = document.createElement('p')
		current.className = 'muted latest-alert-text'
		current.textContent = entry.alert.explanation
		current.title = `Explained by ${entry.alert.explainedBy}: ${entry.alert.explanation}`
		panel.append(current)
	} else if (suggestion) {
		const suggested = document.createElement('p')
		suggested.className = 'muted latest-alert-text suggested-alert'
		suggested.textContent = suggestion.explanation
		suggested.title = `Suggested by ${biddingSystemLabel(state.roomMeta?.biddingSystem ?? 'natural')}. Click Alert / Explain to save or edit it.`
		panel.append(suggested)
	}
	if (selectedAlertIndex === index) panel.append(renderAlertEditor(state, entry, index))
	return panel
}

function renderAuctionHistory(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Auction'
	const summary = document.createElement('span')
	summary.className = 'muted auction-summary-note'
	summary.textContent = state.auction.length
		? `${state.auction.length} call${state.auction.length === 1 ? '' : 's'}`
		: `${state.dealer} deals`
	summary.title = auctionTooltip(state)
	header.append(title, summary)
	section.append(header)
	/* The auction as bridge writes it: one column per seat, clockwise from
	   North, the dealer's column first filled. Reading down a column shows
	   what one partnership did; reading across shows the bidding in order. */
	const grid = document.createElement('div')
	grid.className = 'auction-grid'
	for (const seat of seats) {
		const head = document.createElement('span')
		head.className = `auction-col ${seat === state.dealer ? 'dealer-col' : ''}`
		head.textContent = seat
		head.title = seat === state.dealer ? `${seat} dealt this board.` : `${seat}'s calls.`
		grid.append(head)
	}
	const offset = seats.indexOf(state.dealer)
	for (let slot = 0; slot < offset; slot++) {
		const blank = document.createElement('span')
		blank.className = 'auction-cell blank'
		blank.textContent = '\u2014'
		grid.append(blank)
	}
	state.auction.forEach((entry, index) => {
		const cell = document.createElement('button')
		cell.type = 'button'
		const bid = entry.call.type === 'bid' ? entry.call : undefined
		const red = bid && (bid.strain === 'H' || bid.strain === 'D')
		const last = index === state.auction.length - 1
		cell.className = `auction-cell ${red ? 'red' : ''} ${last ? 'latest' : ''} ${selectedCallIndex === index ? 'chosen' : ''}`
		cell.textContent = callLabel(entry.call)
		cell.title = auctionCallTitle(state, entry)
		if (entry.alert || alertSuggestionForCall(state, index)) {
			const mark = document.createElement('span')
			mark.className = `alert-dot ${entry.alert ? 'explained' : 'suggested'}`
			mark.textContent = entry.alert ? '\u25CF' : '\u25CB'
			cell.append(mark)
		}
		cell.addEventListener('click', () => {
			selectedCallIndex = selectedCallIndex === index ? undefined : index
			selectedAlertIndex = undefined
			selectedAlertQuestionIndex = undefined
			render()
		})
		grid.append(cell)
	})
	if (state.phase === 'auction' && state.auction.length) {
		const waiting = document.createElement('span')
		waiting.className = 'auction-cell awaiting'
		waiting.textContent = '?'
		waiting.title = `${state.currentTurn} is to call.`
		grid.append(waiting)
	}
	section.append(grid)

	const chosen = selectedCallIndex !== undefined ? state.auction[selectedCallIndex] : undefined
	if (chosen && selectedCallIndex !== undefined) {
		const index = selectedCallIndex
		const detail = document.createElement('div')
		detail.className = 'auction-detail'
		const heading = document.createElement('div')
		heading.className = 'auction-detail-head'
		const who = document.createElement('strong')
		who.textContent = `${chosen.seat} ${callLabel(chosen.call)}`
		heading.append(who)
		if (canExplainAuctionCall(state, chosen)) {
			const explain = makeButton(chosen.alert ? 'Edit' : 'Alert')
			explain.title = chosen.alert ? 'Edit this call explanation.' : 'Add an alert/explanation for this call.'
			explain.addEventListener('click', () => {
				selectedAlertIndex = selectedAlertIndex === index ? undefined : index
				alertExplanationDraft = chosen.alert?.explanation ?? alertSuggestionForCall(state, index)?.explanation ?? ''
				render()
			})
			heading.append(explain)
		}
		if (canAskAlertQuestion(state, chosen)) {
			const ask = makeButton('Ask')
			ask.title = 'Ask a follow-up question about this explanation.'
			ask.addEventListener('click', () => {
				selectedAlertQuestionIndex = selectedAlertQuestionIndex === index ? undefined : index
				alertQuestionDraft = ''
				render()
			})
			heading.append(ask)
		}
		detail.append(heading)
		if (!chosen.alert) {
			const suggestion = alertSuggestionForCall(state, index)
			const note = document.createElement('p')
			note.className = 'muted'
			note.textContent = suggestion
				? `${suggestion.explanation} — suggested by ${biddingSystemLabel(state.roomMeta?.biddingSystem ?? 'natural')}, not yet agreed at the table.`
				: 'No explanation on this call.'
			detail.append(note)
		}
		section.append(detail)
		if (chosen.alert) section.append(renderAlertThread(state, chosen, index))
		if (selectedAlertIndex === index && canExplainAuctionCall(state, chosen)) {
			section.append(renderAlertEditor(state, chosen, index))
		}
		if (selectedAlertQuestionIndex === index && canAskAlertQuestion(state, chosen)) {
			section.append(renderAlertQuestionEditor(index))
		}
	} else if (state.auction.length) {
		const hint = document.createElement('p')
		hint.className = 'muted auction-hint'
		hint.textContent = 'Pick a call to read or add its explanation.'
		section.append(hint)
	}
	return section
}

function renderAlertThread(state: BoardView, entry: BoardView['auction'][number], index: number): HTMLElement {
	const thread = document.createElement('div')
	thread.className = 'alert-thread'
	const alert = entry.alert
	const explanation = document.createElement('p')
	explanation.innerHTML = `<strong>Explanation</strong> ${alert?.explanation ?? ''}`
	thread.append(explanation)
	if (!alert) return thread
	for (const question of alert?.questions ?? []) {
		const item = document.createElement('div')
		item.className = `alert-question ${question.answer ? '' : 'unanswered'}`
		const questionText = document.createElement('p')
		questionText.innerHTML = `<strong>Q ${question.askedBy}</strong> ${question.question}`
		item.append(questionText)
		if (question.answer) {
			const answer = document.createElement('p')
			answer.innerHTML = `<strong>A ${question.answeredBy ?? alert.explainedBy}</strong> ${question.answer}`
			item.append(answer)
		} else if (canAnswerAlertQuestion(state, entry)) {
			const answer = document.createElement('div')
			answer.className = 'alert-answer'
			const input = document.createElement('input')
			input.placeholder = 'Answer question'
			input.maxLength = 240
			input.value = alertAnswerDrafts.get(question.id) ?? ''
			input.addEventListener('input', () => {
				alertAnswerDrafts.set(question.id, input.value)
			})
			const button = makeButton('Answer')
			button.addEventListener('click', () => void answerAlertQuestion(index, question.id, input.value))
			answer.append(input, button)
			item.append(answer)
		} else {
			const waiting = document.createElement('p')
			waiting.className = 'muted'
			waiting.textContent = 'Waiting for answer.'
			item.append(waiting)
		}
		thread.append(item)
	}
	return thread
}

function renderAlertQuestionEditor(index: number): HTMLElement {
	const editor = document.createElement('div')
	editor.className = 'alert-editor'
	const label = document.createElement('label')
	label.textContent = 'Ask about this explanation'
	const input = document.createElement('textarea')
	input.maxLength = 180
	input.value = alertQuestionDraft
	input.placeholder = 'Example: Is this forcing? How many cards? What strength?'
	input.addEventListener('input', () => {
		alertQuestionDraft = input.value
	})
	label.append(input)
	const actions = document.createElement('div')
	actions.className = 'session-actions'
	const ask = makeButton('Ask')
	ask.addEventListener('click', () => void askAlertQuestion(index, alertQuestionDraft))
	const cancel = makeButton('Cancel')
	cancel.addEventListener('click', () => {
		selectedAlertQuestionIndex = undefined
		alertQuestionDraft = ''
		render()
	})
	actions.append(ask, cancel)
	editor.append(label, actions)
	return editor
}

function renderAlertEditor(state: BoardView, entry: BoardView['auction'][number], index: number): HTMLElement {
	const editor = document.createElement('div')
	editor.className = 'alert-editor'
	const suggestion = alertSuggestionForCall(state, index)
	const label = document.createElement('label')
	label.textContent = `Explain ${entry.seat} ${callLabel(entry.call)}`
	const input = document.createElement('textarea')
	input.maxLength = 240
	input.value = alertExplanationDraft
	input.placeholder = 'Example: transfer to hearts, artificial, forcing, weak two...'
	input.title = 'This explanation is shown to opponents and spectators.'
	input.addEventListener('input', () => {
		alertExplanationDraft = input.value
	})
	label.append(input)
	const templates = document.createElement('div')
	templates.className = 'alert-templates'
	const templateValues = suggestion ? [suggestion.explanation, ...explanationTemplates] : [...explanationTemplates]
	for (const template of [...new Set(templateValues)]) {
		const chip = makeButton(template)
		chip.title = `Use "${template}".`
		chip.addEventListener('click', () => {
			alertExplanationDraft = template
			input.value = template
		})
		templates.append(chip)
	}
	const actions = document.createElement('div')
	actions.className = 'session-actions'
	const save = makeButton('Save')
	save.title = 'Save this alert/explanation.'
	save.addEventListener('click', () => void explainAuctionCall(index, alertExplanationDraft))
	const clear = makeButton('Clear')
	clear.disabled = !entry.alert
	clear.title = 'Remove this alert/explanation.'
	clear.addEventListener('click', () => void explainAuctionCall(index, ''))
	const cancel = makeButton('Cancel')
	cancel.addEventListener('click', () => {
		selectedAlertIndex = undefined
		alertExplanationDraft = ''
		render()
	})
	actions.append(save, clear, cancel)
	editor.append(label, templates, actions)
	return editor
}

function auctionTooltip(state: BoardView): string {
	if (!state.auction.length) return 'No calls yet.'
	return state.auction.map((entry, index) => {
		const alert = auctionCallAlertLabel(entry)
		const suggestion = alert ? undefined : alertSuggestionForCall(state, index)
		return `${entry.seat}: ${callLabel(entry.call)}${alert ? ` - ${alert}` : suggestion ? ` - Suggested: ${suggestion.explanation}` : ''}`
	}).join('\n')
}

/* Tricks the way declarer counts them: what the contract needs, what each
   side has taken, and a slot per trick so the shape of the hand is visible. */
function renderTrickCounter(state: BoardView): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'trick-counter'
	const declarerSide = state.contract ? partnership(state.contract.declarer) : undefined
	const target = state.contract ? state.contract.level + 6 : undefined

	const scores = document.createElement('div')
	scores.className = 'trick-scores'
	for (const side of ['NS', 'EW'] as const) {
		const won = state.tricksWon[side]
		const box = document.createElement('div')
		box.className = `trick-score ${declarerSide === side ? 'declaring' : ''}`
		const label = document.createElement('span')
		label.className = 'trick-score-label'
		label.textContent = declarerSide === side ? `${side} · declaring` : declarerSide ? `${side} · defending` : side
		const value = document.createElement('strong')
		value.textContent = String(won)
		box.append(label, value)
		if (declarerSide && target !== undefined) {
			const need = document.createElement('span')
			need.className = 'trick-need'
			if (side === declarerSide) {
				const remaining = target - won
				need.textContent = remaining > 0 ? `${remaining} more to make ${state.contract!.level}` : `contract made, +${won - target}`
			} else {
				const remaining = 14 - target - won
				need.textContent = remaining > 0 ? `${remaining} more to set it` : 'contract defeated'
			}
			box.append(need)
		}
		scores.append(box)
	}
	wrap.append(scores)

	const ladder = document.createElement('div')
	ladder.className = 'trick-ladder'
	ladder.setAttribute('aria-label', 'Tricks played, in order')
	for (let number = 1; number <= 13; number++) {
		const trick = state.completedTricks[number - 1]
		const pip = document.createElement('button')
		pip.type = 'button'
		const winnerSide = trick?.winner ? partnership(trick.winner) : undefined
		pip.className = `trick-pip ${winnerSide ? `won-${winnerSide.toLowerCase()}` : 'unplayed'} ${reviewMode && selectedReviewTrick === number - 1 ? 'reviewing' : ''}`
		pip.textContent = String(number)
		pip.disabled = !trick
		pip.title = trick
			? `Trick ${number}: ${trick.plays.map(play => `${play.seat} ${formatCard(play.card)}`).join(', ')} — won by ${trick.winner}. Click to review.`
			: `Trick ${number} has not been played.`
		if (trick) {
			pip.addEventListener('click', () => {
				reviewMode = true
				selectedReviewTrick = number - 1
				render()
			})
		}
		ladder.append(pip)
	}
	wrap.append(ladder)
	return wrap
}

function renderTricks(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Tricks'
	const visibility = makeButton(tricksVisible ? 'Hide log' : 'Show log')
	visibility.title = tricksTooltip(state)
	visibility.addEventListener('click', () => {
		tricksVisible = !tricksVisible
		render()
	})
	header.append(title, visibility)
	section.append(header)
	/* The counter is the point of this panel, so it is always on. The
	   toggle only controls the card-by-card log underneath it. */
	section.append(renderTrickCounter(state))
	if (!tricksVisible) {
		const lastPreview = renderLastTrickPreview(state)
		if (lastPreview) section.append(lastPreview)
		return section
	}
	const list = document.createElement('div')
	list.className = 'history-list'
	for (const [index, trick] of [...state.completedTricks.entries()].reverse()) {
		const row = document.createElement('button')
		row.type = 'button'
		row.className = 'trick-row'
		row.innerHTML = `<span>${index + 1}. ${trick.winner}</span><strong>${trick.plays.map(play => formatCard(play.card)).join(' ')}</strong>`
		row.addEventListener('click', () => {
			reviewMode = true
			selectedReviewTrick = index
			render()
		})
		list.append(row)
	}
	if (!state.completedTricks.length) {
		const empty = document.createElement('p')
		empty.className = 'muted'
		empty.textContent = 'No completed tricks.'
		list.append(empty)
	}
	section.append(list)
	return section
}

function renderLastTrickPreview(state: BoardView): HTMLElement | undefined {
	const trick = state.completedTricks.at(-1)
	if (!trick) return undefined
	const index = state.completedTricks.length - 1
	const row = document.createElement('button')
	row.type = 'button'
	row.className = 'trick-row latest-call'
	row.title = 'Last completed trick. Click to review it.'
	row.innerHTML = `<span>Last ${index + 1}. ${trick.winner}</span><strong>${trick.plays.map(play => `${play.seat}:${formatCard(play.card)}`).join(' ')}</strong>`
	row.addEventListener('click', () => {
		reviewMode = true
		selectedReviewTrick = index
		render()
	})
	return row
}

function tricksTooltip(state: BoardView): string {
	const trick = state.completedTricks.at(-1)
	if (!trick) return 'No completed tricks.'
	return `Last trick ${state.completedTricks.length}: ${trick.winner} won ${trick.plays.map(play => `${play.seat}:${formatCard(play.card)}`).join(' ')}`
}

function renderReviewControls(state: BoardView): HTMLElement {
	const controls = document.createElement('div')
	controls.className = 'review-controls'
	const tricks = reviewTricks(state)
	const toggle = makeButton(reviewMode ? 'Live' : 'Review')
	toggle.disabled = !tricks.length
	toggle.addEventListener('click', () => {
		reviewMode = !reviewMode
		selectedReviewTrick = clampReviewTrickIndex(state, selectedReviewTrick || tricks.length - 1)
		render()
	})
	const previous = makeButton('Prev')
	previous.disabled = !reviewMode || selectedReviewTrick <= 0
	previous.addEventListener('click', () => {
		selectedReviewTrick = clampReviewTrickIndex(state, selectedReviewTrick - 1)
		render()
	})
	const next = makeButton('Next')
	next.disabled = !reviewMode || selectedReviewTrick >= tricks.length - 1
	next.addEventListener('click', () => {
		selectedReviewTrick = clampReviewTrickIndex(state, selectedReviewTrick + 1)
		render()
	})
	const label = document.createElement('span')
	label.className = 'muted review-label'
	label.textContent = reviewMode && tricks.length ? `Trick ${selectedReviewTrick + 1} of ${tricks.length}` : 'Live play'
	controls.append(toggle, previous, next, label)
	return controls
}

function renderAnalysis(): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section analysis-panel'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Analysis'
	const refresh = makeButton('Refresh')
	refresh.addEventListener('click', () => void refreshAnalysis())
	const visibility = makeButton(analysisVisible ? 'Hide' : 'Show')
	visibility.disabled = !analysis
	visibility.title = analysisTooltip(analysis)
	visibility.addEventListener('click', () => {
		analysisVisible = !analysisVisible
		render()
	})
	header.append(title, refresh, visibility)
	section.append(header)

	if (!analysis) {
		const empty = document.createElement('p')
		empty.className = 'muted'
		empty.textContent = 'Refresh for contract, score, HCP, and trick analysis.'
		section.append(empty)
		return section
	}

	if (!analysisVisible) {
		const collapsed = document.createElement('p')
		collapsed.className = 'muted'
		collapsed.textContent = `Analysis loaded for board ${analysis.boardNumber}.`
		section.append(collapsed)
		return section
	}

	const rows = document.createElement('div')
	rows.className = 'stats'
	const summaryRows = [
		['Board', String(analysis.boardNumber)],
		['Phase', analysis.phase],
		['HCP NS', String(analysis.hcp.sides.NS)],
		['HCP EW', String(analysis.hcp.sides.EW)],
		['HCP seats', `N ${analysis.hcp.seats.N}  E ${analysis.hcp.seats.E}  S ${analysis.hcp.seats.S}  W ${analysis.hcp.seats.W}`]
	]
	if (analysis.contractAnalysis) {
		const contract = analysis.contractAnalysis
		const double = contract.contract.doubling === 'doubled' ? 'X' : contract.contract.doubling === 'redoubled' ? 'XX' : ''
		summaryRows.push(
			['Contract', `${contract.contract.level}${strainLabel(contract.contract.strain)}${double} by ${contract.contract.declarer}`],
			['Required', String(contract.requiredTricks)],
			['Declarer tricks', `${contract.declarerTricks} (${contract.result})`],
			['Score', `NS ${contract.score.ns} / EW ${contract.score.ew}`]
		)
	}
	for (const [label, value] of summaryRows) {
		const row = document.createElement('div')
		row.className = 'stat-row'
		row.innerHTML = `<span>${label}</span><strong>${value}</strong>`
		rows.append(row)
	}
	section.append(rows)

	const dds = document.createElement('p')
	dds.className = 'muted'
	dds.textContent = analysis.dds.message
	section.append(dds)

	if (analysis.dds.contract) {
		const verdict = document.createElement('p')
		verdict.className = 'analysis-verdict'
		verdict.textContent = analysis.dds.contract.explanation
		section.append(verdict)
	}

	if (analysis.dds.makeable) {
		const makeableTitle = document.createElement('h3')
		makeableTitle.className = 'subhead'
		makeableTitle.textContent = 'Makeable Tricks'
		const table = document.createElement('div')
		table.className = 'makeable-table'
		for (const text of ['', 'N', 'E', 'S', 'W']) {
			const cell = document.createElement('strong')
			cell.textContent = text
			table.append(cell)
		}
		for (const strain of ['NT', 'S', 'H', 'D', 'C'] as const) {
			const label = document.createElement('strong')
			label.textContent = strainLabel(strain)
			table.append(label)
			for (const seat of seats) {
				const cell = document.createElement('span')
				cell.textContent = String(analysis.dds.makeable[strain][seat])
				table.append(cell)
			}
		}
		section.append(makeableTitle, table)
	}

	if (analysis.dds.par) {
		const par = document.createElement('p')
		par.className = 'muted'
		par.textContent = `Par ${analysis.dds.par.score}: ${formatParContracts(analysis.dds.par.contracts)}`
		section.append(par)
	}

	if (analysis.dds.playGuidance) {
		const guidance = analysis.dds.playGuidance
		const guideTitle = document.createElement('h3')
		guideTitle.className = 'subhead'
		guideTitle.textContent = `Best Plays for ${guidance.seat}`
		const note = document.createElement('p')
		note.className = 'muted'
		note.textContent = guidance.explanation
		const list = document.createElement('div')
		list.className = 'history-list'
		for (const play of guidance.plays) {
			const row = document.createElement('div')
			row.className = `trick-row ${play.best ? 'best-play-row' : ''}`
			row.innerHTML = `<span>${formatCard(play.card)} ${play.label}</span><strong>declarer ${play.projectedDeclarerTricks}</strong>`
			row.title = play.explanation
			list.append(row)
		}
		section.append(guideTitle, note, list)
	}

	if (analysis.dds.playReview?.length) {
		const reviewTitle = document.createElement('h3')
		reviewTitle.className = 'subhead'
		reviewTitle.textContent = 'Play Review'
		const list = document.createElement('div')
		list.className = 'history-list'
		for (const review of analysis.dds.playReview) {
			const row = document.createElement('button')
			row.type = 'button'
			row.className = `trick-row ${review.label === 'no loss' ? 'best-play-row' : 'mistake-row'}`
			const best = review.bestCards.map(formatCard).join(' ')
			row.innerHTML = `<span>${review.trickNumber}.${review.playNumber} ${review.seat}:${formatCard(review.card)} ${review.label}</span><strong>declarer ${review.projectedDeclarerTricks}</strong>`
			row.title = `${review.explanation} Best: ${best}`
			row.addEventListener('click', () => {
				reviewMode = true
				selectedReviewTrick = Math.max(0, review.trickNumber - 1)
				render()
			})
			list.append(row)
		}
		section.append(reviewTitle, list)
	}

	if (analysis.tricks.length) {
		const list = document.createElement('div')
		list.className = 'history-list'
		for (const trick of analysis.tricks) {
			const row = document.createElement('div')
			row.className = 'trick-row'
			row.innerHTML = `<span>${trick.number}. ${trick.winner ?? '-'} ${trick.side ?? ''}</span><strong>${trick.cards.map(formatAnalysisCard).join(' ')}</strong>`
			list.append(row)
		}
		section.append(list)
	}

	return section
}

function renderDealForm(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section deal-form'
	const canEdit = canActNow(state)

	const boardLabel = document.createElement('label')
	boardLabel.textContent = 'Board'
	const boardInput = document.createElement('input')
	boardInput.type = 'number'
	boardInput.min = '1'
	boardInput.value = String(state.boardNumber)
	boardLabel.append(boardInput)

	const seedLabel = document.createElement('label')
	seedLabel.textContent = 'Seed'
	const seedInput = document.createElement('input')
	seedInput.type = 'number'
	seedInput.placeholder = 'Random'
	seedLabel.append(seedInput)

	const dealButton = makeButton('Deal')
	dealButton.disabled = !canEdit
	dealButton.title = canEdit ? 'Deal a new board in this room.' : state.pendingAgreement ? 'Answer the pending table request first.' : 'Spectators cannot deal new boards.'
	dealButton.addEventListener('click', () => {
		analysis = undefined
		void submitAction({
			type: 'deal',
			boardNumber: Number(boardInput.value),
			seed: seedInput.value ? Number(seedInput.value) : undefined
		})
	})

	section.append(boardLabel, seedLabel, dealButton)
	return section
}

function renderPbnPanel(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section pbn-panel'
	const boards = pbnSummaries(pbnText)
	if (pbnBoardIndex >= boards.length) pbnBoardIndex = 0
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'PBN'
	title.title = 'Portable Bridge Notation: a standard text format for saving and sharing bridge deals, auctions, and play records.'
	const exportButton = makeButton('Export')
	exportButton.title = 'Export this board as Portable Bridge Notation.'
	exportButton.addEventListener('click', () => void exportPbn('board'))
	const exportRoomButton = makeButton('Export Room')
	exportRoomButton.title = 'Export all boards in this room as one multi-board PBN.'
	exportRoomButton.addEventListener('click', () => void exportPbn('room'))
	const downloadButton = makeButton('Download')
	downloadButton.title = 'Download the Portable Bridge Notation text as a .pbn file.'
	downloadButton.disabled = !pbnText.trim()
	downloadButton.addEventListener('click', downloadPbn)
	const visibility = makeButton(pbnVisible ? 'Hide' : 'Show')
	visibility.title = pbnVisible ? 'Hide the Portable Bridge Notation text box.' : 'Show the Portable Bridge Notation text box.'
	visibility.addEventListener('click', () => {
		pbnVisible = !pbnVisible
		render()
	})
	header.append(title, exportButton, exportRoomButton, downloadButton, visibility)
	section.append(header)
	if (!pbnVisible) {
		const collapsed = document.createElement('p')
		collapsed.className = 'muted'
		collapsed.textContent = pbnText ? pbnValidationMessage(pbnText) : 'Export or paste a PBN deal.'
		section.append(collapsed)
		return section
	}

	const fileInput = document.createElement('input')
	fileInput.type = 'file'
	fileInput.accept = '.pbn,text/plain'
	fileInput.title = 'Choose a .pbn file to load into the text box.'
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0]
		if (!file) return
		void file.text().then(text => {
			pbnText = text
			pbnBoardIndex = 0
			pbnMessage = `Loaded ${file.name}.`
			render()
		}).catch(() => {
			errorMessage = 'Could not read the PBN file.'
			render()
		})
	})

	const textarea = document.createElement('textarea')
	textarea.value = pbnText
	textarea.placeholder = '[Board "1"]\n[Dealer "N"]\n[Vulnerable "None"]\n[Deal "N:... ... ... ..."]'
	textarea.spellcheck = false
	textarea.title = 'Portable Bridge Notation text. Paste a PBN deal here to import it, or export the current board to fill this box.'

	const actions = document.createElement('div')
	actions.className = 'pbn-actions'
	const importButton = makeButton('Import')
	importButton.title = canActNow(state) ? 'Import the Portable Bridge Notation text into this room.' : state.pendingAgreement ? 'Answer the pending table request first.' : 'Spectators cannot import boards.'
	importButton.disabled = !boards.length || !canActNow(state)
	importButton.addEventListener('click', () => void importPbn())
	const copyButton = makeButton('Copy')
	copyButton.title = 'Copy the Portable Bridge Notation text.'
	copyButton.disabled = !pbnText.trim()
	copyButton.addEventListener('click', () => {
		void navigator.clipboard.writeText(pbnText).catch(() => {
			errorMessage = 'Could not copy PBN.'
			render()
		})
	})
	textarea.addEventListener('input', () => {
		pbnText = textarea.value
		pbnBoardIndex = 0
		pbnMessage = ''
		const updatedBoards = pbnSummaries(pbnText)
		importButton.disabled = !updatedBoards.length || !canActNow(state)
		copyButton.disabled = !pbnText.trim()
		downloadButton.disabled = !pbnText.trim()
	})

	if (boards.length > 1) {
		const selectLabel = document.createElement('label')
		selectLabel.textContent = 'Board to import'
		const select = document.createElement('select')
		for (const board of boards) {
			const option = document.createElement('option')
			option.value = String(board.index)
			option.textContent = `Board ${board.boardNumber} - ${board.dealer} - ${board.vulnerability.toUpperCase()}${board.event ? ` - ${board.event}` : ''}`
			option.selected = board.index === pbnBoardIndex
			select.append(option)
		}
		select.addEventListener('change', () => {
			pbnBoardIndex = Number(select.value)
			render()
		})
		selectLabel.append(select)
		section.append(selectLabel)
	}

	const replayLabel = document.createElement('label')
	replayLabel.className = 'pbn-replay'
	const replayCheckbox = document.createElement('input')
	replayCheckbox.type = 'checkbox'
	replayCheckbox.checked = pbnReplayRecord
	replayCheckbox.addEventListener('change', () => {
		pbnReplayRecord = replayCheckbox.checked
		pbnMessage = ''
	})
	replayLabel.append(replayCheckbox, document.createTextNode(' Replay saved auction/play'))

	const status = document.createElement('p')
	const validation = pbnValidationMessage(pbnText)
	const valid = !pbnText.trim() || boards.length > 0
	status.className = valid ? 'muted pbn-status' : 'error pbn-status'
	status.textContent = pbnMessage || validation
	actions.append(importButton, copyButton)
	section.append(fileInput, textarea, replayLabel, status, actions)
	return section
}

function renderRoomLinks(state: BoardView): HTMLElement {
	const section = document.createElement('section')
	section.className = 'section room-links'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Private Room'
	const roomUrl = inviteUrl(state)
	const input = inviteInput(roomUrl)
	const copy = makeButton('Copy Link')
	copy.title = 'Copy this room link on this computer.'
	copy.addEventListener('click', () => {
		void navigator.clipboard.writeText(roomUrl).catch(() => {
			errorMessage = 'Could not copy link.'
			render()
		})
	})
	const roomRow = document.createElement('div')
	roomRow.className = 'room-link-row'
	roomRow.append(input, copy)
	section.append(title, roomRow)
	return section
}

function inviteInput(value: string): HTMLInputElement {
	const input = document.createElement('input')
	input.readOnly = true
	input.value = value
	input.title = value
	return input
}

function inviteUrl(state: BoardView): string {
	const shareOrigin = state.roomMeta?.networkOrigin && isLoopbackHost(location.hostname)
		? state.roomMeta.networkOrigin
		: location.origin
	const params = new URLSearchParams({ room: state.roomId })
	return `${shareOrigin}${location.pathname}?${params.toString()}`
}

function partnerInviteSeat(role: PlayerRole): Seat | undefined {
	if (role === 'N') return 'S'
	if (role === 'S') return 'N'
	if (role === 'E') return 'W'
	if (role === 'W') return 'E'
	return undefined
}

function partnerRoomsFor(seat: Seat): SavedRoomSummary[] {
	const partner = partnerInviteSeat(seat)
	const side = partnership(seat)
	if (!partner) return []
	return savedRooms
		.filter(room => !room.archived && room.players[partner] && !room.players[seat] && !room.players[side])
		.sort((left, right) => Date.parse(right.savedAt ?? right.createdAt ?? '') - Date.parse(left.savedAt ?? left.createdAt ?? ''))
}

function spectatorRooms(): SavedRoomSummary[] {
	return savedRooms
		.filter(room => !room.archived)
		.sort((left, right) => Date.parse(right.savedAt ?? right.createdAt ?? '') - Date.parse(left.savedAt ?? left.createdAt ?? ''))
}

function lobbyRoomUrl(roomId: string, seat?: Seat): string {
	const params = new URLSearchParams({ room: roomId })
	if (seat) params.set('seat', seat)
	return `${location.origin}${location.pathname}?${params.toString()}`
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function renderLobby(): void {
	if (!savedRoomsLoaded) {
		void loadSavedRooms()
	}
	appRoot.replaceChildren()
	const lobby = document.createElement('section')
	lobby.className = 'lobby'
	const roomId = roomIdFromUrl()
	const preferredSeat = preferredSeatFromUrl()
	const title = document.createElement('h1')
	title.className = 'title'
	title.textContent = roomId && preferredSeat ? `Join room ${roomId} as Seat ${preferredSeat}` : roomId ? `Join room ${roomId}` : 'Bridge Core Table'
	const note = document.createElement('p')
	note.className = 'muted lobby-note'
	note.textContent = roomId
		? preferredSeat ? `Choose Seat ${preferredSeat} to join your partner's room.` : 'Choose your private seat to join this room, or create a fresh room if this link has expired.'
		: 'Create a private room and share the network link with the other browser.'
	const actions = document.createElement('div')
	actions.className = 'lobby-actions'
	const orderedSeatRoles = preferredSeat
		? [preferredSeat, ...privateSeatRoles.filter(seat => seat !== preferredSeat)]
		: privateSeatRoles
	for (const side of orderedSeatRoles) {
		const button = makeButton(roomId ? `Claim ${roleLabel(side)}` : `Create as ${roleLabel(side)}`)
		button.addEventListener('click', () => {
			void chooseLobbySeat(side, roomId).catch(error => {
				errorMessage = error instanceof Error ? error.message : String(error)
				claimConflictSide = errorMessage === `${side} is already claimed` ? side : undefined
				renderLobby()
			})
		})
		actions.append(button)
	}
	const partnerChooser = !roomId && pendingSeatJoin ? renderPartnerRoomChooser(pendingSeatJoin) : undefined
	const spectatorChooser = !roomId && pendingSpectatorJoin ? renderSpectatorRoomChooser() : undefined
	for (const side of tableControlRoles) {
		const button = makeButton(roomId ? `Claim ${roleLabel(side)}` : `Create as ${roleLabel(side)}`)
		button.title = side === 'SPECTATOR'
			? 'Watch without seeing private hands before they are public.'
			: `Use full ${side} side control for testing or solo review. For partner play, choose an individual seat.`
		button.addEventListener('click', () => {
			void chooseLobbyControl(side, roomId).catch(error => {
				errorMessage = error instanceof Error ? error.message : String(error)
				claimConflictSide = errorMessage === `${side} is already claimed` ? side : undefined
				renderLobby()
			})
		})
		actions.append(button)
	}
	if (roomId) {
		const newSouth = makeButton('New room as Seat S')
		newSouth.addEventListener('click', () => void createRoom('S').catch(error => {
			errorMessage = error instanceof Error ? error.message : String(error)
			renderLobby()
		}))
		const newSpectator = makeButton('New room as Spectator')
		newSpectator.addEventListener('click', () => void createRoom('SPECTATOR').catch(error => {
			errorMessage = error instanceof Error ? error.message : String(error)
			renderLobby()
		}))
		actions.append(newSouth, newSpectator)
	}
	if (roomId && claimConflictSide) {
		const takeover = makeButton(`Take over ${claimConflictSide}`)
		takeover.addEventListener('click', () => {
			void claimRoom(claimConflictSide!, true).catch(error => {
				errorMessage = error instanceof Error ? error.message : String(error)
				renderLobby()
			})
		})
		actions.append(takeover)
	}
	const recovery = renderSavedRoomsRecovery()
	const error = document.createElement('div')
	error.className = 'error'
	error.setAttribute('role', 'status')
	error.textContent = errorMessage
	lobby.append(title, note, actions)
	if (partnerChooser) lobby.append(partnerChooser)
	if (spectatorChooser) lobby.append(spectatorChooser)
	lobby.append(recovery, error)
	appRoot.append(lobby)
}

function renderPartnerRoomChooser(seat: Seat): HTMLElement {
	const section = document.createElement('section')
	section.className = 'partner-room-chooser'
	const partner = partnerInviteSeat(seat)!
	const rooms = partnerRoomsFor(seat)
	const label = document.createElement('label')
	label.textContent = `Existing Seat ${partner} rooms for Seat ${seat}`
	const select = document.createElement('select')
	if (!rooms.some(room => room.id === selectedSeatJoinRoomId)) selectedSeatJoinRoomId = rooms[0]?.id ?? ''
	for (const room of rooms) {
		const option = document.createElement('option')
		option.value = room.id
		option.textContent = lobbyRoomUrl(room.id, seat)
		option.selected = room.id === selectedSeatJoinRoomId
		select.append(option)
	}
	select.addEventListener('change', () => {
		selectedSeatJoinRoomId = select.value
	})
	label.append(select)
	const actions = document.createElement('div')
	actions.className = 'lobby-actions'
	const join = makeButton(`Join as Seat ${seat}`)
	join.disabled = !selectedSeatJoinRoomId
	join.title = selectedSeatJoinRoomId ? `Join the selected room as Seat ${seat}.` : 'No matching partner room found.'
	join.addEventListener('click', () => {
		if (selectedSeatJoinRoomId) void claimSpecificRoom(selectedSeatJoinRoomId, seat).catch(error => {
			errorMessage = error instanceof Error ? error.message : String(error)
			renderLobby()
		})
	})
	const copy = makeButton('Copy Selected URL')
	copy.disabled = !selectedSeatJoinRoomId
	copy.addEventListener('click', () => {
		if (!selectedSeatJoinRoomId) return
		void navigator.clipboard.writeText(lobbyRoomUrl(selectedSeatJoinRoomId, seat)).catch(() => {
			errorMessage = 'Could not copy selected room link.'
			renderLobby()
		})
	})
	const create = makeButton(`Create New Seat ${seat} Room`)
	create.title = `Create a separate new room as Seat ${seat}.`
	create.addEventListener('click', () => void createRoom(seat).catch(error => {
		errorMessage = error instanceof Error ? error.message : String(error)
		renderLobby()
	}))
	actions.append(join, copy, create)
	const note = document.createElement('p')
	note.className = 'muted'
	note.textContent = rooms.length
		? `Select your partner's waiting room, then join as Seat ${seat}.`
		: `No waiting Seat ${partner} rooms found.`
	section.append(label, actions, note)
	return section
}

function renderSpectatorRoomChooser(): HTMLElement {
	const section = document.createElement('section')
	section.className = 'partner-room-chooser'
	const rooms = spectatorRooms()
	const label = document.createElement('label')
	label.textContent = 'Existing rooms to watch'
	const select = document.createElement('select')
	if (!rooms.some(room => room.id === selectedSpectatorJoinRoomId)) selectedSpectatorJoinRoomId = rooms[0]?.id ?? ''
	for (const room of rooms) {
		const option = document.createElement('option')
		option.value = room.id
		option.textContent = lobbyRoomUrl(room.id)
		option.selected = room.id === selectedSpectatorJoinRoomId
		select.append(option)
	}
	select.addEventListener('change', () => {
		selectedSpectatorJoinRoomId = select.value
	})
	label.append(select)
	const actions = document.createElement('div')
	actions.className = 'lobby-actions'
	const join = makeButton('Join as Spectator')
	join.disabled = !selectedSpectatorJoinRoomId
	join.title = selectedSpectatorJoinRoomId ? 'Join the selected room as Spectator.' : 'No existing rooms found.'
	join.addEventListener('click', () => {
		if (selectedSpectatorJoinRoomId) void claimSpecificRoom(selectedSpectatorJoinRoomId, 'SPECTATOR').catch(error => {
			errorMessage = error instanceof Error ? error.message : String(error)
			renderLobby()
		})
	})
	const copy = makeButton('Copy Selected URL')
	copy.disabled = !selectedSpectatorJoinRoomId
	copy.addEventListener('click', () => {
		if (!selectedSpectatorJoinRoomId) return
		void navigator.clipboard.writeText(lobbyRoomUrl(selectedSpectatorJoinRoomId)).catch(() => {
			errorMessage = 'Could not copy selected room link.'
			renderLobby()
		})
	})
	const create = makeButton('Create New Spectator Room')
	create.title = 'Create a separate new room as Spectator.'
	create.addEventListener('click', () => void createRoom('SPECTATOR').catch(error => {
		errorMessage = error instanceof Error ? error.message : String(error)
		renderLobby()
	}))
	actions.append(join, copy, create)
	const note = document.createElement('p')
	note.className = 'muted'
	note.textContent = rooms.length
		? 'Select an existing room, then join as Spectator.'
		: 'No active rooms found.'
	section.append(label, actions, note)
	return section
}

function renderSavedRoomsRecovery(): HTMLElement {
	const section = document.createElement('section')
	section.className = 'saved-rooms'
	const header = document.createElement('div')
	header.className = 'section-heading'
	const title = document.createElement('h2')
	title.className = 'title'
	title.textContent = 'Saved Rooms'
	const refresh = makeButton('Refresh')
	refresh.addEventListener('click', () => {
		savedRoomsLoaded = false
		void loadSavedRooms()
	})
	const fileInput = document.createElement('input')
	fileInput.type = 'file'
	fileInput.accept = '.json,application/json'
	fileInput.title = 'Import a Bridge room backup JSON file.'
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0]
		if (file) void importRoomBackup(file)
	})
	header.append(title, refresh)
	section.append(header, fileInput)
	if (!savedRoomsLoaded) {
		const loading = document.createElement('p')
		loading.className = 'muted'
		loading.textContent = 'Loading saved rooms...'
		section.append(loading)
		return section
	}

	const filters = document.createElement('div')
	filters.className = 'saved-room-filters'
	const search = document.createElement('input')
	search.type = 'search'
	search.placeholder = 'Search saved rooms'
	search.value = savedRoomFilter
	search.title = 'Search by room name, room id, phase, or board number.'
	search.addEventListener('input', () => {
		savedRoomFilter = search.value
		renderLobby()
	})
	const archivedLabel = document.createElement('label')
	archivedLabel.className = 'saved-room-archive-toggle'
	const archivedCheckbox = document.createElement('input')
	archivedCheckbox.type = 'checkbox'
	archivedCheckbox.checked = showArchivedRooms
	archivedCheckbox.addEventListener('change', () => {
		showArchivedRooms = archivedCheckbox.checked
		renderLobby()
	})
	archivedLabel.append(archivedCheckbox, document.createTextNode(' Show archived'))
	filters.append(search, archivedLabel)
	section.append(filters)

	const cleanup = document.createElement('div')
	cleanup.className = 'saved-room-cleanup'
	const cleanupLabel = document.createElement('label')
	cleanupLabel.textContent = 'Forget archived older than'
	const cleanupInput = document.createElement('input')
	cleanupInput.type = 'number'
	cleanupInput.min = '0'
	cleanupInput.value = String(archivedCleanupDays)
	cleanupInput.title = 'Archived rooms older than this many days can be removed from Saved Rooms.'
	cleanupInput.addEventListener('input', () => {
		archivedCleanupDays = Math.max(0, Math.trunc(Number(cleanupInput.value) || 0))
	})
	cleanupLabel.append(cleanupInput)
	const cleanupButton = makeButton('Clean Up')
	cleanupButton.title = 'Forget archived rooms older than the selected number of days.'
	cleanupButton.disabled = !savedRooms.some(room => room.archived)
	cleanupButton.addEventListener('click', () => {
		const days = Math.max(0, Math.trunc(archivedCleanupDays))
		if (confirm(`Forget archived rooms older than ${days} day${days === 1 ? '' : 's'}?`)) void cleanupArchivedRooms()
	})
	cleanup.append(cleanupLabel, cleanupButton)
	section.append(cleanup)

	const visibleRooms = savedRooms.filter(room => savedRoomMatches(room))
	if (!savedRooms.length) {
		const empty = document.createElement('p')
		empty.className = 'muted'
		empty.textContent = 'No saved rooms found on this computer.'
		section.append(empty)
		return section
	}
	if (!visibleRooms.length) {
		const empty = document.createElement('p')
		empty.className = 'muted'
		empty.textContent = showArchivedRooms ? 'No saved rooms match this search.' : 'No active saved rooms match this search. Show archived to include archived rooms.'
		section.append(empty)
		return section
	}
	const list = document.createElement('div')
	list.className = 'saved-room-list'
	for (const room of visibleRooms) {
		const row = document.createElement('div')
		row.className = `saved-room-row ${room.archived ? 'archived' : ''}`
		row.title = `Open ${roomDisplayName(room)}. Saved ${formatDateTime(room.savedAt)}. Created ${formatDateTime(room.createdAt)}.`
		const open = makeButton('Open', 'saved-room-open')
		open.title = `Open ${roomDisplayName(room)}.`
		open.addEventListener('click', () => {
			history.replaceState(null, '', `?room=${encodeURIComponent(room.id)}`)
			errorMessage = `Choose a side to rejoin ${roomDisplayName(room)}.`
			renderLobby()
		})
		const name = document.createElement('span')
		name.textContent = roomDisplayName(room)
		const summary = document.createElement('strong')
		summary.textContent = `Board ${room.boardNumber} / ${room.boards} saved`
		const detail = document.createElement('small')
		detail.textContent = `${room.archived ? 'Archived - ' : ''}${room.phase} - saved ${formatRelativeAge(room.savedAt)} - created ${formatRelativeAge(room.createdAt)}`
		const actions = document.createElement('div')
		actions.className = 'saved-room-actions'
		const duplicate = makeButton('Duplicate')
		duplicate.title = `Create a separate copy of ${roomDisplayName(room)}.`
		duplicate.addEventListener('click', () => void duplicateSavedRoom(room))
		const backup = makeButton('Backup')
		backup.title = `Download a backup file for ${roomDisplayName(room)}.`
		backup.addEventListener('click', () => void downloadSavedRoomBackup(room))
		const copy = makeButton('Copy')
		copy.title = `Copy backup text for ${roomDisplayName(room)}.`
		copy.addEventListener('click', () => void copySavedRoomBackup(room))
		actions.append(open, duplicate, backup, copy)
		row.append(name, summary, detail, actions)
		list.append(row)
	}
	section.append(list)
	return section
}

function savedRoomMatches(room: SavedRoomSummary): boolean {
	if (room.archived && !showArchivedRooms) return false
	const query = savedRoomFilter.trim().toLowerCase()
	if (!query) return true
	return [
		room.id,
		room.label ?? '',
		room.phase,
		`board ${room.boardNumber}`,
		`${room.boards} saved`
	].some(value => value.toLowerCase().includes(query))
}

/* What the Play/Scoring group needs: the tricks so far, and — for a
   spectator — why the controls are inert. */
function renderPlayPanel(state: BoardView): HTMLElement {
	const wrap = document.createElement('div')
	wrap.append(renderTricks(state))
	if (state.controlledSide === 'SPECTATOR') {
		const note = document.createElement('p')
		note.className = 'muted session-note'
		note.textContent = 'You are watching. Take a seat in Room to bid, play or deal.'
		wrap.append(note)
	}
	return wrap
}

function nowTabLabel(state: BoardView): string {
	if (state.phase === 'auction') return 'Bidding'
	if (state.phase === 'play') return 'Play'
	return 'Scoring'
}

/* The one line a player checks constantly: is it on me? */
function turnLine(state: BoardView): { text: string, detail: string, isYou: boolean } {
	if (state.phase === 'passed-out') return { text: 'Passed out', detail: 'No contract. Deal the next board.', isYou: false }
	if (state.phase === 'complete') return { text: 'Board complete', detail: contractLabel(state), isYou: false }
	const verb = state.phase === 'auction' ? 'bid' : 'play'
	if (state.pendingAgreement) return { text: 'Table request waiting', detail: agreementText(state), isYou: false }
	if (state.controlledSide === 'SPECTATOR') return { text: `${state.currentTurn} to ${verb}`, detail: 'You are watching this table.', isYou: false }
	if (state.robots[state.currentTurn]) return { text: `${state.currentTurn} robot is playing`, detail: 'The robot takes this seat automatically.', isYou: false }
	const yours = state.phase === 'auction'
		? controlsSeat(state.controlledSide, state.currentTurn)
		: canPlayCurrentSeat(state)
	if (yours) return { text: `Your turn to ${verb}`, detail: tableRoleText(state) || `You are sitting ${state.currentTurn}.`, isYou: true }
	return { text: `${state.currentTurn} to ${verb}`, detail: `Waiting for ${partnership(state.currentTurn)}.`, isYou: false }
}

function renderPanelHead(state: BoardView): HTMLElement {
	const head = document.createElement('div')
	head.className = 'panel-head'

	const turn = turnLine(state)
	const line = document.createElement('p')
	line.className = `turn-line ${turn.isYou ? 'is-you' : ''}`
	line.setAttribute('role', 'status')
	line.textContent = turn.text
	const detail = document.createElement('p')
	detail.className = 'turn-detail'
	detail.textContent = turn.detail
	head.append(line, detail)

	const vulnerable = state.vulnerability !== 'none'
	const meta = document.createElement('div')
	meta.className = 'head-meta'
	const facts: [string, string, boolean][] = [
		['Board', String(state.boardNumber), false],
		state.phase === 'auction'
			? ['Bid', currentBidLabel(state), false]
			: ['Contract', contractLabel(state), false],
		['Dealer', state.dealer, false],
		['Vul', state.vulnerability.toUpperCase(), vulnerable],
		['You', state.controlledSide === 'SPECTATOR' ? 'Spectator' : state.controlledSide, false]
	]
	/* Nobody has taken a trick during the auction; don't print 0-0. */
	if (state.phase !== 'auction') {
		facts.splice(4, 0, ['Tricks', `NS ${state.tricksWon.NS} · EW ${state.tricksWon.EW}`, false])
	}
	for (const [label, value, warn] of facts) {
		const item = document.createElement('span')
		if (warn) item.className = 'vuln-on'
		item.append(`${label} `)
		const strong = document.createElement('b')
		strong.textContent = value
		item.append(strong)
		meta.append(item)
	}
	head.append(meta)

	/* Status belongs beside the action that caused it, not below ten panels.
	   The bidding box prints it under the bid buttons, so skip it there. */
	const shownInBidBox = state.phase === 'auction' && activePanelTab === 'now'
	const status = document.createElement('div')
	status.className = 'error'
	status.setAttribute('role', 'status')
	status.textContent = shownInBidBox ? '' : errorMessage
	head.append(status)

	head.append(renderTabs(state))
	return head
}

function renderTabs(state: BoardView): HTMLElement {
	const strip = document.createElement('div')
	strip.className = 'tabs'
	strip.setAttribute('role', 'tablist')
	strip.setAttribute('aria-label', 'Side panel groups')
	const tabs: [PanelTab, string, boolean][] = [
		['now', nowTabLabel(state), false],
		['deal', 'Deal', Boolean(analysis)],
		['match', 'Match', false],
		['room', 'Room', false]
	]
	const select = (id: PanelTab): void => {
		activePanelTab = id
		render()
		/* Keep focus on the strip so arrow keys keep working after a re-render. */
		document.querySelector<HTMLButtonElement>(`.tab[data-tab="${id}"]`)?.focus()
	}
	tabs.forEach(([id, label, dot], index) => {
		const button = document.createElement('button')
		button.className = 'tab'
		button.type = 'button'
		button.dataset.tab = id
		button.setAttribute('role', 'tab')
		const selected = activePanelTab === id
		button.setAttribute('aria-selected', String(selected))
		/* Roving tabindex: one stop for the strip, arrows move within it. */
		button.tabIndex = selected ? 0 : -1
		button.textContent = label
		button.title = panelTabHint(id, label)
		if (dot && !selected) {
			const mark = document.createElement('span')
			mark.className = 'tab-dot'
			button.append(mark)
		}
		button.addEventListener('click', () => select(id))
		button.addEventListener('keydown', event => {
			const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
			if (step) {
				event.preventDefault()
				select(tabs[(index + step + tabs.length) % tabs.length]![0])
			} else if (event.key === 'Home' || event.key === 'End') {
				event.preventDefault()
				select(tabs[event.key === 'Home' ? 0 : tabs.length - 1]![0])
			}
		})
		strip.append(button)
	})
	return strip
}

function panelTabHint(id: PanelTab, label: string): string {
	if (id === 'now') return `${label}: the controls for this stage of the deal.`
	if (id === 'deal') return 'Deal: analysis, the auction record, tricks and board details.'
	if (id === 'match') return 'Match: running results and finished boards.'
	return 'Room: invite link, table setup, PBN files and backups.'
}

function render(): void {
	if (!view) {
		renderLobby()
		return
	}
	const state = view
	appRoot.replaceChildren()

	const tableShell = document.createElement('div')
	tableShell.className = 'table-shell'
	const topbar = document.createElement('div')
	topbar.className = 'topbar'
	topbar.innerHTML = '<h1 class="title">Bridge Core Table</h1>'

	const actions = document.createElement('div')
	actions.className = 'actions'
	const sidePill = document.createElement('span')
	sidePill.className = 'side-pill'
	sidePill.textContent = `${roleLabel(state.controlledSide)} view`
	const undo = makeButton('Undo')
	undo.disabled = !state.canUndo || !canActNow(state)
	undo.title = state.pendingAgreement ? 'Answer the pending table request first.' : 'Ask the other side to approve Undo when both sides are connected.'
	undo.addEventListener('click', () => void submitAction({ type: 'requestUndo' }))
	const nextBoard = makeButton('Next Board')
	nextBoard.disabled = !canActNow(state)
	nextBoard.title = canActNow(state) ? 'Deal the next board.' : state.pendingAgreement ? 'Answer the pending table request first.' : 'Spectators cannot deal the next board.'
	nextBoard.addEventListener('click', () => {
		analysis = undefined
		reviewMode = false
		selectedReviewTrick = 0
		void submitAction({ type: 'nextBoard' })
	})
	actions.append(sidePill, undo, nextBoard, renderReviewControls(state))
	topbar.append(actions)

	const table = document.createElement('div')
	table.className = 'table'
	const seatMap = visualSeatMap(state)
	table.append(
		renderSeat(state, 'N', seatMap.N),
		renderSeat(state, 'W', seatMap.W),
		renderCenter(state),
		renderSeat(state, 'E', seatMap.E),
		renderSeat(state, 'S', seatMap.S)
	)
	tableShell.append(topbar)
	if (state.phase === 'auction') tableShell.append(renderAuctionHistory(state))
	tableShell.append(table)

	/* Follow the deal: a new phase pulls you back to the controls it needs. */
	if (lastNowPhase !== state.phase) {
		lastNowPhase = state.phase
		activePanelTab = 'now'
	}
	/* A request needs an answer before anything else does. */
	if (state.pendingAgreement) activePanelTab = 'now'

	const sidePanel = document.createElement('aside')
	sidePanel.className = 'side-panel'
	sidePanel.append(renderPanelHead(state))

	const body = document.createElement('div')
	body.className = 'panel-body'
	if (activePanelTab === 'now') {
		if (state.phase === 'auction') body.append(renderAuctionControls(state))
		else body.append(renderPlayPanel(state))
		body.append(renderAgreementPanel(state))
		/* A finished board is read, not played: put the score right here. */
		if (state.phase === 'complete' || state.phase === 'passed-out') body.append(renderMatchResults(state))
	} else if (activePanelTab === 'deal') {
		body.append(renderAnalysis())
		/* During the auction the record already sits above the table. */
		if (state.phase !== 'auction') body.append(renderAuctionHistory(state))
		body.append(renderStats(state))
		body.append(renderDealForm(state))
	} else if (activePanelTab === 'match') {
		body.append(renderMatchResults(state), renderBoardHistory(state))
	} else {
		body.append(renderRoomLinks(state), renderSetupPanel(state), renderRoomAdmin(state), renderPbnPanel(state))
	}
	sidePanel.append(body)

	appRoot.append(tableShell, sidePanel)
}

const initialRoomId = roomIdFromUrl()
const initialToken = initialRoomId ? storedToken(initialRoomId) : undefined
if (initialRoomId && initialToken) void resumeRoom(initialRoomId, initialToken)
else renderLobby()
