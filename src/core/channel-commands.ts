/**
 * Slash Commands over Channels (docs/slash-commands.md) — zentrale,
 * plattform-agnostische Command-Logik für die Message-Pipeline.
 *
 * Scope (Spec §1–§5):
 * - Kuratiertes Command-Set `/stop`, `/new`, `/status`, `/model` — Parsing auf
 *   Text-Ebene, KEINE nativen Plattform-Registries.
 * - Raum-Klassifikation `dm` | `groupHuman` | `groupBot`: DMs implizit aus der
 *   vorhandenen Kanal-Klassifikation (`classifyChannel`), Gruppen explizit über
 *   `platforms.nextcloudTalk.roomTypes` (konfigurations-getrieben, keine
 *   Auto-Erkennung); unklassifizierte Gruppenräume konservativ `groupHuman`.
 * - Permission-Matrix (Spec §4): Commands sind Admin-only UND raumtyp-gated.
 *   groupBot-Räume verarbeiten gar keine Commands (forward an den Agenten als
 *   normale Nachricht); Nicht-Admins bekommen eine kurze Quittung und der
 *   Command wird NICHT an den Agenten weitergereicht.
 *
 * Design: dieses Modul ist BEWUSST eine reine Funktionsschicht ohne Imports
 * aus `rpc.ts`/`message-pipeline.ts`/Adaptern — dadurch
 * - testbar ohne Mocks (Vitest-Unit, Spec §9.1),
 * - zyklenfrei aus dem Talk-Adapter importierbar (`isPublishable`-Filter,
 *   Spec §5: bekanntes Command-Set selektiv für `messageType === "command"`
 *   öffnen),
 * - und die Seiteneffekt-Ausführung (RPC, Adapter-Sends) bleibt in der
 *   `message-pipeline.ts`-Integration.
 */

// ── Raumtypen (Spec §2) ──────────────────────────────────────────────────────

/**
 * Raumtyp für die Command-Gating-Matrix. `dm` ist implizit (aus
 * `classifyChannel`), `groupHuman`/`groupBot` kommen aus dem
 * `roomTypes`-Config-Block (Spec §2: configuration-driven only).
 */
export type RoomType = "dm" | "groupHuman" | "groupBot";

/** Ergebnis der bestehenden Kanal-Klassifikation (message-pipeline.ts). */
export type ChannelKindInput = "dm" | "group" | "unknown";

/**
 * Löst den Gating-Raumtyp auf. Reihenfolge (Spec §2):
 * 1. Explizite `roomTypes`-Konfiguration für diesen Raum (schlägt alles —
 *    konfigurations-getrieben ist der Kern der Entscheidung, da Bots
 *    bewusst als normale Accounts konfiguriert sein können).
 * 2. Impliziter DM aus der Kanal-Klassifikation (`classifyChannel` → "dm").
 * 3. Sicherheitsseite: alles andere (Gruppe oder unklar) → `groupHuman`
 *    (konservativer Default — schränkt Admin-Commands ein, nicht umgekehrt).
 *
 * @param channelId   Raum-/Kanal-ID (= PlatformMessage.channelId, bei Talk
 *                    das Raum-Token).
 * @param channelKind Ergebnis der bestehenden dm/group/unknown-Erkennung.
 * @param roomTypes   Map aus `platforms.nextcloudTalk?.roomTypes` (nur für
 *                    Talk durchreichen; andere Plattformen: undefined).
 */
export function resolveRoomType(
	channelId: string,
	channelKind: ChannelKindInput,
	roomTypes?: Readonly<Record<string, string>>,
): RoomType {
	const configured = roomTypes?.[channelId];
	if (configured === "groupHuman" || configured === "groupBot") return configured;
	if (channelKind === "dm") return "dm";
	return "groupHuman";
}

// ── Parsing (Spec §5) ────────────────────────────────────────────────────────

/** Kuratiertes, plattform-agnostisches Command-Set (Spec §3). */
export type ChannelCommandName = "stop" | "new" | "status" | "model";

export const CHANNEL_COMMAND_NAMES: readonly ChannelCommandName[] = [
	"stop",
	"new",
	"status",
	"model",
];

/** Geparstes Command: Name + Argument-Text (z. B. bei `/model provider/id`). */
export interface ParsedChannelCommand {
	name: ChannelCommandName;
	/** Everything after the command token, trimmed ("" when no argument). */
	arg: string;
}

/**
 * Zentrales Parsing VOR der Agent-Übergabe (Spec §5): der ERSTE Token der
 * Nachricht muss case-insensitive gegen das bekannte Set matchen
 * (`/stop`, `/new`, `/status`, `/model`). Nicht matchender Text fließt
 * unverändert durch (Rückgabe `null`).
 *
 * Edge cases:
 * - `/stopx`, `/stop-now` → kein Match (der Token muss exakt stimmen).
 * - `siehe /stop`        → kein Match (nicht der erste Token).
 * - `/model deepseek/x`  → Match mit arg `deepseek/x`.
 */
export function parseChannelCommand(content: string): ParsedChannelCommand | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith("/")) return null;
	const ws = trimmed.search(/\s/);
	const token = (ws === -1 ? trimmed : trimmed.slice(0, ws)).slice(1).toLowerCase();
	const name = CHANNEL_COMMAND_NAMES.find((c) => c === token);
	if (!name) return null;
	return { name, arg: ws === -1 ? "" : trimmed.slice(ws + 1).trim() };
}

/**
 * Known-command predicate for the Talk adapter's `isPublishable` filter
 * (Spec §5): open the `messageType === "command"` drop ONLY for this set —
 * every other Talk command stays dropped (anti-loop invariant, D4).
 */
export function isKnownChannelCommandText(content: string): boolean {
	return parseChannelCommand(content) !== null;
}

// ── Permission-Matrix (Spec §4) ──────────────────────────────────────────────

/**
 * Matrix Command × Raumtyp (Spec §4). `false` = in diesem Raumtyp nicht
 * ausführbar. groupBot ist vollständig `false` — dort wird zusätzlich gar
 * keine Command-Verarbeitung durchgeführt (Decision `forward`).
 */
export const COMMAND_ROOM_MATRIX: Record<ChannelCommandName, Record<RoomType, boolean>> = {
	stop: { dm: true, groupHuman: true, groupBot: false },
	new: { dm: true, groupHuman: false, groupBot: false },
	status: { dm: true, groupHuman: true, groupBot: false },
	model: { dm: true, groupHuman: false, groupBot: false },
};

/** Kurz-Quittung für Nicht-Admins (Spec §4, Option A). */
export const ADMIN_REQUIRED_ACK = "⚠️ This command requires admin privileges.";

/** Raumtyp-Gating-Quittung (Admin, aber Matrix verbietet den Command dort). */
export function roomGateAck(command: ChannelCommandName): string {
	return `⚠️ /${command} is not available in this room type.`;
}

/**
 * Entscheidungs-Ergebnis für eine eingehende Nachricht.
 * - `not-command`: kein Command → Nachricht normal weiterleiten.
 * - `forward`:    groupBot-Raum → KEINE Command-Verarbeitung, KEINE Quittung;
 *                 Text läuft als normale Nachricht zum Agenten (Spec §4:
 *                 silent drop wäre verwirrender).
 * - `ack`:        abgelehnt (Nicht-Admin / Raum-Gating) → kurze Quittung,
 *                 NICHT an den Agenten weiterreichen (Spec §4).
 * - `execute`:    ausführbar → die Pipeline führt den Command aus.
 */
export type CommandDecision =
	| { kind: "not-command" }
	| { kind: "forward" }
	| { kind: "ack"; text: string }
	| { kind: "execute"; command: ChannelCommandName; arg: string; roomType: RoomType };

/**
 * Reine Entscheidungslogik aus Spec §4 (admin-only UND raumtyp-gated).
 * Reihenfolge: Parsing → groupBot-Forward → Admin-Check → Matrix.
 */
export function decideChannelCommand(input: {
	content: string;
	isAdmin: boolean;
	roomType: RoomType;
}): CommandDecision {
	const parsed = parseChannelCommand(input.content);
	if (!parsed) return { kind: "not-command" };
	// groupBot: keine Command-Verarbeitung, keine Quittung (jeglicher Output in
	// Bot-Gruppen ist ein Event für die anderen Bots — Spec §4).
	if (input.roomType === "groupBot") return { kind: "forward" };
	if (!input.isAdmin) return { kind: "ack", text: ADMIN_REQUIRED_ACK };
	if (!COMMAND_ROOM_MATRIX[parsed.name][input.roomType]) {
		return { kind: "ack", text: roomGateAck(parsed.name) };
	}
	return { kind: "execute", command: parsed.name, arg: parsed.arg, roomType: input.roomType };
}

// ── `/status` Report (Spec §6) ───────────────────────────────────────────────

/** Woher die Modell-Info stammt — für die ehrliche Quellen-Kennzeichnung. */
export type StatusModelSource = "rpc" | "config";

/** Snapshot für den `/status`-Report (vom Aufrufer befüllt, pure Formatierung). */
export interface ChannelStatusSnapshot {
	/** pi-RPC-Prozess läuft und ist verbunden. */
	agentConnected: boolean;
	/** Aktive Adapter-Plattformen (runtime.state.adapters keys). */
	adapters: readonly string[];
	/** Modell-Identifier (z. B. `AGENT/qwen38-27b`); null = unbekannt. */
	model: string | null;
	/** Quelle des Modell-Felds: RPC (get_state) oder Config-Fallback. */
	modelSource?: StatusModelSource;
	/** Kontext-Nutzung als menschenlesbares Feld (z. B. `60,000 / 200,000 (30%)`). */
	contextUsage: string | null;
}

/**
 * Kompakter Health-Report (Spec §6): Agent-Verbindung, Adapter, aktives
 * Modell, Kontext-Nutzung. Fehlende Felder werden explizit als `n/a`
 * ausgewiesen (RPC-Limitationen bleiben sichtbar, Spec §6 Fallback-Regel).
 */
export function formatChannelStatus(s: ChannelStatusSnapshot): string {
	const modelLabel =
		s.model === null
			? "n/a"
			: s.modelSource === "config"
				? `${s.model} (from config — RPC did not report a model)`
				: s.model;
	const lines = [
		"📊 Gateway Status",
		`🤖 Agent: ${s.agentConnected ? "✅ connected" : "❌ not connected"}`,
		`📡 Adapters: ${s.adapters.length > 0 ? s.adapters.join(", ") : "none"}`,
		`🧠 Model: ${modelLabel}`,
		`📏 Context: ${s.contextUsage ?? "n/a"}`,
	];
	return lines.join("\n");
}

/**
 * Formatiert das `contextUsage`-Feld aus `get_session_stats`
 * (tokens/contextWindow/percent). Null-Werte (z. B. direkt nach Compaction)
 * werden zu `n/a` (Spec §6: ehrlich statt raten).
 */
export function formatContextUsage(usage: {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}): string | null {
	if (usage.contextWindow === null || usage.contextWindow === 0) return null;
	const tokens = usage.tokens ?? "?";
	const percent = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
	return `${tokens} / ${usage.contextWindow} tokens (${percent})`;
}

// ── `/model` Report (Spec §7) ────────────────────────────────────────────────

/** pi-Modell-Identifier aus einem get_state-/set_model-Model-Objekt bauen. */
export function formatModelId(model: { provider?: string; id?: string; name?: string }): string {
	const provider = model.provider ?? "";
	const id = model.id ?? "unknown";
	return provider ? `${provider}/${id}` : id;
}

/**
 * `/model <arg>` → (provider, modelId)-Paar (Spec §7).
 * - `provider/modelId` (mit Slash): direkt gesplittet (pi-Provider-Config,
 *   z. B. `z-ai/glm-5.3-flash`).
 * - `modelId` ohne Slash: provider-null — der Aufrufer löst den Provider über
 *   `get_available_models` auf (eindeutiger Match nötig).
 * Leeres/whitespace Argument → null (bedeutet: kein Argument übergeben).
 */
export function parseModelArg(
	arg: string,
): { provider: string; modelId: string } | { provider: null; modelId: string } | null {
	const trimmed = arg.trim();
	if (trimmed === "") return null;
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { provider: null, modelId: trimmed };
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (provider === "" || modelId === "") return { provider: null, modelId: trimmed };
	return { provider, modelId };
}
