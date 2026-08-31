import http from "k6/http";
import { check, fail } from "k6";

const baseUrl = (__ENV.BASE_URL || "http://localhost").replace(/\/$/, "");
const targetUrl = __ENV.TARGET_URL || "https://example.com/k6-redirect-target";

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || "30s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    "http_req_duration{experiment:cache-hit}": ["p(95)<500"],
  },
};

const jsonHeaders = {
  headers: { "Content-Type": "application/json" },
  tags: { experiment: "setup", name: "POST /shorten" },
};

const redirectRequest = {
  // Harici hedef test kapsamında olmadığı için yönlendirmeyi takip etme.
  redirects: 0,
  tags: { experiment: "cache-hit", name: "GET /:short_code" },
};

function upstreamAddress(response) {
  return response.headers["X-Upstream-Addr"] || "header-not-present";
}

export function setup() {
  // Tüm sanal kullanıcıların kullanacağı tek bir kısa URL oluştur.
  const createResponse = http.post(
    `${baseUrl}/shorten`,
    JSON.stringify({ url: targetUrl }),
    jsonHeaders,
  );

  const created = check(createResponse, {
    "setup: short URL created": (response) => response.status === 201,
  });

  if (!created) {
    fail(
      `Could not create a short URL: status=${createResponse.status} body=${createResponse.body}`,
    );
  }

  let shortCode;
  try {
    shortCode = createResponse.json("short_code");
  } catch (error) {
    fail(`Could not parse the create response as JSON: ${error}`);
  }

  if (!shortCode) {
    fail("The create response did not contain short_code");
  }

  // API yanıtındaki localhost container'dan erişilemeyebilir; URL'yi burada kur.
  const redirectUrl = `${baseUrl}/${encodeURIComponent(shortCode)}`;
  // Ana yük fazından önce cache-hit yönlendirme yolunu doğrula.
  const warmResponse = http.get(redirectUrl, {
    ...redirectRequest,
    tags: { experiment: "warm-up", name: "GET /:short_code" },
  });

  const warmed = check(warmResponse, {
    "setup: cache warm-up returned 302": (response) => response.status === 302,
    "setup: redirect target is correct": (response) =>
      response.headers.Location === targetUrl,
  });

  if (!warmed) {
    fail(
      `Could not warm the redirect cache: status=${warmResponse.status} location=${warmResponse.headers.Location}`,
    );
  }

  console.log(
    `Warm-up used upstream ${upstreamAddress(warmResponse)} for short_code=${shortCode}`,
  );

  return { redirectUrl, targetUrl };
}

export default function (data) {
  const response = http.get(data.redirectUrl, redirectRequest);

  check(response, {
    "redirect returned 302": (result) => result.status === 302,
    "redirect location is correct": (result) =>
      result.headers.Location === data.targetUrl,
  });

  // NGINX dağılımını görmek için her sanal kullanıcıdan tek örnek yazdır.
  if (__ITER === 0) {
    console.log(`VU ${__VU} first response used upstream ${upstreamAddress(response)}`);
  }
}
