import { InstanceBase, InstanceStatus, Regex, combineRgb } from '@companion-module/base'
import WebSocket from 'ws'

const PROTOCOL_VERSION = 1 // muss zu app/src/main/netserver.js passen

// Companion-API 2.x: die Klasse wird exportiert statt über runEntrypoint gestartet.
export default class EbbtonInstance extends InstanceBase {
	async init(config, _isFirstInit, secrets) {
		this.config = config
		this.secrets = secrets
		this.state = null
		this.msgId = 0

		this.setActionDefinitions(this.buildActions())
		this.setFeedbackDefinitions(this.buildFeedbacks())
		this.setVariableDefinitions(this.buildVariables())
		this.setPresetDefinitions(this.buildPresetStructure(), this.buildPresets())
		this.resetVariables()

		this.connect()
	}

	async configUpdated(config, secrets) {
		this.config = config
		this.secrets = secrets
		this.authFailed = false
		this.disconnect()
		this.connect()
	}

	async destroy() {
		this.disconnect()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Ebbton',
				value:
					'Verbindet sich mit der Netzwerkschnittstelle von Ebbton. ' +
					'Port und Passwort stehen dort in den Einstellungen unter „Netzwerk“.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Adresse des Aufnahmerechners',
				width: 8,
				default: '127.0.0.1',
				regex: Regex.HOSTNAME,
			},
			{
				type: 'number',
				id: 'port',
				label: 'Port',
				width: 4,
				default: 8765,
				min: 1024,
				max: 65535,
			},
			{
				// verdeckt angezeigt; der Wert liegt im Secrets-Speicher, nicht in der Konfiguration
				type: 'secret-text',
				id: 'password',
				label: 'Passwort für Steuerung',
				width: 12,
				default: '',
			},
		]
	}

	/* ------------------------------------------------------------ Verbindung */

	/** Passwort aus dem Secrets-Speicher (API 2.x), ältere Verbindungen hatten es in der Konfiguration. */
	get password() {
		return this.secrets?.password || this.config?.password || ''
	}

	connect() {
		if (!this.config?.host || !this.config?.port) {
			this.updateStatus(InstanceStatus.BadConfig, 'Adresse oder Port fehlt')
			return
		}
		if (!this.password) {
			this.updateStatus(InstanceStatus.BadConfig, 'Passwort fehlt')
			return
		}

		this.updateStatus(InstanceStatus.Connecting)
		const url = `ws://${this.config.host}:${this.config.port}/`

		try {
			this.ws = new WebSocket(url)
		} catch (err) {
			this.updateStatus(InstanceStatus.ConnectionFailure, String(err.message))
			this.scheduleReconnect()
			return
		}

		this.ws.on('open', () => {
			this.lastError = null
			this.send({ type: 'auth', password: this.password })
			this.startHeartbeat()
		})

		this.ws.on('message', (raw) => {
			let msg
			try {
				msg = JSON.parse(raw.toString())
			} catch {
				return
			}
			this.handleMessage(msg)
		})

		this.ws.on('close', () => {
			this.authed = false
			this.stopHeartbeat()
			this.clearState()
			// Nach falschem Passwort nicht ständig neu versuchen: erst wieder nach Änderung der Einstellungen.
			if (this.authFailed) return
			// Eine konkrete Fehlermeldung (z. B. Verbindung abgelehnt) nicht mit "getrennt" überschreiben.
			if (this.lastError) this.updateStatus(InstanceStatus.ConnectionFailure, this.lastError)
			else this.updateStatus(InstanceStatus.Disconnected)
			this.scheduleReconnect()
		})

		this.ws.on('error', (err) => {
			this.log('debug', `WebSocket-Fehler: ${err.message}`)
			this.lastError = err.message
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
	}

	/**
	 * Eigener Herzschlag: Fällt der Aufnahmerechner hart weg (Strom, WLAN), bemerkt das ein offener
	 * WebSocket sonst erst nach Minuten. Bleibt die Antwort auf ein ping aus, wird neu verbunden.
	 */
	startHeartbeat() {
		this.stopHeartbeat()
		this.awaitingPong = false
		this.heartbeat = setInterval(() => {
			if (this.awaitingPong) {
				this.log('warn', 'Recorder antwortet nicht mehr – Verbindung wird neu aufgebaut.')
				this.lastError = 'Recorder antwortet nicht'
				try {
					this.ws?.terminate()
				} catch {
					/* bereits zu */
				}
				return
			}
			this.awaitingPong = true
			this.send({ type: 'ping', id: ++this.msgId })
		}, 10000)
	}

	stopHeartbeat() {
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.heartbeat = null
		this.awaitingPong = false
	}

	/** Nach einer Trennung nichts Veraltetes anzeigen (z. B. rote "Aufnahme"-Taste). */
	clearState() {
		this.state = null
		this.resetVariables()
		this.checkAllFeedbacks()
	}

	disconnect() {
		this.stopHeartbeat()
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
		if (this.ws) {
			this.ws.removeAllListeners()
			// close() während des Verbindungsaufbaus meldet im nächsten Takt noch einen Fehler; ohne Empfänger
			// wäre das eine unbehandelte Ausnahme, die das Modul abstürzen lässt.
			this.ws.on('error', () => {})
			try {
				this.ws.close()
			} catch {
				/* Verbindung war bereits zu */
			}
			this.ws = null
		}
		this.authed = false
	}

	scheduleReconnect() {
		if (this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connect()
		}, 5000)
	}

	send(obj) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
		this.ws.send(JSON.stringify(obj))
		return true
	}

	command(action, params) {
		if (!this.authed) {
			this.log('warn', 'Nicht mit dem Recorder verbunden – Befehl verworfen.')
			return
		}
		const id = ++this.msgId
		this.send({ type: 'command', id, action, params: params || {} })
	}

	handleMessage(msg) {
		switch (msg.type) {
			case 'hello':
				if (msg.protocol !== PROTOCOL_VERSION) {
					this.log(
						'warn',
						`Der Recorder spricht Protokoll ${msg.protocol}, dieses Modul ${PROTOCOL_VERSION} – bitte Modul und App auf denselben Stand bringen.`
					)
				}
				break

			case 'auth':
				if (msg.ok) {
					this.authed = true
					if (msg.role === 'monitor') {
						// Mit dem Mitlese-Passwort kommen Status und Variablen an, Befehle aber nicht.
						this.updateStatus(InstanceStatus.BadConfig, 'Passwort ist nur zum Mitlesen – Tasten steuern nichts')
					} else {
						this.updateStatus(InstanceStatus.Ok)
					}
					this.send({ type: 'get_state', id: ++this.msgId })
				}
				break

			case 'pong':
				this.awaitingPong = false
				break

			case 'state':
				this.state = msg.payload
				this.applyState()
				break

			case 'levels':
				if (this.state) this.state.levels = msg.payload
				this.setVariableValues({
					level_left: Math.round((msg.payload.l || 0) * 100),
					level_right: Math.round((msg.payload.r || 0) * 100),
					clipping: msg.payload.clip ? 'ja' : 'nein',
					timecode: this.formatTime(msg.payload.duration || 0),
					section_elapsed: this.sectionElapsed(msg.payload.duration),
					...this.loudnessValues(msg.payload.loudness),
				})
				this.checkFeedbacks('clipping')
				break

			case 'result':
				if (msg.ok === false) this.log('warn', `Befehl abgelehnt: ${msg.error}`)
				break

			case 'error':
				if (msg.code === 'auth_failed' || msg.code === 'auth_locked') {
					this.authFailed = true
					this.updateStatus(
						InstanceStatus.AuthenticationFailure,
						msg.code === 'auth_locked' ? 'Zu viele Fehlversuche – Passwort prüfen' : 'Passwort ist falsch'
					)
					this.disconnect()
				} else {
					this.log('warn', `Recorder meldet: ${msg.message}`)
				}
				break

			default:
				break
		}
	}

	/* -------------------------------------------------------------- Variablen */

	buildVariables() {
		return {
			status: { name: 'Aufnahmestatus (Text)' },
			timecode: { name: 'Laufzeit' },
			service_name: { name: 'Name des Gottesdienstes' },
			current_item: { name: 'Aktueller Programmpunkt' },
			next_item: { name: 'Nächster offener Programmpunkt' },
			current_artist: { name: 'Interpret des aktuellen Abschnitts (nur mit Steuer-Passwort)' },
			next_artist: { name: 'Interpret des nächsten Programmpunkts (nur mit Steuer-Passwort)' },
			section_elapsed: { name: 'Laufzeit des aktuellen Abschnitts' },
			item_index: { name: 'Ablauf: Anzahl begonnener Punkte' },
			item_total: { name: 'Ablauf: Anzahl aller Punkte' },
			item_progress: { name: 'Ablauf: Fortschritt („3 / 5“)' },
			marker_count: { name: 'Anzahl gesetzter Abschnitte' },
			pending_count: { name: 'Anzahl offener Programmpunkte' },
			level_left: { name: 'Pegel links (0-100)' },
			level_right: { name: 'Pegel rechts (0-100)' },
			clipping: { name: 'Übersteuerung (ja/nein)' },
			input_status: { name: 'Eingang (ok / leise / ausgefallen)' },
			write_status: { name: 'Speichern (ok / langsam / Fehler)' },
			disk_free: { name: 'Freier Speicherplatz (GB)' },
			disk_hours: { name: 'Aufnahmestunden, die noch Platz haben' },
			cut_open: { name: 'Schnitt läuft gerade (ja/nein)' },
			recording_mode: { name: 'Aufnahmeart (Stereo / Mehrspur)' },
			routing_status: { name: 'Routing am Mischpult (ok / falsch / unbekannt / -)' },
			loudness_momentary: { name: 'Lautheit momentan (LUFS, 0,4 s)' },
			loudness_short: { name: 'Lautheit kurzzeitig (LUFS, 3 s)' },
			loudness_integrated: { name: 'Lautheit der ganzen Aufnahme (LUFS)' },
			loudness_section: { name: 'Lautheit des aktuellen Abschnitts (LUFS)' },
		}
	}

	resetVariables() {
		this.setVariableValues({
			status: 'getrennt',
			timecode: '00:00:00',
			service_name: '-',
			current_item: '-',
			next_item: '-',
			current_artist: '-',
			next_artist: '-',
			section_elapsed: '00:00',
			item_index: 0,
			item_total: 0,
			item_progress: '-',
			marker_count: 0,
			pending_count: 0,
			level_left: 0,
			level_right: 0,
			clipping: 'nein',
			input_status: '-',
			write_status: '-',
			disk_free: '-',
			disk_hours: '-',
			cut_open: 'nein',
			recording_mode: '-',
			routing_status: '-',
			...this.loudnessValues(null),
		})
	}

	applyState() {
		const s = this.state
		if (!s) return
		const labels = {
			idle: 'bereit',
			recording: 'Aufnahme',
			paused: 'pausiert',
			stopped: 'beendet',
		}
		// Offene Punkte in der Reihenfolge des Ablaufplans (die App sortiert nach "order")
		const pending = (s.pending || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))
		// Ablaufpunkte = alles außer von Hand gesetzten Abschnitten (M); begonnen sind die mit gesetztem Anfang.
		const planStarted = (s.sections || []).filter((x) => x.start != null && x.source !== 'manual').length
		const planTotal = planStarted + pending.length
		const current = s.currentSegment
		const currentSection = current ? (s.sections || []).find((x) => x.id === current.markerId) : null
		this.setVariableValues({
			status: labels[s.status] || s.status,
			timecode: this.formatTime(s.duration || 0),
			service_name: s.service?.name || '-',
			current_item: s.currentSegment?.label || '-',
			next_item: pending.length > 0 ? pending[0].label : '-',
			// Mit dem Mitlese-Passwort schickt Ebbton keine Personennamen: dann bleibt es bei „-“.
			current_artist: currentSection?.artist || '-',
			next_artist: pending[0]?.artist || '-',
			section_elapsed: this.sectionElapsed(s.duration),
			item_index: planStarted,
			item_total: planTotal,
			item_progress: planTotal > 0 ? `${planStarted} / ${planTotal}` : '-',
			marker_count: (s.sections || []).filter((x) => x.start != null).length,
			pending_count: pending.length,
			input_status: { ok: 'ok', silent: 'leise', lost: 'ausgefallen' }[s.health?.input] || '-',
			write_status: { ok: 'ok', slow: 'langsam', error: 'Fehler' }[s.health?.write] || '-',
			disk_free: s.health?.disk ? (s.health.disk.freeBytes / 1073741824).toFixed(1) : '-',
			disk_hours: s.health?.disk ? this.formatHours(s.health.disk.hoursLeft) : '-',
			cut_open: (s.cuts || []).some((c) => c.end == null) ? 'ja' : 'nein',
			// recordingMode: gültige Aufnahmeart (laufende Aufnahme, sonst eingestellt); ältere Ebbton-Versionen senden sie nicht.
			recording_mode: { stereo: 'Stereo', multitrack: 'Mehrspur' }[s.recordingMode || s.mode] || '-',
			routing_status: { ok: 'ok', mismatch: 'falsch', unknown: 'unbekannt' }[s.health?.routing] || '-',
		})
		this.checkFeedbacks(
			'recording', 'paused', 'has_pending', 'input_problem', 'write_problem', 'disk_warn', 'disk_low', 'cut_open',
			'routing_mismatch', 'multitrack', 'section_running',
		)
	}

	/** Laufzeit des laufenden Abschnitts (mm:ss bzw. h:mm:ss), aus Dauer der Aufnahme und Anfang des Abschnitts. */
	sectionElapsed(duration) {
		const start = this.state?.currentSegment?.start
		if (start == null) return '-'
		const t = Math.max(0, Math.floor((duration ?? this.state?.duration ?? 0) - start))
		const p = (n) => String(Math.floor(n)).padStart(2, '0')
		return t >= 3600 ? `${Math.floor(t / 3600)}:${p((t % 3600) / 60)}:${p(t % 60)}` : `${p(t / 60)}:${p(t % 60)}`
	}

	/** Lautheit in LUFS mit einer Nachkommastelle; „-“ bei Stille oder wenn Ebbton keine misst (Mehrspur). */
	loudnessValues(l) {
		const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-')
		return {
			loudness_momentary: f(l?.momentary),
			loudness_short: f(l?.shortTerm),
			loudness_integrated: f(l?.integrated),
			loudness_section: f(l?.section),
		}
	}

	formatHours(h) {
		if (h >= 10) return `${Math.round(h)} h`
		if (h >= 1) return `${h.toFixed(1)} h`
		return `${Math.max(0, Math.round(h * 60))} min`
	}

	formatTime(t) {
		const p = (n) => String(Math.floor(n)).padStart(2, '0')
		return `${p(t / 3600)}:${p((t % 3600) / 60)}:${p(t % 60)}`
	}

	/* --------------------------------------------------------------- Aktionen */

	buildActions() {
		return {
			record_start: {
				name: 'Aufnahme starten',
				options: [],
				callback: () => this.command('record.start'),
			},
			record_stop: {
				name: 'Aufnahme beenden',
				options: [],
				callback: () => this.command('record.stop'),
			},
			record_toggle: {
				name: 'Aufnahme starten/beenden',
				options: [],
				callback: () => this.command('record.toggle'),
			},
			record_pause: {
				name: 'Aufnahme pausieren',
				options: [],
				callback: () => this.command('record.pause'),
			},
			record_resume: {
				name: 'Aufnahme fortsetzen',
				options: [],
				callback: () => this.command('record.resume'),
			},
			record_pause_toggle: {
				name: 'Pause umschalten',
				options: [],
				callback: () => {
					if (this.state?.status === 'paused') this.command('record.resume')
					else this.command('record.pause')
				},
			},
			marker_add: {
				name: 'Abschnitt starten / beenden',
				options: [
					{
						type: 'textinput',
						id: 'label',
						label: 'Bezeichnung (beim Start, leer = automatisch nummeriert)',
						default: '',
						useVariables: true,
					},
				],
				// Variablen setzt Companion selbst ein (useVariables), parseVariablesInString gibt es nicht mehr.
				callback: (action) => {
					const label = String(action.options.label ?? '').trim()
					this.command('marker.add', label ? { label } : {})
				},
			},
			marker_next: {
				name: 'Nächster Programmpunkt beginnt hier (beendet den laufenden Abschnitt)',
				options: [],
				callback: () => this.command('marker.next'),
			},
			cut_toggle: {
				name: 'Schnitt starten / beenden (Stelle fehlt im MP3)',
				options: [],
				callback: () => this.command('cut.toggle'),
			},
			undo: {
				name: 'Rückgängig',
				options: [],
				callback: () => this.command('undo'),
			},
			redo: {
				name: 'Wiederholen',
				options: [],
				callback: () => this.command('redo'),
			},
			mode_set: {
				name: 'Aufnahmeart wählen (Stereo / Mehrspur)',
				description: 'Wirkt auf die nächste Aufnahme; während einer Aufnahme lehnt Ebbton ab. Am Pult das Routing passend umstellen.',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Aufnahmeart',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Umschalten' },
							{ id: 'stereo', label: 'Stereo' },
							{ id: 'multitrack', label: 'Mehrspur' },
						],
					},
				],
				callback: (action) => this.command('mode.set', { mode: action.options.mode || 'toggle' }),
			},
			template_apply: {
				name: 'Vorlage für Programmpunkte laden',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name der Vorlage (leer = Standardvorlage)',
						default: '',
						useVariables: true,
					},
				],
				callback: (action) => {
					const name = String(action.options.name ?? '').trim()
					this.command('template.apply', name ? { name } : {})
				},
			},
		}
	}

	/* -------------------------------------------------------------- Feedbacks */

	buildFeedbacks() {
		return {
			recording: {
				type: 'boolean',
				name: 'Aufnahme läuft',
				description: 'Färbt den Button, solange aufgenommen wird',
				defaultStyle: {
					bgcolor: combineRgb(200, 0, 0),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => this.state?.status === 'recording',
			},
			paused: {
				type: 'boolean',
				name: 'Aufnahme pausiert',
				defaultStyle: {
					bgcolor: combineRgb(200, 130, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [],
				callback: () => this.state?.status === 'paused',
			},
			has_pending: {
				type: 'boolean',
				name: 'Es gibt offene Programmpunkte',
				defaultStyle: {
					bgcolor: combineRgb(40, 60, 160),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => (this.state?.pending || []).length > 0,
			},
			input_problem: {
				type: 'boolean',
				name: 'Eingang leise oder ausgefallen',
				description: 'Wird aktiv, wenn länger kaum Pegel anliegt oder der Eingang neu verbunden werden muss',
				defaultStyle: {
					bgcolor: combineRgb(220, 40, 30),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => ['silent', 'lost'].includes(this.state?.health?.input),
			},
			write_problem: {
				type: 'boolean',
				name: 'Aufnahme kann nicht gespeichert werden',
				description: 'Schreibfehler (z. B. Platte voll, Laufwerk entfernt) oder Laufwerk zu langsam',
				defaultStyle: {
					bgcolor: combineRgb(220, 40, 30),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => ['error', 'slow'].includes(this.state?.health?.write),
			},
			routing_mismatch: {
				type: 'boolean',
				name: 'Routing am Mischpult passt nicht zur Aufnahmeart',
				description: 'Z. B. Mehrspur eingestellt, die USB-Ausgänge liefern aber die Stereo-Matrix (oder umgekehrt). „Unbekannt“ (Pult nicht erreichbar) löst nicht aus.',
				defaultStyle: {
					bgcolor: combineRgb(220, 40, 30),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => this.state?.health?.routing === 'mismatch',
			},
			multitrack: {
				type: 'boolean',
				name: 'Aufnahmeart ist Mehrspur',
				defaultStyle: {
					bgcolor: combineRgb(40, 80, 160),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => (this.state?.recordingMode || this.state?.mode) === 'multitrack',
			},
			section_running: {
				type: 'boolean',
				name: 'Abschnitt läuft',
				description: 'Aktiv, solange ein Abschnitt läuft. Mit Namen: nur, wenn der Name des laufenden Abschnitts dieses Wort enthält (z. B. „Predigt“).',
				defaultStyle: {
					bgcolor: combineRgb(40, 140, 70),
					color: combineRgb(255, 255, 255),
				},
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name enthält (leer = jeder Abschnitt)',
						default: '',
					},
				],
				callback: (feedback) => {
					const label = this.state?.currentSegment?.label
					if (label == null) return false
					const wanted = String(feedback.options.name ?? '').trim().toLowerCase()
					return !wanted || label.toLowerCase().includes(wanted)
				},
			},
			disk_warn: {
				type: 'boolean',
				name: 'Speicherplatz wird knapp (unter 3 Stunden)',
				defaultStyle: {
					bgcolor: combineRgb(240, 120, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [],
				callback: () => ['warn', 'low'].includes(this.state?.health?.disk?.level),
			},
			disk_low: {
				type: 'boolean',
				name: 'Speicherplatz fast voll (unter 30 Minuten)',
				defaultStyle: {
					bgcolor: combineRgb(220, 40, 30),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => this.state?.health?.disk?.level === 'low',
			},
			cut_open: {
				type: 'boolean',
				name: 'Schnitt läuft gerade',
				defaultStyle: {
					bgcolor: combineRgb(160, 30, 120),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => (this.state?.cuts || []).some((c) => c.end == null),
			},
			clipping: {
				type: 'boolean',
				name: 'Eingang übersteuert',
				defaultStyle: {
					bgcolor: combineRgb(235, 210, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [],
				callback: () => Boolean(this.state?.levels?.clip),
			},
		}
	}

	/* ---------------------------------------------------------------- Presets */

	/** Gliederung der Presets in Companion (API 2.x: getrennt von den Definitionen). */
	buildPresetStructure() {
		return [
			{ id: 'aufnahme', name: 'Aufnahme', definitions: ['record_toggle', 'pause', 'mode'] },
			{ id: 'abschnitte', name: 'Abschnitte', definitions: ['marker', 'marker_predigt', 'cut', 'undo'] },
			{ id: 'ablaufplan', name: 'Ablaufplan', definitions: ['next_item'] },
			{ id: 'anzeige', name: 'Anzeige', definitions: ['status', 'current_section', 'loudness', 'health'] },
		]
	}

	buildPresets() {
		// Boolean-Feedbacks brauchen in Presets einen eigenen Stil, sonst färbt sich die Taste nicht.
		const feedbackDefs = this.buildFeedbacks()
		const fb = (id) => ({ feedbackId: id, options: {}, style: { ...feedbackDefs[id].defaultStyle } })
		const base = {
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		}

		return {
			record_toggle: {
				type: 'simple',
				name: 'Aufnahme starten/beenden',
				style: { ...base, text: 'REC\\n$(ebbton:timecode)' },
				steps: [{ down: [{ actionId: 'record_toggle' }], up: [] }],
				feedbacks: [fb('recording')],
			},
			mode: {
				type: 'simple',
				name: 'Aufnahmeart umschalten (zeigt Art und Routing)',
				style: { ...base, size: '7', text: '$(ebbton:recording_mode)\\nRouting:\\n$(ebbton:routing_status)' },
				steps: [{ down: [{ actionId: 'mode_set', options: { mode: 'toggle' } }], up: [] }],
				// Reihenfolge: Die spätere Rückmeldung gewinnt – Routing-Warnung (rot) vor Mehrspur (blau).
				feedbacks: [fb('multitrack'), fb('routing_mismatch')],
			},
			pause: {
				type: 'simple',
				name: 'Pause umschalten',
				style: { ...base, text: 'Pause' },
				steps: [{ down: [{ actionId: 'record_pause_toggle' }], up: [] }],
				feedbacks: [fb('paused')],
			},
			marker: {
				type: 'simple',
				name: 'Abschnitt starten / beenden',
				style: { ...base, text: 'Abschnitt\\nStart/Ende' },
				steps: [{ down: [{ actionId: 'marker_add', options: { label: '' } }], up: [] }],
				feedbacks: [fb('section_running')],
			},
			marker_predigt: {
				type: 'simple',
				name: 'Abschnitt „Predigt“ starten / beenden',
				style: { ...base, text: 'Predigt' },
				steps: [{ down: [{ actionId: 'marker_add', options: { label: 'Predigt' } }], up: [] }],
				feedbacks: [{ feedbackId: 'section_running', options: { name: 'Predigt' }, style: { ...feedbackDefs.section_running.defaultStyle } }],
			},
			next_item: {
				type: 'simple',
				name: 'Nächster Programmpunkt',
				style: { ...base, text: 'Weiter\\n$(ebbton:next_item)\\n$(ebbton:item_progress)' },
				steps: [{ down: [{ actionId: 'marker_next' }], up: [] }],
				feedbacks: [fb('has_pending')],
			},
			cut: {
				type: 'simple',
				name: 'Schnitt starten / beenden',
				style: { ...base, text: 'Schnitt\\nStart/Ende' },
				steps: [{ down: [{ actionId: 'cut_toggle' }], up: [] }],
				feedbacks: [fb('cut_open')],
			},
			undo: {
				type: 'simple',
				name: 'Rückgängig',
				style: { ...base, text: 'Rück-\\ngängig' },
				steps: [{ down: [{ actionId: 'undo' }], up: [] }],
				feedbacks: [],
			},
			health: {
				type: 'simple',
				name: 'Eingang und Speicher',
				style: {
					...base,
					size: '7',
					text: 'Eingang: $(ebbton:input_status)\\nSpeicher: $(ebbton:disk_free) GB\\n$(ebbton:disk_hours)',
				},
				steps: [{ down: [], up: [] }],
				feedbacks: [fb('input_problem'), fb('write_problem'), fb('routing_mismatch'), fb('disk_warn'), fb('disk_low')],
			},
			status: {
				type: 'simple',
				name: 'Statusanzeige',
				style: {
					...base,
					size: '7',
					text: '$(ebbton:status)\\n$(ebbton:timecode)\\n$(ebbton:current_item)',
				},
				steps: [{ down: [], up: [] }],
				feedbacks: [fb('recording')],
			},
			current_section: {
				type: 'simple',
				name: 'Aktueller Abschnitt mit Laufzeit',
				style: { ...base, size: '7', text: '$(ebbton:current_item)\\n$(ebbton:current_artist)\\n$(ebbton:section_elapsed)' },
				steps: [{ down: [], up: [] }],
				feedbacks: [fb('section_running')],
			},
			loudness: {
				type: 'simple',
				name: 'Lautheit (LUFS)',
				style: { ...base, size: '7', text: 'LUFS\\nM $(ebbton:loudness_momentary)\\nI $(ebbton:loudness_integrated)' },
				steps: [{ down: [], up: [] }],
				feedbacks: [],
			},
		}
	}
}

export const UpgradeScripts = []
