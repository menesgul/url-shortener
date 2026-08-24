# Test Rehberi

Bu dosya, URL Shortener projesini **adım adım test etmek** ve **mimari kavramları tekrar etmek** için yazılmıştır. Her bölümde ne yaptığınız, ne beklemeniz gerektiği ve neden önemli olduğu açıklanır.

> **Not:** Bu rehber mevcut **tek Flask instance** mimarisine göredir. NGINX load balancing, horizontal Flask replicaları ve k6 load testleri eklendiğinde ilgili bölümler güncellenecektir.

---

## İçindekiler

1. [Ön koşullar](#1-ön-koşullar)
2. [Cache-Aside testi (tam akış)](#2-cache-aside-testi-tam-akış)
3. [Rate limiting testi](#3-rate-limiting-testi)
4. [Kavramsal özet](#4-kavramsal-özet)
5. [Hızlı komut referansı](#5-hızlı-komut-referansı)
6. [Sorun giderme](#6-sorun-giderme)

---

## 1. Ön koşullar

### Servisleri başlatın

```powershell
docker compose up -d --build
```

### Çalıştığını doğrulayın

```powershell
docker compose ps
```

| Servis | Beklenen durum |
|--------|----------------|
| `web` | Up |
| `db` | healthy |
| `redis` | healthy |

Servisler hazır değilse birkaç saniye bekleyip tekrar kontrol edin.

### Test verisi oluşturun

Aşağıdaki testlerde kısa kod `3` varsayılır. Kendi ortamınızda farklı bir kod kullanıyorsanız komutlardaki `3` değerini değiştirin.

Önce bir URL kısaltın:

```powershell
curl.exe -X POST http://localhost:5000/shorten `
  -H "Content-Type: application/json" `
  -d "{\"url\":\"https://redis.io/docs/latest/\"}"
```

Yanıttaki `short_code` değerini not alın. Örnek: `"short_code": "3"`.

### Redirect akışını anlayın

```text
GET /{short_code}
      ↓
  Redis'te var mı?
    /         \
  Evet        Hayır
   ↓            ↓
CACHE HIT   CACHE MISS
   ↓            ↓
302         PostgreSQL → Redis'e yaz → 302
```

Bu **Cache-Aside Pattern**'dır. PostgreSQL source of truth'tur; Redis hızlandırma katmanıdır.

---

## 2. Cache-Aside testi (tam akış)

Bu test Redis'in gerçekten devreye girdiğini, boşaldığında PostgreSQL fallback yaptığını ve sonrasında cache'in yeniden dolduğunu doğrular.

Her adımda **Komut → Beklenen sonuç → Ne anlama gelir** formatı kullanılır.

---

### Adım 2.1 — Redirect çalışıyor mu?

**Komut:**

```powershell
curl.exe -I http://localhost:5000/3
```

**Beklenen sonuç:**

```text
HTTP/1.1 302 FOUND
Location: https://redis.io/docs/latest/
```

**Ne anlama gelir:** Kısa kod doğru URL'ye yönlendiriyor. `302` geçici redirect'tir; tarayıcı `Location` header'ındaki adrese gider.

---

### Adım 2.2 — Cache HIT logunu gör

**Komut:**

```powershell
curl.exe -I http://localhost:5000/3
docker compose logs web --tail 5
```

**Beklenen log:**

```text
CACHE HIT
```

**Ne anlama gelir:** URL Redis'ten okundu; PostgreSQL'e gidilmedi. RAM tabanlı lookup milisaniyeler içinde tamamlanır.

> Canlı log takibi için: `docker compose logs -f web` (durdurmak: `Ctrl+C`)

---

### Adım 2.3 — Redis'i bilerek temizle

**Komut:**

```powershell
docker compose exec redis redis-cli FLUSHALL
```

**Beklenen sonuç:** `OK`

**Ne anlama gelir:** Redis'teki tüm key-value kayıtları silindi. **PostgreSQL etkilenmez** — kalıcı veri orada durur.

Doğrulama:

```powershell
docker compose exec redis redis-cli GET 3
```

Beklenen: `(nil)` — key artık yok.

---

### Adım 2.4 — CACHE MISS'i tetikle

**Komut:**

```powershell
curl.exe -I http://localhost:5000/3
docker compose logs web --tail 5
```

**Beklenen log:**

```text
CACHE MISS - querying database
```

**Ne anlama gelir:** Redis'te bulunamadı → uygulama Base62 decode ile `"3"` → DB ID `3` yapar → PostgreSQL'den `SELECT long_url FROM urls WHERE id = 3` querysi çalıştırır.

---

### Adım 2.5 — Cache'in yeniden dolduğunu doğrula

**Komut:**

```powershell
docker compose exec redis redis-cli GET 3
```

**Beklenen sonuç:**

```text
https://redis.io/docs/latest/
```

**Ne anlama gelir:** Cache miss sonrası uygulama sonucu Redis'e yazdı (`cache.set`). Sonraki istekler tekrar HIT olacak.

---

### Adım 2.6 — İkinci istek CACHE HIT olmalı

**Komut:**

```powershell 
curl.exe -I http://localhost:5000/3
docker compose logs web --tail 5
```

**Beklenen log:** `CACHE HIT`

**Tam akış özeti:**

```text
FLUSHALL → Redis boş
    ↓
1. GET /3 → CACHE MISS → PostgreSQL → Redis'e yaz
    ↓
2. GET /3 → CACHE HIT → direkt redirect
```

✅ Bu akış Cache-Aside mimarisinin doğru çalıştığını kanıtlar.

---

## 3. Rate limiting testi

`/shorten` endpoint'i IP başına **10 istek / 60 saniye** ile sınırlandırılır. Limit Redis'te `rate_limit:{ip}` key'i ile tutulur.

### Neden Redis?

- `INCR` atomiktir — eşzamanlı isteklerde sayaç güvenle artar
- `EXPIRE` ile TTL — 60 saniye sonra sayaç otomatik silinir, ayrı cleanup gerekmez

### Adım 3.1 — Limiti aş

PowerShell'de aşağıdaki script'i çalıştırın (12 istek gönderir):

```powershell
$body = '{"url":"https://www.example.com"}'

1..12 | ForEach-Object {
    try {
        $r = Invoke-WebRequest `
            -Uri "http://localhost:5000/shorten" `
            -Method POST `
            -ContentType "application/json" `
            -Body $body

        "$_ -> $($r.StatusCode)"
    }
    catch {
        "$_ -> $($_.Exception.Response.StatusCode.value__)"
    }
}
```

**Beklenen sonuç:**

```text
1 -> 201
2 -> 201
...
10 -> 201
11 -> 429
12 -> 429
```

**Ne anlama gelir:** İlk 10 istek başarılı (`201 Created`). 11. ve 12. istekler `429 Too Many Requests` döner. Fixed-window limiter: sayaç 60 saniye sonra sıfırlanır.

### Adım 3.2 — Rate limit key'ini incele (isteğe bağlı)

```powershell
docker compose exec redis redis-cli KEYS "rate_limit:*"
```

IP'nize karşılık gelen key'i görebilirsiniz. Sayaç değeri:

```powershell
docker compose exec redis redis-cli GET "rate_limit:172.x.x.x"
```

> Container ağı içinde IP Docker bridge adresi olabilir; bu normaldir.

### 429 almıyorsanız

1. `app/app.py` kaydedildi mi kontrol edin
2. Decorator sırası doğru olmalı:

```python
@app.route("/shorten", methods=["POST"])
@rate_limit(max_requests=10, window=60)
def shorten_url():
```

3. Container'ı yeniden başlatın:

```powershell
docker compose up -d --build web
```

4. Logları kontrol edin:

```powershell
docker compose logs web --tail 20
```

---

## 4. Kavramsal özet

Bu bölüm testleri bitirdikten sonra tekrar okumak içindir.

### Cache-Aside vs Write-Through

|------------------------|    Cache-Aside (okuma)   | Write-Through              |
|------------------------|-------------------------------------------------------|
| Ne zaman dolar?        | Cache miss'te lazy       | Her yazmada                |
| Bu projede             | Redirect okuması         | `/shorten` yazması         |
| Redis boşalırsa        | Sistem çalışır, yavaşlar | Yazma sırasında zaten dolu |

### Fixed-Window vs Sliding-Window

**Fixed-Window** (bu projede kullanılan): Zaman sabit 60 saniyelik bloklara bölünür. Her blokta sayaç sıfırdan başlar; limit aşılırsa 429 döner, blok bitince sayaç tamamen sıfırlanır. Uygulaması basittir — Redis'te `INCR` + `EXPIRE` yeterlidir. Dezavantajı, pencere sınırlarında burst riski taşımasıdır: örneğin 59. saniyede 10 istek ve yeni pencerede hemen 10 istek daha gönderilebilir; kısa sürede 20 istek geçer.

**Sliding-Window** (gelecek iyileştirme): Sabit blok yerine sürekli olarak son 60 saniyeyi hesaba katar. Her istekte "son 60 sn içinde kaç istek yapıldı?" sorusu yanıtlanır; dağılım daha düzgündür ve pencere sınırındaki burst sorunu azalır. Uygulaması fixed-window'a göre daha karmaşıktır — genelde sorted set veya birden fazla Redis key ile yapılır.


### Redis key yapısı

Redis liste veya sıra değildir; düz key-value store'dur:

```text
"3"                    → https://redis.io/docs/latest/
"rate_limit:172.18.0.1" → 10
```

Key olarak **short code** kullanılır, sıra numarası değil. `FLUSHALL` sonrası `/3`'e istek atılınca key yine `"3"` olur.

### Source of truth

```text
PostgreSQL = kalıcı, güvenilir, yavaş (disk)
Redis      = geçici, hızlı, yardımcı (RAM)
```

Redis tamamen silinse bile PostgreSQL'deki veriler korunur.

---

## 5. Hızlı komut referansı

Tüm testleri sırayla kopyala-yapıştır:

```powershell
# Başlat
docker compose up -d --build
docker compose ps

# URL oluştur
curl.exe -X POST http://localhost:5000/shorten -H "Content-Type: application/json" -d "{\"url\":\"https://redis.io/docs/latest/\"}"

# Cache testi
curl.exe -I http://localhost:5000/3
docker compose exec redis redis-cli FLUSHALL
docker compose exec redis redis-cli GET 3          # (nil) beklenir
curl.exe -I http://localhost:5000/3                # CACHE MISS
docker compose logs web --tail 5
docker compose exec redis redis-cli GET 3          # URL dönmeli
curl.exe -I http://localhost:5000/3                # CACHE HIT
docker compose logs web --tail 5

# Rate limit testi (12 istek)
$body = '{"url":"https://www.example.com"}'
1..12 | ForEach-Object { try { $r = Invoke-WebRequest -Uri "http://localhost:5000/shorten" -Method POST -ContentType "application/json" -Body $body; "$_ -> $($r.StatusCode)" } catch { "$_ -> $($_.Exception.Response.StatusCode.value__)" } }
```

---

## 6. Sorun giderme

| Belirti                        |        Olası neden          |             Çözüm                    |
|--------------------------------|-----------------------------|--------------------------------------|
| `connection refused`           | Servisler henüz hazır değil | `docker compose ps`, birkaç sn bekle |
| `404` redirect'te              | Kod DB'de yok               | Önce `/shorten` ile URL oluştur      |
| CACHE HIT/MISS log yok         | Eski container              | `docker compose up -d --build web`   |
| 429 gelmiyor                   | Rate limit decorator eksik  | `app.py` kontrol et, rebuild         |
| `(nil)` ama redirect çalışıyor | Normal — miss sonrası dolar | Adım 2.5'i tekrarla                  |

---

## Gelecek güncellemeler

Aşağıdaki özellikler eklendiğinde bu rehber genişletilecek:

| Özellik | Test değişiklikleri |
|---------|---------------------|
| NGINX load balancing | Port `:80`, `X-Forwarded-For`, upstream dağılımı |
| Horizontal Flask replicas | Hangi replica'nın log verdiği, sticky session gerekmez |
| k6 load testing | Script'ler, throughput/latency metrikleri, rate limit eşiği |
