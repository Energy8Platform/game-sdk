import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { transformJsonlZst } from '../src/transform-jsonl-zst.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'transform-jsonl-zst-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeJsonlZst(name: string, lines: string[]): string {
  const jsonlPath = join(workDir, `${name}.jsonl`);
  const zstPath = join(workDir, `${name}.jsonl.zst`);
  writeFileSync(jsonlPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  execFileSync('zstd', ['-q', '-f', '-o', zstPath, jsonlPath]);
  return zstPath;
}

function readJsonlZst(zstPath: string): string[] {
  // Bump maxBuffer well past the 1 MiB default — some tests round-trip
  // multi-megabyte payloads.
  const jsonl = execFileSync('zstd', ['-dc', '-q', zstPath], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
  if (jsonl.length === 0) return [];
  return jsonl.endsWith('\n') ? jsonl.slice(0, -1).split('\n') : jsonl.split('\n');
}

describe('transformJsonlZst', () => {
  it('round-trips identity as a pure byte passthrough', async () => {
    const lines = [
      '{"id":0,"payoutMultiplier":120}',
      '{"id":1,"payoutMultiplier":0}',
      '{"id":2,"payoutMultiplier":500}',
    ];
    const input = writeJsonlZst('in', lines);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({ inputPath: input, outputPath: output });

    // Identity mode does not split into lines, so the counters stay at zero —
    // by design, to keep the path allocation-free.
    expect(result.identityPassthrough).toBe(true);
    expect(result.linesRead).toBe(0);
    expect(result.linesWritten).toBe(0);
    expect(readJsonlZst(output)).toEqual(lines);
  });

  it('applies a line mapper as a 1:1 transform', async () => {
    const input = writeJsonlZst('in', [
      '{"id":0,"v":1}',
      '{"id":1,"v":2}',
      '{"id":2,"v":3}',
    ]);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      mapper: (line, i) => {
        const obj = JSON.parse(line);
        return JSON.stringify({ ...obj, idx: i, doubled: obj.v * 2 });
      },
    });

    expect(result.identityPassthrough).toBe(false);
    expect(result.linesWritten).toBe(3);
    expect(readJsonlZst(output)).toEqual([
      '{"id":0,"v":1,"idx":0,"doubled":2}',
      '{"id":1,"v":2,"idx":1,"doubled":4}',
      '{"id":2,"v":3,"idx":2,"doubled":6}',
    ]);
  });

  it('drops lines when mapper returns null', async () => {
    const input = writeJsonlZst('in', [
      '{"keep":true,"id":0}',
      '{"keep":false,"id":1}',
      '{"keep":true,"id":2}',
      '{"keep":false,"id":3}',
    ]);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      mapper: (line) => (JSON.parse(line).keep ? line : null),
    });

    expect(result.linesRead).toBe(4);
    expect(result.linesWritten).toBe(2);
    expect(readJsonlZst(output)).toEqual([
      '{"keep":true,"id":0}',
      '{"keep":true,"id":2}',
    ]);
  });

  it('expands a single input line into multiple outputs when mapper returns an array', async () => {
    const input = writeJsonlZst('in', ['{"id":0}', '{"id":1}']);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      mapper: (line) => [line, line],
    });

    expect(result.linesRead).toBe(2);
    expect(result.linesWritten).toBe(4);
    expect(readJsonlZst(output)).toEqual([
      '{"id":0}',
      '{"id":0}',
      '{"id":1}',
      '{"id":1}',
    ]);
  });

  it('handles an empty input file', async () => {
    const input = writeJsonlZst('in', []);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({ inputPath: input, outputPath: output });

    expect(result.linesRead).toBe(0);
    expect(result.linesWritten).toBe(0);
    expect(existsSync(output)).toBe(true);
    expect(readJsonlZst(output)).toEqual([]);
  });

  it('emits a trailing line that lacks a final newline', async () => {
    // Build a raw jsonl with no terminating \n, compress it manually so we
    // exercise the trailing-flush path in the mapper branch.
    const jsonlPath = join(workDir, 'no-final-lf.jsonl');
    writeFileSync(jsonlPath, '{"id":0}\n{"id":1}');
    const input = join(workDir, 'no-final-lf.jsonl.zst');
    execFileSync('zstd', ['-q', '-f', '-o', input, jsonlPath]);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      mapper: (line) => line,
    });

    expect(result.linesRead).toBe(2);
    expect(result.linesWritten).toBe(2);
    expect(readJsonlZst(output)).toEqual(['{"id":0}', '{"id":1}']);
  });

  it('rejects when the input file does not exist', async () => {
    const output = join(workDir, 'out.jsonl.zst');
    await expect(
      transformJsonlZst({
        inputPath: join(workDir, 'does-not-exist.jsonl.zst'),
        outputPath: output,
      }),
    ).rejects.toThrow(/zstd -d/);
  });

  it('calls onProgress with the running counts (mapper mode)', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `{"i":${i}}`);
    const input = writeJsonlZst('in', lines);
    const output = join(workDir, 'out.jsonl.zst');
    const calls: Array<[number, number]> = [];

    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      mapper: (line) => line,
      progressEveryLines: 100,
      onProgress: (r, w) => calls.push([r, w]),
    });

    expect(result.linesRead).toBe(250);
    // Mid-stream ticks at 100 / 200 + a final flush at 250.
    expect(calls).toEqual([
      [100, 100],
      [200, 200],
      [250, 250],
    ]);
  });

  it('supports a large stream (identity byte-pipe) without per-line allocations', async () => {
    const N = 50_000;
    const lines = Array.from({ length: N }, (_, i) =>
      JSON.stringify({ id: i, payload: 'x'.repeat(40) }),
    );
    const input = writeJsonlZst('in', lines);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({ inputPath: input, outputPath: output });

    expect(result.identityPassthrough).toBe(true);
    const out = readJsonlZst(output);
    expect(out.length).toBe(N);
    expect(out[0]).toBe(lines[0]);
    expect(out[N - 1]).toBe(lines[N - 1]);
  });

  it('processes a single line larger than a default stream chunk (128 KiB) via mapper', async () => {
    // Construct a line of ~512 KiB so it spans many decompressor chunks. This
    // is the failure mode that `readline += string` hits at scale; the
    // Buffer-based splitter must concatenate transparently.
    const bigLine = '{"id":0,"payload":"' + 'x'.repeat(500_000) + '"}';
    const input = writeJsonlZst('in', [bigLine, '{"id":1}']);
    const output = join(workDir, 'out.jsonl.zst');

    const sizes: number[] = [];
    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      mapper: (line) => {
        sizes.push(line.length);
        return line;
      },
    });

    expect(result.linesRead).toBe(2);
    expect(result.linesWritten).toBe(2);
    expect(sizes[0]).toBe(bigLine.length);
    expect(sizes[1]).toBe('{"id":1}'.length);
    const out = readJsonlZst(output);
    expect(out[0].length).toBe(bigLine.length);
    expect(out[1]).toBe('{"id":1}');
  });

  it('passes raw Buffer to binaryMapper and lets it emit Buffer or string', async () => {
    const input = writeJsonlZst('in', [
      '{"id":0,"v":1}',
      '{"id":1,"v":2}',
      '{"id":2,"v":3}',
    ]);
    const output = join(workDir, 'out.jsonl.zst');

    const seen: Array<{ isBuffer: boolean; byteLength: number; firstByte: number }> = [];
    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      binaryMapper: (lineBuf, i) => {
        seen.push({
          isBuffer: Buffer.isBuffer(lineBuf),
          byteLength: lineBuf.length,
          firstByte: lineBuf[0],
        });
        // Mix Buffer + string returns: even indices stay as Buffer, odd as string.
        return i % 2 === 0 ? lineBuf : lineBuf.toString('utf8');
      },
    });

    expect(result.linesRead).toBe(3);
    expect(result.linesWritten).toBe(3);
    expect(seen.every((s) => s.isBuffer)).toBe(true);
    expect(seen[0].firstByte).toBe('{'.charCodeAt(0));
    expect(readJsonlZst(output)).toEqual([
      '{"id":0,"v":1}',
      '{"id":1,"v":2}',
      '{"id":2,"v":3}',
    ]);
  });

  it('binaryMapper rewrites a multi-megabyte line via prefix-only string conversion', async () => {
    // Mimic the curate use case: id-prefix lookup + verbatim tail. Build a
    // ~3 MB line so the test stays fast but the path is identical to what a
    // 1 GB book line would exercise — only the prefix becomes a string.
    const bigTail = '"events":[' + '0,'.repeat(1_500_000) + '0]';
    const bigLine = `{"id":42,${bigTail}}`;
    const input = writeJsonlZst('in', [
      `{"id":1,"keep":false}`,
      bigLine,
      `{"id":99,"keep":true}`,
    ]);
    const output = join(workDir, 'out.jsonl.zst');

    const selected = new Map<number, number>([
      [42, 0],
      [99, 1],
    ]);
    const idPrefix = /^\{"id":(\d+),/;

    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      binaryMapper: (lineBuf) => {
        // Peek only the first 32 bytes — works regardless of full line size.
        const head = lineBuf.subarray(0, 32).toString('utf8');
        const m = idPrefix.exec(head);
        if (!m) return null;
        const newId = selected.get(Number(m[1]));
        if (newId === undefined) return null;
        const prefix = Buffer.from(`{"id":${newId},`);
        const tail = lineBuf.subarray(m[0].length);
        return Buffer.concat([prefix, tail], prefix.length + tail.length);
      },
    });

    expect(result.linesRead).toBe(3);
    expect(result.linesWritten).toBe(2);
    const out = readJsonlZst(output);
    expect(out.length).toBe(2);
    // First written line is the rewritten big one (id 42 → 0).
    expect(out[0].startsWith('{"id":0,"events":[')).toBe(true);
    expect(out[0].length).toBe(bigLine.length - `{"id":42,`.length + `{"id":0,`.length);
    expect(out[1]).toBe('{"id":1,"keep":true}');
  });

  it('rejects when both mapper and binaryMapper are provided', async () => {
    const input = writeJsonlZst('in', ['{"id":0}']);
    const output = join(workDir, 'out.jsonl.zst');
    await expect(
      transformJsonlZst({
        inputPath: input,
        outputPath: output,
        mapper: (l) => l,
        binaryMapper: (b) => b,
      }),
    ).rejects.toThrow(/either.*mapper.*binaryMapper/);
  });

  it('honors the zstdLevel parameter', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({ id: i, lots: 'of repeating text '.repeat(5) }),
    );
    const input = writeJsonlZst('in', lines);
    const outFast = join(workDir, 'fast.jsonl.zst');
    const outSmall = join(workDir, 'small.jsonl.zst');

    await transformJsonlZst({ inputPath: input, outputPath: outFast, zstdLevel: 1 });
    await transformJsonlZst({ inputPath: input, outputPath: outSmall, zstdLevel: 19 });

    expect(readJsonlZst(outFast)).toEqual(readJsonlZst(outSmall));
    const fastSize = statSync(outFast).size;
    const smallSize = statSync(outSmall).size;
    expect(smallSize).toBeLessThanOrEqual(fastSize);
  });
});
