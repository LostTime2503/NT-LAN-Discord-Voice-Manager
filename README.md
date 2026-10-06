# NT-LAN Voice Manager

Discord-bot for NT-LAN voice channel management.

## Miljovariabler

| Variabel | Pakrevd | Beskrivelse |
| --- | --- | --- |
| `DISCORD_TOKEN` | Ja | Bot-token fra Discord Developer Portal. |
| `DISCORD_CLIENT_ID` | Ja | Application ID fra Discord Developer Portal. |
| `DISCORD_GUILD_ID` | Ja | Server-ID til Discord-serveren boten skal registrere slash commands pa. |
| `JOIN_TO_CREATE_CHANNEL_ID` | Nei | Kanal-ID for "Lag ny kanal her", satt av `/setup-voice-manager`. |
| `CS_TEAM_CATEGORY_ID` | Nei | Kategori-ID for CS-lagkanaler, satt av `/setup-voice-manager`. |
| `CREW_LOG_CHANNEL_ID` | Nei | Tekstkanal-ID boten sender online/offline-meldinger til, f.eks. `#bot-log`. |
| `EMPTY_CHANNEL_DELETE_DELAY_MS` | Nei (standard `300000`) | Millisekunder en tom midlertidig voice-kanal star ubrukt for boten sletter den. |

Ingen av disse skal ligge i kildekoden, `Dockerfile` eller Git. De settes lokalt i `.env`, eller som miljovariabler pa serveren/i Dockhand.

## Forste milepael

- Leser hemmeligheter fra lokal `.env`.
- Registrerer en guild-scoped slash command: `/ping`.
- Starter en `discord.js`-klient som kan svare i testserveren.

## Lokal oppstart

Installer Node.js 20 LTS eller nyere forst. Sjekk deretter:

```powershell
node -v
npm -v
```

Installer avhengigheter:

```powershell
npm.cmd install
```

Lag en lokal `.env` basert pa `.env.example`:

```powershell
Copy-Item .env.example .env
```

Fyll inn disse verdiene i `.env`:

- `DISCORD_TOKEN`: bot-token fra Discord Developer Portal.
- `DISCORD_CLIENT_ID`: Application ID fra Discord Developer Portal.
- `DISCORD_GUILD_ID`: ID-en til testserveren.

Ikke legg `.env` i Git, og ikke del bot-token i chat.

Registrer slash commands pa testserveren:

```powershell
npm.cmd run deploy:commands
```

Start boten lokalt:

```powershell
npm.cmd run dev
```

Hvis du far `SELF_SIGNED_CERT_IN_CHAIN`, la Node bruke Windows sitt sertifikatlager i den aktive terminalen:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
```

Hvis terminalen samtidig ikke finner `node`, legg Node-mappen inn i PATH for den aktive terminalen:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"
```

Kjor deretter kommandoene pa nytt:

```powershell
npm.cmd run deploy:commands
npm.cmd run dev
```

Enkleste Windows-start i dette prosjektet er a bruke de ferdige `.cmd`-filene:

```powershell
.\scripts\deploy-commands.cmd
.\scripts\dev.cmd
```

I Windows PowerShell kan `npm` bli blokkert av execution policy fordi PowerShell velger `npm.ps1`. Bruk `npm.cmd` hvis du far en slik feilmelding.

Hvis `npm.cmd` ikke finnes i terminalen etter at PATH er oppdatert, lukk den gamle terminalen og apne en ny. Du kan ogsa bruke full sti midlertidig:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run deploy:commands
& "C:\Program Files\nodejs\npm.cmd" run dev
```

Test `/ping` i Discord-testserveren.

## Test voice manager

1. Start boten med `.\scripts\dev.cmd`.
2. Kjor `/setup-voice-manager` i Discord-testserveren. Du ma ha rettighet til a administrere kanaler.
3. Kommandoen lager/finner kategorien `–KANALER` og voice-kanalen `Lag ny kanal her`.
4. Kommandoen lager/finner ogsa kategorien `–CS LAG`, som brukes senere til private CS-lagkanaler.
5. Kopier `JOIN_TO_CREATE_CHANNEL_ID=...` og `CS_TEAM_CATEGORY_ID=...` fra svaret inn i lokal `.env`.
6. Stopp boten med `Ctrl+C` og start den pa nytt med `.\scripts\dev.cmd`.
7. Bli med i `Lag ny kanal her` i Discord.
8. Boten skal lage en ny midlertidig voice-kanal under `–KANALER` og flytte deg dit.
9. Forlat den midlertidige kanalen. Den slettes etter `EMPTY_CHANNEL_DELETE_DELAY_MS` millisekunder.

Uten aktiv tilgangskontroll far kanaleieren `Manage Channels` pa den midlertidige kanalen. Med aktiv tilgangskontroll brukes bare `/voice-name`, slik at kanalrettighetene ikke kan endres av vanlige medlemmer. Eierskapet lagres i `data/voice-owners.json` og Docker-volumet `bot-data` for a overleve omstart.

Nar du star i en midlertidig kanal du selv har laget, kan du ogsa endre navn med kommandoen:

```text
/voice-name navn: nytt kanalnavn
```

Boten sorterer midlertidige kanaler alfabetisk under `–KANALER` etter opprettelse og navneendring.

Hvis boten restartes, rydder den automatisk ved oppstart:

- tomme voice-kanaler under `–KANALER` slettes
- voice-kanaler under `–KANALER` som fortsatt har brukere blir tatt over og overvaket videre
- `Lag ny kanal her` slettes aldri av cleanupen
- brukere som ble sittende fast i `Lag ny kanal her` mens boten var nede, far en ny midlertidig kanal og blir flyttet dit automatisk

Midlertidige kanaler far automatisk serverens gjeldende maks bitrate. Pa en ikke-boostet server blir dette Discords standard maks. Hvis testserveren boostes senere, oker bitraten automatisk uten kodeendring.

Hvis du setter `CREW_LOG_CHANNEL_ID` i `.env` til en tekstkanal-ID, f.eks. `#bot-log`, sender boten:

- en melding nar den blir online
- en melding nar den stoppes kontrollert med `Ctrl+C` eller `docker stop`

Dette dekker planlagt stopp, ikke krasj eller strombrudd. Automatisk varsling ved krasj krever et overvakingsoppsett rundt Docker/Dockhand, som vi setter opp i Docker-milepaelen.

For rask lokal test kan du sette dette lavere i `.env`, for eksempel:

```env
EMPTY_CHANNEL_DELETE_DELAY_MS=10000
```

## Nettsidekobling, kallenavn og tilgang

Tilgang er basert pa Discord-koblingen og fullt navn, ikke pa deltakelse i et bestemt LAN. API-et ma inkludere ogsa brukere som ikke er pameldt arets arrangement. Dette er fortsatt en kontrakt som ma bekreftes med nettsideansvarlig; boten kan ikke oppdage kontoer endepunktet utelater.

API-formatet er `{ "data": { "participants": { "DISCORD_ID": { "name": "Fullt navn", "firstName": "Fornavn" } } } }`. Noklene behandles som tekst; `discordUsername`, `crew`, `admin`, `days`, `meals` og `children` brukes ikke til autorisasjon. Nettsiden ma ha verifisert Discord-ID-en gjennom Discord-innlogging. API-klienten bruker client credentials med `scope=openid`, fornyer token automatisk og prover en gang til ved 401. API-kall har tidsgrense og samtidige kall samles.

### Nye miljovariabler

| Variabel | Beskrivelse |
| --- | --- |
| `ACCESS_CHANNEL_ID` | Tekstkanal for inngangsmeldingen. |
| `ACCESS_ROLE_ID` | Egen tilgangsrolle under bade bot og Crew. Du bestemmer rettighetene i Discord; administrative rettigheter varsles uten a stoppe boten. |
| `CREW_ROLE_ID` | Crew-rolle; denne og roller over den gir tilgang uten nettsidekobling. Administrator og servereier unntas ogsa. |
| `REGISTRATION_URL` | HTTPS-lenken medlemmene apner for a logge inn/koble Discord. |
| `REGISTRATION_API_URL` | HTTPS-adressen for deltakerobjektet. |
| `REGISTRATION_TOKEN_URL` | HTTPS-adressen for tokenutstedelse. |
| `REGISTRATION_CLIENT_ID` | Klient-ID, normalt `discord-bot`. |
| `REGISTRATION_CLIENT_SECRET` | Hemmelig klientnokkel. Aldri i Git eller logger. |
| `ACCESS_DRY_RUN` | Standard `true`: ingen navne-, rolle-, meldings- eller rettighetsendringer fra tilgangskontrollen. Eksisterende voice-funksjoner fortsetter som normalt. |
| `ACCESS_SYNC_INTERVAL_MS` | Standard `60000`: intervall for automatisk kontroll av eksisterende medlemmer. |

Alle fire API-/token-/klientinnstillinger ma fylles ut sammen. Nar de er tomme, er tilgangskontrollen av. Nar API-et er konfigurert, kreves kanal, roller og nettsidelenke. MAT-variablene i eksempelfilen er reservert; det er ingen MAT- eller matfunksjon i denne implementasjonen.

### Oppstart pa testserver

1. Roter eventuelle tidligere delte hemmeligheter. Fyll ut API-innstillingene og nye Discord-ID-er lokalt uten a dele verdiene.
2. Opprett en tilgangsrolle med de medlemsrettighetene du onsker, plassert under bade botrollen og Crew. Sett `ACCESS_ROLE_ID`. Boten endrer aldri rollens serverrettigheter.
3. Aktiver **Server Members Intent** under Bot i Discord Developer Portal. Boten trenger `Manage Nicknames`, `Manage Roles`, samt eksisterende voice-rettigheter. I inngangskanalen trenger den `View Channel`, `Send Messages` og `Read Message History`.
4. Sett kanalrettighetene manuelt i Discord som beskrevet nedenfor. Det finnes ingen kategoriliste eller automatisk kanalbeskyttelse i boten.
5. Behold `ACCESS_DRY_RUN=true`. Kjor `npm.cmd test`, `npm.cmd run deploy:commands` og `npm.cmd run dev`. Loggen viser bare summerte kontrollresultater, ikke navn eller API-payloads.
6. Kjor `/setup-access` i torrkjoring. Standard synlighet for kommandoen er Manage Server; gi Crew tilgang under serverens integrasjonsinnstillinger hvis nodvendig.
7. Nar testresultatene er riktige, sett `ACCESS_DRY_RUN=false` og start boten pa nytt. Navn og tilgangsroller synkroniseres da automatisk. Kjor `/setup-access` for a publisere/oppdatere inngangsmeldingen uten a endre kanalrettighetene.
8. Test med et vanlig medlem uten crew/admin: inngangskanalen synlig for uverifiserte, navn satt for rolle tildeles, beskyttede kanaler synlige etterpa og inngangskanalen skjult. Test ogsa API-feil, omstart, voice og en Discord-koblet bruker uten arets pamelding.

Inngangsmeldingen har nettsidelenke og **Sjekk tilgang**-knapp. Knappen gir et privat svar. Crew beholder tilgang uten kobling/navn; deres navn oppdateres bare hvis API-et har dem og boten kan endre medlemmet. Hoyere roller og servereier ma sette navn selv. Navn over 32 tegn forkortes til API-ets fornavn og siste navneledd; dersom det fortsatt ikke passer eller navnet er ugyldig, ma Crew hjelpe. Sammensatte etternavn kan kreve manuell kontroll. Boten vedlikeholder navn gjennom polling; ta bort `Change Nickname` fra vanlige medlemsroller dersom egen navneendring skal forbys, men behold den for Crew.

### Kanalrettigheter og tilbakeforing

Discord er kilden til rollens rettigheter. Vanlige medlemsrettigheter begrenser ikke oppstart eller rolletildeling. Administrator, rolle-/kanaladministrasjon og modereringsrettigheter pa tilgangsrollen gir en advarsel i loggen, ikke et oppstartsstopp; ingen rettigheter fjernes automatisk. Administrator omgar kanalbeskyttelsen, sa gjennomga slike advarsler selv. Gjentatte kontroller av samme uendrede rettigheter gir ikke gjentatte advarsler.

Manglende roller, utilstrekkelige botrettigheter eller feil rolleplassering setter tilgangssynken pa pause med en konkret melding, ikke hele boten. Rett opp problemet og start boten pa nytt for a gjenoppta den periodiske synken. Knappen og nye medlemskontroller validerer oppsettet for nye API-/Discord-endringer. API-nedetid gir fortsatt automatisk nytt forsok pa neste intervall. Eksisterende voice-kanaler og medlemstilgang beholdes; nye voice-kanaler krever fremdeles crew-unntak/tilgangsrolle og beskyttet kategori. Ved ufullstendige miljovariabler som hindrer opprettelse av tilgangstjenesten, blokkeres all ny voice-opprettelse til konfigurasjonen er rettet.

Kanalrettigheter settes manuelt i Discord. Pa medlemskategoriene nekter du `@everyone` **View Channel** og tillater tilgangsrollen, botrollen, Crew og relevante lederroller. Synkroniser underkanalene med kategorien og kontroller andre rolle-/personunntak. Private crew-kategorier skal ikke apnes for tilgangsrollen. Pa inngangskanalen tillater du `@everyone` **View Channel** og nekter tilgangsrollen; boten trenger **View Channel**, **Send Messages** og **Read Message History**. Nekt meldinger for vanlige medlemmer. Kanaler uten kategori ma ogsa konfigureres separat. Administrator omgar skjulingen.

Join-to-create bruker sin faktiske foreldrekategori: boten kontrollerer at `@everyone` nektes **View Channel** og at tilgangsrollen tillates **View Channel**, og kopierer kategoriens overwrites til nye voice-kanaler. Ingen kategori-ID-liste kreves. Du ma selv kontrollere andre unntak og Crew-/bottilgang. Boten endrer ikke dine manuelle rettigheter ved oppstart eller ved vanlig `/setup-access`.

Hvis en eldre versjon allerede opprettet `data/access-permissions-backup.json`, kan `/setup-access gjenopprett:true bekreft:true` eksplisitt gjenopprette disse gamle rettighetene. Ikke bruk dette ved vanlig manuelt oppsett: det kan overskrive senere manuelle endringer. Det opprettes ingen nye rettighetskopier. Gjenoppretting er bare en kontroll i torrkjoring; navn og tilgangsroller tilbakestilles ikke. Ta vare pa eventuell gammel sikkerhetskopi og Docker-volumet. Hvis en sikkerhetskopiert kanal er slettet, kreves manuell gjennomgang. Botlagde voice-kanaler etter sikkerhetskopien ma eventuelt ryddes separat.

Et vellykket og formatvalidert API-svar brukes som gjeldende koblingsliste. Hvis en vanlig brukers Discord-ID mangler, fjernes tilgangsrollen ved neste kontroll; loggen teller dette som `revoked`. Brukere uten rollen blir `not-linked`. Crew, roller over Crew, administratorer og servereier unntas alltid, og deres roller fjernes ikke ved frakobling. Kallenavn tilbakestilles ikke. Med `ACCESS_DRY_RUN=true` fjernes ingen roller.

API-nedetid, HTTP-feil, tidsavbrudd og ugyldig svarformat fjerner aldri eksisterende tilgangsroller. En vellykket tom liste er derimot gyldig og kan fjerne tilgang fra alle vanlige medlemmer. API-et ma derfor returnere en komplett liste over alle Discord-koblede brukere, ogsa personer uten arets LAN-pamelding; et filtrert eller ufullstendig svar kan ellers gi feilaktig fjerning. Boten kan ikke skille slik utelatelse fra frakobling. Ny kobling gir tilgang igjen etter navnekontrollen. Nye brukere far aldri tilgang nar kontrollen feiler. Andre roller/personunntak kan fortsatt gi kanaltilgang; manuelle Discord-rettigheter ma vaere riktige. Rollefjerning kobler ikke eksplisitt fra en allerede aktiv voice-forbindelse. Nye kategorier/kanaler ma ogsa fa riktige manuelle rettigheter; kategoriens synlighet alene er ikke nok hvis underkanalene har egne overstyringer.

### Docker og utrulling

Docker Compose videresender de nye variablene og lagrer sikkerhetskopi/voice-eierskap i `bot-data:/app/data`. Eksisterende bind-mounts/volumer ma vaere skrivbare for containerens `node`-bruker. Oppdater variablene i Dockhand, bygg nytt image og gjenskap containeren gjennom eksplisitt sync. Vanlig restart bruker gammelt image. Slash-kommandoer registreres separat; Docker starter bare boten.

Ved overgang fra eldre branch-builds, slett bare den genererte `dist`-mappen for ny build sa gamle JavaScript-filer ikke blir liggende igjen. `npm.cmd run dev` bruker `src` direkte.

## TypeScript-kort forklart

- `type ChatInputCommandInteraction` betyr at TypeScript vet hvilken type Discord-interaksjon `/ping` mottar.
- `strict: true` gjor at TypeScript stopper flere feil tidlig, for eksempel manglende miljo-variabler eller feil typer.
- Filene importerer med `.js` selv om kildefilene er `.ts`, fordi NodeNext bygger TypeScript til ekte JavaScript-moduler.