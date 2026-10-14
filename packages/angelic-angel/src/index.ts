#!/usr/bin/env node
import { runCli } from './cli.js';
import type { CliOptions } from './cli.js';
import { pathToFileURL } from 'node:url';
export async function main(argv: string[], options: CliOptions = {}): Promise<number> {
  const controller = new AbortController();
  const interrupt = (): void => { controller.abort(new Error('Interrupted')); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    return await runCli(argv, { ...options, signal });
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
