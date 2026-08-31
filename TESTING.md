# Test Rehberi

Bu dosya, URL Shortener projesini **adım adım test etmek** ve **mimari kavramları tekrar etmek** için yazılmıştır. Her bölümde ne yaptığınız, ne beklemeniz gerektiği ve neden önemli olduğu açıklanır.

> **Mimari geçiş notu:** Projenin NGINX öncesindeki başlangıç aşamasında Flask doğrudan `http://localhost:5000` üzerinden test ediliyordu. Bu tarihsel adımlar [NGINX mimari rehberinde](docs/nginx-reverse-proxy-and-load-balancing.md) korunur. Aşağıdaki komutlar mevcut/final yapıyı test eder: client trafiği `http://localhost` üzerinden NGINX'e gider ve NGINX üç Flask replica arasında load balancing yapar. Host portu `5000` artık doğrudan erişime kapalıdır.

---

## İçindekiler

1. [Ön koşullar](#1-ön-koşullar)
2. [Cache-Aside testi (tam akış)](#2-cache-aside-testi-tam-akış)
3. [Rate limiting testi](#3-rate-limiting-testi)
4. [Kavramsal özet](#4-kavramsal-özet)
5. [Hızlı komut referansı](#5-hızlı-komut-referansı)
6. [Sorun giderme](#6-sorun-giderme)
7. [k6 mimari deneyleri](#7-k6-mimari-deneyleri)

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
| `nginx` | Up; host portu `80` publish edilmiş |
| `web` | Üç replica Up; yalnızca internal `5000/tcp` |
| `db` | healthy |
| `redis` | healthy |

Servisler hazır değilse birkaç saniye bekleyip tekrar kontrol edin. Bundan sonraki HTTP komutları NGINX'in public ingress'i olan `http://localhost` adresini kullanır.

### Test verisi oluşturun

Aşağıdaki testlerde kısa kod `3` varsayılır. Kendi ortamınızda farklı bir kod kullanıyorsanız komutlardaki `3` değerini değiştirin.

Önce bir URL kısaltın:

```powershell
curl.exe -X POST http://localhost/shorten `
  -H "Content-Type: application/json" `
  -d '{"url":"https://redis.io/docs/latest/"}'
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
curl.exe -I http://localhost/3
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
curl.exe -I http://localhost/3
docker compose logs web --tail 5
```

**Beklenen log:**

```text
CACHE HIT
```

**Ne anlama gelir:** URL Redis'ten okundu; PostgreSQL'e gidilmedi. RAM tabanlı lookup milisaniyeler içinde tamamlanır.

> Canlı log takibi için: `docker compose logs -f web` (durdurmak: `Ctrl+C`). `docker compose logs web` üç replica'nın loglarını birlikte gösterir; isteği işleyen replica satırın container prefix'inden görülebilir.

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
curl.exe -I http://localhost/3
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
curl.exe -I http://localhost/3
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

`/shorten` endpoint'i IP başına **10 istek / 60 saniye** ile sınırlandırılır. Limit Redis'te `rate_limit:{ip}` key'i ile tutulur. NGINX `X-Forwarded-For` header'ını ekler; Flask `ProxyFix(x_for=1)` ile tam olarak bir proxy hop'una güvendiği için `request.remote_addr` özgün client IP'sini temsil eder.

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
            -Uri "http://localhost/shorten" `
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

**Ne anlama gelir:** İlk 10 istek başarılı (`201 Created`). 11. ve 12. istekler `429 Too Many Requests` döner. Mevcut sayaç, son kabul edilen istekten yaklaşık 60 saniye sonra TTL ile silinir.

### Adım 3.2 — Rate limit key'ini incele (isteğe bağlı)

```powershell
docker compose exec redis redis-cli KEYS "rate_limit:*"
```

IP'nize karşılık gelen key'i görebilirsiniz. Sayaç değeri:

```powershell
docker compose exec redis redis-cli GET "rate_limit:172.x.x.x"
```

> Local Docker ortamında görülen adres host/VM ağına ait olabilir. Önemli olan farklı client IP'lerinin farklı `rate_limit:{ip}` key'leri kullanmasıdır.

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



## Cache-Aside vs Write-Through

|                        | Cache-Aside (okuma)| Write-Through              |
|------------------------|---------------------------|----------------------------|
| Ne zaman dolar?        | Cache miss'te lazy        | Her yazmada                |
| Bu projede             | Redirect okuması          | `/shorten` yazması         |
| Redis boşalırsa        | Sistem çalışır, yavaşlar  | Yazma sırasında zaten dolu |

### Sayaç + TTL, Fixed-Window ve Sliding-Window

**Bu projedeki sayaç + TTL yaklaşımı:** Fixed-window fikrinin basitleştirilmiş bir eğitim örneğidir, fakat katı takvim blokları kullanmaz. Kabul edilen her istekte `EXPIRE` tekrar 60 saniyeye ayarlanır. Ayrıca limit kontrolündeki `GET` ile sonraki `INCR` birlikte atomik olmadığı için concurrent istekler nominal limiti aşabilir. Bölüm 7.4 bu davranışı ölçer.

**Fixed-Window** (kavramsal referans): Zaman sabit 60 saniyelik bloklara bölünür. Her blokta sayaç sıfırdan başlar; limit aşılırsa 429 döner, blok bitince sayaç tamamen sıfırlanır. Dezavantajı, pencere sınırlarında burst riski taşımasıdır: örneğin 59. saniyede 10 istek ve yeni pencerede hemen 10 istek daha gönderilebilir; kısa sürede 20 istek geçer.

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
curl.exe -X POST http://localhost/shorten -H "Content-Type: application/json" -d '{"url":"https://redis.io/docs/latest/"}'

# Cache testi
curl.exe -I http://localhost/3
docker compose exec redis redis-cli FLUSHALL
docker compose exec redis redis-cli GET 3          # (nil) beklenir
curl.exe -I http://localhost/3                # CACHE MISS
docker compose logs web --tail 5
docker compose exec redis redis-cli GET 3          # URL dönmeli
curl.exe -I http://localhost/3                # CACHE HIT
docker compose logs web --tail 5

# Rate limit testi (12 istek)
$body = '{"url":"https://www.example.com"}'
1..12 | ForEach-Object { try { $r = Invoke-WebRequest -Uri "http://localhost/shorten" -Method POST -ContentType "application/json" -Body $body; "$_ -> $($r.StatusCode)" } catch { "$_ -> $($_.Exception.Response.StatusCode.value__)" } }
```

---

## 6. Sorun giderme

| Belirti                        |        Olası neden          |             Çözüm                    |
|--------------------------------|-----------------------------|--------------------------------------|
| `connection refused`           | Servisler henüz hazır değil | `docker compose ps`, birkaç sn bekle |
| `localhost:5000` bağlantısı reddediliyor | Beklenen davranış; Flask host'a publish edilmez | `http://localhost` üzerinden NGINX'i kullan |
| `404` redirect'te              | Kod DB'de yok               | Önce `/shorten` ile URL oluştur      |
| CACHE HIT/MISS log yok         | Eski container              | `docker compose up -d --build web`   |
| 429 gelmiyor                   | Rate limit decorator eksik  | `app.py` kontrol et, rebuild         |
| `(nil)` ama redirect çalışıyor | Normal — miss sonrası dolar | Adım 2.5'i tekrarla                  |

---

## 7. k6 mimari deneyleri

Bu deneylerin amacı laptop'un veya Flask development server'ın üretim kapasitesini bulmak değildir. Amaç aynı yerel ortamda tekrarlanabilen karşılaştırmalar yaparak NGINX, üç Flask replica, Redis cache ve PostgreSQL fallback davranışını gözlemlemektir.

### 7.1 k6 kurulumu

Windows Package Manager kullanan PowerShell kullanıcıları:

```powershell
winget install k6 --source winget
k6 version
```

Chocolatey alternatifi:

```powershell
choco install k6
k6 version
```

Güncel kurulum seçenekleri için [Grafana k6 kurulum rehberine](https://grafana.com/docs/k6/latest/set-up/install-k6/) bakın. Yerel kurulum istemiyorsanız repository'deki `k6` Compose servisini kullanabilirsiniz. Bu servis `load-test` profiline aittir; normal `docker compose up` sırasında başlamaz.

Önce uygulama servislerini başlatın:

```powershell
docker compose up -d --build
docker compose ps
```

Host'tan çalışan k6 için varsayılan hedef `http://localhost` adresidir. Compose container içinden `localhost` container'ın kendisini gösterdiği için `BASE_URL=http://nginx` kullanılmalıdır. Repository'deki opt-in Compose servisi bunu hazır olarak ayarlar.

### 7.2 Redirect ve cache-hit deneyi

Script: `load-tests/redirect.js`

Script test başlamadan önce `/shorten` ile bir URL oluşturur, yanıttan `short_code` değerini çıkarır ve `BASE_URL/{short_code}` adresine bir warm-up isteği gönderir. API'nin döndürdüğü `short_url` doğrudan kullanılmaz; bu değer container içinden erişilemeyen `http://localhost/...` içerebilir.

Setup aşamasındaki `POST /shorten` aynı IP bazlı rate limit'e tabidir. Redirect deneyini bir rate-limit deneyinden hemen sonra aynı client IP'siyle çalıştırırsanız setup isteği `429` alabilir. Son kabul edilen istekten sonra limiter state'inin süresinin dolmasını bekleyin veya yalnızca disposable yerel Redis'te aşağıda açıklanan bilinçli reset yöntemini kullanın.

Redirect isteklerinde `redirects: 0` kullanılır. Böylece k6 yalnızca NGINX ve URL shortener'ı ölçer; `Location` header'ındaki harici `example.com` adresini takip edip üçüncü taraf bir servise yük göndermez.

Host üzerinden varsayılan çalıştırma:

```powershell
k6 run .\load-tests\redirect.js
```

Host üzerinden ayarları değiştirme örneği:

```powershell
k6 run -e BASE_URL=http://localhost -e VUS=10 -e DURATION=30s .\load-tests\redirect.js
```

Compose içinden çalıştırma:

```powershell
docker compose run --rm k6 run /scripts/redirect.js
```

Bu deney şunları doğrular:

- Setup sırasında kısa URL oluşturulabilir.
- Warm-up ve yük istekleri `302` döndürür ve doğru `Location` header'ını taşır.
- Ana yük fazı Redis cache-hit yolunu kullanır.
- Cache-hit isteklerinin en az yüzde 99'u check'lerden geçer, beklenmeyen HTTP failure oranı yüzde 1'in altında kalır ve p95 süresi 500 ms'nin altında olur.

500 ms eşiği üretim SLO'su değildir; başlangıç için anlaşılır bir yerel guardrail'dir. Aynı makinede tekrarlanan deneyleri karşılaştırdıktan sonra gerekçeli biçimde değiştirilebilir.

#### Replica dağılımını gözlemleme

NGINX her yanıta `X-Upstream-Addr` ekler. Script warm-up upstream adresini ve her VU'nun ilk yanıttaki upstream adresini loglar:

```text
VU 1 first response used upstream 172.20.0.5:5000
VU 2 first response used upstream 172.20.0.6:5000
```

Birden fazla farklı adres görmek, isteklerin birden fazla Flask replica'ya ulaştığına dair basit kanıttır. Küçük bir örnekte kusursuz eşit dağılım beklenmemelidir; bu log karmaşık bir load-balancer ölçüm sistemi değildir.

### 7.3 Cache hit ve cache miss'i ayırma

`redirect.js` bilinçli olarak bir **cache-hit** deneyidir. Warm-up tamamlandıktan sonra aynı kısa kod tekrar tekrar çağrılır ve Redis yolu ölçülür.

Bir kısa kod için Redis'i temizlemek yalnızca sonraki ilk redirect'i miss yapar:

```text
Redis temizle → ilk GET PostgreSQL fallback → Redis SET → sonraki GET'ler cache hit
```

Bu nedenle test sırasında bir kez `FLUSHALL` çalıştırıp bütün yükü "cache-miss testi" olarak adlandırmak doğru değildir. Kontrollü cache-miss deneyi için önceden oluşturulmuş çok sayıda farklı kısa kodun cache kayıtları temizlenmeli ve her kod yalnızca bir kez çağrılmalıdır. Bu ayrı bir veri hazırlama ve deney akışıdır; mevcut cache-hit benchmark'ıyla karıştırılmaz. Tek fallback akışını doğrulamak için Bölüm 2'deki manuel test kullanılabilir.

### 7.4 Rate-limit deneyi

Script: `load-tests/rate-limit.js`

Rate-limit sonuçları önceki isteklerden etkilenir. Temiz bir yerel deneyden önce son kabul edilen `/shorten` isteğinden sonra en az 60 saniye bekleyin. Yalnızca disposable Compose Redis'i kullanıyorsanız şu komutla bütün cache ve rate-limit verisini temizleyebilirsiniz:

```powershell
docker compose exec redis redis-cli FLUSHALL
```

`FLUSHALL` bütün Redis verisini siler; paylaşılan veya üretim Redis'inde kullanmayın. PostgreSQL kayıtları silinmez.

#### Sıralı mod: nominal davranış

Varsayılan mod tek VU ile 12 isteği sıralı gönderir. Temiz state'te ilk 10 isteğin `201`, sonraki iki isteğin `429` olması beklenir:

```powershell
k6 run .\load-tests\rate-limit.js
```

Compose içinden:

```powershell
docker compose run --rm k6 run /scripts/rate-limit.js
```

`created_responses=10`, `rate_limited_responses=2` ve başarılı threshold'lar nominal davranışı doğrular.

#### Concurrent mod: mevcut race condition'ı gözlemleme

Önce tekrar 60 saniye bekleyin veya disposable Redis'i temizleyin. Ardından:

```powershell
k6 run -e MODE=concurrent .\load-tests\rate-limit.js
```

Compose içinden:

```powershell
docker compose run --rm -e MODE=concurrent k6 run /scripts/rate-limit.js
```

Concurrent mod `per-vu-iterations` executor ile varsayılan olarak 20 VU başlatır ve her VU tam olarak bir istek gönderir. Böylece hızlı bir VU'nun paylaşılan iteration havuzundan birden fazla iş alması engellenir ve deney bilinçli olarak VU başına tek concurrent istek üretir. İşletim sistemi ve k6 scheduler'ı bütün paketlerin aynı nanosaniyede ulaşmasını garanti etmez. Mevcut limiter önce Redis `GET`, sonra ayrı bir pipeline ile `INCR` + `EXPIRE` yaptığı için limit kontrolünün tamamı atomik değildir. Birden fazla istek aynı düşük sayaç değerini görürse 10'dan fazla `201` alınabilir.

- `created_responses` 10 ise bu çalıştırmada overshoot gözlenmedi.
- `created_responses` 10'dan büyükse concurrent istekler nominal limiti aştı.
- `created_responses: count<=10` threshold'unun kırmızı olması bu modda yararlı deney kanıtıdır; script veya uygulama hatasını gizlemek için eşik değiştirilmez.
- `rate_limited_responses` kaç isteğin `429` aldığını gösterir.

Bu milestone rate limiter'ı yeniden tasarlamaz. Ayrıca kabul edilen her istekte `EXPIRE` yeniden ayarlandığı için davranış dokümantasyondaki katı takvim tabanlı fixed-window tanımından farklı olabilir. Amaç mevcut davranışı görünür kılmaktır.

### 7.5 Metrikleri okuma

| Metrik | Bu deneylerde anlamı |
|--------|----------------------|
| `http_req_duration` | HTTP isteğinin toplam süresi. Redirect scriptindeki tagged threshold yalnızca ana cache-hit fazını değerlendirir. |
| `http_req_failed` | k6'nın beklenmeyen saydığı yanıtların oranı. Rate-limit scripti `429` yanıtlarını deneyin beklenen sonucu olarak işaretler. |
| `checks` | Status ve `Location` gibi fonksiyonel kontrollerin başarı oranı. Threshold `rate>0.99` değeridir. |
| `iterations` | Default test fonksiyonunun kaç kez tamamlandığı. Redirect deneyinde yaklaşık olarak yük fazındaki redirect sayısını temsil eder. |
| `http_reqs` | Setup dahil toplam HTTP request sayısı; yanındaki `/s` değeri gözlenen throughput'tur. |
| `p(95)` | İsteklerin yüzde 95'inin bu sürede veya daha hızlı tamamlandığını gösterir; en yavaş yüzde 5 bu değerin üzerindedir. |
| `created_responses` | Rate-limit deneyinde alınan `201` sayısı. Concurrent modda 10'dan büyük olması overshoot kanıtıdır. |
| `rate_limited_responses` | Rate-limit deneyinde alınan `429` sayısı. |

Threshold başarısızlığı sonucu silmez; ölçümün belirlenen öğretici guardrail'i karşılamadığını söyler. Önce container loglarını, Docker kaynak kullanımını ve test state'ini inceleyin.

### 7.6 Ölçüm sınırları

- Flask halen development server ile çalışır; sonuçlar production kapasite iddiası değildir.
- k6 ve servisler aynı bilgisayarda çalışıyorsa CPU, RAM ve Docker Desktop kaynakları için yarışırlar.
- PostgreSQL ve Redis tek ve paylaşılan instance'lardır; eski veri ve rate-limit key'leri sonucu etkileyebilir.
- Başarılı her `POST /shorten` PostgreSQL'e kalıcı bir URL satırı ekler. Redirect setup'ı ve rate-limit deneylerindeki `201` yanıtları test verisi oluşturur; tekrarlanan çalıştırmalar URL ID sequence'ini ilerletir.
- Redis `FLUSHALL` bu PostgreSQL satırlarını veya ID sequence'ini silmez; yalnızca Redis cache ve rate-limit state'ini temizler.
- Her cache hit için yazılan uygulama logu yüksek yükte ek maliyet ve yoğun log çıktısı oluşturur.
- `X-Upstream-Addr` örnekleri birden fazla replica kullanımını gösterir, fakat kusursuz round-robin eşitliğini kanıtlamaz.
- Setup ve warm-up request'leri genel k6 özetine dahil olabilir; cache-hit latency threshold'u `experiment:cache-hit` tag'i ile ana fazı ayrı değerlendirir.

Sonuçları aynı makine, aynı Compose ayarları, aynı VU/duration ve temiz test state'i ile karşılaştırın. Raporlarken komutu, k6 sürümünü ve Docker kaynak ayarlarını kaydedin.

---

## Tamamlanan güncellemeler

NGINX load balancing, horizontal Flask replica doğrulaması ve ayrı k6 cache/rate-limit deneyleri artık bu rehberin mevcut akışına dahildir.
