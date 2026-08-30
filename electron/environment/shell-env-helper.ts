const CAPTURE_PREFIX = 'PISKIE_ENV_CAPTURE_';
const TRANSIENT_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'OLDPWD',
  'PWD',
  'SHLVL',
  '_',
]);

function isValidEntry(name: string, value: string | undefined): value is string {
  return name.length > 0
    && !name.includes('=')
    && !name.includes('\0')
    && value !== undefined
    && !value.includes('\0');
}

const marker = process.env.PISKIE_ENV_CAPTURE_MARKER;
if (!marker) {
  process.stderr.write('Piskie environment capture marker is missing.\n');
  process.exitCode = 2;
} else {
  const environment: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith(CAPTURE_PREFIX) || TRANSIENT_KEYS.has(name)) continue;
    if (isValidEntry(name, value)) environment[name] = value;
  }

  const payload = Buffer.from(JSON.stringify(environment), 'utf8').toString('base64');
  process.stdout.write(`${marker}${payload}\n`);
}
