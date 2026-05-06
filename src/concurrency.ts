import pLimit from "p-limit";

export function makeLimiter(concurrency = 5) {
  return pLimit(concurrency);
}
