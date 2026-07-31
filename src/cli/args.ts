/**
 * Hand-rolled arg parsing shared by `team pull` and `player pull` — GRAMMAR.md forbids a `--`
 * payload terminator and these two commands are the whole surface that needs more than the
 * global flags, so a dependency is not worth taking for it (spec constraint: no new npm deps).
 *
 * Grammar: `tn <noun> <verb> <target> [flags]` — the first non-flag argument is the target; every
 * `--name` must be one of the caller's declared `booleanFlags`/`valueFlags` or parsing fails. This
 * is deliberately stricter than "ignore what I don't recognize": an unrecognized flag is very
 * likely a typo'd real one, and silently accepting it would make the typo invisible.
 */
export type ParsedArgs = {
  target?: string;
  flags: Record<string, string | true>;
  error?: string;
};

export function parseArgs(args: string[], booleanFlags: string[], valueFlags: string[]): ParsedArgs {
  let target: string | undefined;
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (booleanFlags.includes(name)) {
        flags[name] = true;
        continue;
      }
      if (valueFlags.includes(name)) {
        const value = args[i + 1];
        if (value === undefined) {
          return { flags, error: `flag --${name} requires a value` };
        }
        flags[name] = value;
        i++;
        continue;
      }
      return { flags, error: `unrecognized flag --${name}` };
    }
    if (target === undefined) {
      target = arg;
      continue;
    }
    return { flags, error: `unexpected extra argument "${arg}"` };
  }

  return { target, flags };
}
