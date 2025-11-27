# Configuration Management

This project uses environment-based configuration with support for multiple environments.

## Environment Files

The configuration system loads environment variables from multiple files with the following precedence (later files override earlier ones):

1. **`.env`** - Base configuration, committed to git
2. **`.env.{NODE_ENV}`** - Environment-specific (development, production, test), committed to git
3. **`.env.local`** - Local overrides, **NEVER committed to git**

### Available Environment Files

- **`.env.development`** - Development environment defaults
- **`.env.production`** - Production environment settings
- **`.env.test`** - Test environment configuration
- **`.env.example`** - Template for all available configuration options

## Usage

### Development

For local development, the system automatically loads `.env.development`:

```bash
npm run dev
```

To override settings locally without modifying tracked files:

1. Copy `.env.example` to `.env.local`
2. Add your local overrides (API keys, custom ports, etc.)
3. `.env.local` is git-ignored and safe for secrets

### Production

```bash
NODE_ENV=production npm start
```

**IMPORTANT**: Never store secrets in `.env.production`. Use environment variables or secrets management:
- Kubernetes secrets
- Docker secrets
- Cloud provider secret managers (AWS Secrets Manager, Azure Key Vault, etc.)
- Environment variables in your deployment platform

### Testing

```bash
NODE_ENV=test npm test
```

## Configuration Options

### Server
- `NODE_ENV` - Environment (development | production | test)
- `PORT` - HTTP server port (default: 3000)
- `WS_PORT` - WebSocket server port (default: 3001)

### Services
- `REDIS_URL` - Redis connection URL
- `DATABASE_URL` - PostgreSQL connection URL
- `ASR_SERVICE_URL` - Automatic Speech Recognition service
- `TTS_SERVICE_URL` - Text-to-Speech service
- `VERIFICATION_SERVICE_URL` - Verification service
- `VECTOR_STORE_URL` - Vector store service

### LLM
- `OPENAI_API_KEY` - OpenAI API key (primary)
- `LLM_API_KEY` - Alternative LLM API key
- `LLM_MODEL` - Model to use (default: gpt-4)

### GitHub Integration
- `GITHUB_TOKEN` - GitHub personal access token for code search

### Performance
- `MAX_LATENCY_MS` - Maximum allowed latency (default: 500ms)
- `API_REFRESH_INTERVAL_MS` - API data refresh interval (default: 180000ms / 3min)

### Session
- `SESSION_TIMEOUT_MS` - Session timeout (default: 300000ms / 5min)

### Logging
- `LOG_LEVEL` - Log level (fatal | error | warn | info | debug | trace)

### Verification
- `VERIFICATION_ENABLED` - Enable/disable verification (default: true)

## Best Practices

### Development
1. Use `.env.local` for your personal API keys and local settings
2. Never commit `.env.local`
3. Keep `.env.development` with safe defaults for team members

### Production
1. Use environment variables or secrets management for all sensitive data
2. Never hardcode API keys or passwords
3. Use minimal logging (`LOG_LEVEL=info` or `error`)
4. Enable all security features (`VERIFICATION_ENABLED=true`)

### Testing
1. Use mock values for external services
2. Use different ports to avoid conflicts with development
3. Disable features that slow down tests (if appropriate)
4. Use minimal logging for clean test output

## Example: Local Development Setup

1. Copy the example file:
```bash
cp .env.example .env.local
```

2. Add your API keys:
```env
# .env.local
OPENAI_API_KEY=sk-your-actual-api-key
GITHUB_TOKEN=ghp_your-github-token
LOG_LEVEL=debug
```

3. Start development:
```bash
npm run dev
```

The system will load in order:
1. `.env` (base)
2. `.env.development` (dev defaults)
3. `.env.local` (your secrets) ← overrides everything

## Troubleshooting

### Configuration not loading
- Check that your `.env` files are in the project root
- Verify `NODE_ENV` is set correctly
- Run with `LOG_LEVEL=debug` to see which files are loaded

### API key not working
- Verify the key is set in `.env.local` or environment variables
- Check there are no trailing spaces in the value
- Ensure the placeholder value (`your-api-key-here`) is replaced

### Wrong environment loading
- Check `NODE_ENV` environment variable
- Verify the correct `.env.{NODE_ENV}` file exists
- Remember: `.env.local` always takes precedence
