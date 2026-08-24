# URL Shortener

Flask tabanlı bir URL kısaltma servisi. Uzun URL'leri PostgreSQL'de kalıcı olarak saklar, Base62 ile kısa kod üretir ve redirect isteklerini Redis ile hızlandırır.

## Özellikler

- **POST `/shorten`** — Uzun URL kaydeder, kısa kod döner
- **GET `/<short_code>`** — Kısa koda 302 redirect
- **GET `/health`** — Servis sağlık kontrolü
- Redis cache-aside ile hızlı okuma
- IP bazlı rate limiting (`/shorten` için 10 istek / dakika)

## Hızlı Başlangıç

```powershell
docker compose up -d --build
docker compose ps
```

Servisler hazır olduğunda:
''powerShell-native , kendi shellinize uygun olarak convert edin..

$body = @{
    url = "https://example.com"
} | ConvertTo-Json

Invoke-RestMethod `
    -Uri "http://localhost:5000/shorten" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body

Örnek yanıt:

```json
{
  "short_url": "http://localhost:5000/1",
  "short_code": "1"
}
```

Redirect testi:

```powershell
curl.exe -I http://localhost:5000/1
```

Detaylı test adımları için [app/TESTING.md](app/TESTING.md) dosyasına bakın.

## Proje Yapısı

```text
url-shortener/
├── docker-compose.yml    # web, db, redis servisleri
├── README.md
└── app/
    ├── app.py            # Flask API
    ├── Dockerfile
    ├── init.sql          # PostgreSQL şema
    ├── requirements.txt
    └── TESTING.md        # Manuel test rehberi
```

## Mimari Genel Bakış

```text
Client
  │
  ├─ POST /shorten ──► Flask ──► PostgreSQL (INSERT)
  │                      │
  │                      └──────► Redis (cache.set)
  │
  └─ GET /{code} ──────► Flask ──► Redis (cache.get)
                           │
                           ├─ HIT  ──► 302 Redirect
                           │
                           └─ MISS ──► PostgreSQL (SELECT)
                                        │
                                        └─► Redis'e yaz + 302 Redirect
```

| Katman | Rol | Teknoloji |
|--------|-----|-----------|
| API | HTTP isteklerini işler | Flask |
| Kalıcı depolama | Source of truth | PostgreSQL |
| Hız katmanı | Redirect cache + rate limit sayaçları | Redis |

---

## Architecture Notes

### 1. Docker Compose ve Service Discovery

Docker Compose `web`, `db` ve `redis` servislerini aynı özel Docker ağına bağlar. Bu ağda servis adları aynı zamanda hostname olarak çözülür:

| Servis adı | Bileşen |
|------------|---------|
| `web` | Flask API |
| `db` | PostgreSQL |
| `redis` | Redis |

Flask uygulaması PostgreSQL'e `db`, Redis'e `redis` hostname'i ile bağlanır; IP adresi bilmesine gerek yoktur. Bu, DNS tabanlı service discovery'nin basit bir örneğidir — Kubernetes'te de servisler benzer şekilde birbirini bulur.

`depends_on` + `condition: service_healthy` sayesinde Flask, PostgreSQL ve Redis tamamen hazır olmadan başlamaz. Bu, "connection refused" hatalarını azaltır.

### 2. Neden Base62?

URL shortener için kısa ve URL-safe kodlar gerekir. Base62 şu karakterleri kullanır: `0-9`, `a-z`, `A-Z` (toplam 62 karakter).

PostgreSQL'in `SERIAL` ile ürettiği benzersiz ID, Base62 ile encode edilir:

```text
64 → "12"
```

Her DB ID benzersiz olduğu için çakışma riski yoktur. Kısa kod üretimi için ayrı bir tablo veya uniqueness kontrolü gerekmez; ID zaten primary key'dir.

**Alternatifler ve neden seçilmediği:**

|        Yaklaşım         |                                Dezavantaj                                     |
|-------------------------|-------------------------------------------------------------------------------|
| Rastgele string         | Çakışma kontrolü gerekir                                                      |
| Hash (MD5/SHA)          | Kısaltmak için truncate gerekir; truncation collision yönetimi gerektirebilir |
| Auto-increment + Base62 | Basit, deterministik, çakışmasız ✓                                            |

### 3. Cache-Aside Pattern

Redirect akışında Redis yardımcı bir katmandır; **source of truth PostgreSQL'dir**.

```text
READ akışı:
1. Redis'e bak
2. Varsa → redirect (CACHE HIT)
3. Yoksa → PostgreSQL'den oku (CACHE MISS)
4. Sonucu Redis'e yaz
5. Redirect et
```

Redis bu akışta source of truth değildir; cache kaybı veri kaybına yol açmaz. PostgreSQL üzerinden sistem çalışmaya devam eder; yalnızca ilk istek daha yavaş olur.

**Yazma ve okuma farkı:** `/shorten` sırasında önce PostgreSQL'e yazılır, ardından Redis'e cache kaydı eklenir. Redirect okumasında ise cache-aside kullanılır — miss olduğunda PostgreSQL'den okunup Redis lazy doldurulur. Bu hibrit davranış yaygındır ve ilk redirect'i de hızlandırır; ancak klasik anlamda tam bir write-through cache implementasyonu değildir.

### 4. Neden PostgreSQL + Redis?

| İhtiyaç | Çözüm |
|---------|-------|
| Kalıcılık, ACID, ilişkisel model | PostgreSQL |
| Milisaniye altı okuma, TTL, atomic INCR | Redis |

Her redirect isteğinde PostgreSQL sorgusu yapmak, Redis cache üzerinden servis etmeye göre daha fazla latency ve database yükü oluşturur. Redis RAM'de çalışır ve O(1) key lookup sunar. Rate limit sayaçları da Redis'te tutulur çünkü `INCR` atomiktir ve `EXPIRE` ile TTL destekler.

### 5. Rate Limiting (Fixed-Window)

`/shorten` endpoint'i IP bazlı rate limit ile korunur: **10 istek / 60 saniye**.

```text
Key: rate_limit:{client_ip}
Komutlar: INCR + EXPIRE (Redis pipeline ile birlikte çalıştırılır)
Limit aşılırsa: HTTP 429
```

Bu bir **fixed-window** limiter'dır. Sayaç her 60 saniyede sıfırlanır.

|      Tür       |           Davranış              | Bu projede          |
|----------------|---------------------------------|------------         |
| Fixed-window   | Sabit pencerede sayaç           | ✓ Kullanılıyor      |
| Sliding-window | Son N saniyeyi sürekli hesaplar | Gelecek iyileştirme |
| Token bucket   | Burst'e izin verir | Alternatif |

Redis'in `INCR` işlemi atomiktir ve eşzamanlı sayaç artışlarında veri kaybını önler. TTL ile sayaç otomatik silinir; ayrı temizleme job'u gerekmez. Mevcut fixed-window implementasyonu eğitim amaçlı basit tutulmuştur: önce `GET` ile sayaç kontrol edilir, ardından `INCR` yapılır — bu iki adım birlikte atomik değildir ve çok eşzamanlı isteklerde limit teorik olarak birkaç istek aşılabilir.

**Mevcut sınırlama:** Rate limiter `request.remote_addr`değerini kullanır.Docker networking veya reverse proxy arkasında bu değer gerçek client IP yerine proxy/gateway adresi olabilir.(NGINX) eklendiğinde `X-Forwarded-For` header'ı okunmalıdır — bu, planlanan NGINX katmanında ele alınacak.

### 6. Veri Akışı Özeti

**Yazma (`POST /shorten`):**

```text
JSON body → PostgreSQL INSERT → RETURNING id
           → Base62 encode
           → Redis SET
           → 201 + short_url
```

**Okuma (`GET /<code>`):**

```text
Redis GET → HIT  → 302
          → MISS → PostgreSQL SELECT by id
                 → Redis SET
                 → 302
```

### 7. Tek Instance Sınırları (Mevcut Durum)

Şu anki mimari bilinçli olarak basit tutulmuştur:

- Tek Flask container (`web`) — horizontal scaling yok
- Tek Redis instance — cluster/replication yok
- Tek PostgreSQL instance — read replica yok
- Load balancer yok — tüm trafik doğrudan `:5000`'e gider

Bu sınırlar öğrenme ve demo için uygundur. Production'da bu katmanların ölçeklendirilmesi gerekir.

---

## Yol Haritası

Aşağıdaki geliştirmeler planlanmaktadır. Mevcut dokümantasyon ve testler **tek instance** mimarisine göre yazılmıştır; bu özellikler eklendikçe güncellenecektir.

| # | Özellik | Beklenen etki |
|---|---------|---------------|
| 1 | **NGINX load balancing** | Trafik dağıtımı, reverse proxy, `X-Forwarded-For` ile gerçek IP |
| 2 | **Horizontal Flask replicas** | Birden fazla `web` instance, stateless API ölçeklendirme |
| 3 | **k6 load testing** | Throughput, latency ve rate limit davranışının ölçülmesi |

NGINX eklendiğinde client `:80` veya `:8080` üzerinden erişecek; Flask replicaları doğrudan dışarıya açılmayacak. Rate limit ve cache testleri bu mimariye göre revize edilecek.

---

## API Referansı

### `POST /shorten`

```json
// Request
{ "url": "https://example.com" }

// Response 201
{ "short_url": "http://localhost:5000/1", "short_code": "1" }

// Response 400 — url alanı eksik
// Response 429 — rate limit aşıldı
```

### `GET /<short_code>`

```text
302 Found
Location: https://example.com

404 — kod bulunamadı
```

### `GET /health`

```json
{ "status": "healthy" }
```

## Bağımlılıklar

| Paket | Amaç |
|-------|------|
| Flask 3.1 | HTTP API |
| redis 5.3 | Redis istemcisi |
| psycopg2-binary 2.9 | PostgreSQL istemcisi |
