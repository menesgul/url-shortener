# NGINX Reverse Proxy and Load Balancing

## 1. Goal

URL Shortener başlangıçta bütün HTTP trafiğini doğrudan tek Flask container'ında karşılıyordu:

```text
Client -> Flask :5000 -> PostgreSQL / Redis
```

Bu çalışmada mimari iki küçük milestone ile geliştirildi:

1. Flask'ın önüne reverse proxy olarak NGINX yerleştirildi.
2. Flask service'i horizontal scaling ile üç replica olarak çalıştırıldı ve NGINX bu replica'lar arasında load balancing yapacak şekilde yapılandırıldı.

Bu doküman bu iki mimari milestone'u ve final Flask proxy entegrasyonunu kapsar. k6 ile load testing henüz yapılmadı.

---

## 2. Starting Architecture

Başlangıçtaki `docker-compose.yml` üç service tanımlıyordu:

- Tek Flask `web` service'i
- PostgreSQL `db` service'i
- Redis `redis` service'i

Flask portu aşağıdaki `ports` tanımıyla doğrudan host'a publish ediliyordu:

```yaml
web:
  build: ./app
  ports:
    - "5000:5000"
```

Başlangıç mimarisi:

```text
Client
  |
  | http://localhost:5000
  v
Flask web :5000
  |             |
  v             v
PostgreSQL     Redis
```

Host portu 5000 doğrudan Flask container portu 5000'e bağlı olduğu için client ile Flask arasında reverse proxy veya load balancer yoktu. Bütün request'ler aynı Flask instance'ına gidiyordu.

---

## 3. Milestone 1 — Adding NGINX as a Reverse Proxy

İlk milestone'da yalnızca trafiğin giriş noktası değiştirildi. Flask hâlâ tek instance olarak çalıştı:

```text
Before: Client -> Flask :5000
After:  Client -> NGINX :80 -> Flask :5000
```

NGINX host'a açık public entry point oldu. Flask ise yalnızca Compose internal network içinde erişilebilir kaldı.



### NGINX configuration

Milestone 1 sırasında kullanılan reverse-proxy `server` bloğu şu yapıdaydı:

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://web:5000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Bu direktiflerin projedeki görevleri:

- `server`: Port ve route kurallarını aynı virtual server altında toplar.
- `listen 80`: NGINX'in container içinde HTTP request'lerini port 80'de dinlemesini sağlar.
- `server_name _`: Bu projede özel bir domain kullanılmadığı için gelen host adlarını karşılayan yer tutucudur. Tek `server` bloğu olduğu için request'ler bu bloğa gelir.
- `location /`: `/health`, `/shorten` ve `/<short_code>` dahil bütün application route'larını kapsar.
- `proxy_pass http://web:5000`: Request'i Compose network içindeki Flask `web` service'ine aktarır.
- `proxy_http_version 1.1`: NGINX ile upstream arasındaki bağlantıda HTTP/1.1 kullanır.
- `Host`: Client'ın gönderdiği host bilgisini upstream'e taşır.
- `X-Real-IP`: NGINX'in gördüğü client IP bilgisini upstream'e iletir.
- `X-Forwarded-For`: Request'in geçtiği proxy zincirine client IP bilgisini ekler.
- `X-Forwarded-Proto`: Client'ın NGINX'e `http` veya `https` ile ulaştığını upstream'e bildirir.

Bu header'ların gönderilmesi Flask'ın otomatik olarak onlara güvenmesi anlamına gelmez. Milestone 1'in ilk proxy-only doğrulamasında `ProxyFix` henüz eklenmemişti; final uygulamada tek NGINX hop'una güvenen yapılandırma Bölüm 9'da açıklanır.

### Docker Composedaki Değişiklik

NGINX service'i aşağıdaki temel ayarlarla eklendi:

```yaml
nginx:
  image: nginx:alpine
  ports:
    - "80:80"
  volumes:
    - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro
  depends_on:
    - web
```

- `80:80`, host portu 80'i NGINX container portu 80'e publish ediyor. Client artık `http://localhost/...` üzerinden NGINX'e ulaşır.
- Bind mount, repository içindeki config dosyasını NGINX'in default server config konumuna bağlar.
- `:ro`, mount'u read-only yapar. Container çalışan config dosyasını okuyabilir fakat repository'deki dosyayı değiştiremez.
- `depends_on`, NGINX ile `web` arasındaki başlangıç sırasını ifade eder; tek başına application readiness garantisi değildir.

Flask tarafındaki host port eşlemesi kaldırıldı:

```yaml
web:
  build: ./app
  expose:
    - "5000"
```

`ports` ve `expose` arasındaki önemli fark:

|    Tanım         |              Bu projedeki etkisi          |
|------------------|-------------------------------------------|
| `ports: "80:80"` | NGINX portunu host üzerinden erişilebilir yapar.                                                         |
| `expose: "5000"` | Flask'ın internal portunu dokümante eder; host'a port publish etmez.                                     |

Compose aynı network içindeki service'ler için service-name DNS sağlar. Bu nedenle NGINX sabit bir container IP'si bilmeden `web:5000` adresini kullanabilir. Container IP'leri değişebilir, `web` service adı ise mimari içindeki kararlı isimdir.

---

## 4. Validating the Reverse Proxy

Milestone 1 aşağıdaki sırayla doğrulandı.

### 4.1 Compose modelini doğrulama

```powershell
docker compose config --quiet
```

Bu komut Compose dosyasının parse edilebildiğini ve modelin geçerli olduğunu kontrol etti. Exit code `0`, config validation'ın başarılı olduğunu gösterdi.

Rendered modeli görmek için ayrıca şu komut çalıştırıldı:

```powershell
docker compose config
```

Çıktıda NGINX için host portu `80`, Flask için yalnızca `expose: 5000` görüldü.

### 4.2 Stack'i build edip başlatma

```powershell
docker compose up -d --build
```

Bu komut Flask image'ını build etti, NGINX image'ını çekti ve dört service'i başlattı. PostgreSQL ve Redis healthcheck'leri `healthy` olduktan sonra Flask başlatıldı.

### 4.3 Port durumunu kontrol etme

```powershell
docker compose ps
```

Gözlenen önemli portlar:

```text
nginx   0.0.0.0:80->80/tcp
web     5000/tcp
db      5432/tcp
redis   6379/tcp
```

Yalnızca NGINX satırında host port publish edildi. `web` satırındaki `5000/tcp`, portun container/internal network tarafında olduğunu gösterdi.

### 4.4 NGINX config validation

```powershell
docker compose exec nginx nginx -t
```

Bu komut çalışan NGINX container'ı içinde config syntax'ını test etti. Gözlenen sonuç:

```text
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

### 4.5 Public health request

```powershell
curl.exe -sS -i --max-time 10 http://localhost/health
```

Gözlenen response:

```text
HTTP/1.1 200 OK
Server: nginx/1.31.4
Content-Type: application/json

{"status":"healthy"}
```

Bu sonuç client'ın NGINX'e ulaştığını ve NGINX'in `/health` request'ini Flask'a başarıyla proxy ettiğini gösterdi.

### 4.6 Flask host portunun kapalı olduğunu doğrulama

```powershell
curl.exe -sS -i --max-time 3 http://localhost:5000/health
```

Gözlenen sonuç:

```text
curl: (7) Failed to connect to localhost port 5000: Could not connect to server
```

`http://localhost/health` çalışırken `http://localhost:5000/health` bağlantısının başarısız olması, Flask'ın artık doğrudan host'a publish edilmediğini kanıtladı.

### 4.7 `/shorten` ve redirect akışını doğrulama

Kısa URL oluşturup dönen kodu NGINX üzerinden çağırmak için şu PowerShell komutu çalıştırıldı:

```powershell
$created = Invoke-RestMethod `
  -Uri 'http://localhost/shorten' `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"url":"https://example.com"}'

$created | ConvertTo-Json -Compress
curl.exe -sS -D - -o NUL --max-time 10 "http://localhost/$($created.short_code)"
```

Gözlenen sonuçta `short_code` değeri `1` oldu ve NGINX üzerinden `GET /1` request'i şu redirect'i döndürdü:

```text
HTTP/1.1 302 FOUND
Server: nginx/1.31.4
Location: https://example.com
```

Final proxy entegrasyonundan sonra aynı test yeniden çalıştırıldığında Flask response içindeki `short_url` alanı `http://localhost/1` olarak üretildi. Bu URL NGINX'in public ingress'i üzerinden erişilebilir.

Milestone 1 sonunda mimari:

```text
Client :80
    |
    v
NGINX
    | internal network
    v
Flask web :5000
    |             |
    v             v
PostgreSQL     Redis
```

---

## 5. Milestone 2 — Horizontal Flask Scaling

İkinci milestone'da Flask kapasitesi horizontal scaling ile artırıldı.

- Vertical scaling: Tek Flask instance'ına daha fazla CPU veya memory vermektir.
- Horizontal scaling: Aynı application image'ından birden fazla Flask instance'ı çalıştırmaktır.

Bu repository'de `web1`, `web2` ve `web3` adında üç kopya service tanımı oluşturulmadı. Tek `web` service tanımı korundu ve replica sayısı üç olarak belirtildi:

```yaml
web:
  build: ./app
  expose:
    - "5000"
  deploy:
    replicas: 3
```

Her replica aynı environment değerlerini kullanır:

```text
POSTGRES_HOST=db
REDIS_HOST=redis
```

Bu nedenle bütün Flask container'ları aynı PostgreSQL database'i ve Redis cache'i paylaşır. URL kayıtları local container filesystem'inde tutulmadığı için request'in hangi replica'ya gittiği kalıcı veri açısından fark yaratmaz. Mevcut tasarımda kullanıcı session'ı gibi replica-local state bulunmadığından sticky session gerekli değildir.

Bu açıklama PostgreSQL veya Redis'in de ölçeklendirildiği anlamına gelmez; ikisi de tek service olarak çalışmaya devam eder.

---

## 6. Turning NGINX into a Load Balancer

Milestone 2 sonrasında kullanılan mevcut upstream yapılandırması:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;

upstream flask_backend {
    zone flask_backend 64k;
    server web:5000 resolve;
}

server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://flask_backend;
        add_header X-Upstream-Addr $upstream_addr always;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Bu yapılandırmada:

- `resolver 127.0.0.11`, Docker'ın container içindeki internal DNS resolver adresini kullanır.
- `valid=10s`, DNS sonucunun tekrar çözülmeden önce geçerli tutulacağı süreyi belirtir.
- `upstream flask_backend`, Flask backend pool'unu tanımlar.
- `zone flask_backend 64k`, runtime DNS ile oluşan upstream state'inin NGINX worker process'leri arasında paylaşılmasını sağlar.
- `server web:5000 resolve`, `web` service adını çalışma sırasında replica IP'lerine çözer.
- `proxy_pass http://flask_backend`, application request'lerini bu backend pool'a gönderir.

Container IP adresleri geçicidir; recreate veya scale işlemleri sırasında değişebilir. Bu nedenle NGINX config içine `172.x.x.x` biçiminde IP yazılmadı. Kararlı Compose service adı ve Docker DNS kullanıldı.

`least_conn`, `ip_hash` veya başka bir algoritma belirtilmedi. NGINX bu durumda varsayılan round-robin davranışını kullanır:

```text
Request 1 -> Flask replica A
Request 2 -> Flask replica B
Request 3 -> Flask replica C
Request 4 -> Flask replica A
```

---

## 7. Starting Three Flask Replicas

Üç replica ile stack'i başlatmak için çalıştırılan komut:

```powershell
docker compose up -d --build --scale web=3
```

`--scale web=3`, Compose'a `web` service tanımından üç container çalıştırmasını söyler. Gözlenen container'lar:

```text
nginx-reverse-proxy-inspection-web-1
nginx-reverse-proxy-inspection-web-2
nginx-reverse-proxy-inspection-web-3
```

Bunlar kısaca `web-1`, `web-2` ve `web-3` olarak düşünülebilir. Container IP'leri kalıcı değildir ve config içinde kimlik olarak kullanılmamalıdır.

Compose işleminde NGINX container'ı zaten `Running` durumunda kaldı. Bind-mounted dosya değişmiş olsa da çalışan NGINX master process yeni config'i kendiliğinden uygulamadı. Bu nedenle şu komut çalıştırıldı:

```powershell
docker compose exec nginx nginx -s reload
```

İki NGINX komutunun görevleri farklıdır:

| Command | Görev |
|---|---|
| `nginx -t` | Config dosyasını parse eder ve syntax/geçerlilik kontrolü yapar; çalışan process'e yeni config'i uygulamaz. |
| `nginx -s reload` | Çalışan NGINX master process'e config'i yeniden yükleme sinyali gönderir. |

Önce `nginx -t` ile config doğrulandı, ardından reload yapıldı. Reload çıktısındaki `signal process started` mesajı reload sinyalinin gönderildiğini gösterdi.

---

## 8. Proving Round-Robin Load Balancing

Üç container'ın `Up` durumda görünmesi yalnızca horizontal scaling'in gerçekleştiğini gösterir. NGINX'in request'leri gerçekten dağıttığını tek başına kanıtlamaz.

Bu nedenle NGINX seviyesinde geçici bir observability header'ı eklendi:

```nginx
add_header X-Upstream-Addr $upstream_addr always;
```

`$upstream_addr`, request'i işleyen upstream'in `IP:port` değeridir. Flask route'u veya response body değiştirilmeden seçim gözlemlenebilir.

Test için çalıştırılan komut:

```powershell
1..12 | ForEach-Object {
    $header = curl.exe -sS -D - -o NUL --max-time 10 `
      http://localhost/health |
      Select-String -Pattern '^X-Upstream-Addr:'

    "Request $_ -> $($header.Line.Trim())"
}
```

İlk altı request'te gözlenen sıra:

```text
Request 1 -> X-Upstream-Addr: 172.20.0.6:5000
Request 2 -> X-Upstream-Addr: 172.20.0.4:5000
Request 3 -> X-Upstream-Addr: 172.20.0.7:5000
Request 4 -> X-Upstream-Addr: 172.20.0.6:5000
Request 5 -> X-Upstream-Addr: 172.20.0.4:5000
Request 6 -> X-Upstream-Addr: 172.20.0.7:5000
```

Aynı üç adreslik sıra 12 request boyunca dört kez tekrarlandı. Container/IP eşleşmesi test anında şöyleydi:

```text
web-1 -> 172.20.0.6
web-2 -> 172.20.0.4
web-3 -> 172.20.0.7
```

Bu düzenli `A -> B -> C -> A` sırası, request'lerin üç upstream arasında round-robin ile dağıtıldığını gösterdi.

`X-Upstream-Addr` learning ve debugging için yararlıdır ancak internal network adresini client'a açıklar. Production ortamında genellikle kaldırılmalı veya yalnızca internal debugging erişimine sınırlandırılmalıdır.

---

## 9. Final Architecture

```text
                         Internet / Client
                                 |
                               :80
                                 |
                              NGINX
                       reverse proxy +
                        load balancer
                      /       |       \
                     /        |        \
                 web-1      web-2      web-3
                  :5000      :5000      :5000
                     \        |        /
                      \       |       /
                       PostgreSQL + Redis
```

Host-public bileşen:

- `nginx`: Host portu `80` üzerinden erişilebilir.

Internal-only bileşenler:

- Üç `web` replica: Yalnızca Compose network içinde port `5000`.
- `db`: Yalnızca Compose network içinde port `5432`.
- `redis`: Yalnızca Compose network içinde port `6379`.

Client, Flask replica'larına veya data service'lerine doğrudan bağlanmaz. Bütün HTTP application trafiği NGINX üzerinden geçer.

### Final Flask proxy integration

Final uygulama NGINX'in ilettiği gerçek client IP'sini güvenli sınırla kullanır:

```python
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)
```

Yalnızca `X-Forwarded-For` için tam bir proxy hop'una güvenilir. NGINX zincirin en sağına gördüğü client adresini eklediği için `request.remote_addr` özgün client IP'sini, Redis rate limiter da client başına ayrı key'i kullanır. Uygulama `X-Forwarded-For` header'ını manuel olarak parse etmez.

Public short URL origin'i de environment ile yapılandırılır:

```yaml
environment:
  - PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost}
```

`/shorten`, varsayılan local Compose setup'ında `http://localhost/<code>` döndürür. Farklı bir public origin gerektiğinde `PUBLIC_BASE_URL` değiştirilebilir; public URL içinde NGINX container veya service adı kullanılmaz.

---

## 10. Commands Used — In Order

1. Milestone 1 Compose modelini sessiz config validation ile kontrol etmek.

   ```powershell
   docker compose config --quiet
   ```

2. Rendered Compose modelinde NGINX `ports` ve Flask `expose` sonucunu görmek.

   ```powershell
   docker compose config
   ```

3. Tek Flask instance'lı reverse-proxy stack'ini build edip başlatmak.

   ```powershell
   docker compose up -d --build
   ```

4. Yalnızca NGINX'in host port publish ettiğini ve data service healthcheck durumlarını görmek.

   ```powershell
   docker compose ps
   ```

5. NGINX config syntax'ını container içinde doğrulamak.

   ```powershell
   docker compose exec nginx nginx -t
   ```

6. `/health` route'unun NGINX üzerinden `200 OK` döndüğünü kanıtlamak.

   ```powershell
   curl.exe -sS -i --max-time 10 http://localhost/health
   ```

7. Flask'ın artık host portu 5000 üzerinden erişilemediğini doğrulamak.

   ```powershell
   curl.exe -sS -i --max-time 3 http://localhost:5000/health
   ```

8. NGINX üzerinden URL oluşturma route'unu doğrulamak.

   ```powershell
   Invoke-RestMethod -Uri 'http://localhost/shorten' ...
   ```

9. Oluşturulan kodun NGINX üzerinden `302` redirect verdiğini doğrulamak.

   ```powershell
   curl.exe -sS -D - -o NUL "http://localhost/$($created.short_code)"
   ```

10. Üç replica ve upstream değişikliklerinden sonra Compose modelini tekrar doğrulamak.

    ```powershell
    docker compose config --quiet
    ```

11. Yeni resolver/upstream config'ini uygulamadan önce doğrulamak.

    ```powershell
    docker compose exec nginx nginx -t
    ```

12. Aynı `web` service tanımından üç Flask container çalıştırmak.

    ```powershell
    docker compose up -d --build --scale web=3
    ```

13. Çalışan NGINX process'e yeni load-balancer config'ini yükletmek.

    ```powershell
    docker compose exec nginx nginx -s reload
    ```

14. `web-1`, `web-2` ve `web-3` container'larının çalıştığını doğrulamak.

    ```powershell
    docker compose ps
    ```

15. `X-Upstream-Addr` header'ını 12 request boyunca gözlemleyerek round-robin dağılımını kanıtlamak.

    ```powershell
    1..12 | ForEach-Object { ... curl.exe ... }
    ```

16. Gözlenen upstream IP'lerini test anındaki Flask container adlarıyla eşleştirmek.

    ```powershell
    docker inspect --format ...
    ```

17. Değişikliklerde whitespace hatası olmadığını kontrol etmek.

    ```powershell
    git diff --check
    ```

---

## 11. Deferred Improvements

Bu çalışma production-ready bir NGINX/Flask deployment oluşturmayı amaçlamadı. Aşağıdaki konular bilinçli olarak ertelendi:

- k6 load testing
- Flask development server yerine Gunicorn veya başka bir production WSGI server
- PostgreSQL ve Redis bağlantılarını da kontrol eden daha güçlü health/readiness checks
- TLS/HTTPS termination
- Production öncesinde debugging amaçlı `X-Upstream-Addr` header'ının kaldırılması

Bu maddeler çözülene kadar yapı öğrenme ve local development amacıyla değerlendirilmelidir; production deployment olarak kabul edilmemelidir.
