import { z } from 'zod';

const proxyPasswordSchema = z.string()
  .describe('Optional proxy authentication password returned unchanged by local config reads.')
  .meta({
    'x-piskie': {
      recommendedProbe: 'connectivity',
    },
  });

export const proxyProfileConfigSchema = z.strictObject({
  name: z.string().trim().min(1).describe('User-visible proxy name.'),
  protocol: z.enum(['http', 'https', 'socks5']).describe('Proxy transport protocol.'),
  host: z.string().trim().min(1).describe('Proxy server hostname or IP address.'),
  port: z.number().int().min(1).max(65535).describe('Proxy server TCP port.'),
  username: z.string().describe('Optional proxy authentication username.').optional(),
  password: proxyPasswordSchema.optional(),
  enabled: z.boolean().describe('Whether this proxy can be selected for new connections.'),
});

export const proxyPoolStoredDocumentSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  proxies: z.record(z.string().trim().min(1), proxyProfileConfigSchema),
});

