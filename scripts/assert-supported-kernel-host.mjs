const hostKey = `${process.platform}-${process.arch}`;
const supportedHosts = new Set(['darwin-arm64', 'win32-x64', 'linux-x64']);
const requiredHost = process.argv[2];

if (!supportedHosts.has(hostKey)) {
  console.error(`Cannot package: no managed browser kernel asset for ${hostKey}`);
  process.exit(1);
}

if (requiredHost && hostKey !== requiredHost) {
  console.error(`Cannot package ${requiredHost} on ${hostKey}; run this target on ${requiredHost}`);
  process.exit(1);
}
