import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'metro-mcp',
  description: 'React Native runtime debugging, inspection, and automation via MCP',
  base: '/',

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Troubleshooting', link: '/troubleshooting' },
      { text: 'Changelog', link: '/changelog' },
      { text: 'npm', link: 'https://www.npmjs.com/package/metro-mcp' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Client SDK', link: '/sdk' },
          { text: 'Custom Plugins', link: '/plugins' },
          { text: 'Profiling', link: '/profiling' },
          { text: 'Test Recording', link: '/testing' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Tools', link: '/tools' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
    ],

    outline: 'deep',

    socialLinks: [
      { icon: 'github', link: 'https://github.com/steve228uk/metro-mcp' },
    ],

    editLink: {
      pattern: 'https://github.com/steve228uk/metro-mcp/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Stephen Radford',
    },

    search: {
      provider: 'local',
    },
  },
})
