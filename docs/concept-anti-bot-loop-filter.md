# Konzept — Gateway-seitiger Anti-Bot-Loop-Filter

**Status:** Entwurf (2026-09-24) — Entscheidung ausstehend
**Bezug:** ADR `adr-bot-allowlist.md` (2026-09-20), Punkt „bewusst zurückgestellt"
**Owner-Konzept:** Igor (Orchestrator), Freigabe/Umsetzung: Edgar

## 1. Problem

Bei anwesendem Zweitbot in einem Gruppenraum löst eine vom Gateway (oder vom
Modell) gesendete Stumm-Notiz den anderen Bot aus → endloser Bot-auf-Bot-Ping-Pong.
Aktuell werden zwei Notizen-Typen gesendet, die beide auslösen:

1. **Gateway-Fallback** (`src/core/message-pipeline.ts` ~Z. 567): bei leerer
   Agent-Antwort (`responseText.length === 0`) wird fest gesendet:
   `I processed your message but had no text response. Please try again.`
2. **Stumm-Notiz des Modells**: glm-5.3-flash hält sich nicht an die
   „empty message"-Anweisung des Guards und sendet z. B.
   `*(Nachricht nicht an Igor adressiert – Igor bleibt stumm…)*`.

Beide sind reale, gesendete Nachrichten → der andere Bot löst sie auf.

## 2. Ist-Stand

- Guard `buildPolicyGuard` (`src/security/tool-policy.ts`) weist Modell bei
  nicht-adressierter Gruppenmessage auf „empty message" hin — aber **kein**
  deterministischer „nicht-adressiert"-Flag wird zurückgegeben.
- Sendevorgang (`message-pipeline.ts` ~Z. 545–579): sendet `finalText` bzw. den
  Fallback-Fallback — **ohne** kontextbasierte Prüfung „Gruppe + nicht-adressiert".
- Loop-Schutz laut ADR (max. 2 Bot-Runden + Rate-Limit) wirkt nicht gegen die
  gesendete Stumm-Notiz.
- `groupRooms`-Config existiert nicht (nur im ADR erwähnt).

## 3. Festgezerrte Anforderungen (Edgar, 2026-09-24)

1. **Umfang: global** — alle Plattformen, alle Gruppenräume (nicht nur NC Talk).
2. **Auslöser: alle** — nicht nur konfigurierte Bots, auch Bot-Accounts, die als
   normale User erscheinen.
3. **Filterziel: beide** Notizen — Gateway-Fallback **und** Modell-Stumm-Notiz.

Randbedingung: **Private/DM-Kommunikation bleibt intakt** — Filter nur auf
Gruppen/Channels, nicht auf Direktnachrichten.

## 4. Ansatz-Vergleich

### Ansatz A — output-basiert (karger Eingriff)
- Guard-Anweisung verschärfen: „return an empty string, emit NO text".
- Gateway filtert in Gruppen leere Antworten + erkannte Stumm-Notizen (Regex) →
  kein Senden.
- **Restrisiko:** glm-5.3-flash hält sich nicht an „empty message" → Stumm-Notiz
  landet trotzdem im Raum → Ping-Pong setzt sich fort. Nicht ausreichend.

### Ansatz B — kontextbasiert (sauber, empfohlen)
- Adressierung (@Igor/@all) **gateway-seitig** vor der Modell-Frage erkannt
  (Regex, konsistent mit ADR „strikte @-Adressierung").
- Bei **Gruppe + nicht-adressiert** → Modell **nie** befragt → deterministisch
  stumm, kein gesendeter Text, kein Auslösestoff für den anderen Bot.
- Gateway-Fallback (leere Antwort) global unterbinden (kein „I processed…").
- **Vorteil:** 100% zuverlässig, kein Rest-Ping-Pong.
- **Aufwand:** Adressierungserkennung plattformübergreifend; Identität „Gruppe vs.
  DM" über `channelType`/Label (`gateway:<platform>:<channelId>`) ableiten.

### Hybrid (Empfehlung)
Ansatz B als primärer Mechanismus + Ansatz A (leere-Antwort-Filter global) als
Sicherheitsnetz für den Fall, dass das Modell doch textuell antwortet.

## 5a. Nachtrag (2026-09-24, nach Bot-Loop-Ereignis): Leer-Nachrichten-Filter

**Ereignis:** Nach Deploy trat erneut ein Bot-Loop auf (Nextcloud Talk, zwei Räume). Root-Cause:
leere/„."-Nachrichten werden als gültige Kommunikation behandelt → lösen Modell-Antwort aus → Loop.
Der Ansatz-B-Filter greift hier nicht (NC Talk = `unknown` ohne groupRooms; Loop läuft über
Leer-`.`-Nachrichten, nicht über Adressierung).

**Festgezerrt (Edgar):**
- **Leer-Definition:** Länge 0 **oder** Länge 1 mit nicht-alphanumerischem Zeichen **außer** `?`/`!`.
  Gefiltert: `""`, `.`, `,`, `;`, `:` … — NICHT gefiltert: `?`, `!` (echte Kommunikation).
- **Filter: global** — alle Absender, alle Plattformen.
- **Adressierungs-Regel unverändert:** Igor antwortet auf @Igor/@all, egal von wem
  (auch Bots in Allowlist).
- **`groupRooms` konfiguriert** (2026-09-24): die vier NC-Talk-Räume als
  `gateway:nextcloudTalk:<token>`-Labels → NC Talk wird als `group` erkannt (Ansatz B greift).

**Umsetzung (Leer-Filter):**
- Inbound: `content` leer nach obiger Definition → Nachricht ignorieren (kein Modell-Call),
  **außer** `isBotAddressed(content)` → dann antworten.
- Ansiedlung: zentral im Message-Pfad (Pipeline, vor Modell-Call), global für alle Plattformen.
- Outbound-Seite bereits umgesetzt (leere Antwort → nichts senden).

## 5. Offene Fragen an Edgar
- Ansatz B (kontextbasiert) OK als Primärmechanismus?
- Adressierungserkennung global für alle Plattformen (Telegram/NC Talk/Discord/…)?
- Soll die Adressierungs-Erkennung zukünftig zentral im Gateway liegen (statt
  nur Guard-Anweisung ans Modell)?

## 6. Geplante Umsetzung (nach Freigabe)
- Neue Funktion `isGroupMessageAddressed(platform, content)` + `isGroupChannel()`.
- Insertion in `message-pipeline.ts` vor `runPrompt` (Nicht-Adressierung → Return,
  kein Modell-Call).
- Gateway-Fallback ~Z. 567 global auf „kein Senden" setzen.
- Tests: E2E Bot-auf-Bot-Szenario (2 Bots, nicht-adressiert → 0 gesendete Nachrichten).
- ADR aktualisieren (von „zurückgestellt"

## 6b. Relevanten Dateien (File-Map, vollständig — Raten unnötig)
- `src/core/message-pipeline.ts` — Bot-Filter (~Z. 76–100), Sendebereich (~Z. 545–579, Gateway-Fallback).
- `src/security/tool-policy.ts` — `buildPolicyGuard` (~Z. 522–585), GROUP MESSAGE RULE.
- `src/types.ts` — Message-/Channel-Typen (`channelType`/`metadata`).
- `docs/adr-bot-allowlist.md` — zu aktualisieren (Status → umgesetzt).

## 6c. Protokoll-Pflicht (gegen empty_result)
- Ergebnis, Reflexion und Trace zwingend mit dem write-Tool als
  `output/{role}-{timestamp}/{result,reflection,trace}.md` ablegen. Deliverables ins
  Projektverzeichnis, nie in output/." auf „umgesetzt").
