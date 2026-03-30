import { createMarkdownRenderer } from 'vitepress'

interface Release {
  tag: string
  name: string
  date: string
  body: string
  url: string
  prerelease: boolean
}

export default {
  async load(): Promise<Release[]> {
    const md = await createMarkdownRenderer(process.cwd())

    const res = await fetch('https://api.github.com/repos/steve228uk/metro-mcp/releases', {
      headers: { 'Accept': 'application/vnd.github+json' },
    })

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status}`)
    }

    const releases: any[] = await res.json()

    return releases.map(r => {
      const body = (r.body || '').trim().replace(/^(#{1,5})/gm, '$1#')
      return {
        tag: r.tag_name as string,
        name: (r.name || r.tag_name) as string,
        date: r.published_at as string,
        body: md.render(body),
        url: r.html_url as string,
        prerelease: r.prerelease as boolean,
      }
    })
  },
}
