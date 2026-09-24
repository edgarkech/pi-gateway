# ADR — Bot-Allowlist & Group-Message Silence (2026-09-20)

**Status:** Umgesetzt + live verifiziert (2026-09-20); Anti-Bot-Loop-Erweiterung (Ansatz B) umgesetzt (2026-09-24, `concept-anti-bot-loop-filter.md`); Leer-Nachrichten-Filter (§5a) umgesetzt (2026-09-24)

## Kontext

Der Gateway filtert Bot-Nachrichten (actorType `bots`) seit dem Anti-Loop-Konzept
(D4/§5.3) stillschweigend — Pepe (Bot) war im Gruppenraum u4cmmzxu für den Agent
unsichtbar, obwohl Bot-zu-Bot-Kommunikation laut Gruppenraum-Regeln (SYSTEM-RPC.md
[0d]) ausdrücklich erlaubt und überwacht sein soll. Zusätzlich antwortete der
Security-Layer auf nicht-erlaubte User mit „You are not allowed to use this
agent…" — auch auf Bot-Nachrichten, was Lärm erzeugt und Antwort-Loops provozieren
kann.

## Entscheidung (Edgar, 2026-09-20)

1. **Bot-Allowlist:** Neues Config-Feld `platforms.nextcloudTalk.allowedBots`
   (Liste von Bot-ActorIds, initial Pepe `bot-2a9f834ad7c9e0462aff11033a6514dd4a45d802`).
   Gelistete Bots werden wie Menschen behandelt (Kontext + Antwort-Regel); fremde
   Bots bleiben gefiltert. Default `[]` erhält das bisherige Verhalten.
2. **Security-Layer:** Gelistete Bots umgehen den Allowlist-Check
   (message-pipeline.ts); fremde Bots werden **still verworfen** (keine Meldung —
   sie würde Lärm + Loops provozieren). `resolveUserId` löst Bots auf die stabile
   actorId auf (statt Displayname, der keine Allowlist matchen konnte).
3. **Strikte @-Adressierung:** Nur explizit `@Igor`/`@all` zählt als Adresse —
   Klartext-Nennungen („Igor") nicht (sonst würde „Hey Pepe, kannst Du Igor's
   Nachrichten lesen" als Adressierung zählen). SYSTEM-RPC.md [0d] Punkt 1
   präzisiert (Sprech-/Schweig-Disziplin).
4. **Prompt-Zeile:** Der Policy-Guard (tool-policy.ts) enthält eine
   GROUP MESSAGE RULE: Group message not addressed to you explicitly (@Igor/@all)
   → respond with an empty message (no text).

## Bekanntes Verhalten (ursprünglich Option A) — ersetzt durch Ansatz B (2026-09-24)

Das frühere Modell (glm-5.3-flash) befolgte die „empty message"-Anweisung nicht
zuverlässig: Es antwortete mit einer kurzen Stumm-Notiz („*(Nachricht nicht an
Igor adressiert – Igor bleibt stumm gemäß Gruppenregel.)*"), die regulär in den
Raum gesendet wurde — ein realer Auslösestoff für Bot-auf-Bot-Ping-Pong.

### Anti-Bot-Loop-Filter (Ansatz B, `concept-anti-bot-loop-filter.md`)

Mit der Festzurrung (2026-09-24, Edgar) ist das gateway-seitig deterministisch
unterbunden:

1. **Adressierung gateway-seitig** (`message-pipeline.ts`, `classifyChannel` +
   `isBotAddressed`): Gruppennachrichten ohne explizite @-Adressierung
   (@Igor/@all) befragen das Modell **nie** → deterministisch stumm, kein
   gesendeter Text, kein Auslösestoff für den Zweitbot.
   - Gruppen-/DM-Erkennung über platform-Metadaten (`chatType`/`isDM`/`isGroup`)
     sowie explizite `groupRooms`-Labels (`gateway:<platform>:<channelId>`) für
     Kanäle ohne DM-Flag (z. B. Nextcloud-Talk-Räume). `unknown` wertet der
     Filter als NICHT-Gruppe → **DM bleibt intakt**.
   - Kanonische @-RegEx als Einzel-Quelle in `tool-policy.ts` (`isBotAddressed`),
     von Pipeline und Policy-Guard gemeinsam genutzt (ADR Pkt. 3).
2. **Gateway-Fallback global unterbunden**: leere Agent-Antwort sendet kein
   „I processed your message…" mehr; die evtl. Platzhalter-Message wird
   best-effort entfernt. (Hybrid-Risikominimierung aus dem Konzept.)
3. **Gruppen-Config** `groupRooms?: string[]` (GatewayConfig) — leer/fehlend =
   heutiges Verhalten; Backward-kompatibel.

Umfang (Festzurrungspunkt 1–3): global, alle Plattformen, alle Gruppenräume,
Auslöser auch für Bot-Accounts, die als normale User erscheinen (actorType
`users`); beide Notizen-Typen (Modell-Stumm-Notiz + Gateway-Fallback) sind
adressiert.

### Leer-Nachrichten-Filter (Ansatz B §5a, umgesetzt 2026-09-24)

Nach Deploy trat erneut ein Bot-Loop auf (Nextcloud Talk, zwei Räume);
Root-Cause: leere/`.`-Nachrichten wurden als gültige Kommunikation behandelt →
Modell-Antwort → Loop. Der Adressierungs-Filter (Ansatz B) greift hier nicht
(NC Talk = `unknown` ohne groupRooms; Loop läuft über Leer-`.`-Notizen, nicht
über Adressierung). Festzurrung (Edgar):

- **Leer-Definition** (`isEmptyMessage`, `message-pipeline.ts`): Länge 0 **oder**
  Länge 1 mit nicht-alphanumerischem Zeichen **außer** `?`/`!`. Gefiltert:
  `""`, `.`, `,`, `;`, `:` … — NICHT gefiltert: `?`, `!` (echte Kommunikation).
  Alphanumerisch = Unicode-Buchstaben (`\p{L}`) oder Ziffern (`\p{N}`).
- **Filter: GLOBAL** — alle Absender, alle Plattformen, alle Kanäle (auch
  `unknown`/DM; im Gegensatz zum Adressierungs-Filter, der nur bei positiv
  erkannter Gruppe greift). Ansiedlung: zentral im Message-Pfad
  (`message-pipeline.ts`, `onMessage`), **vor** jedem Modell-Call.
- **Adressierungs-Regel unverändert:** `isBotAddressed` (@Igor/@all)
  überschreibt den Leer-Filter → auch eine ansonsten „leere" Nachricht, die
  den Bot explizit adressiert, wird beantwortet.
- **`groupRooms` konfiguriert (2026-09-24):** die vier NC-Talk-Räume als
  `gateway:nextcloudTalk:<token>`-Labels → NC Talk wird als `group` erkannt
  (Ansatz B greift).

Tests: `tests/core/anti-bot-loop-classify.test.ts` (Unit `isEmptyMessage`),
`tests/core/anti-bot-loop-group.test.ts` (E2E: Leer-`.`/`,` ignoriert global,
`?`/`@Igor` passiert). Stand 2026-09-24: 512 Tests grün + 5 E2E-Skips
(517 gesamt).

## Konsequenzen

- Bot-zu-Bot-Kommunikation läuft in beide Richtungen sichtbar (live verifiziert:
  Pepe-Nachrichten im Session-Protokoll, Igor antwortet auf @Igor).
- Loop-Schutz: keine „not allowed"-Meldungen mehr an Bots; Schweig-Regel +
  [0d]-Loop-Regel (max 2 Bot-Runden) + Rate-Limit tragen das Restrisiko.
- Tests: 484 grün + 5 E2E-Skips; Commits `0e59978` (Feature), `322acd1` (Fix).
- Anti-Bot-Loop (Ansatz B): 503 Tests grün + 5 E2E-Skips (Stand 2026-09-24);
  neue Suiten `tests/core/anti-bot-loop-group.test.ts` (E2E) +
  `tests/core/anti-bot-loop-classify.test.ts` (Unit), Config-Tests in
  `tests/config.test.ts`.
