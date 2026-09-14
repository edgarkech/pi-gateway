/**
 * Nextcloud Talk — OCS type definitions (Phase 4 S1).
 *
 * Source: concept_phase_4_nextcloud.md §6.2 (TalkChatMessage / TalkRichObject)
 * and the verified spreed/OCS endpoints (§7).
 */

/**
 * Ein Rich Object in einer Talk-Nachricht (Message Parameter). Bei einem
 * Datei-Sharing trägt es z. B. `type: "file"` samt `id`, `name`, `path`,
 * `mimetype`, `size`, `link`. Weitere Typen sind Mentions (`user`/`call`),
 * Emojis (`emoji`) u. a.
 */
export interface TalkRichObject {
	/** Objekt-Typ: "file" | "user" | "call" | "guest" | "emoji" | … */
	type: string;
	/** Opake, stabile ID (bei file: die File-ID). */
	id: string;
	/** Anzeigename / Dateiname. */
	name: string;
	/** User-relativer Pfad (bei file: "path"). */
	path?: string;
	/** Deklarierter MIME-Typ (bei file). */
	mimetype?: string;
	/** Dateigröße in Bytes (bei file). */
	size?: number;
	/** Öffentlicher/Laden-Link (bei file). */
	link?: string;
	/** Beliebig weitere Felder je nach Objekt-Typ. */
	[key: string]: string | number | boolean | undefined;
}

/**
 * Eine Chat-Nachricht aus der Talk-OCS-API (Konzept §6.2).
 */
export interface TalkChatMessage {
	id: number;
	token: string;
	/** "users" | "bots" | "guests" | "federated_users" | "deleted_users" */
	actorType: string;
	/** Nextcloud-UserID des Senders (bei actorType === "users"). */
	actorId: string;
	actorDisplayName: string;
	/** Sekunden seit Unix-Epoch (UTC). */
	timestamp: number;
	/** "" für normale Nachrichten; sonst System-Event-Kennung. */
	systemMessage: string;
	/** "comment" | "comment_deleted" | "system" | "command" */
	messageType: string;
	/** Rich-Object-String mit {placeholders}. */
	message: string;
	/** Platzhalter-Auflösung, z. B. { file: {…} } bei Datei-Sharing. */
	messageParameters: Record<string, TalkRichObject>;
	referenceId?: string;
	markdown?: boolean;
	/** Gesetzt, wenn die Nachricht nachträglich editiert wurde. */
	lastEditTimestamp?: number;
}

/**
 * Eine Talk-Konversation (Raum), wie sie `GET /room` liefert.
 * Nur die Felder, die der Gateway braucht (Konzept §7).
 */
export interface TalkRoom {
	/** Raum-Token (stabiler Identifier, auch für chat- und dav-Pfade). */
	token: string;
	/** 1 = 1:1, 2 = Gruppen, 3 = Öffentlicher/Gruppen-Chat. */
	type: number;
	/** Anzeigename des Raums. */
	displayName?: string;
	/** Anzahl ungelesener Nachrichten (für Poll-Priorisierung). */
	unreadMessages?: number;
	/** Letzte Aktivität als UNIX-Sekunden. */
	lastActivity?: number;
	/** Gibt an, ob der User als Bot/User hinzugefügt wurde. */
	participantType?: number;
}

/**
 * OCS-Antwort-Envelope. Nextcloud liefert immer `{ ocs: { meta, data } }`
 * (JSON dank `Accept: application/json`). `meta.statuscode === 100` = OK.
 */
export interface OcsResponse<T = unknown> {
	ocs: {
		meta: {
			status: string;
			statuscode: number;
			message?: string;
		};
		data: T;
	};
}
