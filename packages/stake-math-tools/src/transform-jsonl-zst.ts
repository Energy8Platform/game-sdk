/**
 * Streaming `*.jsonl.zst → *.jsonl.zst` transformer.
 *
 * Decompresses the input with zstd, runs each line through an optional user
 * mapper, recompresses the result. Pipes everything — no temp files, memory
 * footprint stays at one line regardless of input size, so gigabyte books
 * files work fine.
 *
 * Why not `readline.createInterface`? readline accumulates each line as a
 * growing JS string (`buffer += chunk`), which hits V8's ~512MB string-length
 * limit on books files that contain very long event arrays — manifests as
 * `RangeError: Invalid string length` deep in node:internal/readline. The
 * Buffer-based splitter here keeps incomplete-line state as raw bytes and
 * only materializes a string at the LF boundary (mapper mode) or never
 * (identity mode), so any line that fits in OS memory is fine.
 *
 * In identity mode (no mapper) we don't split at all — we pipe decompressor
 * output directly into compressor input as raw bytes. That's the fastest
 * path: ~25 MB/s of compressed input on a single core, dominated by the
 * zstd subprocesses, with zero JS string allocation.
 *
 * Requires the `zstd` binary on PATH (same precondition as the rest of the
 * stake-bridge tooling).
 */

import { spawn } from 'node:child_process';

export type LineMapper = (
  line: string,
  index: number,
) => string | string[] | null | undefined;

export type BinaryLineMapper = (
  line: Buffer,
  index: number,
) => Buffer | string | Array<Buffer | string> | null | undefined;

export interface TransformJsonlZstParams {
  /** Path to a zstd-compressed `.jsonl.zst` file. */
  inputPath: string;
  /** Path where the transformed `.jsonl.zst` will be written (overwritten). */
  outputPath: string;
  /** Per-line transform with the line decoded as a JS string. Default =
   *  identity passthrough (byte pipe, no per-line allocations).
   *
   *  - Return a `string` to replace the line with that content.
   *  - Return a `string[]` to expand one input line into several output lines.
   *  - Return `null` / `undefined` to drop the line entirely.
   *
   *  Mutually exclusive with `binaryMapper`. Use `binaryMapper` instead when
   *  any single line could exceed V8's ~512 MB string-length cap (e.g. bonus
   *  game books with massive event arrays) — `toString('utf8')` will throw
   *  `ERR_STRING_TOO_LONG` on lines above that limit. */
  mapper?: LineMapper;
  /** Per-line transform with the line passed as a raw `Buffer`. Use this
   *  for any line that may exceed V8's ~512 MB string limit, or when you
   *  only need to peek at a small prefix (`line.subarray(0, 64).toString()`)
   *  and want to pass the rest of the bytes through verbatim.
   *
   *  Return shape:
   *    - `Buffer` or `string` — replace the line with that content.
   *    - array of `Buffer | string` — expand to N output lines.
   *    - `null` / `undefined` — drop.
   *
   *  Mutually exclusive with `mapper`. */
  binaryMapper?: BinaryLineMapper;
  /** zstd compression level for the output. 1 = fastest, 22 = smallest.
   *  Default 9 — same level the kitsune optimize pipeline uses. */
  zstdLevel?: number;
  /** Called every `progressEveryLines` input lines with running counts.
   *  Useful for progress bars on multi-million-row files. Identity mode
   *  reports `linesRead == linesWritten == 0` because we don't split. */
  onProgress?: (linesRead: number, linesWritten: number) => void;
  /** How often to fire `onProgress`. Default 100_000. */
  progressEveryLines?: number;
}

export interface TransformJsonlZstResult {
  linesRead: number;
  linesWritten: number;
  /** True when identity mode was used: byte-pipe passthrough without
   *  per-line counting (so `linesRead`/`linesWritten` will be 0). */
  identityPassthrough: boolean;
}

const LF = 0x0a;
const LF_BUFFER = Buffer.from([LF]);

export async function transformJsonlZst(
  params: TransformJsonlZstParams,
): Promise<TransformJsonlZstResult> {
  const {
    inputPath,
    outputPath,
    mapper,
    binaryMapper,
    zstdLevel = 9,
    onProgress,
    progressEveryLines = 100_000,
  } = params;

  if (mapper && binaryMapper) {
    throw new Error(
      'transformJsonlZst: pass either `mapper` (string) or `binaryMapper` (Buffer), not both',
    );
  }
  const anyMapper = mapper ?? binaryMapper;

  const decompress = spawn('zstd', ['-dc', '-q', inputPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const compress = spawn(
    'zstd',
    [`-${zstdLevel}`, '-q', '-f', '-o', outputPath],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );

  const decompressDone = waitForExit(decompress, 'zstd -d');
  const compressDone = waitForExit(compress, 'zstd -c');

  const writeChunk = (chunk: Buffer | string): Promise<void> => {
    if (compress.stdin.write(chunk)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        compress.stdin.off('drain', onDrain);
        compress.stdin.off('error', onError);
      };
      compress.stdin.once('drain', onDrain);
      compress.stdin.once('error', onError);
    });
  };

  let linesRead = 0;
  let linesWritten = 0;

  try {
    if (!anyMapper) {
      // Identity mode: byte-pipe. Never split into lines, never materialize
      // strings, never accumulate buffers. Constant memory regardless of how
      // long individual lines are.
      for await (const chunk of decompress.stdout!) {
        await writeChunk(chunk);
      }
    } else {
      // Mapper mode: split on LF boundaries by scanning raw bytes. We keep
      // incomplete-line bytes in a small array of Buffers (no concatenation
      // into a single growing JS string), then `Buffer.concat` + `toString`
      // when the LF is finally seen (string mapper) or never (binary mapper).
      let pending: Buffer[] = [];
      let pendingLen = 0;

      const writeMapperResult = async (out: Buffer | string): Promise<void> => {
        await writeChunk(out);
        await writeChunk(LF_BUFFER);
        linesWritten++;
      };

      const flushLine = async (lineBuf: Buffer): Promise<void> => {
        // Strip trailing CR for CRLF tolerance, matching readline behaviour.
        const trimmed =
          lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d
            ? lineBuf.subarray(0, lineBuf.length - 1)
            : lineBuf;

        let result: string | string[] | Buffer | Array<Buffer | string> | null | undefined;
        if (binaryMapper) {
          result = binaryMapper(trimmed, linesRead);
        } else {
          // String mapper: decode the line. Lines above V8's ~512 MB string
          // cap throw ERR_STRING_TOO_LONG here — re-throw with a pointer to
          // `binaryMapper` so the failure mode is obvious.
          let lineStr: string;
          try {
            lineStr = trimmed.toString('utf8');
          } catch (err) {
            if (
              err instanceof Error &&
              (err as NodeJS.ErrnoException).code === 'ERR_STRING_TOO_LONG'
            ) {
              const wrapped = new Error(
                `transformJsonlZst: line ${linesRead} is ${trimmed.length} bytes — ` +
                  `exceeds V8 max JS string length (~512 MB). Use the ` +
                  '`binaryMapper` option to receive the line as a Buffer.',
              );
              (wrapped as { cause?: unknown }).cause = err;
              throw wrapped;
            }
            throw err;
          }
          result = mapper!(lineStr, linesRead);
        }
        linesRead++;

        if (result === null || result === undefined) {
          // drop
        } else if (Array.isArray(result)) {
          for (const out of result) {
            await writeMapperResult(out);
          }
        } else {
          await writeMapperResult(result);
        }

        if (onProgress && linesRead % progressEveryLines === 0) {
          onProgress(linesRead, linesWritten);
        }
      };

      for await (const chunk of decompress.stdout! as AsyncIterable<Buffer>) {
        let start = 0;
        // Buffer.indexOf(LF) is a C++ scan, ~20× faster than a JS byte loop.
        while (start < chunk.length) {
          const lf = chunk.indexOf(LF, start);
          if (lf < 0) {
            // No LF in the remainder — stash as pending and move on.
            const remainder = chunk.subarray(start);
            const owned = Buffer.from(remainder);
            pending.push(owned);
            pendingLen += owned.length;
            break;
          }
          const tail = chunk.subarray(start, lf);
          let lineBuf: Buffer;
          if (pendingLen === 0) {
            lineBuf = tail;
          } else {
            pending.push(tail);
            lineBuf = Buffer.concat(pending, pendingLen + tail.length);
            pending = [];
            pendingLen = 0;
          }
          await flushLine(lineBuf);
          start = lf + 1;
        }
      }

      // Trailing line without a terminating LF — emit it the same way readline
      // would (so callers don't silently lose data when the input lacks a
      // final newline).
      if (pendingLen > 0) {
        const lineBuf = Buffer.concat(pending, pendingLen);
        await flushLine(lineBuf);
      }
    }
  } catch (err) {
    compress.stdin.destroy();
    throw err;
  }

  compress.stdin.end();

  await Promise.all([decompressDone, compressDone]);

  if (mapper && onProgress) onProgress(linesRead, linesWritten);

  return { linesRead, linesWritten, identityPassthrough: !mapper };
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      reject(new Error(`${label} failed to spawn: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${label} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`,
          ),
        );
    });
  });
}
