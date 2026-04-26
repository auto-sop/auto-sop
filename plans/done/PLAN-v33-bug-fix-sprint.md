# V33: Bug Fix Sprint — BUG-C1 + BUG-D1 + BUG-E1 + BUG-S1

## Overview
Bekleyen 4 bug'ı tek sprint'te temizle. Hepsi kalite/güvenilirlik sorunları — yeni özellik yok.

1. **BUG-C1**: `auto-sop status` "last tick: never", "directives: 0" gösteriyor ama pipeline çalışıyor
2. **BUG-D1**: Semantik olarak aynı direktifler tekrar tekrar oluşuyor (wrbeautiful'da 2 aynı credential direktifi)
3. **BUG-E1**: e2e integration testler paralel çalışmada timeout veriyor
4. **BUG-S1**: Dev-army agent'ları session inflation yapıyor — 1 çalışma = 21 session = sahte graduation

## Architecture Decisions

### BUG-C1: Status verb fix
**Root cause**: `readLastLearnerRun()` in `src/status/collector.ts` (line 120-125) hardcoded olarak `{ lastRunAt: null, lastExitCode: null }` dönüyor — Phase 2'de yazılmış, Phase 3 learner entegrasyonu hiç yapılmamış. Aynı şekilde `countDirectives()` CLAUDE.md'deki `- ` satırlarını sayıyor ama managed section marker'lar arasındaki directiveleri doğru saymıyor.

**Fix**:
- `readLastLearnerRun()`: learner cursor dosyasını oku (`<project>/.auto-sop/state/learner-cursor.json`). `updated_at` → `lastRunAt`, cursor var → exit code 0.
- `scheduler.lastTickAt`: Global recap logdan (`~/.auto-sop/logs/recap.log`) son tick'in timestamp'ini oku.
- `directives.count`: Directive history dosyasından (`<project>/.auto-sop/state/directive-history.json`) aktif (pruned=false) entry sayısını oku. CLAUDE.md regex yerine authoritative source.

### BUG-D1: Semantic dedup for directives
**Root cause**: `mergeCandidateEvidence()` in `src/learner/pattern-store.ts` sadece `id` bazında dedup yapıyor. Aynı anlama gelen ama farklı kelimelerle ifade edilen direktifler ayrı entry'ler olarak kalıyor.

**Fix**: LLM-based dedup çok pahalı/yavaş. Bunun yerine **lightweight keyword-overlap dedup**:
- Yeni candidate kabul edilmeden önce, mevcut tüm candidate ve directive rule_text'leriyle keyword overlap hesapla
- Overlap > 60% → aynı direktif say, merge et (evidence birleştir, daha iyi rule_text'i tut)
- Keyword extraction'ı zaten v31'de yazdık (`extractKeywords` in directive-fire.ts) — aynı fonksiyonu reuse et
- Bu LLM'den önce çalışır, sıfır maliyet

### BUG-E1: Flaky e2e test fix
**Root cause**: `large-output` ve `orphan-recovery` testler `waitForQuiescence` ile 160s bekliyor ama paralel test suite'de resource contention yüzünden timeout oluyor. Tek başına çalışınca sorun yok.

**Fix**:
- Timeout'u artırmak çözüm değil — testleri sequential modda çalıştır (`describe.sequential` veya test config'de isolate)
- VEYA: testleri `test:serial` gibi ayrı bir script'e taşı, ana suite'den `it.skip` yerine tamamen ayır
- En temiz çözüm: Vitest'in `pool: 'forks'` + `fileParallelism: false` opsiyonunu sadece bu test dosyası için kullan

### BUG-S1: Session inflation fix
**Root cause**: `src/learner/main.ts` line 530: `currentSessionIds = [...new Set(turnData.map(t => t.session_id))]`. Dev-army'de her agent (ARCHITECT, YODA, APEX, PRISM...) kendi `session_id`'sine sahip. Bir 20 dakikalık army run'da 21 farklı session_id üretiyor. `graduateCandidates()` 3 distinct session istiyor → tek army run'da hemen graduate oluyor.

**Fix**: Time-window dedup — aynı saat içindeki session'ları tek "observation" say:
- `session_ids` yerine `observation_windows` konsepti ekle
- Session'ları 1-saatlik pencereler halinde grupla (aynı saatte 10 agent session'ı = 1 observation)
- Graduation threshold: 3 distinct observation windows (farklı saatlerde gerçekleşen çalışmalar)
- Bu en az invasive fix — mevcut `session_ids` field'ını korur, sadece graduation check'i değişir

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Fix `auto-sop status` display (BUG-C1)
   Files: `src/status/collector.ts`, `test/status/collector.test.ts`
   Requirements:
   - `readLastLearnerRun()`: Learner cursor dosyasını oku (`<project>/.auto-sop/state/learner-cursor.json`). `updated_at` alanını parse et → `lastRunAt` olarak dön. Dosya yoksa veya parse hata verirse `null` dön (mevcut davranış korunur).
   - `countDirectives()`: Directive history dosyasını oku (`<project>/.auto-sop/state/directive-history.json`). `entries` objesinde `pruned !== true` olan entry sayısını dön. Dosya yoksa fallback olarak mevcut CLAUDE.md regex'i kullan.
   - Scheduler `lastTickAt`: Global recap log'dan (`~/.auto-sop/logs/recap.log`) son satırı oku, `t` alanını parse et. Bu collectStatus seviyesinde yapılır, scheduler backend'e dokunma.
   - Tests: cursor dosyası varken/yokken lastRunAt, history dosyasından directive count, recap log'dan lastTickAt
   Acceptance: `auto-sop status` gerçek tick zamanını, gerçek directive sayısını, gerçek learner run zamanını gösterir.

2. ARCHITECT: Add keyword-overlap dedup for directive candidates (BUG-D1)
   Files: `src/learner/pattern-store.ts`, `src/capture/writer/directive-fire.ts`, `test/learner/pattern-store.test.ts`
   Requirements:
   - `extractKeywords` fonksiyonunu `directive-fire.ts`'den export et (zaten var, sadece export ekle)
   - `isSemanticallyDuplicate(ruleTextA: string, ruleTextB: string): boolean` fonksiyonu yaz:
     - Her iki rule_text'in keyword'lerini çıkar
     - Jaccard similarity hesapla: `|intersection| / |union|`
     - Similarity > 0.6 → true (duplicate)
   - `mergeCandidateEvidence()` içinde, yeni candidate eklemeden önce mevcut candidates'a karşı `isSemanticallyDuplicate` check yap
   - Duplicate bulunursa: mevcut candidate'ın session_ids, turn_ids, occurrence_count'ına merge et, yeni candidate'ı atla
   - Ayrıca `applyDirectiveHistory()` içinde aynı check'i yap — yeni directive kabul edilmeden önce mevcut aktif directive'lerle karşılaştır
   - Tests: aynı anlam farklı kelime → duplicate tespit, tamamen farklı → değil, edge cases (çok kısa text, boş keyword)
   Acceptance: wrbeautiful'daki 2 credential direktifi gibi near-duplicate'ler artık tek entry olarak merge edilir.

3. ARCHITECT: Fix flaky e2e integration tests (BUG-E1)
   Files: `test/capture/integration/end-to-end.test.ts`, `vitest.config.ts`
   Requirements:
   - `large-output` ve `orphan-recovery` testlerdeki `it.skip` → `it` olarak geri aç
   - Bu test dosyasını vitest config'de `fileParallelism: false` ile sequential moda al (diğer testleri etkilemeden)
   - VEYA: Bu dosyayı ayrı bir vitest workspace config'e taşı (`vitest.config.serial.ts`)
   - Timeout'u makul bir değere ayarla (120s → 30s sequential modda yetmeli)
   - CI'da da geçtiğini doğrula
   Acceptance: Tüm e2e testler `it.skip` olmadan, tam suite ile birlikte çalışır ve geçer.

4. ARCHITECT: Fix session inflation in graduation (BUG-S1)
   Files: `src/learner/pattern-store.ts`, `test/learner/pattern-store.test.ts`
   Requirements:
   - `timeWindowKey(sessionId: string, turnData: TurnData[]): string` yardımcı fonksiyon:
     - Session'ın en erken turn timestamp'ini bul
     - 1-saatlik pencereye yuvarla: `YYYY-MM-DDTHH` (saat bazında)
     - Dön: `"2026-04-25T17"` gibi
   - `graduateCandidates()` içinde, `distinctSessions` yerine `distinctObservationWindows` kullan:
     - `session_ids` → her birinin time-window key'ini hesapla
     - Unique time-window sayısı ≥ GRADUATION_THRESHOLD (3)
   - Sorun: `session_ids` string listesi, ama timestamp bilgisi yok. Çözüm:
     - `PatternCandidate` interface'ine `observation_windows?: string[]` optional field ekle
     - `mergeCandidateEvidence()` ve `matchedExisting` handler'ında, session eklerken aynı zamanda time-window'u da kaydet
     - `main.ts`'de: turn data'dan session → time-window mapping oluştur, candidate'lara ekle
   - Backward compat: `observation_windows` yoksa (eski candidates) → `session_ids.length` kullan (mevcut davranış)
   - Tests: 
     - 21 session aynı saatte = 1 observation window → graduate etmez
     - 3 session farklı saatlerde = 3 observation windows → graduate eder
     - Eski candidate'lar (observation_windows yok) → eski davranış korunur
   Acceptance: Tek bir dev-army çalışmasından 21 session geldiğinde, 3 distinct saat dilimi geçmeden graduate olmaz.

### Wave 2 (depends on Wave 1)

5. ARCHITECT: Integration test — verify all 4 bugs fixed
   Files: `test/status/status-integration.test.ts`, `test/learner/dedup-integration.test.ts`
   Requirements:
   - Status integration: cursor dosyası oluştur → status doğru lastRunAt gösterir
   - Dedup integration: 2 semantik duplicate candidate → merge olur, 1 entry kalır
   - Session inflation integration: 10 session aynı saat, 3 session farklı saat → graduation sadece ikinci case'de olur
   - e2e test: full suite çalışır, skip yok
   Acceptance: Tüm buglar test ile doğrulanmış.

## Quality Gates (MANDATORY)
6. YODA: Code review — dedup threshold (0.6 Jaccard makul mü?), time-window granularity (1 saat doğru mu?), status collector backward compat
7. APEX: Security review — learner cursor dosyasından injection riski, recap log parsing güvenliği
8. ANALYZER: Code improvement review — C veya üstü

## Finalize
9. ARCHITECT: Commit with message: `fix(v33): BUG-C1 status display + BUG-D1 semantic dedup + BUG-E1 flaky tests + BUG-S1 session inflation`

## Acceptance Criteria
- `auto-sop status` gerçek tick zamanı, gerçek directive sayısı, gerçek learner run zamanı gösterir
- Semantik olarak aynı direktifler otomatik merge edilir (Jaccard > 0.6)
- e2e testler skip olmadan full suite'te geçer
- Dev-army session inflation → tek saat dilimi = tek observation, 3 farklı saat dilimi gerekli graduation için
- `npm run build` başarılı
- Tüm testler geçer
- Kalite gate'leri onaylı (YODA + APEX + ANALYZER)

## What This Plan Does NOT Include
- LLM-based semantic dedup (çok pahalı — keyword Jaccard yeterli)
- Cross-project dedup (Phase 10 scope)
- Fire false positive temizliği (mevcut 20 fire'ı silme — v31 bigram matching bundan sonrakileri düzeltir)
- Dev-army agent type filtering (sadece `main` session saymak — time-window daha genel çözüm)
