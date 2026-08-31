# k6 Yük Testi Kilometre Taşı

## Amaç

k6, URL kısaltıcının mimarisini tekrarlanabilir bir deneye dönüştürmek için eklendi. Amaç, yönlendirme throughput ve latency değerlerini gözlemlemek, NGINX'in trafiği tüm Flask replikalarına gönderdiğini doğrulamak ve Redis destekli rate limiter'ın sıralı ve eşzamanlı isteklerde farklı davranıp davranmadığını test etmekti.

Bu ölçümler, üretim kapasitesine ilişkin bir iddia değil, tanılama amaçlıdır. Komutlar ve yürütme adımları [TESTING.md](../TESTING.md#7-k6-mimari-deneyleri) dosyasında yer almaya devam etmektedir; bu belge kilometre taşındaki mimariyi, gözlemleri, sonuçları ve çıkarılan dersleri kaydeder.

## Test edilen mimari

```text
k6
 |
 v
NGINX
 |
 +--> Flask replica 1 --+
 +--> Flask replica 2 --+--> Redis
 +--> Flask replica 3 --+--> PostgreSQL
```

NGINX, herkese açık tek giriş noktasıdır ve istekleri üç Flask replikasına dağıtır. Replikalar Redis ve PostgreSQL'i paylaşır; böylece bir istek, gördüğü URL verisi veya rate-limit durumu değişmeden herhangi bir replika tarafından işlenebilir. PostgreSQL kalıcı doğruluk kaynağı olmaya devam ederken Redis, yönlendirme cache kayıtlarını ve rate-limit sayaçlarını saklar.

## Yönlendirme ve cache deneyi

Yönlendirme testi, hazırlık sırasında bir kısa URL oluşturur ve ölçülen yük başlamadan önce bir ısınma isteği gönderir. `/shorten`, oluşturulan URL'yi zaten Redis'e yazdığı için bu ısınma isteği cache'i doldurmaz veya ilk PostgreSQL fallback işlemini önlemez; ana yük fazından önce cache-hit yönlendirme yolunun çalıştığını doğrular. Ardından yük aşaması aynı kısa kodu tekrar tekrar ister.

Yönlendirmeler bilinçli olarak takip edilmez (`redirects: 0`). Test edilen davranış bir `302` yanıtıdır: k6 hem status değerini hem de `Location` header'ını doğrular ve ardından durur. Yönlendirmenin otomatik olarak takip edilmesi, trafiği harici hedef URL'ye gönderir, üçüncü taraf network latency değerini sonuçlara dahil eder ve URL kısaltıcının sınırları dışındaki bir sistemi ölçerdi.

### Cache hit ve cache miss

Yönlendirme araması bir cache-aside akışını izler:

```text
GET /{short_code}
  |
  +--> Redis hit  --> return 302
  |
  +--> Redis miss --> query PostgreSQL --> populate Redis --> return 302
```

Bir cache hit, PostgreSQL sorgusu yapılmadan Redis'ten sunulur. Cache miss durumunda Flask, kalıcı URL'yi PostgreSQL'den alıp Redis'e geri yazar; bu kod için sonraki istekler hit olur. Bu nedenle cache'lenmiş tek bir kodu temizlemek, cache yeniden ısınmadan önce yalnızca bir miss üretir. Gerçek bir cache-miss yük deneyi için cache kayıtları bulunmayan, önceden hazırlanmış çok sayıda kısa kodun her birinin bir kez istenmesi gerekir. Mevcut yönlendirme yük testi, bilinçli olarak bir cache-hit deneyidir.

### Replika dağılımı

NGINX, yanıtlara `X-Upstream-Addr` ekler. k6 betiği, ısınma isteğinin upstream adresini ve her virtual user tarafından görülen ilk upstream adresini kaydeder. Farklı adresler, isteklerin farklı Flask container'larına ulaştığına dair doğrudan kanıt sağlar. Kaydedilen yönlendirme çalıştırmasında üç Flask replikasının tamamına ait adresler gözlemlendi.

Bu header, replikaların katılımını gösterir; ancak küçük bir log örneği, kusursuz biçimde eşit round-robin dağılımını kanıtlamaz. Bu, eksiksiz bir load-balancer adalet metriğinden ziyade debugging ve öğrenme sinyalidir.

## Rate-limit deneyleri

`/shorten` limiti, limiter'ın mevcut 60 saniyelik TTL davranışı içinde istemci başına nominal olarak kabul edilen 10 istektir. Sıralı ve eşzamanlı modlar aynı uygulama implementasyonunu kullanır ancak farklı varış desenleri uygular.

### Sıralı sonuç

Tek bir virtual user sırayla 12 istek gönderdi:

| Yanıt | Sayı |
|----------|------:|
| `201 Created` | 10 |
| `429 Too Many Requests` | 2 |

Bu, nominal davranıştır: ilk 10 istek kabul edildi ve sonraki 2 istek rate-limit'e takıldı.

### Eşzamanlı sonuç

Eşzamanlı deneyde, her biri tek iteration çalıştıran 20 virtual user kullanıldı ve VU başına bir istek üretildi:

| Yanıt | Sayı |
|----------|------:|
| `201 Created` | 13 |
| `429 Too Many Requests` | 7 |

Nominal limit, 3 başarılı istek kadar aşıldı. Bu aşım, rate limiter'daki mevcut bir race condition'ı ortaya çıkarır; tasarım gereği izin verilen ek burst capacity değildir.

Limiter, geçerli değeri Redis `GET` ile okur, isteğin devam edip edemeyeceğine karar verir ve ancak bundan sonra `INCR` ile `EXPIRE` komutlarını çalıştırır. `INCR` kendi başına atomic olsa da check-then-increment dizisinin tamamı atomic değildir. Eşzamanlı istekler, herhangi biri değeri artırmadan önce aynı değeri okuyabilir; böylece birkaç istek kontrolden birlikte geçerek kabul edilen istek sayısını 10'un üzerine çıkarabilir. k6 deneyi, bu kilometre taşında limiter'ı değiştirmeden söz konusu doğruluk sorununu gözlemlenebilir hale getirir.

## Kaydedilen yönlendirme sonucu

Yerel bir cache-hit yönlendirme çalıştırması şu sonuçları üretti:

| Metrik | Sonuç |
|--------|-------:|
| Requests | 18,457 |
| Throughput | ~612.55 requests/second |
| Request duration p95 | ~31.68 ms |
| Failed requests | 0% |
| Flask replicas observed | 3 of 3 |

Sonuç, test edilen yerel stack'in çalıştırmayı beklenmeyen HTTP hataları olmadan tamamladığını, ölçülen istek sürelerinin %95'ini yaklaşık 31.68 ms veya altında tuttuğunu ve trafiği yapılandırılmış tüm Flask replikalarına dağıttığını gösterir. Bir production service-level objective olarak değil, tekrarlanabilir bir yerel baseline olarak kullanılmalıdır.

## Sınırlamalar

- Deney, k6 ile servis container'larının aynı host CPU, bellek ve ağ kaynakları için yarıştığı Docker Desktop üzerinde yerel olarak çalıştırıldı.
- Flask, production WSGI server yerine development server'ını kullanır.
- Sonuç bir üretim kapasitesi benchmark'ı değildir ve deployment boyutlandırması ya da sürdürülebilir maksimum throughput için genellenmemelidir.
- Her başarılı `/shorten` isteği kalıcı bir satır ekler. Bu nedenle yönlendirme hazırlığı ve kabul edilen rate-limit istekleri PostgreSQL'de test URL'leri bırakır ve ID dizisini ilerletir; Redis'i temizlemek bunları kaldırmaz.
- Yönlendirme çalıştırması, sürekli PostgreSQL cache-miss performansından ziyade öncelikle ısınmış bir Redis cache yolunu ölçer.
- `X-Upstream-Addr`, hangi replikaların gözlemlendiğini doğrular ancak tek başına kusursuz biçimde eşit trafik dağılımını ortaya koymaz.

## Çıkarılan dersler

Deney, NGINX'in tek bir ingress üzerinden üç Flask replikasının tamamını kullanabildiğini ve ısınmış bir Redis cache'in temiz, tekrarlanabilir bir yönlendirme yolu sunduğunu doğruladı. Ayrıca yönlendirme işlemenin neden `302` yanıtında durması gerektiğini de gösterdi: aksi halde ölçüm sistem sınırını aşar ve hedef siteye bağımlı hale gelir.

En önemlisi, yük testi sıralı bir kontrolün ortaya çıkarmadığı bir doğruluk özelliğini açığa çıkardı. Sıralı rate-limit çalıştırması nominal 10 istek limitine uyarken eşzamanlı varışlar, limiter'ın karar ve artırma işlemleri tek bir atomic işlem olmadığı için üç istek kadar aşım üretti. Bu nedenle performans deneyleri yalnızca latency ve throughput ölçümleri için değil, sıradan functional testing'in gözden kaçırabileceği concurrency davranışını ortaya çıkarmak için de yararlıdır.

Kaydedilen sayılar en iyi şekilde, gelecekteki değişiklikleri aynı makine, Compose yapılandırması, veri durumu, virtual-user sayısı ve süre altında karşılaştırmaya yönelik bir baseline olarak değerlendirilmelidir. Bir production benchmark için production server, kontrollü altyapı, temsilî trafik ve veri ile kaynak izleme eşliğinde tekrarlanan çalıştırmalar gerekir.
