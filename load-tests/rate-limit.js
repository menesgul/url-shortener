import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const baseUrl = (__ENV.BASE_URL || "http://localhost").replace(/\/$/, "");
const mode = (__ENV.MODE || "sequential").toLowerCase();
const nominalLimit = 10;
const sequentialRequests = Number(__ENV.REQUESTS || 12);
const concurrentVus = Number(__ENV.VUS || 20);

if (!["sequential", "concurrent"].includes(mode)) {
  throw new Error('MODE must be either "sequential" or "concurrent"');
}

if (mode === "sequential" && sequentialRequests <= nominalLimit) {
  throw new Error("REQUESTS must be greater than 10 to observe HTTP 429");
}

if (mode === "concurrent" && concurrentVus <= nominalLimit) {
  throw new Error("VUS must be greater than 10 to observe HTTP 429");
}

const createdResponses = new Counter("created_responses");
const rateLimitedResponses = new Counter("rate_limited_responses");
const unexpectedResponses = new Counter("unexpected_responses");

// 429 bu testte beklenir; http_req_failed metriğini hata olarak şişirmesin.
http.setResponseCallback(
  http.expectedStatuses({ min: 200, max: 399 }, 429),
);

const commonThresholds = {
  http_req_failed: ["rate<0.01"],
  checks: ["rate>0.99"],
  unexpected_responses: ["count==0"],
};

export const options = {
  scenarios: {
    rate_limit:
      mode === "sequential"
        ? {
            executor: "shared-iterations",
            vus: 1,
            iterations: sequentialRequests,
            maxDuration: "30s",
          }
        : {
            // Her sanal kullanıcı bir kez çalışarak aynı anda tek istek gönderir.
            executor: "per-vu-iterations",
            vus: concurrentVus,
            iterations: 1,
            maxDuration: "30s",
          },
  },
  thresholds:
    mode === "sequential"
      ? {
          ...commonThresholds,
          created_responses: [`count==${nominalLimit}`],
          rate_limited_responses: [
            `count==${sequentialRequests - nominalLimit}`,
          ],
        }
      : {
          ...commonThresholds,
          // Atomik olmayan limiter eşzamanlı isteklerde limiti aşabilir.
          created_responses: [`count<=${nominalLimit}`],
          rate_limited_responses: ["count>=1"],
        },
};

export default function () {
  // Her isteği benzersiz URL ile göndererek yalnızca rate limit'i ölç.
  const response = http.post(
    `${baseUrl}/shorten`,
    JSON.stringify({
      url: `https://example.com/k6-rate-limit/${mode}/${__VU}/${__ITER}`,
    }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { experiment: `rate-limit-${mode}`, name: "POST /shorten" },
    },
  );

  createdResponses.add(response.status === 201 ? 1 : 0);
  rateLimitedResponses.add(response.status === 429 ? 1 : 0);
  unexpectedResponses.add(
    response.status !== 201 && response.status !== 429 ? 1 : 0,
  );

  // Sıralı modda ilk 10 istek başarılı, kalanlar 429 olmalı.
  if (mode === "sequential") {
    const expectedStatus = __ITER < nominalLimit ? 201 : 429;
    check(response, {
      [`request ${__ITER + 1} returned ${expectedStatus}`]: (result) =>
        result.status === expectedStatus,
    });
  } else {
    check(response, {
      "concurrent response was 201 or 429": (result) =>
        result.status === 201 || result.status === 429,
    });
  }
}
