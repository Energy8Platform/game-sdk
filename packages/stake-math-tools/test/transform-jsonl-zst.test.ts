import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  const jsonl = execFileSync('zstd', ['-dc', '-q', zstPath]).toString('utf8');
  if (jsonl.length === 0) return [];
  return jsonl.endsWith('\n') ? jsonl.slice(0, -1).split('\n') : jsonl.split('\n');
}

describe('transformJsonlZst', () => {
  it('round-trips an identity passthrough', async () => {
    const lines = [
      '{"id":0,"payoutMultiplier":120}',
      '{"id":1,"payoutMultiplier":0}',
      '{"id":2,"payoutMultiplier":500}',
    ];
    const input = writeJsonlZst('in', lines);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({ inputPath: input, outputPath: output });

    expect(result.linesRead).toBe(3);
    expect(result.linesWritten).toBe(3);
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

  it('rejects when the input file does not exist', async () => {
    const output = join(workDir, 'out.jsonl.zst');
    await expect(
      transformJsonlZst({
        inputPath: join(workDir, 'does-not-exist.jsonl.zst'),
        outputPath: output,
      }),
    ).rejects.toThrow(/zstd -d/);
  });

  it('calls onProgress with the running counts', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `{"i":${i}}`);
    const input = writeJsonlZst('in', lines);
    const output = join(workDir, 'out.jsonl.zst');
    const calls: Array<[number, number]> = [];

    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
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

  it('supports a large stream without blowing memory', async () => {
    // 50_000 lines at ~80 bytes each → ~4MB jsonl. Streaming should chew through
    // this with constant memory; we just sanity-check the count round-trips.
    const N = 50_000;
    const lines = Array.from({ length: N }, (_, i) =>
      JSON.stringify({ id: i, payload: 'x'.repeat(40) }),
    );
    const input = writeJsonlZst('in', lines);
    const output = join(workDir, 'out.jsonl.zst');

    const result = await transformJsonlZst({
      inputPath: input,
      outputPath: output,
      // Keep id, drop payload — mimics a books-rewrite filter step.
      mapper: (line) => {
        const o = JSON.parse(line);
        return JSON.stringify({ id: o.id });
      },
    });

    expect(result.linesRead).toBe(N);
    expect(result.linesWritten).toBe(N);
    const out = readJsonlZst(output);
    expect(out.length).toBe(N);
    expect(out[0]).toBe('{"id":0}');
    expect(out[N - 1]).toBe(`{"id":${N - 1}}`);
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

    // Both decode to identical content.
    expect(readJsonlZst(outFast)).toEqual(readJsonlZst(outSmall));
    // Higher level produces an at-least-as-small file on repetitive input.
    const fastSize = readFileSync(outFast).length;
    const smallSize = readFileSync(outSmall).length;
    expect(smallSize).toBeLessThanOrEqual(fastSize);
  });
});
