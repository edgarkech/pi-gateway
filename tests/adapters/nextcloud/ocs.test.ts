/**
 * Phase 4 (S1) — OcsClient unit tests (gemocktes fetch, keine echte Nextcloud).
 *
 * Testfaelle nach Konzept §12 / Zeile 608:
 *   1. baseUrl-Validierung (https Pflicht, http nur via allowInsecureHttp).
 *   2. Basic-Auth-Header korrekt (und Token NIE im URL/Query/Log).
 *   3. Request-Bau (OCS-APIRequest-Header, Accept, Query-Params).
 *   4. OCS-Validierung robust: (a) statuscode===100 ODER (b) HTTP-2xx +
 *      meta.status !== "failure" (reale Instanz sendet HTTP 200/statuscode 200).
 *   5. JSON-/Fehler-Parsing (401 → AUTH_FAILED, ungültiges JSON → INVALID_RESPONSE).
 *   6. receiveChat: 304 = nichts Neues; 200 + X-Chat-Last-Given-Header.
 *   7. openFileStream: WebDAV-Pfad-Bildung (remote.php/dav/files/{userId}/{path}).
 */

import { Readable } from "node:stream";
import { describe, expect, it, vi, afterEach } from "vitest";

import { OcsClient, TalkError } from "../../../src/adapters/nextcloud/ocs.js";
import type { TalkChatMessage } from "../../../src/adapters/nextcloud/talk-types.js";

/** OCS-Antwort-Hüllen-Builder (Erfolg + Fehler). */
function ocsBody<T>(data: T, statuscode = 100, message = "", status = "ok"): unknown {
	return {
		ocs: {
			meta: { status, statuscode, message },
			data,
		},
	};
}

/**
 * Eine gemockte `fetch`, die den Aufruf protokolliert (URL + init-Headers) und
 * je nach Matcher eine vorbereitete Antwort zurückgibt.
 */
function stubFetch(
	returnHandler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: Array<{ url: string; headers: Record<string, string>; body?: string }> } {
	const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const headers = (init?.headers as Record<string, string>) ?? {};
			const body = init?.body as string | undefined;
			calls.push({ url, headers, body });
			return returnHandler(url, init ?? {});
		}),
	);
	return { calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers(),
		text: async () => JSON.stringify(payload),
	} as unknown as Response;
}

function jsonResponseWithHeaders(payload: unknown, headers: Record<string, string>): Response {
	const res = jsonResponse(payload, 200);
	(res as { headers: Headers }).headers = new Headers(headers);
	return res;
}

/** Builder für eine realistische Talk-Chat-Nachricht. */
function talkMessage(overrides: Partial<TalkChatMessage> = {}): TalkChatMessage {
	return {
		id: 501,
		token: "room-tok",
		actorType: "users",
		actorId: "alice",
		actorDisplayName: "Alice",
		timestamp: 1_700_000_000,
		systemMessage: "",
		messageType: "comment",
		message: "hello",
		messageParameters: {},
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ── 1. baseUrl-Validierung ──────────────────────────────────────────────

describe("OcsClient — Konstruktor & baseUrl-Validierung (§6.1)", () => {
	it("akzeptiert https:// ohne allowInsecureHttp", () => {
		expect(
			() =>
				new OcsClient({
					baseUrl: "https://nextcloud.local",
					userId: "bot",
					appToken: "tok",
				}),
		).not.toThrow();
	});

	it("wirft für http:// ohne allowInsecureHttp", () => {
		expect(
			() =>
				new OcsClient({
					baseUrl: "http://nc.local",
					userId: "bot",
					appToken: "tok",
				}),
		).toThrow(TalkError);
	});

	it("erlaubt http:// nur mit allowInsecureHttp:true", () => {
		expect(
			() =>
				new OcsClient({
					baseUrl: "http://nc.local",
					userId: "bot",
					appToken: "tok",
					allowInsecureHttp: true,
				}),
		).not.toThrow();
	});

	it("wirft für unbekanntes Schema", () => {
		expect(
			() =>
				new OcsClient({
					baseUrl: "ftp://nc.local",
					userId: "bot",
					appToken: "tok",
					allowInsecureHttp: true,
				}),
		).toThrow(TalkError);
	});
});

// ── 2. Basic-Auth-Header + Token-Leak (§6.3 / §9.2) ────────────────────

describe("OcsClient — Basic-Auth & Token-Security (§6.3, §12)", () => {
	const client = () =>
		new OcsClient({
			baseUrl: "https://nc.local",
			userId: "bot-user",
			appToken: "SECRET-APP-TOKEN",
		});

	it("setzt korrekten Basic-Auth-Header (base64(user:appToken))", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody([])));
		await client().listRooms();

		expect(calls).toHaveLength(1);
		const auth = calls[0].headers["Authorization"];
		expect(auth).toBe(`Basic ${Buffer.from("bot-user:SECRET-APP-TOKEN").toString("base64")}`);
	});

	it("das App-Token erscheint NIE in der Request-URL", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody([])));
		await client().listRooms();

		expect(calls[0].url).not.toContain("SECRET-APP-TOKEN");
	});

	it("das App-Token erscheint NIE in der sendChatMessage-URL oder im Body", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody(talkMessage())));
		await client().sendChatMessage("room-tok", "hi agent");

		expect(calls).toHaveLength(1);
		expect(calls[0].url).not.toContain("SECRET-APP-TOKEN");
		expect(calls[0].body).not.toContain("SECRET-APP-TOKEN");
		// Der Text steht im JSON-Body, der Token-Auth nur im Header.
		expect(calls[0].body).toContain("hi agent");
	});
});

// ── 3. Request-Bau (Header, Params) ────────────────────────────────────

describe("OcsClient — Request-Bau (§6.1, §12)", () => {
	const client = () =>
		new OcsClient({
			baseUrl: "https://nc.local",
			userId: "bot",
			appToken: "tok",
		});

	it("setzt OCS-APIRequest:true und Accept:application/json", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody([])));
		await client().listRooms();

		expect(calls[0].headers["OCS-APIRequest"]).toBe("true");
		expect(calls[0].headers["Accept"]).toBe("application/json");
	});

	it("hängt Query-Params korrekt an den /room-Endpoint", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody([])));
		await client().listRooms({ modifiedSince: 1_700_000_000 });

		expect(calls[0].url).toBe(
			"https://nc.local/ocs/v2.php/apps/spreed/api/v4/room?modifiedSince=1700000000",
		);
		expect(calls[0].url).not.toContain("tok");
	});

	it("baut den korrekten Endpoint-Pfad für listRooms (NC 33: v4)", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody([])));
		await client().listRooms();
		expect(calls[0].url).toBe("https://nc.local/ocs/v2.php/apps/spreed/api/v4/room");
	});

	it("setzt Content-Type:application/json beim Senden", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody(talkMessage())));
		await client().sendChatMessage("room-tok", "hi");
		expect(calls[0].headers["Content-Type"]).toBe("application/json");
	});
});

// ── 4. OCS-Validierung robust (§6.1, §12, Zeile 608) ───────────────────
// Regel: Erfolg bei (a) statuscode===100 ODER (b) HTTP-2xx + meta.status
// !== "failure" — reale Instanzen senden HTTP 200 mit statuscode 200.

describe("OcsClient — OCS-Validierung robust (§12/608)", () => {
	const client = () =>
		new OcsClient({ baseUrl: "https://nc.local", userId: "bot", appToken: "tok" });

	it("liefert ocs.data bei statuscode===100", async () => {
		const rooms = [
			{ token: "a", type: 3, displayName: "A" },
			{ token: "b", type: 3, displayName: "B" },
		];
		stubFetch(() => jsonResponse(ocsBody(rooms)));

		const result = await client().listRooms();
		expect(result).toHaveLength(2);
		expect(result[0].token).toBe("a");
	});

	it("akzeptiert HTTP 200 + statuscode 200 + meta.status 'ok' (reale Instanz)", async () => {
		const rooms = [{ token: "real", type: 3, displayName: "Real" }];
		stubFetch(() => jsonResponse(ocsBody(rooms, 200, "OK", "ok"), 200));

		const result = await client().listRooms();
		expect(result).toHaveLength(1);
		expect(result[0].token).toBe("real");
	});

	it("akzeptiert HTTP 2xx + meta.status !== 'failure' unabhängig vom statuscode", async () => {
		// z. B. NC v4 mit statuscode 207 oder Großschreibung 'OK'.
		stubFetch(() => jsonResponse(ocsBody([], 207, "Multi-Status", "OK"), 200));

		const result = await client().listRooms();
		expect(result).toEqual([]);
	});

	it("wirft TalkError bei HTTP 2xx + meta.status 'failure' (auch mit statuscode 100 ≠ …)", async () => {
		stubFetch(() => jsonResponse(ocsBody(null, 404, "room not found", "failure"), 200));

		await expect(client().listRooms()).rejects.toBeInstanceOf(TalkError);
		await expect(client().listRooms()).rejects.toMatchObject({ code: "HTTP_200" });
	});

	it("wirft TalkError bei meta.status 'Failure' (case-insensitive)", async () => {
		stubFetch(() => jsonResponse(ocsBody(null, 404, "nope", "Failure"), 200));

		await expect(client().listRooms()).rejects.toMatchObject({ code: "HTTP_200" });
	});

	it("wirft INVALID_RESPONSE, wenn die OCS-Hülle (ocs.meta) fehlt", async () => {
		stubFetch(
			() =>
				({
					status: 200,
					ok: true,
					headers: new Headers(),
					text: async () => JSON.stringify({ foo: "bar" }),
				}) as Response,
		);

		await expect(client().listRooms()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
	});

	it("sendChatMessage liefert die erzeugte Nachricht zurück", async () => {
		const msg = talkMessage({ id: 902 });
		stubFetch(() => jsonResponse(ocsBody(msg)));
		const got = await client().sendChatMessage("room-tok", "hi");
		expect(got.id).toBe(902);
	});
});

// ── 5. JSON-/Fehler-Parsing (§12) ──────────────────────────────────────

describe("OcsClient — JSON-/Fehler-Parsing (§12)", () => {
	const client = () =>
		new OcsClient({ baseUrl: "https://nc.local", userId: "bot", appToken: "tok" });

	it("wirft AUTH_FAILED bei HTTP 401/403", async () => {
		stubFetch(
			() =>
				({
					status: 401,
					ok: false,
					headers: new Headers(),
					text: async () => "unauthorized",
				}) as Response,
		);

		await expect(client().listRooms()).rejects.toMatchObject({ code: "AUTH_FAILED" });
	});

	it("wirft ROOM_NOT_FOUND bei HTTP 404", async () => {
		stubFetch(
			() =>
				({
					status: 404,
					ok: false,
					headers: new Headers(),
					text: async () => "",
				}) as Response,
		);

		await expect(client().listRooms()).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
	});

	it("wirft INVALID_RESPONSE bei ungültigem JSON", async () => {
		stubFetch(
			() =>
				({
					status: 200,
					ok: true,
					headers: new Headers({ "Content-Type": "application/json" }),
					text: async () => "not-json{",
				}) as unknown as Response,
		);

		await expect(client().listRooms()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
	});

	it("wirft einen HTTP_-code bei nicht-OK-HTTP-Status", async () => {
		stubFetch(
			() =>
				({
					status: 500,
					ok: false,
					headers: new Headers(),
					text: async () => "",
				}) as Response,
		);

		await expect(client().listRooms()).rejects.toMatchObject({ code: "HTTP_500" });
	});

	it("normalisiert reine Netzwerkfehler zu NETWORK", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);

		await expect(client().listRooms()).rejects.toMatchObject({ code: "NETWORK" });
	});
});

// ── 6. receiveChat (Long-Poll) ─────────────────────────────────────────

describe("OcsClient — receiveChat Long-Poll (§7)", () => {
	const client = () =>
		new OcsClient({ baseUrl: "https://nc.local", userId: "bot", appToken: "APP-TOK-SECRET" });

	it("HTTP 304 bedeutet 'nichts Neues'", async () => {
		stubFetch(() => ({ status: 304, ok: false, headers: new Headers() }) as Response);
		const res = await client().receiveChat("room-tok", { lookIntoFuture: 1 });
		expect(res.status).toBe(304);
		expect(res.messages).toEqual([]);
	});

	it("200 + X-Chat-Last-Given liefert Nachrichten und nächsten Offset", async () => {
		const msgs = [talkMessage({ id: 501 }), talkMessage({ id: 502 })];
		stubFetch(() => jsonResponseWithHeaders(ocsBody(msgs), { "X-Chat-Last-Given": "502" }));

		const res = await client().receiveChat("room-tok", { lookIntoFuture: 1, limit: 100 });
		expect(res.status).toBe(200);
		expect(res.messages).toHaveLength(2);
		expect(res.xChatLastGiven).toBe(502);
	});

	it("akzeptiert HTTP 200 + statuscode 200 (reale Instanz) und liefert Nachrichten", async () => {
		const msgs = [talkMessage({ id: 601 })];
		stubFetch(() =>
			jsonResponseWithHeaders(ocsBody(msgs, 200, "OK", "ok"), { "X-Chat-Last-Given": "601" }),
		);

		const res = await client().receiveChat("room-tok", { lookIntoFuture: 1 });
		expect(res.status).toBe(200);
		expect(res.messages).toHaveLength(1);
		expect(res.xChatLastGiven).toBe(601);
	});

	it("setzt lookIntoFuture/lastKnownMessageId/setReadMarker als Query-Params", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody([])));
		await client().receiveChat("room-tok", {
			lookIntoFuture: 1,
			timeout: 30,
			lastKnownMessageId: 501,
			setReadMarker: 1,
			limit: 50,
		});

		const url = calls[0].url;
		expect(url).toContain("lookIntoFuture=1");
		expect(url).toContain("timeout=30");
		expect(url).toContain("lastKnownMessageId=501");
		expect(url).toContain("setReadMarker=1");
		expect(url).toContain("limit=50");
		expect(url).toContain("/ocs/v2.php/apps/spreed/api/v1/chat/room-tok");
		// App-Token nie in der URL.
		expect(url).not.toContain("APP-TOK-SECRET");
	});
});

// ── 6b. setReadMarker (P2a) ─────────────────────────────────────────
// POST /chat/{token}/read mit { lastReadMessageId } — setzt den
// Ungelesen-Zähler zurück. OCS-Erfolgs-Semantik wie überall: statuscode
// 100 ODER HTTP-2xx + meta.status !== "failure" (NC 33).

describe("OcsClient — setReadMarker (P2a)", () => {
	const client = () =>
		new OcsClient({ baseUrl: "https://nc.local", userId: "bot", appToken: "APP-TOK-SECRET" });

	it("POSTet auf /chat/{token}/read mit Body { lastReadMessageId }", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody(null)));
		await client().setReadMarker("room-tok", 502);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			"https://nc.local/ocs/v2.php/apps/spreed/api/v1/chat/room-tok/read",
		);
		expect(JSON.parse(calls[0].body as string)).toEqual({ lastReadMessageId: 502 });
		expect(calls[0].headers["Content-Type"]).toBe("application/json");
	});

	it("setzt Basic-Auth und lässt das App-Token aus URL/Body heraus", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody(null)));
		await client().setReadMarker("room-tok", 1);

		expect(calls[0].headers["Authorization"]).toBe(
			`Basic ${Buffer.from("bot:APP-TOK-SECRET").toString("base64")}`,
		);
		expect(calls[0].url).not.toContain("APP-TOK-SECRET");
		expect(calls[0].body).not.toContain("APP-TOK-SECRET");
	});

	it("akzeptiert statuscode===100 (klassische OCS-Erfolgsantwort)", async () => {
		stubFetch(() => jsonResponse(ocsBody(null, 100, "OK", "ok")));
		await expect(client().setReadMarker("room-tok", 42)).resolves.toBeUndefined();
	});

	it("akzeptiert HTTP 200 + statuscode 200 (reale NC-33-Instanz)", async () => {
		stubFetch(() => jsonResponse(ocsBody(null, 200, "OK", "ok"), 200));
		await expect(client().setReadMarker("room-tok", 42)).resolves.toBeUndefined();
	});

	it("wirft TalkError bei meta.status 'failure' (auch mit HTTP 2xx)", async () => {
		stubFetch(() => jsonResponse(ocsBody(null, 404, "no such room", "failure"), 200));
		await expect(client().setReadMarker("room-tok", 42)).rejects.toMatchObject({
			code: "HTTP_200",
		});
	});

	it("wirft AUTH_FAILED bei HTTP 401", async () => {
		stubFetch(
			() =>
				({
					status: 401,
					ok: false,
					headers: new Headers(),
					text: async () => "",
				}) as Response,
		);
		await expect(client().setReadMarker("room-tok", 42)).rejects.toMatchObject({
			code: "AUTH_FAILED",
		});
	});

	it("wirft INVALID_RESPONSE für ungültige Message-IDs (0, negativ, NaN, Bruchzahl)", async () => {
		const c = client();
		for (const bad of [0, -5, NaN, 1.5]) {
			await expect(c.setReadMarker("room-tok", bad)).rejects.toMatchObject({
				code: "INVALID_RESPONSE",
			});
		}
	});

	it("markRoomRead ist ein Alias für setReadMarker (gleicher Endpoint/Body)", async () => {
		const { calls } = stubFetch(() => jsonResponse(ocsBody(null)));
		await client().markRoomRead("room-tok", 777);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain("/chat/room-tok/read");
		expect(JSON.parse(calls[0].body as string)).toEqual({ lastReadMessageId: 777 });
	});
});

// ── 7. openFileStream (WebDAV) ─────────────────────────────────────────

describe("OcsClient — openFileStream WebDAV (§7.3, §12)", () => {
	const client = () =>
		new OcsClient({
			baseUrl: "https://nc.local",
			userId: "bot",
			appToken: "APP-TOK-SECRET",
		});

	it("baut remote.php/dav/files/{userId}/{userPath} und streamt den Body", async () => {
		const fileContent = Buffer.from("PNG-BYTES");
		const fileStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(fileContent));
				controller.close();
			},
		});
		const { calls } = stubFetch(
			() =>
				({
					status: 200,
					ok: true,
					headers: new Headers(),
					body: fileStream,
				}) as unknown as Response,
		);

		const stream = await client().openFileStream("photos/pic.png");
		expect(stream).toBeInstanceOf(Readable);

		// WebDAV-Pfad-Bildung: userId + userPath; userPath nie doppelt gemountet.
		expect(calls[0].url).toBe("https://nc.local/remote.php/dav/files/bot/photos/pic.png");

		const chunks: Buffer[] = [];
		for await (const chunk of stream) chunks.push(Buffer.from(chunk));
		expect(Buffer.concat(chunks)).toEqual(fileContent);
	});

	it("trimmt führende Slashes des userPath, ohne da-Verzeichnis wegzustanzen", async () => {
		const { calls } = stubFetch(
			() =>
				({
					status: 200,
					ok: true,
					headers: new Headers(),
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.close();
						},
					}),
				}) as unknown as Response,
		);

		await client().openFileStream("/deep/file.pdf");
		expect(calls[0].url).toBe("https://nc.local/remote.php/dav/files/bot/deep/file.pdf");
	});

	it("setzt Basic-Auth auch für den WebDAV-Download", async () => {
		const { calls } = stubFetch(
			() =>
				({
					status: 200,
					ok: true,
					headers: new Headers(),
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.close();
						},
					}),
				}) as unknown as Response,
		);

		await client().openFileStream("a.bin");
		expect(calls[0].headers["Authorization"]).toBe(
			`Basic ${Buffer.from("bot:APP-TOK-SECRET").toString("base64")}`,
		);
		expect(calls[0].url).not.toContain("APP-TOK-SECRET");
	});
});
