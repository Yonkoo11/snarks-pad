// A gate for the work that decodes an uploaded picture docs/API.md v2.8.2, S4-03). A small file can unpack into hundreds of megabytes of pixels, so
// the API unit (1 GiB) must never decode many at once: at most `max` run together, the next `maxWaiting` wait their turn in the order they came, and one
// more is refused at once (DecodeQueueFull, which the upload route answers 503 busy with retry-after). A slot is held only while the decoder works, never
// while a client is still sending its file, so a slow upload cannot hold up the others' decodes.

/** Too many pictures are already waiting to be decoded. */
export class DecodeQueueFull extends Error {
  constructor() {
    super("too many pictures are waiting to be decoded");
    this.name = "DecodeQueueFull";
  }
}

export interface DecodeGate {
  /** Runs `task` when a place is free (at once, or after the ones ahead of it); throws DecodeQueueFull when the queue is full. A task that fails gives its place back. */
  run<T>(task: () => Promise<T>): Promise<T>;
  stats(): { running: number; waiting: number };
}

export function makeDecodeGate(max: number, maxWaiting: number): DecodeGate {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    async run(task) {
      if (running >= max) {
        if (waiting.length >= maxWaiting) throw new DecodeQueueFull();
        await new Promise<void>((resolve) => waiting.push(resolve)); // the task ahead hands its place over: `running` stays counted
      } else {
        running += 1;
      }
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else running -= 1;
      }
    },
    stats: () => ({ running, waiting: waiting.length }),
  };
}
