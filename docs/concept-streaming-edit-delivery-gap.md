# Streaming-Edits vs. Zweiter-Bot-Zustellung (Delivery Gap)

**Datum:** 2026-09-30
**Status:** Beobachtung + Hypothese, zu klären in einer der nächsten Sessions
**Kontext:** Beobachtung von ekech/Markus im Nextcloud-Talk (Raum mit Igor + Pepe)

## Beobachtung

- Alle Outbound-Nachrichten des Gateways (Igor) tragen in Nextcloud Talk dauerhaft
  das „edited"-Badge.
- Der Zweitbot (Pepe) erhält Nachrichten, in denen ihn ekech/Markus per `@` erwähnen,
  **zuverlässig und sofort**.
- Nachrichten von Igor (Gateway-Bot) kommen bei Pepe dagegen **nicht zuverlässig** an —
  teils gar nicht, teils verspätet/unvollständig.

## Root Cause „edited"-Badge (verifiziert, kein Bug)

`src/core/message-pipeline.ts`:

1. **Platzhalter** (~Z. 475): sofortiges `sendMessage` mit „⏳ Thinking…".
2. **Streaming-Edits** (~Z. 610–631): laufendes `editMessage` in den Platzhalter,
   gedrosselt auf `EDIT_THROTTLE_MS = 400` (max. 2,5 Edits/s, Rate-Limit-Schutz).
3. **Final-Edit** (~Z. 665): letzter `editMessage` ersetzt den Platzhalter durch den
   fertigen Text.

Der Adapter mappt das auf `PUT /chat/{token}/{messageId}` („Streaming-Edit",
`src/adapters/nextcloud-talk.ts` ~Z. 729). Ein Edit erzeugt **keine neue Message-ID** —
er ändert die existierende Nachricht und setzt nur `lastEditTimestamp`. Daher zeigt Talk
bei **jeder** Bot-Antwort „edited" an (mindestens der Final-Edit läuft immer). Das ist
Design-Entscheidung (Live-Streaming-Ansicht), kein Fehler.

## Hypothese: Warum Pepe Igor-Nachrichten verpasst

Der Inbound-Poller (`src/adapters/nextcloud/poller.ts`) arbeitet mit Wasserstand
`lastKnownMessageId` + `lookIntoFuture=1` (Long-Poll). Nachrichten **unterhalb** des
Wasserstands werden **nie erneut** zugestellt.

Daraus folgt für den Zweitbot (falls er analog pollt):

> ⚠️ **Überholt durch den Nachtrag 2026-09-30** — Pepe nutzt Webhooks, kein Polling.

1. Igor sendet Platzhalter „⏳ Thinking…" → **neue ID** → Pepe pollt sie, Wasserstand
   läuft über diese ID.
2. Streaming-Edits + Final-Edit (mit dem eigentlichen, ggf. mit `@Pepe` versehenen
   Text) tragen **dieselbe ID** → werden von Pepe **nie neu zugeliefert**.
3. Ob Pepe den Volltext je „sieht", hängt nur vom **Timing** seines Polls ab:
   - Poll **nach** dem Final-Edit → er liest die Nachricht mit Volltext ✓
   - Poll **vor** dem Final-Edit → er sieht nur „⏳ Thinking…"/Zwischenstand, der
     Endtext kommt für immer nicht nach ✗

Nachrichten von ekech/Markus werden nie editiert → neue ID → jede Poll nach dem Senden
liefert den Volltext. Das deckt die Beobachtung exakt ab („bei Erwähnung durch uns
zuverlässig, bei Igor nicht").

## Nachtrag 2026-09-30: Pepe nutzt Webhooks, kein Polling

Korrektur zur Hypothese: Der Talk-Adapter von Pepe arbeitet mit **Webhooks**, nicht mit
Long-Polling. Die Wasserstand-Logik (`lastKnownMessageId`) gilt für Pepe daher nicht;
der Mechanismus des Delivery Gap ändert sich:

1. Igor sendet Platzhalter „⏳ Thinking…" → **neue Message** → NC Talk feuert den
   `chat`-Webhook → Pepe erhält den Platzhalter (ohne `@`-Mention).
2. Streaming-Edits + Final-Edit (ggf. mit `@Pepe`) tragen **dieselbe Message-ID** →
   NC Talk feuert bei Edits **keinen** Webhook (es gibt kein Edit-Event) → der Endtext
   kommt bei Pepe **deterministisch nie** an.

Konsequenz: Der Gap ist im Webhook-Modus **nicht timing-abhängig** (im Polling-Modus
hätte ein Poll nach dem Final-Edit den Volltext geliefert) — er ist hart. Die
Beobachtung („bei Erwähnung durch uns zuverlässig, bei Igor nicht") passt damit
exakter.

### Verifiziert 2026-09-30 (Doku + Quellcode)

- **Offizielle API-Doku** (nextcloud-talk.readthedocs.io → „Bots and webhooks"): Bot-
  Webhook-Events sind `Create` (neue Chat-Message), `Activity` (System-Message),
  `Like`/`Undo` (Reaktionen), `Join`/`Leave` (Bot-Installation/Entfernung). Es gibt
  **kein Edit-Event**.
- **Quellcode** (`nextcloud/spreed`, `lib/Service/BotService.php`, main): genau diese
  sechs Event-Listener (`afterChatMessageSent`, `afterSystemMessageSent`,
  `afterReactionAdded/Removed`, `afterBotEnabled/Disabled`). Die Edit-Pfad-
  Implementierung feuert **kein** Event in den Bot-Invocation-Pfad → Edits werden an
  Webhook-Bots **nie** zugestellt. Listener-Satz seit Talk 17.1 (NC 27.1) stabil,
  betrifft NC 33 / Talk 23.
- **Nebenfund „No bots for bots“**: In `afterChatMessageSent` — sendet der Absender
  als Talk-Bot, werden andere Bots gar nicht angerufen (serverseitig). Für Igor nicht
  relevant: das Gateway läuft als **User-Account** (App-Token), nicht als Talk-Bot.
  Pepe erhält Igor-Nachrichten daher (als User-Absender) — nur den Platzhalter.

**Alternativ/ergänzend zu prüfen:**
- Filtert Pepe-Bot nach `actorType === "bots"` (vgl. Anti-Loop-Selbstfilter D4) und
  verwirft Igor-Nachrichten grundsätzlich?
- Reagiert Pepe nur auf `@`-Mentions? Der Platzhalter enthält keine Mention, der
  Final-Edit-Text schon — letzterer wird aber (s. o.) nicht erneut zugestellt.
- Pepe könnte den Platzhalter als eigenständige Nachricht verarbeiten und dadurch
  doppelte/leere Reaktionen auslösen (Loop-Risiko).

## Design (festgezurr 2026-09-30, umgesetzt)

Zwei Ebenen, **Single-Shot hat Vorrang** (Entscheidung Edgar 2026-09-30):

| Ebene | Config | Semantik |
|---|---|---|
| Raum-Override | `singleShotRooms: ["gateway:<platform>:<channelId>", …]` (top-level, Label-Format + Validierung wie `groupRooms`) | Gelistete Räume **immer** Single-Shot |
| Plattform-Flag | `platforms.<p>.streaming` (Default `true`, alle Adapter) | `false` = Single-Shot plattformweit |

**Plattübergreifend** gebaut (Discord/Slack/Telegram/WhatsApp/NC-Talk nutzen dasselbe
Streaming-Muster), initial nur NC-Talk-Räume konfiguriert: `u4cmmzxu`, `mmp26ta6`
(die Räume mit Pepe).

**Umsetzung** (2026-09-30, `src/core/message-pipeline.ts` + `src/config.ts` +
`src/types.ts`):
- `isStreamingEnabled(config, platform, channelId)` — zentrale Entscheidung
- `!useStreaming` → kein Platzhalter-`sendMessage` (`sentId` bleibt `undefined`),
  Typing-Indikator + Heartbeat aktiv; Final-Text läuft über den bestehenden
  `else`-`sendMessage`-Zweig (neue Message-ID)
- `setStreamRedirectHandler` (Interaktive-Antwort-Redirect) überspringt in
  Single-Shot-Modus den frischen Platzhalter
- Stream-Callback war bereits an `sentId` bedingt → keine weitere Logik
- Tests: `tests/core/streaming-single-shot.test.ts` (Unit: Prioritäten-Logik ·
  E2E: Single-Shot-Raum / Streaming-Default / Plattform-Flag, Mock-NC)

## Lösungsoptionen (historisch — Option 1 umgesetzt, s. Design)

1. **Single-Shot-Modus (empfohlen):** Config-Flag `platforms.nextcloudTalk.streaming`
   (Default `true`). Bei `false`:
   - keinen Platzhalter senden, kein Streaming-Edit;
   - fertigen Text als **eine neue `sendMessage`** schicken → neue Message-ID →
     zuverlässige Zustellung an Polling-Bots.
   - Typing-Indikator bleibt alsUX-Signal aktiv. Trade-off: keine Live-Vorschau.
   - Optional Variante: Platzhalter behalten, aber am Ende **löschen** und finalen Text
     als neue Nachricht senden (neue ID). ⚠️ Für den Zweitbot ist auch der Platzhalter
     selbst Trigger-Stoff (Anti-Bot-Loop, vgl. concept-anti-bot-loop-filter.md) —
     „kein Platzhalter" ist daher vorzuziehen.
2. **Pepe-seitig:** Edits verarbeiten (`lastEditTimestamp`) — außerhalb unseres
   Einflusses, nur als Fallback zu dokumentieren.

## Nächste Schritte (für die Session)

- [x] Webhook-Verhalten verifizieren (2026-09-30): **nein** — NC Talk feuert bei Edits
      keinen Bot-Webhook (Doku + `BotService.php`-Quellcode, s. Nachtrag). Der Gap ist
      deterministisch. (Pepe-seitige Mention-/Bot-Filter bleiben als Sekundärfaktor
      ungeprüft — für die Zustellung des Endtexts aber irrelevant, da der Webhook
      gar nicht feuert.)
- [x] Flag `streaming` + `singleShotRooms` in Pipeline implementieren (Default
      `true`, Verhalten unverändert) + Tests (2026-09-30, Suite 520 grün).
      Deployment + Produktiv-Config (`singleShotRooms: u4cmmzxu, mmp26ta6`) +
      Dienst-Neustart ausstehend.
- [ ] A/B-Test im Raum: Streaming-Antwort vs. Single-Shot-Antwort, Zustellung bei
      Pepe beobachten.
- [ ] Entscheidung dokumentieren (ggf. als ADR), für andere Adapter (Discord, Slack,
      Telegram, WhatsApp nutzen dasselbe Streaming-Muster) prüfen, ob das Flag
      plattformübergreifend nötig ist.
