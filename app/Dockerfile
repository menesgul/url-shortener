FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "app.py"]

# Bu Dockerfile, Flask uygulamasının çalışacağı container image'ını oluşturur.
#
# 1. Python 3.12 slim image'ı temel alınır.
# 2. requirements.txt içindeki Python bağımlılıkları kurulur.
# 3. Uygulama dosyaları container içerisine kopyalanır.
# 4. Container başladığında app.py çalıştırılır.
#
# Dockerfile yalnızca web/Flask servisinin nasıl build edileceğini tanımlar.
# PostgreSQL ve Redis servislerinin birlikte nasıl çalışacağı ise
# docker-compose.yml içerisinde tanımlanır.