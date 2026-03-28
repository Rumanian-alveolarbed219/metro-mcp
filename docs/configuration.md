# Configuration

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `METRO_HOST` | `localhost` | Metro bundler host |
| `METRO_PORT` | `8081` | Metro bundler port |
| `DEBUG` | — | Enable debug logging |

## CLI Arguments

```bash
npx -y metro-mcp --host 192.168.1.100 --port 19000
# or
bunx metro-mcp --host 192.168.1.100 --port 19000
```

## Config File

Create `metro-mcp.config.ts` in your project root:

```typescript
import { defineConfig } from 'metro-mcp';

export default defineConfig({
  metro: {
    host: 'localhost',
    port: 8081,
    autoDiscover: true,  // Scan common ports automatically
  },
  plugins: [],
  bufferSizes: {
    logs: 500,
    network: 200,
    errors: 100,
  },
  network: {
    interceptFetch: false,  // Opt-in: inject JS to wrap fetch()
  },
});
```
