export const VENUE_TIMEOUT_MS = 15_000;

let venueTimeoutMs = VENUE_TIMEOUT_MS;

export function getVenueTimeoutMs(): number {
  return venueTimeoutMs;
}

export function setVenueTimeoutMsForTests(ms: number): void {
  venueTimeoutMs = ms;
}

function isTimeoutLike(e: unknown): boolean {
  if (e == null || typeof e !== "object") return false;
  const name = (e as { name?: string }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function timeoutMessage(venue: string): string {
  return `${venue}: timeout after ${getVenueTimeoutMs() / 1000}s`;
}

export async function venueFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const timeout = AbortSignal.timeout(getVenueTimeoutMs());
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

export async function withVenueTimeout<T>(
  venue: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ms = getVenueTimeoutMs();
  const work = fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutMessage(venue));
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    void work.catch(() => {});
    if (isTimeoutLike(e)) throw new Error(timeoutMessage(venue));
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function parseJsonOrWarn<T>(
  res: Response,
  context: string,
): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `! ${context}: JSON parse failed (${res.status} ${res.statusText}): ${msg}`,
    );
    return {} as T;
  }
}

export async function readTextOrWarn(
  res: Response,
  context: string,
): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`! ${context}: body read failed: ${msg}`);
    return "";
  }
}
