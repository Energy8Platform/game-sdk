/**
 * Streaming `*.jsonl.zst → *.jsonl.zst` transformer.
 *
 * Decompresses the input with zstd, runs each line through an optional user
 * mapper, recompresses the result. Pipes everything — no temp files, memory
 * footprint stays at one line regardless of input size, so gigabyte books
 * files work fine.
 *
 * The mapper operates on raw UTF-8 lines (no trailing `\n`). For JSON payloads
 * the caller does the parse / stringify themselves; that way a passthrough or
 * regex-only filter doesn't pay the JSON parse cost.
 *
 * Requires the `zstd` binary on PATH (same precondition as the rest of the
 * stake-bridge tooling).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type LineMapper = (
  line: string,
  index: number,
) => string | string[] | null | undefined;

export interface TransformJsonlZstParams {
  /** Path to a zstd-compressed `.jsonl.zst` file. */
  inputPath: string;
  /** Path where the transformed `.jsonl.zst` will be written (overwritten). */
  outputPath: string;
  /** Per-line transform. Default = identity passthrough.
   *
   *  - Return a `string` to replace the line with that content.
   *  - Return a `string[]` to expand one input line into several output lines.
   *  - Return `null` / `undefined` to drop the line entirely. */
  mapper?: LineMapper;
  /** zstd compression level for the output. 1 = fastest, 22 = smallest.
   *  Default 9 — same level the kitsune optimize pipeline uses. */
  zstdLevel?: number;
  /** Called every `progressEveryLines` input lines with running counts.
   *  Useful for progress bars on multi-million-row files. */
  onProgress?: (linesRead: number, linesWritten: number) => void;
  /** How often to fire `onProgress`. Default 100_000. */
  progressEveryLines?: number;
}

export interface TransformJsonlZstResult {
  linesRead: number;
  linesWritten: number;
}

export async function transformJsonlZst(
  params: TransformJsonlZstParams,
): Promise<TransformJsonlZstResult> {
  const {
    inputPath,
    outputPath,
    mapper,
    zstdLevel = 9,
    onProgress,
    progressEveryLines = 100_000,
  } = params;

  const decompress = spawn('zstd', ['-dc', '-q', inputPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const compress = spawn(
    'zstd',
    [`-${zstdLevel}`, '-q', '-f', '-o', outputPath],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );

  // Track child-process exits so we can fail the promise on non-zero codes.
  const decompressDone = waitForExit(decompress, 'zstd -d');
  const compressDone = waitForExit(compress, 'zstd -c');

  const writeLine = (data: string): Promise<void> => {
    if (compress.stdin.write(data)) return Promise.resolve();
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
    const rl = createInterface({ input: decompress.stdout!, crlfDelay: Infinity });
    for await (const line of rl) {
      const result = mapper ? mapper(line, linesRead) : line;
      linesRead++;

      if (result === null || result === undefined) {
        // drop
      } else if (Array.isArray(result)) {
        for (const out of result) {
          await writeLine(out + '\n');
          linesWritten++;
        }
      } else {
        await writeLine(result + '\n');
        linesWritten++;
      }

      if (onProgress && linesRead % progressEveryLines === 0) {
        onProgress(linesRead, linesWritten);
      }
    }
  } catch (err) {
    compress.stdin.destroy();
    throw err;
  }

  compress.stdin.end();

  await Promise.all([decompressDone, compressDone]);

  if (onProgress) onProgress(linesRead, linesWritten);

  return { linesRead, linesWritten };
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
