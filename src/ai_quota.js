import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

const COUNTER_PATH = "limits/ai-requests.json";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const PER_MINUTE = 12;
const PER_DAY = 200;

let localCounter = {};

function nextCounter(previous, now) {
  const minute = Math.max(Math.floor(now / MINUTE_MS), previous.minute ?? 0);
  const day = Math.max(Math.floor(now / DAY_MS), previous.day ?? 0);
  const minuteCount = previous.minute === minute ? previous.minuteCount : 0;
  const dayCount = previous.day === day ? previous.dayCount : 0;
  if (dayCount >= PER_DAY) return { retryAfter: Math.ceil(((day + 1) * DAY_MS - now) / 1000) };
  if (minuteCount >= PER_MINUTE) {
    return { retryAfter: Math.ceil(((minute + 1) * MINUTE_MS - now) / 1000) };
  }
  return { counter: { minute, day, minuteCount: minuteCount + 1, dayCount: dayCount + 1 } };
}

export async function takeAiQuota({
  token = process.env.BLOB_READ_WRITE_TOKEN,
  distributed = Boolean(process.env.VERCEL),
  getBlob = get,
  putBlob = put
} = {}) {
  if (!token) {
    if (distributed) throw new Error("AI quota requires a private Blob store on Vercel.");
    const { counter, retryAfter } = nextCounter(localCounter, Date.now());
    if (counter) localCounter = counter;
    return retryAfter ?? 0;
  }

  const options = { token, access: "private", abortSignal: AbortSignal.timeout(4000) };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const blob = await getBlob(COUNTER_PATH, { ...options, useCache: false });
    let previous = {};
    if (blob) {
      if (!blob.stream || !blob.blob.etag) throw new Error("AI quota data is unavailable.");
      previous = await new Response(blob.stream).json();
      if (!previous || ![previous.minute, previous.day, previous.minuteCount, previous.dayCount]
        .every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("AI quota data is invalid.");
      }
    }
    const { counter, retryAfter } = nextCounter(previous, Date.now());
    if (retryAfter) return retryAfter;

    try {
      await putBlob(COUNTER_PATH, JSON.stringify(counter), {
        ...options,
        addRandomSuffix: false,
        allowOverwrite: Boolean(blob),
        ...(blob && { ifMatch: blob.blob.etag })
      });
      return 0;
    } catch (error) {
      // A first create can race another create. Subsequent writes require the latest ETag.
      if (attempt === 3 || (blob && !(error instanceof BlobPreconditionFailedError))) throw error;
    }
  }
}
