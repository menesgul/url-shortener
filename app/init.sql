CREATE TABLE IF NOT EXISTS urls (
    id SERIAL PRIMARY KEY,
    long_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PostgreSQL ilk kez initialize edilirken otomatik olarak çalıştırılır.
-- URL eşleşmelerinin kalıcı olarak tutulacağı `urls` tablosunu oluşturur.
--
-- id: Her URL için otomatik artan benzersiz kimlik.
--     Kısa kod üretiminde kullanılabilir.
-- long_url: Kullanıcının orijinal URL'si.
-- created_at: Kaydın oluşturulma zamanı.
--
-- Docker Compose, bu init.sql dosyasını PostgreSQL container'ının
-- /docker-entrypoint-initdb.d/ klasöründe erişilebilir hale getirir.
-- PostgreSQL ilk veritabanı kurulumunda bu klasördeki SQL dosyalarını otomatik çalıştırır.

--Veri modeli ilişkisel ve benzersizlik garantisi gerekiyor. 
--Ayrıca auto-increment ID’leri Base62 ile kısa URL kodlarına çevirmek kolay olduğu için 
--PostgreSQL uygun bir tercih.