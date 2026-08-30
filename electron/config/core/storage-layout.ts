import path from 'node:path';

export const CONFIG_HISTORY_RETENTION = 5;

export interface ConfigDomainStoragePaths {
  configFile: string;
  historyDirectory: string;
  plansDirectory: string;
  lockFile: string;
}

export function configDomainStoragePaths(
  rootDirectory: string,
  domain: string,
): ConfigDomainStoragePaths {
  if (!/^[a-z][a-z0-9-]*$/.test(domain)) {
    throw new TypeError(`Invalid Config Domain ID: ${domain}`);
  }
  const root = path.resolve(rootDirectory);
  return {
    configFile: path.join(root, 'config', `${domain}.json`),
    historyDirectory: path.join(root, 'config-history', domain),
    plansDirectory: path.join(root, 'config-plans', domain),
    lockFile: path.join(root, 'config', `.${domain}.lock`),
  };
}
