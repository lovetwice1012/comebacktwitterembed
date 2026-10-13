import { emitKeypressEvents } from 'node:readline';
import { DEFAULT_CONFIG_PATH, loadConfig, saveConfig } from './config.js';
import { subscribe } from './push.js';
import { unregister, type AutoPushOptions } from './autopush.js';
import { register, assertLegacyPermission, type LegacyOptions } from './legacy/twitter-registration.js';
import { listen } from './listener.js';
import { AngelicAngelError, safeError } from './errors.js';
const commands = {
  init: 'Initialize config file (interactive if no arguments given)',
  register: 'Register AutoPush subscription and Twitter Push endpoint',
  listen: 'Start listening for push notifications',
  status: 'Show current config and registration status',
  unregister: 'Unregister AutoPush subscription'
} as const;
export type Command = keyof typeof commands;
export interface CliArguments { config: string; verbose: boolean; command?: Command; authToken?: string; ct0?: string; help?: string }
class UsageError extends Error {}
export function help(command?: Command, long = true): string {
  if (command) return `${commands[command]}\n\nUsage: angelic-angel ${command}${command === 'init' ? ' [OPTIONS]' : ''}\n\nOptions:\n${command === 'init' ? '      --auth-token <AUTH_TOKEN>  Twitter auth_token\n      --ct0 <CT0>                Twitter ct0 (CSRF token)\n' : ''}  -h, --help${command === 'init' ? '                   ' : '  '}Print help\n`;
  return `${long ? 'A server for receiving tweet notifications by emulating browser Web Push.' : 'Twitter Web Push Receiver'}\n\nUsage: angelic-angel [OPTIONS] <COMMAND>\n\nCommands:\n${Object.entries(commands).map(([name, description]) => `  ${name.padEnd(12)}${description}`).join('\n')}\n  help          Print this message or the help of the given subcommand(s)\n\nOptions:\n  -c, --config <CONFIG>  Configuration file path [default: angelic-angel.toml]\n  -v, --verbose         Enable verbose output (debug logs)\n  -h, --help            Print help${long ? ' (see a summary with \'-h\')' : ' (see more with \'--help\')'}\n`;
}
export function parseCli(argv: string[]): CliArguments {
  const result: CliArguments = { config: DEFAULT_CONFIG_PATH, verbose: false };
  let hasConfig = false, endOptions = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--' && !endOptions) { endOptions = true; continue; }
    if (!result.command && endOptions) throw new UsageError('unrecognized subcommand or option');
    if (arg === 'help' && !result.command) {
      const selected = argv[index + 1];
      if (selected === 'help' && argv.length === index + 2) {
        result.help = 'Print this message or the help of the given subcommand(s)\n\nUsage: angelic-angel help [COMMAND]...\n\nArguments:\n  [COMMAND]...  Print help for the subcommand(s)\n'; return result;
      }
      if (selected && !Object.hasOwn(commands, selected)) throw new UsageError('unrecognized subcommand');
      if (argv.length > index + 2) throw new UsageError('unexpected argument');
      result.help = help(selected as Command | undefined); return result;
    }
    if (!endOptions && (arg === '--help' || arg === '-h')) { result.help = help(result.command, arg === '--help'); return result; }
    const [name, ...values] = arg.split('=');
    const takeValue = (): string => {
      if (values.length) return values.join('=');
      const value = argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('a value is required for this option');
      return value;
    };
    if (!endOptions && !result.command && name === '--config') {
      if (hasConfig) throw new UsageError('option cannot be used multiple times');
      result.config = takeValue(); hasConfig = true; continue;
    }
    if (!endOptions && !result.command && arg === '--verbose') {
      if (result.verbose) throw new UsageError('option cannot be used multiple times');
      result.verbose = true; continue;
    }
    if (!endOptions && !result.command && arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      for (let position = 1; position < arg.length; position++) {
        const flag = arg[position];
        if (flag === 'h') { result.help = help(undefined, false); return result; }
        if (flag === 'v') {
          if (result.verbose) throw new UsageError('option cannot be used multiple times');
          result.verbose = true;
        } else if (flag === 'c') {
          if (hasConfig) throw new UsageError('option cannot be used multiple times');
          const remainder = arg.slice(position + 1);
          result.config = remainder ? remainder.replace(/^=/, '') : takeValue();
          hasConfig = true; break;
        } else throw new UsageError('unrecognized option');
      }
      continue;
    }
    if (!result.command && Object.hasOwn(commands, arg)) { result.command = arg as Command; endOptions = false; continue; }
    if (!endOptions && result.command === 'init' && (name === '--auth-token' || name === '--ct0')) {
      if (name === '--auth-token') { if (result.authToken !== undefined) throw new UsageError('option cannot be used multiple times'); result.authToken = takeValue(); }
      else { if (result.ct0 !== undefined) throw new UsageError('option cannot be used multiple times'); result.ct0 = takeValue(); }
      continue;
    }
    throw new UsageError(result.command ? 'unexpected argument' : 'unrecognized subcommand or option');
  }
  if (!result.command) throw new UsageError('a subcommand is required');
  return result;
}
export interface CliOptions {
  stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; env?: NodeJS.ProcessEnv;
  signal?: AbortSignal; autopush?: AutoPushOptions; legacy?: LegacyOptions;
  prompt?: (label: string, signal?: AbortSignal) => Promise<string>;
}
async function promptSecret(label: string, signal?: AbortSignal): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) throw new AngelicAngelError('Config', 'input error: interactive terminal required');
  signal?.throwIfAborted();
  process.stderr.write(`${label}: `);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => { input.off('keypress', keypress); signal?.removeEventListener('abort', aborted); input.setRawMode(wasRaw); input.pause(); process.stderr.write('\n'); };
    const aborted = (): void => { cleanup(); reject(signal?.reason); };
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === 'c') { cleanup(); process.emit('SIGINT'); reject(new AngelicAngelError('Config', 'input interrupted')); }
      else if (key.name === 'return' || key.name === 'enter') { if (!value) return; cleanup(); resolve(value); }
      else if (key.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (text && !key.ctrl && !text.includes('\u001b')) value += text;
    };
    input.on('keypress', keypress); signal?.addEventListener('abort', aborted, { once: true });
  });
}
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const output = options.stdout ?? process.stdout, errorOutput = options.stderr ?? process.stderr;
  let cli: CliArguments;
  try { cli = parseCli(argv); }
  catch (error) { errorOutput.write(`error: ${error instanceof UsageError ? error.message : 'invalid arguments'}\n\nUsage: angelic-angel [OPTIONS] <COMMAND>\n\nFor more information, try '--help'.\n`); return 2; }
  if (cli.help) { output.write(cli.help); return 0; }
  const env = options.env ?? process.env;
  const legacy = { ...options.legacy, allowLegacyX: options.legacy?.allowLegacyX ?? env.ANGELIC_ANGEL_ALLOW_LEGACY_X === '1', signal: options.signal };
  try {
    options.signal?.throwIfAborted();
    switch (cli.command) {
      case 'init': {
        errorOutput.write('Initializing configuration\n\n');
        const prompt = options.prompt ?? promptSecret;
        const auth_token = cli.authToken ?? await prompt('auth_token', options.signal);
        const ct0 = cli.ct0 ?? await prompt('ct0', options.signal);
        options.signal?.throwIfAborted();
        await saveConfig({ twitter: { auth_token, ct0 } }, cli.config);
        errorOutput.write(`done Saved to ${cli.config}\n`); break;
      }
      case 'status': {
        errorOutput.write('Status\n\n');
        const config = await loadConfig(cli.config).catch(() => undefined);
        if (!config) errorOutput.write('Config  not found\n  Run angelic-angel init to initialize.\n');
        else {
          errorOutput.write(`Config  ${cli.config}\n  auth_token  [REDACTED]\n  ct0         [REDACTED]\n\n`);
          if (config.registration) errorOutput.write('Registration  active\n  endpoint    [REDACTED]\n  uaid        [REDACTED]\n  channel_id  [REDACTED]\n');
          else errorOutput.write('Registration  not registered\n  Run angelic-angel register to register.\n');
        } break;
      }
      case 'register': {
        errorOutput.write('Registering push subscription\n\n');
        const config = await loadConfig(cli.config);
        assertLegacyPermission(legacy);
        const subscription = await subscribe(undefined, { ...options.autopush, signal: options.signal });
        await register(config.twitter, subscription, legacy);
        options.signal?.throwIfAborted();
        config.registration = subscription;
        await saveConfig(config, cli.config);
        errorOutput.write(`done Saved to ${cli.config}\n`); break;
      }
      case 'unregister': {
        errorOutput.write('Unregistering\n\n');
        const config = await loadConfig(cli.config);
        if (!config.registration) throw new AngelicAngelError('Config', 'No registration found.');
        await unregister(config.registration.autopush, { ...options.autopush, signal: options.signal });
        options.signal?.throwIfAborted();
        delete config.registration;
        await saveConfig(config, cli.config);
        errorOutput.write(`done Registration removed from ${cli.config}\n`); break;
      }
      case 'listen': {
        const config = await loadConfig(cli.config);
        if (!config.registration) throw new AngelicAngelError('Config', 'No registration found. Run `register` first.');
        await listen(config.registration, cli.config, { signal: options.signal, env, autopush: options.autopush, legacy,
          onEvent: cli.verbose ? event => { errorOutput.write(`${JSON.stringify(event)}\n`); } : undefined }); break;
      }
    }
    if (options.signal?.aborted) errorOutput.write('\nInterrupted\n');
    return 0;
  } catch (error) {
    if (options.signal?.aborted) { errorOutput.write('\nInterrupted\n'); return 0; }
    errorOutput.write(`error: ${safeError(error)}\n`); return 1;
  }
}
