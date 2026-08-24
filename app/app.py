import os
import string
from functools import wraps

from flask import Flask, request, redirect, jsonify
import redis
import psycopg2

app = Flask(__name__)

# Define the 62 characters used for short codes (0-9, a-z, A-Z)
ALPHABET = string.digits + string.ascii_lowercase + string.ascii_uppercase

# Connect to Redis for fast lookups
cache = redis.Redis(
    host=os.environ.get("REDIS_HOST", "redis"),
    port=int(os.environ.get("REDIS_PORT", 6379)),
    decode_responses=True,
)


def get_db():  # opens a connection to PostgreSQL.
    """Connect to PostgreSQL for permanent storage."""
    return psycopg2.connect(
        host=os.environ.get("POSTGRES_HOST", "db"),
        database=os.environ.get("POSTGRES_DB", "urlshortener"),
        user=os.environ.get("POSTGRES_USER", "postgres"),
        password=os.environ.get("POSTGRES_PASSWORD", "postgres"),
    )

def base62_encode(num):
    """Convert a database ID into a short alphanumeric string."""

    if num == 0:
        return ALPHABET[0]

    result = []

    while num > 0:
        num, remainder = divmod(num, 62)
        result.append(ALPHABET[remainder])

    return "".join(reversed(result))


def base62_decode(code):
    """Convert a short code back into the original database ID."""
    num = 0
    for char in code:
        num = num * 62 + ALPHABET.index(char)
    return num

# Base62 Encode:
# DB'deki sayısal ID'yi kısa koda çevirir.
# Sayı sürekli 62'ye bölünür, kalanlar alınır ve tersten okunur.
# Örn: 64 -> "12"

# Base62 Decode:
# Kısa kodu tekrar DB ID'sine çevirir.
# Her basamak 62 tabanında değerlendirilir.
# Örn: "12" -> 1*62 + 2 = 64

def rate_limit(max_requests=10, window=60):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            # Get the client's IP address
            client_ip = request.remote_addr
            # Create a unique Redis key for this IP
            key = f"rate_limit:{client_ip}"
            # Check current request count
            current = cache.get(key)
            if current and int(current) >= max_requests:
                return jsonify({"error": "Rate limit exceeded. Try again later."}), 429
            # Increment counter and set expiration atomically
            pipe = cache.pipeline()
            pipe.incr(key)
            pipe.expire(key, window)
            pipe.execute()
            return f(*args, **kwargs)
        return decorated_function
    return decorator

    # • request.remote_addr:
#   İsteği gönderen kullanıcının IP adresini alır.
#
# • cache.get(key):
#   Bu IP'nin Redis'te kaç istek yaptığını kontrol eder.
#
# • max_requests:
#   İstek sayısı limiti aşarsa endpoint çalıştırılmadan
#   HTTP 429 (Too Many Requests) döndürülür.
#
# • cache.pipeline():
#   INCR ve EXPIRE işlemlerini Redis'e birlikte gönderir.

@app.route("/shorten", methods=["POST"])
@rate_limit(max_requests=10, window=60)  # 10 istek/dakika limiti.
def shorten_url():
    # Grab the long URL from the request body
    data = request.get_json()
    if not data or "url" not in data:
        return jsonify({"error": "Missing url field"}), 400

    long_url = data["url"]

    # Save to PostgreSQL - the database assigns an auto-incrementing ID
    conn = get_db()
    cur = conn.cursor()
    cur.execute("INSERT INTO urls (long_url) VALUES (%s) RETURNING id", (long_url,))
    url_id = cur.fetchone()[0]
    conn.commit()
    cur.close()
    conn.close()

    # Encode the database ID into a short code
    short_code = base62_encode(url_id)

    # Cache the mapping for fast redirects later
    cache.set(short_code, long_url)

    return jsonify({"short_url": f"http://localhost:5000/{short_code}", "short_code": short_code}), 201
    
# Receive long URL → store in database → get a unique ID back →
# encode that ID into a short code → cache it → return the short URL.

# When a long URL hits the /shorten endpoint with a POST request,
#the app first reads the URL from the request body and saves it to PostgreSQL.
#PostgreSQL assigns an auto-incrementing ID to the new record.
#The app then encodes this database ID using Base62 to generate a short code.
#This short code is mapped to the original long URL and stored in Redis for faster lookups.
#Finally, the API returns the generated short URL to the client.


@app.route("/<short_code>")
def redirect_url(short_code):
    # redirect_url() handles GET requests. 
    #It first checks Redis (fast), falls back to PostgreSQL (slower), caches the result for next time,
    #and issues a 302 redirect.

    # Check the fast cache first
    long_url = cache.get(short_code)

    if long_url:
        print("CACHE HIT", flush=True)
        return redirect(long_url, code=302)

    # Cache miss - fall back to the database
    print("CACHE MISS - querying database", flush=True)
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT long_url FROM urls WHERE id = %s", (base62_decode(short_code),))
    result = cur.fetchone()
    cur.close()
    conn.close()

    if not result:
        return jsonify({"error": "Short URL not found"}), 404

    # Found it in the database - cache it for next time
    long_url = result[0]
    cache.set(short_code, long_url)

    return redirect(long_url, code=302)


@app.route("/health")  # uygulama ayakta mı kontrol etmek için.
def health():
    return jsonify({"status": "healthy"}), 200

if __name__ == "__main__":  # Flask uygulamasını 5000 portunda dışarıdan erişilebilir şekilde çalıştırmak için.
    app.run(host="0.0.0.0", port=5000)