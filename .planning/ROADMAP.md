# Roadmap: auto-sop

**Created:** 2026-04-13
**Last updated:** 2026-04-28
**Depth:** standard
**Phases:** 10 (restructured: Metrics before SaaS, publish after both)
**Coverage:** 61/61 v1 requirements mapped

## Phases

- [x] **Phase 0: Distribution Decision + Foundations** — Resolve hybrid distribution model, build pure-logic foundations (PathResolver, Config, Scrubber). _(v1 — shipped 2026-04-13)_
- [x] **Phase 1: Capture Foundation** — Hook shim, capture writer, turn-directory store. <50ms hook latency, fail-open. _(v2 — shipped 2026-04-13, hardened v4-v8)_
- [x] **Phase 2: Installer + Scheduler + CLI Skeleton** — `npx auto-sop install`, hourly launchd/systemd, status/doctor/pause CLI. _(v3 — shipped 2026-04-13, hotfixes v4-v8, launchd reliability v12)_
- [x] **Phase 3: Learner** — Rule-based detectors (N≥3 evidence) + LLM-driven directive generation via `claude -p`. _(v9 MVP batch, v13 detectors, v14 LLM ON, v17 learn-now + hard-kill → 100%)_
- [x] **Phase 4: ManagedSectionEditor** — Atomic, hash-checked, git-aware CLAUDE.md writer, never clobbers user edits, revertible. _(v10-v11 light editor, v16 hardening → 100%)_
- [x] **Phase 5: Inspection CLI + Packaging** — `recent`/`show`/`revert` verbs, npm publish pipeline, README badges, GitHub community files, Homebrew tap staging. _(v17-v22 → 100%)_
- [x] **Phase 6: Native Windows + Hardening** — Platform abstraction layer, Task Scheduler backend, NTFS ACL, learner drift fix, incremental pattern memory. _(v23-v25 Windows, v26 site, v27 drift fix, v29 incremental patterns)_
- [x] **Phase 7: Metrics & Social Proof** — Directive-fire detection, token/time savings tracker, "errors prevented" counter, `auto-sop stats` CLI. Pure CLI-side work, no cloud needed. _(v30 fire detection, v31 categorization+bigram, v32 token/time/errors — COMPLETE 2026-04-27)_
- [ ] **Phase 8: SaaS Platform + Monetization** — Clerk auth + Supabase + Stripe + Vercel dashboard. **Separate repo `auto-sop-site/`.** CLI gains 1-project soft cap + feature-touch trial + Ed25519 signed validation + X25519 request encryption. Free forever for solo, Pro $12/mo. ~95% done — **only Stripe billing remains.** _(v34 dashboard, v36 CLI licensing, v37 anti-abuse, v38 BIND-7 CLI + bug cleanup, v39 BIND-7/8 server, v40 BIND-8 CLI encryption — all DONE. v35 Stripe queued as launch blocker.)_
- [ ] **Phase 9: First Public Launch + Viral Growth** — npm v0.1.0 publish, repo already public (ELv2), Homebrew tap live, landing page with real metrics, demo GIF, **referral & rewards system**. Everything a developer sees on first contact must be professional + Pro upgrade path + viral loop exists. _(→ after v35 Stripe completes)_
- [ ] **Phase 10: Smart Directive Targeting** — Scope-aware directive placement: universal → CLAUDE.md, context-specific → Claude Code Skills. Prevents context bloat at scale. Post-launch feature. _(→ v44+)_

### Decision: Distribution & licensing model (REVISED 2026-04-26)

**Decision: Open source (Elastic License 2.0) + 4-layer technical protection.**

Kod açık, topluluk güveni ve katkısı var — ama lisans + teknik korumalar sayesinde rakip ürün oluşturulamaz ve ücretsiz sınır (1 proje) bypass edilemez.

| Aspect | Decision |
|--------|----------|
| **CLI repo (`auto-sop`)** | **Public** (GitHub public repo) |
| **Cloud repo (`auto-sop-cloud`)** | **Private** (backend, dashboard, billing) |
| **License** | **Elastic License 2.0 (ELv2)** — kaynak okunabilir, fork edilebilir ama rakip ürün oluşturma ve managed service sunma yasak |
| **Distribution** | npm + Homebrew (kaynak açık, build edilmiş paket) |
| **Pricing** | 1 proje = **free** (lisans key gerekli), 2+ proje = **Pro $12/mo** |
| **Onboarding flow** | `npx auto-sop install` → lisans key sor → kullanıcı cloud dashboard'dan ücretsiz signup → free key al → CLI'a yapıştır → install tamamlanır |
| **Obfuscation (S6)** | **Gereksiz** — kod zaten açık, koruma lisans + teknik katmanlarda |
| **SEA binary (S7)** | **Opsiyonel** — Homebrew convenience için, güvenlik amacıyla değil |

#### 4 Katmanlı Koruma Modeli (Detay)

##### Katman 1: Project Binding (Local — Offline Çalışır)

Hook install anında her projeye bir binding dosyası yazılır. Bu dosya projenin bu makine + bu lisans key ile bağlandığını kanıtlar.

```
npx auto-sop install (proje dizininde)
  ↓
1. Lisans key'i iste (veya ~/.auto-sop/config'den oku)
2. Binding token üret:
   token = HMAC-SHA256(license_key, project_path + machine_id)
3. Proje içine yaz:
   <project>/.auto-sop/binding.json
   {
     "license_key_hash": "sha256(key)[0:16]",   // key'in kendisi değil, hash'i
     "machine_id": "sha256(hostname + username)",
     "bound_at": "2026-04-26T18:00Z",
     "token": "hmac-sha256-result"
   }
4. Global registry'ye proje kaydı ekle (zaten mevcut mekanizma):
   ~/.auto-sop/state/project-registry.json
```

**Bypass analizi:**
- `binding.json` silmek → proje unbound olur → learner o projede çalışmaz (kendi ayağına sıkar)
- `binding.json` başka projeye kopyalamak → HMAC `project_path` içeriyor → token eşleşmez → geçersiz
- Sahte binding oluşturmak → `license_key` bilmeden geçerli HMAC üretilemez

**Not:** `<project>/.auto-sop/` zaten `.gitignore`'da — binding dosyası repo'ya push edilmez.

##### Katman 2: Periodic Server Validation (Online — 7 Gün Grace)

Her learner tick'inde (saatlik) CLI sunucuya bağlanıp lisansı doğrular.

```
Her tick başlangıcında:
  1. Tüm projelerdeki binding.json dosyalarını tara
  2. Aktif bound proje sayısını hesapla
  3. Sunucuya gönder:
     POST https://api.auto-sop.com/v1/license/validate
     {
       "key": "license-key",
       "machine_id": "sha256(hostname+username)",
       "bound_projects": 3,
       "binding_hashes": ["hash1", "hash2", "hash3"]
     }
  4. Sunucu döner (imzalı response — Katman 3):
     {
       "payload": {
         "valid": true,
         "plan": "free",
         "max_projects": 1,
         "issued_at": "2026-04-26T18:00:00Z",
         "expires_at": "2026-04-26T19:00:00Z",
         "nonce": "a1b2c3d4"
       },
       "signature": "ed25519-signature"
     }
  5. Response'u local cache'e yaz:
     ~/.auto-sop/state/license-cache.json
```

**Proje sayısı aşımında:**
- `bound_projects > max_projects` → ilk proje hariç diğerlerinde learner DURUR
- Capture çalışmaya devam eder (veri kaybı olmasın)
- Status mesajı: "Pro plan required for multiple projects. Upgrade at https://app.auto-sop.com"

**Offline grace (7 gün):**
- Sunucuya ulaşılamıyorsa → WARNING log, eski cache ile çalışmaya devam
- 7 gün üst üste ulaşılamadıysa → learner DURUR, capture devam eder
- Kullanıcı online olunca → validate → normal çalışma devam eder

**Bypass analizi:**
- Sunucu call'ını koddan silmek → 7 gün sonra grace biter, learner durur
- `max_projects` check'i koddan silmek → sunucu her tick'de gerçek sayıyı biliyor, sunucu tarafında da enforce edebilir (sonraki tick'te yine durdurur)
- Eski "valid:true" response'u cache'e yazmak → Katman 3 (imza + nonce) bunu engelliyor

##### Katman 3: Signed Response Integrity (Ed25519 — Sahte Sunucu Engelliyor)

Sunucu response'larını Ed25519 ile imzalar. CLI'da sadece public key gömülü — kod açık olsa bile kimse sahte response üretemez.

```
Sunucu tarafı (private key ile imzala):
  const payloadStr = JSON.canonicalize(payload)
  const signature = crypto.sign(null, Buffer.from(payloadStr), SERVER_PRIVATE_KEY)
  return { payload, signature: signature.toString('base64') }

CLI tarafı (public key ile doğrula):
  // Bu key CLI koduna gömülü — open source'da herkes görebilir, sorun değil
  const SERVER_PUBLIC_KEY = "MCowBQYDK2VwAyEA..."  // Ed25519 public key

  const payloadStr = JSON.canonicalize(response.payload)
  const valid = crypto.verify(
    null,
    Buffer.from(payloadStr),
    SERVER_PUBLIC_KEY,
    Buffer.from(response.signature, 'base64')
  )
  if (!valid) throw new Error('Invalid server signature — response rejected')
```

**Neden Ed25519 (asymmetric) ve HMAC (symmetric) değil?**
- HMAC'ta shared secret CLI koduna gömülü → repo public → herkes secret'ı görür → sahte sunucu kurabilir
- Ed25519'da CLI'da sadece public key var → private key sadece sunucuda → sahte imza üretmek matematiksel olarak imkansız
- Node.js `crypto` modülünde built-in destekli, ek bağımlılık yok

**Replay koruması:**
```
license-cache.json:
  {
    "validated_at": "2026-04-26T18:00Z",
    "last_nonce": "a1b2c3d4",
    "payload": { ... },
    "signature": "base64..."
  }

Her tick'de kontrol:
  - Yeni nonce !== last_nonce (replay engellenmiş)
  - issued_at > önceki issued_at (zaman ileri gidiyor)
  - expires_at henüz geçmemiş (eski response kullanılamaz)
```

##### Katman 3b: CLI Self-Hash — Tamper Detection

Public key değiştirme saldırısına karşı ek koruma. CLI kendi dosyalarının hash'ini hesaplar ve sunucuya gönderir. Sunucu, yayınlanan resmi sürümlerin hash'lerini bilir — tanımadığı hash'i olan client'a imzalı response vermez.

```
Build/publish sırasında (CI pipeline):
  1. npm build → dist/ oluşur (içinde Ed25519 public key gömülü)
  2. cli_hash = SHA256(dist/ içindeki tüm dosyalar, sorted + concatenated)
  3. Hash sunucuya kaydedilir:
     POST /v1/admin/register-release
     { version: "0.3.1", cli_hash: "abc123...", published_at: "..." }
  4. npm publish çalışır

Her tick'de (runtime):
  1. CLI kendi dosyalarının hash'ini hesaplar (aynı algoritma)
  2. Validation request'e ekler:
     POST /v1/license/validate
     { key, machine_id, bound_projects, cli_hash: "abc123...", cli_version: "0.3.1" }
  3. Sunucu kontrol eder:
     - "abc123..." benim bildiğim resmi bir sürüm hash'i mi?
     - EVET → normal validation yap, Ed25519 ile imzala, dön
     - HAYIR → { valid: false, reason: "tampered_client" } (imzalamayı REDDET)
  4. CLI imzayı doğrular:
     - İmza geçerli + valid: true → çalışmaya devam
     - İmza geçersiz veya valid: false → DUR
```

**Neden çalışıyor — public key saldırısı örneği:**
```
Orijinal paket: hash = "abc43", içinde public_key = "ASLI"
  → Tick: CLI "abc43" gönderir → sunucu tanır → imzalar → CLI doğrular ✓

Saldırgan public key'i değiştirir: hash = "xyz99", içinde public_key = "SAHTE"
  → Tick: CLI "xyz99" gönderir → sunucu tanımaz → İMZALAMAZ → CLI çalışmaz ✗
```

Sunucu, tanımadığı bir hash'e sahip client'a asla imzalı response vermediği için, public key değiştirmek artık tek başına yetmiyor.

**Teknik sınır (kabul edilen risk):**
Saldırgan hem hash check kodunu silip hem fake sunucu kurarsa, teknik olarak bypass edebilir. Bu her client-side uygulamada (Spotify, Adobe, JetBrains dahil) aynıdır — kullanıcının makinesinde çalışan kodu %100 korumak mümkün değil. Amacımız kırma maliyetini yükseltmek:

| Bypass seviyesi | Ne yapması lazım | Kim yapar |
|---|---|---|
| Seviye 1 | max_projects check sil | Script kiddie — tek satır |
| Seviye 2 | + server call sil + 7 gün bekle | Orta seviye |
| Seviye 3 | + public key değiştir | Tek başına yetmez — sunucu tanımadığı hash'i reddeder |
| Seviye 4 | + hash check sil + fake sunucu kur | Çok ileri — 4 farklı değişiklik |
| Seviye 4b | + request encryption bypass (X25519 kaldır) | 5 farklı değişiklik — fake sunucu kursa bile request format'ını da değiştirmeli |
| Seviye 5 | Tüm korumayı sök + dağıt | **ELv2 ihlali → cease & desist → dava** |

Her katman bir "değişiklik daha" gerektiriyor. Seviye 4b'ye ulaşacak kadar motive olan kullanıcı oranı <%0.1 — ve o kişi için de Katman 4 (hukuki) devreye giriyor.

**Bypass analizi:**
- DNS spoof ile sahte sunucu kurmak → Ed25519 private key olmadan geçerli imza üretilemez
- Eski response'u tekrar kullanmak → nonce + timestamp kontrolü engelliyor
- Public key'i değiştirmek → CLI hash değişir → sunucu tanımadığı hash'i imzalamaz (Katman 3b)
- Hash check + fake sunucu + public key birlikte değiştirmek → teknik olarak mümkün ama 4 farklı değişiklik + ELv2 ihlali (Katman 4)

##### Katman 3c: Request Encryption (X25519 Sealed Box — BIND-8)

CLI → Server yönünde request confidentiality. HTTPS'in üzerine defense-in-depth katmanı.

```
CLI tarafı (request gönderirken):
  1. Server Ed25519 public key → X25519 public key'e dönüştür
  2. Ephemeral X25519 key pair üret (her request için yeni)
  3. ECDH: cli_ephemeral_private × server_x25519_public → shared_secret
  4. AES-256-GCM ile request payload şifrele
  5. Gönder: { encrypted_payload, ephemeral_public_key, nonce, tag }

Server tarafı (request alırken):
  1. Ed25519 private key → X25519 private key'e dönüştür
  2. ECDH: server_x25519_private × cli_ephemeral_public → aynı shared_secret
  3. AES-256-GCM ile decrypt → plaintext request
```

**Neden X25519 ve Ed25519 değil?**
- Ed25519 = signing only (imza oluşturma/doğrulama)
- X25519 = key exchange (ECDH → shared secret → encryption)
- İkisi aynı Curve25519 ailesi — key dönüşümü Node.js `crypto`'da native (v16+)
- Tek key pair hem signing (Ed25519) hem encryption (X25519) için kullanılır

**Ne koruyor:**
- License key, machine_id, binding hash'leri HTTPS üzerine ek olarak application layer'da da şifrelenir
- MITM saldırganı HTTPS'i kırsa bile (certificate pinning olmadan), request payload'ı açamaz
- Ephemeral key pair → her request farklı shared_secret → forward secrecy

**Bypass analizi:**
- Network sniffing → payload encrypted, sadece ephemeral public key görünür
- Replay attack → nonce + ephemeral key değişiyor, aynı encrypted payload yeniden kullanılamaz
- Server public key'i değiştirmek → Katman 3b (self-hash) bunu zaten engelliyor

##### Katman 4: Hukuki Koruma (Elastic License 2.0)

Teknik korumaları bypass eden biri hâlâ **lisans ihlali** yapıyor.

**ELv2 ne yasaklıyor?**
1. Yazılımı kullanarak rakip ürün/hizmet sunmak (competing product)
2. Yazılımı managed service olarak sunmak (SaaS olarak satmak)
3. Lisans koşullarını değiştirmek veya kaldırmak

**Kodu fork edip validation'ı söken biri:**
- ELv2 Madde 2 ihlali: "You may not... remove or obscure any functionality in the Software that is protected by the License Key"
- Cease & desist gönderilebilir
- npm/Homebrew'da aynı ismi kullanamazlar (trademark)
- Fork'un güvenlik güncellemesi yok, yeni özellik yok → topluluk güveni bizde

**Referans şirketler (aynı model):**
- **Elasticsearch** → Elastic License 2.0 (biz de bunu kullanıyoruz)
- **MongoDB** → Server Side Public License (SSPL)
- **HashiCorp Terraform** → Business Source License (BSL)
- **Grafana** → AGPL-3.0
- Hepsi kaynak kodu açık, hepsi ticari koruma altında

#### Koruma Özeti

| Saldırı Vektörü | Katman 1 (Binding) | Katman 2 (Server) | Katman 3 (Signature) | Katman 3b (Self-Hash) | Katman 3c (Request Enc.) | Katman 4 (Hukuki) |
|---|---|---|---|---|---|---|
| Key olmadan 2. proje açmak | ❌ Binding token üretilemez | — | — | — | — | — |
| Binding.json kopyalamak | ❌ HMAC path-specific | — | — | — | — | — |
| max_projects check'i silmek | — | ❌ Sunucu enforce | — | — | — | ❌ Lisans ihlali |
| Sahte sunucu kurmak | — | — | ❌ Ed25519 imza | — | — | — |
| Eski response cache'lemek | — | — | ❌ Nonce + timestamp | — | — | — |
| Public key değiştirmek | — | — | — | ❌ Hash değişir → sunucu reddeder | — | ❌ Lisans ihlali |
| Public key + fake sunucu | — | — | — | — | — | ❌ 3 değişiklik + ELv2 ihlali |
| Server call'ı tamamen silmek | — | ❌ 7 gün grace → durur | — | — | — | ❌ Lisans ihlali |
| npm'den modifiye paket dağıtmak | — | — | — | ❌ Hash eşleşmez | — | ❌ Lisans + trademark |
| Request sniffing (MITM) | — | — | — | — | ❌ X25519 sealed box | — |
| License key extraction | — | — | — | — | ❌ Payload app-layer encrypted | — |
| Tüm teknik korumaları sökmek | — | — | — | — | — | ❌ ELv2 ihlali → dava |

**Sonuç:** Casual bypass (teknik bilgisi düşük kullanıcı) imkansız. Determined bypass (kodu fork edip değiştiren) teknik olarak mümkün ama hukuki olarak kovuşturulabilir. Bu, Elasticsearch/MongoDB/Terraform'un kullandığı endüstri standardı koruma seviyesi.

#### Open Source'un Getirdiği Avantajlar

| Avantaj | Neden Önemli |
|---------|-------------|
| **Güven** | Kullanıcılar kodu okuyabilir — "veri dışarı gitmiyor" iddiasını doğrulayabilir |
| **Topluluk katkısı** | Bug fix PR'ları, yeni detektörler, çeviri |
| **SEO / keşfedilebilirlik** | GitHub'da aranabilir, Stars ile social proof |
| **Geliştirici beklentisi** | CLI tool'lar genelde açık kaynak bekleniyor — kapalı kaynak güven kırıyor |
| **Güvenlik denetimi** | Bağımsız security researcher'lar kodu inceleyebilir |

**Implications for phases:**
- Phase 8 (SaaS): Cloud dashboard signup + license key generation + Ed25519 key pair generation + validation endpoint + X25519 request encryption. CLI `install` requires a valid key. Aynı Ed25519 key pair hem response signing (integrity) hem request encryption (confidentiality, X25519'a dönüştürerek) için kullanılır.
- Phase 9 (Launch): CLI repo public, cloud repo private. Apache 2.0 → ELv2 lisans değişikliği.
- S6 (obfuscation) **artık gerekli değil** — kod zaten açık, koruma teknik + hukuki katmanlarda.
- S7 (SEA binary) **opsiyonel** — Homebrew convenience için, güvenlik amacıyla değil.
- Binding mekanizması Phase 8'de implement edilecek (S-BIND serisi backlog item'lar).
- Ed25519 key pair: sunucu private key'i gizli, CLI public key'i koda gömülü.
- Avukata danışma gerekli: ELv2'nin Türk hukuku altında geçerliliği ve uygulanabilirliği.

### Reordering rationale (2026-04-23)
1. **Windows before Metrics:** Cross-platform must work before measuring outcomes.
2. **Metrics before SaaS (SWAPPED):** Metrics are pure CLI-side work (no cloud infra). Landing page needs real numbers ("47 errors prevented") to convert — selling features without proof doesn't work. SaaS dashboard (M5 widget) can show metrics AFTER they exist, not before.
3. **SaaS after Metrics:** Dashboard's value proposition IS the metrics. Build the data first, then the viewer.
4. **Publish after everything:** Day-one users need full experience — cross-platform CLI, proof stats, Pro upgrade path.
5. **Smart Directive Targeting post-launch:** Requires real-world usage patterns to design well.

### Inserted work (between phases, not on original roadmap)
- **v26** — Landing page website (`auto-sop-site/` repo, Next.js, purple brand, owl mascot)
- **v27** — Learner drift fix (error serialization, repair CLI verb, auto-recovery)
- **v28** — Vercel deploy + auto-sop.com domain (`auto-sop-site/` repo)
- **v29** — Incremental pattern memory (LLM accumulates candidates across ticks)

### Key discovery: Recall gate NOT needed
Claude Code natively reads `<project>/CLAUDE.md` into system context at session start. Directives written by the learner to the managed section are automatically visible to Claude in the next session. No separate recall-gate binary or UserPromptSubmit hook injection is required. This eliminates the R1 backlog item and simplifies the Phase 3→4 bridge.

## Phase Details

### Phase 0: Distribution Decision + Foundations
**Goal:** Resolve the hybrid (npm CLI + plugin bundle + scheduler) distribution shape and land the pure-logic foundations (paths, config, scrubber) that everything downstream depends on.
**Depends on:** Nothing (first phase)
**Requirements:** INST-07, INST-08, PRIV-01, PRIV-02, PRIV-03, PRIV-05
**Success Criteria** (what must be TRUE):
  1. Distribution model is written down as an accepted ADR: `npx claude-sop install` copies a Claude Code plugin bundle AND registers an OS scheduler; unresolved sub-questions resolved.
  2. Scrubber (pure library) redacts `sk-ant-*`, AWS keys, GitHub tokens, `KEY=VALUE` env patterns, and high-entropy blobs at >95% recall against a fixture corpus — before any write path exists.
  3. Scrubber is layered: baseline regex pack plus user-overridable rule pack loaded from `~/.claude-sop/rules/`.
  4. Plugin declares Node ≥18.17 engines and refuses to run on Windows; CI proves macOS + Linux matrix green.
  5. Package contains zero `postinstall` lifecycle script and zero outbound network calls from any code path exercised by unit tests.
**Plans:** TBD

### Phase 1: Capture Foundation
**Goal:** Every Claude Code turn — prompts, tool calls, subagent Task I/O, responses — lands on disk as a scrubbed, finalized, atomically-visible capture directory without perceptibly slowing the user's session.
**Depends on:** Phase 0 (uses Scrubber + PathResolver + Config)
**Requirements:** CAPT-01, CAPT-02, CAPT-03, CAPT-04, CAPT-05, CAPT-06, CAPT-07, CAPT-08, CAPT-09, CAPT-10, PRIV-04, PRIV-07
**Success Criteria** (what must be TRUE):
  1. After a real Claude Code session, `<project>/.claude-sop/captures/{timestamp}-{agent}-{file}-{hash}/` contains `prompt.md`, `response.md`, `tool-calls.jsonl`, `files-changed.txt`, and `meta.json` for every completed turn — and nothing for in-flight turns.
  2. Every captured file is mode `0600` and every capture directory is mode `0700`; scrubbed content contains zero matches for the Phase 0 secret corpus.
  3. Hook shim completes in under 50ms wall-clock (measured in CI), always exits 0, never writes to stdout, and logs failures to an error file.
  4. Subagent `Task` invocations appear as captures linked to their parent turn with both input and output preserved.
  5. Captures written in `<project>/.claude-sop/` are discoverable (pointer or mirror) under `~/.claude/sop/<project-id>/`, and capture is fully suppressed when `CLAUDE_SOP_LEARNER=1` is set in the environment.
**Plans:** TBD

### Phase 2: Installer + Scheduler + CLI Skeleton
**Goal:** A user running `npx claude-sop install` in a project gets hooks wired, an hourly OS scheduler registered, a gitignored capture dir, an empty managed section in CLAUDE.md, and a working CLI for status/health/pause — all idempotent, all cleanly uninstallable.
**Depends on:** Phase 1 (installer wires Phase 1 hooks; CLI reads Phase 1 captures)
**Requirements:** INST-01, INST-02, INST-03, INST-04, INST-05, INST-06, SCHED-01, SCHED-02, SCHED-03, SCHED-04, SCHED-05, PRIV-06, CLI-01, CLI-04, CLI-05, CLI-06, LIC-01, LIC-02
**Success Criteria** (what must be TRUE):
  1. User runs `npx claude-sop install` in a fresh project and afterwards: hooks are live in the project's Claude Code configuration (non-destructively merged with any existing hooks), `.claude-sop/` is in `.gitignore`, and `CLAUDE.md` contains empty `<!-- claude-sop:begin -->` / `<!-- claude-sop:end -->` markers.
  2. Running `npx claude-sop install` a second time is a no-op: no duplicate hooks, no duplicate scheduler units, no duplicate managed-section markers.
  3. After install, an hourly scheduler job is registered via launchd (macOS) or systemd user unit (Linux, cron fallback) using absolute binary paths, survives reboot, and runs even with no Claude Code session active; concurrent ticks are blocked by `flock`.
  4. `npx claude-sop status` prints a table with project id, paths, hook wiring state, scheduler state, last learner run, pending captures, and directive count; `npx claude-sop doctor` runs a full health check; `pause`/`resume`/`purge` behave as specified; all commands return non-zero on failure with actionable errors.
  5. `npx claude-sop uninstall` removes hooks, the scheduler unit (no zombies, no stale plists), and managed-section markers while preserving captures by default.
**Plans:** TBD

### Phase 3: Learner (Offline then `claude` CLI)
**Goal:** Every hour, a learner reads new captures, runs deterministic detectors with evidence-threshold discipline, and emits strict-JSON directive proposals grounded in at least 3 separate sessions — without requiring an Anthropic API key by default and without being exploitable via prompt injection in captured tool output.
**Depends on:** Phase 1 (reads captures), Phase 2 (runs under scheduler)
**Requirements:** LEARN-01, LEARN-02, LEARN-03, LEARN-04, LEARN-05, LEARN-06, LEARN-07, LEARN-08
**Success Criteria** (what must be TRUE):
  1. Learner runs on its hourly tick, reads only captures created since the previous run, and emits directive proposals whose content is valid against a strict JSON schema (non-conforming model output is rejected and logged).
  2. Default learner invocation uses the user's existing `claude` CLI login with no Anthropic API key configured; an alternate model can be selected via `npx claude-sop config set model <name>` plus a user-supplied key.
  3. A directive is only proposed when at least 3 distinct sessions contain evidence of the same mistake pattern; single-instance findings are never surfaced.
  4. Captured tool output is wrapped in `<capture>` tags marked untrusted, and injected instructions inside captured content never influence the learner's directive output (verified by a fixture suite).
  5. `npx claude-sop learn-now --dry-run` prints proposed directives without writing; scheduled runs apply them. Runs exceeding 600s are killed and logged without blocking the next tick.
**Plans:** TBD

### Phase 4: ManagedSectionEditor
**Goal:** Directive proposals from the learner land inside the CLAUDE.md managed section through an atomic, hash-checked, git-aware writer that is impossible to use as a user-edit-clobbering footgun — and that the user can always revert.
**Depends on:** Phase 3 (consumes learner proposals)
**Requirements:** MD-01, MD-02, MD-03, MD-04, MD-05, MD-06, MD-07, MD-08
**Success Criteria** (what must be TRUE):
  1. After a learner run, new directives appear only between `<!-- claude-sop:begin -->` and `<!-- claude-sop:end -->`; all content outside the markers is byte-identical to before the run (verified by a golden-file suite).
  2. Each directive has a timestamp, a plain-language rule, and an evidence pointer back to source capture IDs; duplicates against existing managed content are skipped; the section is capped at the configured max (default ~25) with TTL pruning.
  3. Writes are atomic (temp-file + rename) — no intermediate state is ever observable; if the pre-write hash of the managed section differs from the last-known hash, the run is aborted, the user's edits are backed up to `~/.claude/sop/<pid>/managed-history/conflict-<ts>.md`, and the skip is surfaced in `status`.
  4. Writes are silently skipped during an active `git rebase` or `git merge`, never corrupting conflict markers.
  5. `npx claude-sop revert` rolls back the most recent managed-section change from backup and the change is reflected in `status`.
**Plans:** TBD

### Phase 5: Inspection CLI + Packaging Hardening
**Goal:** Users can inspect captured turns from the CLI, and the package is ready for `npm publish` with provenance, type-correctness, and a Claude Code version matrix proving the happy path end-to-end.
**Depends on:** Phases 1–4 (ships the complete product)
**Requirements:** CLI-02, CLI-03
**Success Criteria** (what must be TRUE):
  1. `npx claude-sop recent [--since 1h]` lists recent captured turns with session/turn id, agent, timestamp, and changed files.
  2. `npx claude-sop show <session-or-turn-id>` prints the full contents of the requested capture (prompt, response, tool-calls) with scrubbed content.
  3. Package publishes with `--provenance`; `publint` and `@arethetypeswrong/cli` pass in CI; dual ESM+CJS entry points resolve correctly in both module systems.
  4. End-to-end smoke test passes against a matrix of supported Claude Code versions: install → run a scripted session → verify captures → trigger learner → verify managed-section update → uninstall clean.
  5. A "looks-done-but-isn't" release checklist (≥20 items: no postinstall, no network egress, hook latency budget, scrubber recall, idempotency, reboot survival, etc.) is enforced in CI before a tag can be published.
**Plans:** TBD

### Phase 6: Native Windows Support (NEW — inserted 2026-04-18)
**Goal:** Make claude-sop run natively on Windows (not just WSL). The current `platform-check.ts` refuses `win32` with exit 1 — this has to become a supported platform before paying SaaS subscribers can be acquired from the Windows developer population.

**Why this blocks SaaS:**
A user pays $X/month for cloud dashboard → runs claude-sop install on their Windows box → CLI refuses → immediate refund + negative review. Cannot ship SaaS while this is the experience.

**What native Windows actually needs:**

| Layer | Current (macOS/Linux) | Windows port |
|---|---|---|
| Scheduler | launchd / systemd | **Task Scheduler** (`schtasks.exe /Create /SC HOURLY`) |
| Scheduler wrapper | `tick.sh` bash script | `tick.cmd` or `tick.ps1` |
| Hook shim shebang | `#!/usr/bin/env node` | `.cmd` wrapper that invokes `node shim.cjs` (Claude Code runs hooks via cmd.exe on Windows) |
| Detached writer spawn | `spawn(..., { detached: true })` + `unref()` | Same API but "session leader" has no meaning — needs Windows-specific daemonization idiom (possibly `CREATE_NEW_PROCESS_GROUP` flag) |
| File permissions | `chmod 0600 / 0700` | NTFS ACLs — `icacls` or Node's built-in `fs.chmod` is a no-op on Windows. Need ACL-based equivalent via `child_process` call to `icacls` |
| Path home | `~/.claude-sop/` | `%USERPROFILE%\.claude-sop\` — already handled by `os.homedir()` but all docs/error messages need rewording |
| Process kill-switch env | `CLAUDE_SOP_CAPTURE_SUPPRESS=1` | Same — works cross-platform |
| proper-lockfile | Works | Works (verified cross-platform) |

**Dependencies:**
- Phase 5 (must have a publishable package first — no point in Windows CI if we haven't shipped v1)
- Claude Code itself must support Windows (verify before starting — if Claude Code is Linux/macOS only, Phase 6 is blocked)
- Dogfood observation period (v18→v20 gap) to understand macOS/Linux issues before chasing Windows issues

**Planned versions:**
  - v20: Windows scheduler backend — `src/scheduler/windows-schtasks.ts` with Task Scheduler XML generation, install/uninstall via `schtasks.exe`
  - v21: Windows shim adapter — `.cmd` wrapper files bundled in plugin, path translation in `src/installer/`, ACL-based permissions
  - v22: Windows CI matrix — GitHub Actions `windows-latest` runner, isolated smoke tests for scheduler + hook firing + capture pipeline

**Success Criteria:**
  1. `npx claude-sop install` on Windows 10/11 completes with zero errors, hook entries written to `.claude/settings.json`, Task Scheduler job registered, CLAUDE.md managed section created.
  2. Hourly Task Scheduler tick fires the learner. LLM analysis runs (`claude -p` works on Windows if Claude Code supports it).
  3. Hook shim fires on `UserPromptSubmit` from Windows Claude Code session; capture pipeline produces turn directories with correct ACL permissions (owner-only).
  4. `claude-sop uninstall` removes the Task Scheduler job cleanly, no stale entries survive a reboot.
  5. CI green on `ubuntu-latest`, `macos-latest`, AND `windows-latest`. Smoke test includes install→capture→learner tick→managed section write→uninstall end-to-end.
**Plans:** TBD (v20-v22)

### Phase 8: SaaS Platform + Monetization (was Phase 7, moved to Phase 8 on 2026-04-23 — Metrics first)
**Goal:** Turn the plugin into a commercial open-source product (ELv2) with a web dashboard, license-key gated install, 4-layer technical protection, encrypted cloud sync, and subscription billing — while keeping 1-project free tier and all LLM analysis local (free via user's Claude Max).

**Install flow (REVISED 2026-04-26):**
```
$ npx auto-sop install
Enter your license key: ___
  (Get a free key at https://app.auto-sop.com/signup)
  ↓
1. License key sunucuda doğrulanır (Ed25519 signed response)
2. binding.json oluşturulur (HMAC-SHA256 project binding)
3. Hook'lar + scheduler kurulur
4. İlk tick'de periodic validation başlar
```
Cloud dashboard signup → free-tier license key → paste into CLI → server validates key → binding token created → install proceeds. No anonymous installs — every user has an account. This enables: usage tracking, project binding, upgrade prompts, cloud sync, support contact.

**Stack decision (confirmed):**
- **Auth:** Clerk (JWT, <10K MAU free tier)
- **DB + API:** Supabase (Postgres + RLS + Edge Functions)
- **Billing:** Stripe (existing account, Checkout + Customer Portal)
- **Frontend:** Next.js on Vercel (free hobby tier)
- **Encryption:** Client-side AES-256, key derived from Clerk user_id + project_id (server never sees plaintext)
- **License signing:** Ed25519 key pair (private on server, public embedded in CLI)

**Business model (REVISED 2026-04-26 — open source ELv2 + 4-layer protection):**

| Tier | What | Price | Gate |
|---|---|---|---|
| **Free** (forever) | 1 project, unlimited directives, full local capture + LLM analysis, all CLI verbs | $0 | License key required (free signup at dashboard) |
| **Pro** | Unlimited projects + encrypted cloud sync + curated directive packs + cross-project patterns + dashboard | **$12/mo** or **$99/yr** | Upgrade via dashboard |
| **Trial** | Full Pro for 14 days from first Pro feature touch | $0, **no credit card** | Triggered by attempting 2nd project |

**Critical UX — Soft gate (Notion model):**
- Trial expiry NEVER deletes existing data
- Trial expiry NEVER locks existing functionality
- User just cannot ADD new projects beyond their first one
- Existing learnings, captures, directives keep working forever
- This avoids the "value retracted after proof-of-value" psychological backlash that traditional 14-day-then-paywall trials suffer from
- Reference: Notion's 1000-block limit on Free tier — limits creation, never destroys existing

**Why this model works:**
- Solo dev with 1 main project: never hits gate, free forever, becomes evangelist (viral channel)
- Solo dev with 5+ projects: hits gate organically at moment of need, sees value, converts
- Team dev: definitely needs multiple projects, converts immediately
- Cross-project pattern detection is impossible without ≥2 projects → natural Pro feature, honest upsell
- Cloud sync is opt-in → server costs only for paying users
- No credit card on trial → friction-free, conversion 8-12% (sector avg vs ~3% with CC required)

**Reference:** RTK AI (`rtk-ai.app`, `github.com/rtk-ai/rtk`) — exact same playbook, MIT/Apache CLI + paid cloud team analytics ($15/dev/mo). Plus GitLab CE/EE, Sentry, Grafana, Mattermost, Plausible, PostHog all use open core successfully.

**Cloud data policy (confirmed):**
- Directives + recap summary sync to cloud (JSON, ~50 KB/project/month)
- Raw captures NEVER leave the machine (privacy)
- Client-side encryption: AES-256, key = hash(clerk_user_id + project_id). Server stores encrypted blobs only.
- Free tier: ZERO network egress. Pro tier: opt-in only.

**Cloud data policy (confirmed):**
- Directives + recap summary sync to cloud (JSON, ~50 KB/project/month)
- Raw captures NEVER leave the machine (privacy)
- Client-side encryption: AES-256, key = hash(clerk_user_id + project_id). Server stores encrypted blobs only.

**Architecture:**
```
LOCAL (free forever):
  hooks → capture → learner → claude -p ($0) → directives → CLAUDE.md
  ↓ (encrypted JSON, directives + stats only)
CLOUD (15 days free → paid):
  Clerk auth → Supabase DB → Dashboard (Next.js/Vercel)
  Stripe billing → subscription gate on dashboard API
```

**Depends on:** Phase 5 (publishable package)
**Requirements:** LIC-03..10 (revised to match new stack)

**Repository structure (decided 2026-04-17):**
SaaS work lives in a **SEPARATE repository/directory**, NOT this project.

- `~/Developer/claude-sop/` — **THIS repo.** The CLI plugin, learner, capture pipeline, CLAUDE.md editor. Open-source/semi-OSS friendly, runs locally.
- `~/Developer/claude-sop-cloud/` — **NEW repo.** Backend API (Supabase Edge Functions), frontend dashboard (Next.js), billing webhooks. Private, monetization layer.

The CLI in this repo gains a thin `sync` module that talks to the cloud repo's public API. The two repos version and deploy independently.

**Planned versions (RENUMBERED 2026-04-18 — pushed back by Phase 6 Windows insertion):**
  - v23: `claude-sop-cloud/` repo bootstrap — Supabase schema + Clerk auth + Stripe billing scaffolding. No CLI integration yet.
  - v24: CLI `sync` module (THIS repo) — local directives → AES-256 encrypt → POST to cloud API.
  - v25: Dashboard frontend in `claude-sop-cloud/` — Next.js + Vercel, cross-project view.
  - v26: CLI `login`/`logout` verbs (THIS repo) — Clerk browser popup auth, JWT stored in `secrets.enc`.
  - v27: Obfuscation + Node SEA binary (THIS repo) — optional, anti-piracy hardening. Must produce Windows-native binary too (Phase 6 requirement).

**Success Criteria (REVISED 2026-04-19):**
  1. User runs `auto-sop install` → free tier active immediately, no signup, 1-project quota.
  2. User runs `auto-sop install` in 2nd project → CLI prompts: "You're at 1/1 projects on Free. Start 14-day Pro trial? [Y/n] (no credit card)". On Y → trial begins, 2nd project installs.
  3. User runs `auto-sop login` (only when starting trial or upgrading) → browser popup → Clerk auth → JWT in `secrets.enc`.
  4. Every learner tick on Pro: directives + recap stats encrypted client-side (AES-256) and synced to Supabase via Edge Function. Sync failure non-blocking (offline grace 7 days).
  5. Dashboard at `app.auto-sop.com` shows all projects, active directives, directive history timeline, agent stats, monthly savings widget (Phase 9 dependency). Clerk auth required.
  6. Trial countdown: 14 days from first Pro feature touch. Expired trial → user STAYS on Free (1 project), existing data UNTOUCHED, just can't add new project. `status` shows "trial expired — upgrade at <url> to add more projects".
  7. `auto-sop status` shows tier (free/trial/pro), trial days remaining (if applicable), project count vs cap, last sync time, offline grace remaining. Stripe Customer Portal link for self-service billing.
  8. Encrypted sync: server stores AES-256 encrypted blobs only. Supabase RLS ensures user can only read own data. No PII in server logs.
  9. **F1-F5 backlog items** (project gate, trial state machine, soft gate UX, packs, cross-project) all green.
**Plans:** TBD (v23-v27)

### Phase 9: First Public Launch + Viral Growth (was Phase 9, expanded 2026-04-26)
**Goal:** Launch auto-sop publicly with professional first-impression experience AND built-in viral growth mechanics. Day-one users see real metrics, can upgrade to Pro, and have incentives to share.

**Launch checklist:**
1. npm v0.1.0 publish with provenance
2. Homebrew tap live
3. GitHub repo public (ELv2 license)
4. Landing page with real dogfood metrics
5. Demo GIF/video on landing page
6. Product Hunt launch prepared

**Referral & Rewards System (viral growth):**

| Mekanik | Ödül | Tekrar | Amacı |
|---------|------|--------|-------|
| **Referral link** | Her iki tarafa +1 ay Pro trial | Sınırsız | Dropbox modeli — kanıtlanmış en güçlü viral loop |
| **GitHub Star** | +1 ay Pro trial | Tek seferlik | Repo visibility + social proof (stars = credibility) |
| **Tweet/LinkedIn paylaşım** | +15 gün Pro trial | Ayda 1 | Organik reach, developer audiences |
| **Product Hunt upvote** | +15 gün Pro trial | Tek seferlik (launch day) | Launch day boost |
| **CLAUDE.md badge** | Ongoing %10 Pro indirim | Sürekli (badge kaldırılmadığı sürece) | Developer-to-developer keşif — her repo'nun CLAUDE.md'si bir reklam |

**Neden "credits" değil "Pro trial gün"?**
- Free tier zaten sınırsız (1 proje) — credits anlamsız
- Pro'nun değerini tattırmak asıl amaç — deneyip bırakmak yerine deneyip görmek
- Basit mental model: "arkadaşını davet et → 1 ay Pro bedava"

**Implementation notes:**
- `asop_referrals` table: referrer_id, referee_id, reward_days, claimed_at
- `asop_rewards` table: user_id, reward_type (github_star, tweet, linkedin, claude_badge), reward_days, claimed_at, expires_at
- Referral link: `https://auto-sop.com/signup?ref={user_code}`
- GitHub star verification: GitHub API check (user starred repo?)
- Tweet verification: Twitter/X intent URL + manual claim button
- LinkedIn verification: share URL + manual claim button
- CLAUDE.md badge: periodic scan of user's public repos for badge presence

**Depends on:** Phase 8 (dashboard + billing must exist)
**Plans:** TBD (v38-v39)

### Phase 10: Smart Directive Targeting (post-launch)
**Goal:** Prevent CLAUDE.md context bloat at scale by routing directives to the right surface — universal rules stay in CLAUDE.md (always in system prompt), context-specific rules become Claude Code Skills (on-demand, loaded only when relevant).

**Problem this solves:**
- CLAUDE.md is a "steering file" — loaded into EVERY Claude Code session's system prompt
- Directives accumulate over months (even with v16 TTL cap at 25)
- Narrow directives (e.g. "for hero carousel, use transform-only animations") waste context when user is editing backend code
- Dolu context prompt following'i zayıflatır (frontier model weakness)

**Solution:**
LLM classifier tags each proposal's scope:
- `universal` → CLAUDE.md managed section (current behavior)
- `skill:<skill_name>` → separate skill markdown file, invoked on-demand via Claude Code's Skill tool or slash command
- `file:<glob>` → context-specific, injected only when target files are in the conversation

**Planned versions:**
  - v28: Scope classification in directive schema (Zod extension) + LLM prompt update to request scope
  - v29: Skill file generation — write `~/.claude/skills/<project>-<skill>.md` per scope, update plugin manifest
  - v30: CLAUDE.md vs Skills split + migration tool for existing directives

**Depends on:** Phase 4 (hardened editor must exist), 1-2 months of real dogfood data to identify pollution patterns.

**Success Criteria:**
  1. LLM proposal includes `scope` field (universal | skill:<name> | file:<glob>), validated by Zod.
  2. `claude-sop recap --run` routes directives: universal → CLAUDE.md, skill-scoped → `~/.claude/skills/`, file-scoped → metadata for future file-aware injection.
  3. `CLAUDE.md` managed section stays compact (<15 directives typical) even for power users with months of history.
  4. Claude Code Skill files are invokable via `/claude-sop:<skill-name>` slash commands.
  5. Migration: existing CLAUDE.md directives (pre-v24) are analyzed and optionally split into skills by `claude-sop migrate-directives --classify`.
**Plans:** TBD (v28-v30)

_Design insight (2026-04-17): steering files grow unbounded and Claude Code's Skills mechanism is the right home for context-specific knowledge._

### Phase 7: Metrics & Social Proof (was Phase 9/8, promoted to Phase 7 on 2026-04-23 — before SaaS)
**Goal:** Make auto-sop's value measurable and viral. Without concrete numbers ("47 errors prevented this month", "67% fewer tokens", "2.3 hours saved"), the landing page sells features instead of outcomes — and feature-list landing pages don't convert.

**Inspiration — RTK AI:** Their landing page shows the killer comparison:
```
cargo test               → 4,823 tokens
rtk cargo test           →    11 tokens
                       -99.8%
```
This isn't a feature list. It's a working command output with a number. That's what sells.

**Our equivalent — auto-sop should be able to show:**
```
Without auto-sop directives:
$ claude "implement npm test setup"
→ ❌ npm test failed: node_modules stale (3rd time this week)
→ Tokens: 12,847 / Time: 8m

With auto-sop directives in CLAUDE.md:
$ claude "implement npm test setup"
→ ✅ Detected stale node_modules, ran npm ci first → all green
→ Tokens: 4,231 / Time: 2m
                       -67% tokens, -75% time
```

To produce these numbers we need (M-series backlog items):

- **M1** Directive-fire detection — UserPromptSubmit hook checks if any active directive in CLAUDE.md is relevant to the current prompt. Heuristic match (keyword overlap) for v31, LLM-based for v33.
- **M2** Token/time savings tracker — capture token usage from `claude -p --output-format json` responses. Compare sessions WITH directives vs sessions BEFORE directive existed (same project, same user, same task type).
- **M3** "Errors prevented this month" counter — for each Bash failure pattern that became a directive, count subsequent sessions where the same command DIDN'T fail (because Claude saw the directive and adjusted). This is the headline number.
- **M4** Landing page side-by-side demo — RTK-format proof copy on landing page. Real terminal recording, not screenshot. Live or scripted. Updated monthly with aggregate user stats (anonymized).
- **M5** Dashboard widget (Pro tier) — "This month: X errors prevented, Y tokens saved, Z hours of work redo avoided". Viral social-share button: "auto-sop saved me 47 errors this month → claim badge."
- **M6** `auto-sop stats` CLI verb — local-only metric display, free tier (no cloud needed). Shows per-project savings.

**Why Phase 7 (before SaaS):** Metrics are pure CLI-side work — no cloud infra needed. M1-M4 and M6 are local-only. M5 (dashboard widget) moves to SaaS phase. The landing page needs real numbers to convert — build the data pipeline first, then the SaaS viewer. Also: metrics prove the product works, which de-risks the SaaS investment.

**Cloud stats aggregation strategy:** Installed clients gather local stats (directive fires, categories, error prevention, session metrics). In Phase 8 (SaaS), Pro-tier CLI syncs these stats to the cloud (encrypted). The cloud aggregates across all users to produce landing page proof numbers: "auto-sop users prevented 12,000 errors this month" / "average 67% fewer token usage after directives." Stats are opt-in, anonymized, and never include prompt text or code. The local `auto-sop stats` verb shows per-project numbers; the cloud dashboard shows aggregate trends + per-user breakdown.

**Planned versions:**
  - v30: M1 + M6 — directive-fire detection (heuristic) + `auto-sop stats` CLI verb (**DONE**)
  - v31: Fire quality (bigram matching) + categorization (error/efficiency/best-practice) + session metrics + error prevention tracking (**DONE**)
  - v32: M2 + M3 — token/time savings tracker + "errors prevented" counter (requires hook integration with Claude Code). Also: CLI `sync` prep — structure local stats for cloud upload format.

**Depends on:** Phase 6 (working learner with incremental patterns). M5 (dashboard widget) deferred to Phase 8 (SaaS). Cloud stats aggregation and landing page proof numbers depend on Phase 8 sync pipeline.

**Success Criteria:**
  1. After 2 weeks of use, `auto-sop stats` shows non-zero "directives fired" count.
  2. Landing page demo command produces real before/after numbers, updated automatically from anonymized aggregate user data.
  3. Pro dashboard widget shows monthly trend with clear social-share affordance.
  4. M3 number ("errors prevented") is conservative — only counted when directive demonstrably influenced Claude's behavior (verified by LLM analysis of capture).
  5. No false-positive metric inflation — would rather under-claim than oversell.
**Plans:** TBD (v31-v33)

_Strategic insight from user (2026-04-19): "rtk's side-by-side proof on landing page is the strongest sales weapon. Cargo test → 4823 tokens / rtk cargo test → 11 tokens. Real working command, not staged screenshot. We need metrics."_

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Distribution Decision + Foundations | 1/1 | **COMPLETE** | v1 |
| 1. Capture Foundation | 1/1 | **COMPLETE** | v2, v4-v8 |
| 2. Installer + Scheduler + CLI | 2/2 | **COMPLETE** | v3, v4-v8, v12 |
| 3. Learner | 3/3 | **COMPLETE** | v9, v13, v14, v17 |
| 4. ManagedSectionEditor | 2/2 | **COMPLETE** | v10, v11, v16 |
| 5. Inspection CLI + Packaging | 2/2 | **COMPLETE** | v17-v22 |
| 6. Native Windows + Hardening | 5/5 | **COMPLETE** | v23-v25 (Windows), v27 (drift fix), v29 (incremental patterns) |
| 7. Metrics & Social Proof | 3/3 | **COMPLETE** | v30 (fire detection), v31 (categorization), v32 (token/time/errors) |
| 8. SaaS Platform + Monetization | ~95% | **NEAR COMPLETE** — Stripe billing (v35) in progress, stats sync done | See breakdown below |
| 9. First Public Launch | 0/1 | **BLOCKED** on v35 Stripe + v43-v48 enhancements | After v48 |
| 10. Smart Directive Targeting | 0/3 | Not started — post-launch | v50+ |

### Phase 8 Breakdown (two repos)

**CLI repo (`auto-sop/`):**
| Item | Status | Plan |
|------|--------|------|
| BIND-1 Project binding | ✅ Done | v36 |
| BIND-2 Periodic server validation | ✅ Done | v36 |
| BIND-3 Ed25519 response verification | ✅ Done | v36 |
| BIND-4 License cache + grace period | ✅ Done | v36 |
| BIND-5 Project count enforcement | ✅ Done | v36 |
| BIND-7 CLI self-hash computation | ✅ Done | v38 |
| BIND-7 tampered_client handling | ✅ Done | v38 |
| BIND-8 CLI request encryption (X25519) | ✅ Done | v40 + d421902 hotfix — E2E verified against prod server |
| Trial state machine | ✅ Done | v36 |
| Soft gate UX | ✅ Done | v36 |
| Offline grace 7 days | ✅ Done | v36 |
| Bug cleanup (V36-1/4, D1, E1) | ✅ Done | v38 |
| ioreg PATH fix (launchd compat) | ✅ Done | v38 |

**Site repo (`auto-sop-site/`):**
| Item | Status | Plan |
|------|--------|------|
| Landing page | ✅ Done | v26 |
| Vercel deploy + domain | ✅ Done | v28 |
| Clerk auth + dashboard | ✅ Done | v34 |
| License validation API | ✅ Done | v34 |
| Machine abuse detection | ✅ Done | v37 |
| Deleted account handling | ✅ Done | v37 |
| BIND-7 server hash registry | ✅ Done | v39 |
| BIND-8 X25519 request decryption | ✅ Done | v39 |
| Clerk UserProfile routing fix | ✅ Done | v39 (routing="hash") |
| Stripe billing | ⏳ **Queued — ONLY remaining Phase 8 item** | v35 (launch blocker) |
| Project sync to dashboard | ✅ Done | Manual fix (validate endpoint) |

### What remains before launch

**Done (Phase 8 core):**
- ~~v38~~ ✅ CLI bug cleanup + BIND-7 self-hash (committed)
- ~~v40~~ ✅ BIND-8 CLI request encryption (committed + E2E verified against prod server)
- ~~v41~~ ✅ Encrypted stats sync: CLI → server hourly upload (X25519), tables, dashboard real metrics. **E2E verified: 5 projects syncing, 297K tokens saved showing in DB.**
- ~~v42~~ ✅ MetricsState persist fix — `saveMetricsState()` wired into tick. Stats sync now fires every hour. (Delivered by v41 ARCHITECT, plan moved to done.)

**In progress:**
1. **v35** 🔄 (launch blocker, **site**) — Stripe billing: Checkout, Customer Portal, webhooks, upgrade UI, trial management. Plan in `auto-sop-site/plans/queued/`. **Stripe test keys configured, products + prices ($12/mo, $99/yr) created.**
2. **v46** 🔄 (**CLI**) — Directive transparency: self-reported fires via `[sop:applied:ID]` markers, capture writer parsing, cloud sync of directive IDs + confirmed fires.

**Done (recently completed):**
- ~~v43~~ ✅ Dashboard per-project stats + gains charts (auto-sop-site, PR #5)
- ~~v44~~ ✅ Deterministic metrics — real byte-counted token estimation (CLI, `eff3c5b`)
- ~~v45~~ ✅ Metrics persist fix — treeshake:false for learner bundle + recompute + hybrid savings (CLI, `545a5b8`)
- ~~v47~~ ✅ Directive hits dashboard — DirectiveHits component, stats-history API, migration 007 (auto-sop-site, PR #6)

**Queued:**
3. **v48** ⏳ (**CLI + site**) — Directive previews: CLI sends first 10 words per directive via stats-sync. Site displays directive ID + preview + hit count on directives page. Supabase migration 008.

**Future (not yet planned):**
4. **v49** — Landing page aggregate stats: Public-facing anonymous numbers from `SUM(asop_stats_summary)`. Hero section: "auto-sop users prevented X errors this month."
5. **v50** — CLI token consumption transparency: `auto-sop stats --self` showing own token cost per 24h.
6. **v51** — Dashboard project toggle: Free=1 active project, toggle UI, upgrade prompt → Stripe Checkout.
7. **BUG-METRICS-1** — Time-saved formula calibration: cap at wall-clock, confidence bands, TOKENS_PER_MINUTE adjustment.

**Phase 9 (launch prep):**
8. **v52** — Launch prep — npm v0.1.0 publish with provenance, real metrics on landing page, demo GIF/video (M4)
9. **Homebrew tap** — already staged (v22), activate on launch day
10. **Phase 9 viral** (post-launch) — referral system (R1-R6), Product Hunt prep, CLAUDE.md badge program

## Execution History

| Version | Commit | What shipped |
|---------|--------|--------------|
| v1 | `e77b13f` | Phase 0: ADR, PathResolver, Config, Scrubber, recall gate corpus |
| v2 | `998335d` | Phase 1: hook shim, detached writer, turn directories, bidirectional subagent linking |
| v3 | `18d43a1` | Phase 2: installer, launchd scheduler, CLI skeleton |
| v4 | `b5a08ca` | Hotfix: CLI ESM bin + plugin bundle + smoke test |
| v5 | `ad5fbbb` | Hotfix: plugin bundle layout + learner stub |
| v6 | `a22c0e6` | Hotfix: shim shebang + marketplace schema + stub polarity + doctor logic |
| v7 | `3e8a5b5` | Hotfix: stage writer.cjs into plugin bundle + e2e capture smoke |
| v8 | `2700dde` | Hotfix: bundle ALL writer runtime deps + isolated e2e smoke |
| v9 | `aed0da7` | Phase 3 MVP: project registry, cursor, turn scanner, recap.log, recap verb |
| v10 | `e9b1b61` | Phase 4 light: ManagedSectionEditor, sample directive, statusline, test cleanup |
| v11 | `555fb39` | Hotfix: statusline parser reads real Claude Code settings.json structure |
| v12 | `84b180b` | Hotfix: launchd bootstrap + warmup kickstart + doctor effective check |
| v13 | `860434d` | Phase 3: first detectors — repeated bash failure + edit match fail + strict schema |
| v14 | `9841bb7` | Phase 3: LLM-driven directive generation — claude -p default ON, $0 cost (Claude Max) |
| v15 | `e99673e` | Bug fix sprint — B1-B8 cleaned (legacy markers, flaky tests, import.meta, pane cwd, env var rename) |
| v16 | `5a694d7` | Phase 4 hardening — hash check + git-aware + revert + TTL + dedup + evidence links + golden tests |
| v17 | `6b4e136` | Phase 3 completion + Inspection CLI + bug cleanup (I6-I9 + C1+C2 + B9-B12) |
| v18 | `7b606fb` | Publish readiness — rename to auto-sop, Apache 2.0 LICENSE, publish workflow, release-check |
| v19 | `b531ea7` | Org URL migration (auto-sop/auto-sop) + auto-bump version hook |
| v19b | — | Ralph-loop infinite loop fix (safe defaults + safety valve) |
| v20 | `19161ae` | Directive restore-render bug fix (history directives survive zero-turn ticks) |
| v21 | `1d10cfb` | GitHub community files + CI fixes (TypeScript strict, flaky tests, Ubuntu platform) |
| v22 | `abb6dff` | README badges + npm metadata + publish workflow hardening + Homebrew tap staging |
| v23 | `29d71bd` | Native Windows foundation — platform abstraction + Task Scheduler + build fixes |
| v24 | `f6a8517` | Windows chmod migration + CI fix sprint + NTFS permission helper |
| v25 | — | Windows CI matrix (Phase 6 final step) |
| v26 | `a2e82d7` | auto-sop.com landing page — purple brand, owl mascot, SEO-ready (`auto-sop-site/` repo) |
| v27 | `0b9a956` | Learner drift fix — error serialization, repair CLI verb, auto-recovery after 3 drifts |
| v28 | — | Vercel deploy + auto-sop.com domain (`auto-sop-site/` repo, queued) |
| v29 | — | Incremental pattern memory — LLM accumulates candidates across ticks |
| v30 | `5b01df7` | Directive-fire detection + `auto-sop stats` CLI verb |
| v31 | `1938438` | Fire categorization + bigram matching + session metrics + error prevention tracking |
| v32 | — | Phase 7 completion: token/time savings tracker + errors prevented counter |
| v33 | — | Bug fix sprint |
| v34 | — | SaaS platform: Clerk auth + Supabase dashboard + license validation API (`auto-sop-site/`) |
| v36 | — | CLI license binding + server validation (BIND-1→6) |
| v37 | — | Backend anti-abuse: machine abuse detection + deleted account handling (`auto-sop-site/`) |
| v38 | `56b9db8` | CLI bug cleanup + BIND-7 self-hash tamper detection + ioreg PATH fix |
| v39 | `71d2a6c` | BIND-7 server hash registry + BIND-8 X25519 request decryption (`auto-sop-site/`) |
| v40 | `af0e004` | BIND-8 CLI request encryption (X25519 + AES-256-GCM) |
| v40-fix | `d421902` | BIND-8 hotfix: align HKDF params + SPKI DER format with server — E2E verified |
| v41 | `cf737d2` | Encrypted stats sync — X25519 hourly CLI→server upload, stats tables, dashboard real metrics (both repos) |
| v42 | — | MetricsState persist fix — delivered inside v41, `saveMetricsState()` wired into tick |
| v43 | — | Dashboard per-project stats + gains charts + period filter (`auto-sop-site/`, PR #5) |
| v44 | `eff3c5b` | Deterministic token counting — real bytes replace 200/call heuristic |
| v45 | `545a5b8` | Metrics persist survives tree-shake + recompute flag + hybrid savings. Root cause: tsup treeshake stripped saveMetricsState from bundle (try/catch with empty catch = dead code). Fix: `treeshake: false` for learner bundle. |
| v46 | 🔄 | Directive transparency — self-reported fires via `[sop:applied:ID]` markers, capture writer parsing, cloud sync of directive IDs + confirmed fires (auto-sop, in progress) |
| v47 | — | Directive hits dashboard — DirectiveHits component, DirectiveSummary card, confirmed_fires_total in stats-history API, migration 007 (`auto-sop-site/`, PR #6) |
| v48 | ⏳ | Directive previews — CLI sends first 10 words per directive via stats-sync (auto-sop, queued) + site displays ID/preview/hits on directives page (auto-sop-site, queued) |

## Remaining Backlog

### v14 (in progress) — LLM intelligence
- ~~**I1** First detector~~ ✅ shipped v13
- ~~**I2** Second detector~~ ✅ shipped v13
- ~~**I3** Strict JSON schema~~ ✅ shipped v13
- ~~**I4** Prompt injection resistance~~ ✅ shipped v13
- **I5** LLM-driven directive generation (`claude -p` default ON) — LEARN-01, LEARN-02 ← **v14 in progress**
- **I6** 600s hard kill on learner — LEARN-08
- **I7** `claude-sop learn-now --dry-run` verb — LEARN-07
- ~~R1 Recall gate~~ — **NOT NEEDED** (Claude Code reads CLAUDE.md natively)

### Editor hardening (v15) — Phase 4 completion
- **E1** Hash-checked write (abort on drift, conflict backup) — MD-03
- **E2** Git-aware (skip during rebase/merge) — MD-04
- **E3** `claude-sop revert` command — MD-05
- **E4** Duplicate directive detection — MD-06
- **E5** TTL pruning + max 25 directive cap — MD-07
- **E6** Evidence pointer per directive (source_capture_ids) — MD-02
- **E7** Golden-file test suite — MD-08

### Bug fix sprint (v16)
- **B1** Remove installer's legacy `<!-- claude-sop:begin -->` markers (conflicts with v10 markers)
- **B2** Smoke test flaky perf (500ms → 600-800ms limit)
- **B3** `import.meta` tsup CJS warning fix
- **B4** Idempotency: directive timestamp → last turn finalized_at (not wall-clock minute)
- **B5** Statusline: native stdin JSON parse from Claude Code
- **B6** dev-army cwd attribution (`DEV_ARMY_TARGET_PROJECT` env var)
- **B7** Rename `CLAUDE_SOP_LEARNER` env var (confusing dual meaning)

### Inspection CLI (v17) — Phase 5 partial
- **C1** `claude-sop recent [--since 1h]` — CLI-02
- **C2** `claude-sop show <id>` — CLI-03

### Packaging + launch (v18) — Phase 5 completion
- **P1** npm publish --provenance
- **P2** publint + @arethetypeswrong/cli CI gate
- **P3** Claude Code version matrix E2E test
- **P4** "Looks-done-but-isn't" checklist (>=20 items)
- **P5** Dual ESM+CJS entry point validation
- **P6** README polish + demo GIF/video

### Referral & Viral Growth (v38-v39) — Phase 9 R-series
- **R1** Referral system — `asop_referrals` table, unique referral codes per user, `?ref=CODE` signup flow. Both referrer and referee get +30 days Pro trial. Dashboard shows referral stats.
- **R2** GitHub Star reward — GitHub API integration, verify user starred `auto-sop/auto-sop` repo. +30 days Pro trial, one-time. Claim button in dashboard.
- **R3** Social share rewards — Tweet/LinkedIn share with tracking. Twitter intent URL + claim button. +15 days Pro trial per platform, monthly limit.
- **R4** Product Hunt launch integration — Upvote verification + special launch day reward (+15 days Pro trial). One-time.
- **R5** CLAUDE.md badge program — Users add `<!-- auto-sop-badge: USER_CODE -->` to their public repos' CLAUDE.md. Periodic scan verifies badge presence. Ongoing 10% Pro discount while badge is active. Dual benefit: user gets discount, we get developer-to-developer discovery.
- **R6** Rewards dashboard page — `/dashboard/rewards` showing: earned days, referral link with copy, social task checklist, referral history, pending rewards.

### Dogfood observation milestone (between v18 and v20)
_Not a planned code version — 1-2 week period of running the tool on real projects after MVP publish. Hotfix patches (v18.1, v18.2…) as needed. Outputs: directive quality data, Windows user count, Phase 6 priority input._

### Native Windows Support (v23-v25) — Phase 6
- **WIN1** Windows scheduler backend — `src/scheduler/windows-schtasks.ts` with Task Scheduler XML + install/uninstall via `schtasks.exe`
- **WIN2** Windows hook shim adapter — `.cmd` wrapper bundled in plugin, ACL-based permissions via `icacls`, path translation
- **WIN3** Windows CI matrix — GitHub Actions `windows-latest` runner, smoke tests for scheduler + hook firing + capture pipeline
- **WIN4** `platform-check.ts` updated to ALLOW `win32` when all 3 above are green
- **WIN5** Verify `claude -p` binary support on Windows (LLM mode must work)
- **WIN6** Docs: Windows-specific install section in README, troubleshooting guide

### SaaS / monetization (v33-v37) — Phase 8
- **S1** License validation API — Ed25519 signed responses, `POST /v1/license/validate` endpoint. Key pair generation, nonce tracking, replay prevention. (`auto-sop-cloud/` repo)
- **S2** Clerk integration in `auto-sop-cloud` — Sign in/up flows, JWT verify, license key generation on signup
- **S3** Trial state machine — 14 days OR feature-touch-triggered, no credit card, stored in `secrets.enc`
- **S4** Soft gate UX — at trial expiry, EXISTING data untouched, only NEW project blocked
- **S5** Offline grace (7 days) — `license-cache.json` TTL, learner stops after grace, capture continues
- ~~**S6** Obfuscation pipeline (CLI source)~~ → **REMOVED** — kod açık (ELv2), obfuscation gereksiz
- **S7** Node SEA binary (macOS + Linux + **Windows** — Phase 6 req) — **opsiyonel**, convenience only
- **S8** Stripe Checkout + Customer Portal integration — **Test keys configured in `.env.local`, products created in Stripe dashboard: $12/mo + $99/yr. Plan in `auto-sop-site/plans/queued/PLAN-v35-stripe-billing.md`.**
- **S9** Pricing page on landing site (`auto-sop.com`)
- **S10** Dashboard app (`auto-sop-cloud/` repo, Next.js + Vercel)
- **S11** CLI sync module (encrypted directive push to Supabase Edge Functions)

### Protection layer implementation (v33-v37) — Phase 8 BIND-series
- **BIND-1** Project binding — `binding.json` oluşturma: `HMAC-SHA256(license_key, project_path + machine_id)`. Install sırasında yazılır, her tick'de token doğrulanır.
- **BIND-2** Periodic server validation — her tick başlangıcında `POST /v1/license/validate`. Bound project sayısı + binding hash'leri gönderilir.
- **BIND-3** Ed25519 response verification — CLI'a server public key gömme, response signature doğrulama, nonce + timestamp replay koruması.
- **BIND-4** License cache + grace period — `~/.auto-sop/state/license-cache.json`. 7 gün offline grace, grace sonrası learner durur, capture devam eder.
- **BIND-5** Project count enforcement — `bound_projects > max_projects` → ilk proje hariç learner durur. Status mesajında upgrade yönlendirmesi.
- **BIND-6** ELv2 license file — repo'daki Apache 2.0 LICENSE dosyasını Elastic License 2.0 ile değiştir. npm package.json `license` field güncelle.
- ~~**BIND-7** CLI self-hash tamper detection~~ ✅ Done (v38 CLI, v39 server) — build sırasında `dist/` hash'i hesapla ve sunucuya kaydet. Her tick'de CLI kendi hash'ini hesaplar, sunucu bilinen hash ile karşılaştırır. Eşleşmeyen → `tampered_client` reject.
- ~~**BIND-8** Request encryption (X25519 ECDH + AES-256-GCM)~~ ✅ Done (v39 server, v40 CLI, d421902 hotfix — E2E verified) — CLI → Server request confidentiality. Dedicated X25519 keypair (not converted from Ed25519). Ephemeral X25519 key pair per request, HKDF-SHA256 key derivation, AES-256-GCM encryption. Content-Type: `application/x-asop-encrypted`. Server accepts both encrypted and plaintext (fallback). HTTPS üzerine defense-in-depth katmanı.

### Freemium gating (v33-v37) — Phase 8 F-series
- **F1** Project count enforcement — Free=1, Pro=∞. `auto-sop install` in 2nd project triggers trial prompt
- **F2** Trial state machine — `secrets.enc` stores: `started_at`, `triggered_by` (e.g. "second_project_install"), `ended_at`. Tamper-resistant via existing secrets.enc encryption
- **F3** Soft gate UX — clear messaging when at quota: "You're using 1/1 projects on Free. Upgrade to Pro for unlimited (no credit card on trial)." Existing project keeps working untouched
- **F4** Curated directive packs — `~/.auto-sop/packs/<framework>.json` (e.g. `nextjs.json`, `rails.json`). Pulled from cloud on Pro tier. Free tier: only learns from own captures, no shared packs
- **F5** Cross-project pattern detection — when Pro user has ≥2 projects, learner runs an additional "shared learnings" pass that finds patterns appearing in 2+ projects, surfaces as candidates for promotion to a directive pack
- **F6** Dashboard project toggle (v43) — Free users see ALL bound projects in dashboard but can only ACTIVATE one at a time. Toggle switch per project. Activating 2nd project while on Free → upgrade prompt → Stripe Checkout. Server-enforced: `asop_projects.active` boolean column. Deactivated projects: learner stops, capture continues, data preserved. UX: clean toggle list, not error message. Inspiration: Notion's block limit — limits creation, never destroys.

### Stats sync & transparency (v41-v47) — Phase 8 STATS-series
- ~~**STATS-1** Encrypted stats sync (v41)~~ ✅ Done — CLI sends project-level totals hourly via X25519 encrypted POST. Server stores in `asop_stats_log` (append) + `asop_stats_summary` (upsert). Dashboard reads real aggregated stats. E2E verified 2026-04-27.
- ~~**STATS-1b** MetricsState persist (v42)~~ ✅ Done — `saveMetricsState()` wired into tick. Stats sync fires every hour. Delivered by v41 ARCHITECT.
- ~~**STATS-1c** Deterministic metrics (v44)~~ ✅ Done — Real byte-counted token estimation replaces 200/call heuristic. `byte_counted` primary method, `tool_call_heuristic` fallback, hybrid when byte savings = 0 but tool calls dropped >20%.
- ~~**STATS-1d** Dashboard per-project stats + charts (v43)~~ ✅ Done — Recharts AreaChart, period filter, per-project detail page, real stats on project cards (auto-sop-site PR #5).
- ~~**STATS-1e** Metrics persist tree-shake fix (v45)~~ ✅ Done — `treeshake: false` for learner bundle. Root cause: tsup tree-shaker stripped `saveMetricsState`/`loadMetricsState` because call sites were in try/catch with empty catch blocks (treated as side-effect-free dead code).
- **STATS-2** Directive transparency (v46, **CLI**, 🔄 in progress) — Self-reported fires via `[sop:applied:ID]` markers in Claude output, capture writer parsing, cloud sync of `directive_ids` + `confirmed_fires_by_directive` + `estimation_method`.
- ~~**STATS-2b** Directive hits dashboard (v47)~~ ✅ Done — DirectiveHits component, DirectiveSummary card, confirmed_fires_total in stats-history API, migration 007 (auto-sop-site PR #6).
- **STATS-2c** Directive previews (v48, **CLI + site**, ⏳ queued) — CLI extracts first 10 words of each directive rule_text, sends as `directive_previews` map in stats-sync. Site accepts, stores in new `directive_previews` JSONB column (migration 008), displays on directives page with hit counts.
- **STATS-3** Landing page aggregate stats (v49) — Public API endpoint (`GET /api/v1/public/stats`), anonymous platform-wide aggregates, hero section numbers.
- **STATS-4** CLI token consumption transparency (v50) — `auto-sop stats --self`, own token cost per 24h.
- **STATS-5** Time-saved formula calibration (BUG-METRICS-1) — Current `TOKENS_PER_MINUTE = 200` produces inflated estimates (68h "saved" in 25h wall-clock). Needs: confidence bands, wall-clock cap, sample size weighting, task complexity normalization.

### Metrics & Social Proof (v30-v32) — Phase 7 M-series
- **M1** Directive-fire detection — UserPromptSubmit hook checks if active directives are relevant to current prompt. Heuristic match (keyword) for v31, LLM-based for v33
- **M2** Token/time savings tracker — capture token usage from `claude -p --output-format json` responses. Compare sessions before/after directive existed
- **M3** "Errors prevented this month" counter — for each Bash failure pattern that became a directive, count subsequent sessions where same command DIDN'T fail. Headline number for landing page
- **M4** Landing page side-by-side proof copy — RTK format: "$ command → 4823 tokens / $ auto-sop command → 11 tokens". Real terminal recording, updated monthly with anonymized aggregate user data
- **M5** Pro dashboard widget — monthly trend graph + viral social-share button: "auto-sop saved me 47 errors this month → tweet badge"
- **M6** `auto-sop stats` CLI verb — local-only metric display, free tier (no cloud needed). Shows per-project savings

### Known bugs (fix when convenient)
- **BUG-METRICS-1** **Time-saved formula is inflated.** `total_time_saved_minutes = total_tokens_saved / TOKENS_PER_MINUTE` where `TOKENS_PER_MINUTE = 200` (src/metrics/state.ts:31). The formula multiplies per-session token savings by ALL post-directive sessions, assuming every session would have been equally expensive without directives. Result: auto-sop-site shows 68h 57m "time saved" in just 2 days of real usage (~25h wall-clock). Root causes: (a) small "before" sample (9 sessions vs 81 "after"), (b) assumes ALL improvement is from directives (ignores task complexity variance), (c) `TOKENS_PER_MINUTE = 200` converts tokens to time too generously. Fix options: (1) add confidence band based on sample size, (2) cap time_saved at wall-clock elapsed since first directive, (3) increase TOKENS_PER_MINUTE constant, (4) add disclaimer "estimated" label on dashboard, (5) normalize by task complexity (same command/intent comparison). Priority: medium — inflated numbers undermine credibility with sophisticated users.
- **BUG-V34-1** `validate/route.ts` — Supabase log insert (validation_log) has no error handling; rate limiting silently degrades on DB errors. Add try/catch around log insert, don't let log failure block validation response.
- **BUG-V34-2** `validate/route.ts` — `select("*")` over-fetches user row. Should be `select("id, plan, max_projects, stripe_customer_id")` — only the fields actually used.
- **BUG-V34-3** `dashboard.ts` — `patternCandidates` is a magic-number fabrication (`count * 1.6`). Replace with real metric from CLI stats or remove until real data exists.
- **BUG-V34-4** Dashboard layout — double-queries `asop_users` table (layout fetches user, page fetches user again). Hoist user fetch to layout, pass via React context or server component prop.
- **BUG-C1** `auto-sop status` shows "last tick: never" and "directives: 0" even when learner cursor is advancing and CLAUDE.md has active directives. The status verb reads `scheduler.lastTickAt` and `learner.lastRunAt` fields that the tick script never writes to. Actual batch pipeline works correctly — recap log, cursors, and directive generation all function. Display-only issue.
- **BUG-D1** **Semantic near-duplicate directives.** The LLM proposes directives per-tick without strong dedup against semantically similar existing ones. The merge logic catches exact ID matches but not near-duplicates. Example: wrbeautiful has two separate directives about "never embed API tokens in inline scripts" and "never pass Shopify access tokens as inline arguments" — same lesson, different wording. Also cross-project overlap on agent efficiency patterns (wrbeautiful + aiagenttr-website both learned review-agent waste lessons independently). Fix: add semantic similarity check during merge step — cosine similarity on rule_text embeddings, or LLM-based "is this the same lesson?" gate before accepting a new directive. Target: <5% duplicate rate across active directives.
- **BUG-E1** **Flaky e2e integration tests under parallel load.** The large-output and orphan-recovery tests in test/capture/integration/end-to-end.test.ts time out (waitForQuiescence 160s) when running alongside the full test suite. They pass reliably in isolation. Root cause: resource contention under parallel test execution.
- **BUG-V36-1** `server-client.ts` — Unused `isCacheValid` import. Either call it in `fallbackToCache` or remove the import.
- **BUG-V36-2** `main.ts` — Double `checkLicenseBeforeTick` call. Refactor to single call, extract both `allowed` and `maxProjects` from one result.
- **BUG-V36-3** `GRACE_PERIOD_MS` duplicated in `server-client.ts`. Export from `cache.ts` and import instead.
- **BUG-V36-4** `server-client.ts` — `resetFailures` utility bypassed in success path. Use the existing utility instead of manual reset.
- **BUG-S1** **Session inflation from Dev Army agents.** Each subagent (ARCHITECT, YODA, APEX, PRISM, etc.) creates its own `session_id`, so a single 20-minute dev-army run on wrbeautiful-shopify-theme produced 21 sessions from 25 turns. The 3-session graduation threshold is trivially met in one sitting, causing the LLM to graduate all candidates immediately. Real impact: wrbeautiful got 10 directives from what was effectively 1 user work session. Fix options: (a) deduplicate by parent session / transcript_path root, (b) time-window grouping (sessions within same hour = 1 observation), (c) only count `main` agent type sessions toward threshold. This is a **quality issue, not a crash** — directives generated are still valid, but the "evidence: 3 sessions" claim is misleading.

### dev-army improvements (parallel)
- **D1** Commander default to dispatch-and-wait.sh
- **D2** dispatch-task.sh stderr fix → formal commit + review
- **D3** Agent-poll inbox watcher stability

### Smart Directive Targeting (v39+) — Phase 10 (post-launch)
- **SD1** Scope classification field in DirectiveProposal Zod schema
- **SD2** LLM prompt update — ask Claude to label each directive's scope
- **SD3** Skill file generator (`~/.claude/skills/<project>-<skill>.md`)
- **SD4** CLAUDE.md vs Skills routing in directive-builder
- **SD5** Migration tool: `claude-sop migrate-directives --classify` for existing CLAUDE.md directives

### Cross-cutting (parallel)
- **X1** Linux CI matrix (systemd + cron)
- **X2** Multi-project cross-project pattern detection
- **X3** User directive feedback (like/reject)
- **X4** ADR finalize (sideload vs marketplace)
- **X5** Plugin distribution → Claude Code marketplace
- **X6** I8 — LLM skip if turns_new=0 (avoid wasteful analysis on idle ticks)

## Coverage Validation

- v1 requirements total: 61
- Mapped: 61
- Orphans: 0
- Duplicates: 0

| Phase | Requirement Count | IDs |
|---|---|---|
| 0 | 6 | INST-07, INST-08, PRIV-01, PRIV-02, PRIV-03, PRIV-05 |
| 1 | 12 | CAPT-01..10, PRIV-04, PRIV-07 |
| 2 | 18 | INST-01..06, SCHED-01..05, PRIV-06, CLI-01, CLI-04, CLI-05, CLI-06, LIC-01, LIC-02 |
| 3 | 8 | LEARN-01..08 |
| 4 | 8 | MD-01..08 |
| 5 | 2 | CLI-02, CLI-03 |
| 6 | 8 | LIC-03..10 |

---
*Roadmap created: 2026-04-13*
*Last updated: 2026-04-28 — Phase 8 ~95% complete. v43-v45 + v47 done. v46 directive transparency in progress (CLI). v48 directive previews queued (CLI + site). v35 Stripe still the only Phase 8 launch blocker. Known issue: BUG-METRICS-1 time-saved formula inflated (68h "saved" in 25h wall-clock — TOKENS_PER_MINUTE=200 too generous, small before-sample, no wall-clock cap). Critical path: v35 Stripe → v48 previews → v49 landing page stats → launch.*
