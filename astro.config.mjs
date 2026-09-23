// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmTools from '@wave-rf/starlight-llm-tools';

export default defineConfig({
  site: 'https://issuerd.org',
  integrations: [
    starlight({
      plugins: [starlightLlmTools()],
      title: 'issuerd',
      description:
        'Identity & Access Management in Rust — conformance-tested OIDC/OAuth2, Keycloak-compatible, horizontally scalable, shipped as a single binary.',
      logo: {
        alt: 'issuerd',
        // shown in light mode (dark-coloured artwork)
        light: './src/assets/logo.svg',
        // shown in dark mode (light-coloured artwork)
        dark: './src/assets/white-logo.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.png',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/issuerd/issuerd' },
      ],
      sidebar: [
        { slug: 'docs-overview', label: 'Documentation overview' },
        {
          label: 'First steps',
          items: [
            { slug: 'getting-started', label: 'Getting started' },
            { slug: 'configuration' },
            { slug: 'provisioning' },
          ],
        },
        {
          label: 'Deployment',
          items: [{ slug: 'deployment' }, { slug: 'clustering' }, { slug: 'performance' }],
        },
        {
          label: 'Administration & integration',
          items: [
            { slug: 'administration' },
            { slug: 'client-integration', label: 'Client integration' },
          ],
        },
        {
          label: 'Agentic & MCP workloads',
          items: [
            { slug: 'agentic-iam-mcp', label: 'Agentic IAM: MCP tool calls' },
            { slug: 'ciba-step-up', label: 'Human step-up with CIBA' },
          ],
        },
        {
          label: 'Identity sources',
          items: [
            { slug: 'user-federation', label: 'User federation' },
            { slug: 'ldap-group-mapping', label: 'LDAP group mapping' },
            { slug: 'identity-brokering', label: 'Identity brokering' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { slug: 'security' },
            { slug: 'monitoring' },
            { slug: 'backup-and-upgrade', label: 'Backup & upgrade' },
            { slug: 'troubleshooting' },
          ],
        },
      ],
    }),
  ],
});
