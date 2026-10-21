import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
export const BOT_ROOT = path.resolve(here, '..')

const truthy = (v) => v != null && /^(1|true|yes|on)$/i.test(String(v))

/**
 * Loads config.json (or CELEVENT_CONFIG) and layers environment overrides on
 * top. Secrets only ever come from the environment, never from the file.
 */
export function loadConfig({ env = process.env, file } = {}) {
  const configPath = file ?? env.CELEVENT_CONFIG ?? path.join(BOT_ROOT, 'config.json')
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))

  // LLM backend: explicit LLM_PROVIDER, else Ollama when it's configured and
  // there's no Anthropic key.
  const llmProvider = env.LLM_PROVIDER
    ?? (!env.ANTHROPIC_API_KEY && (env.OLLAMA_API_KEY || env.OLLAMA_HOST) ? 'ollama' : 'anthropic')
  if (llmProvider === 'ollama') cfg.review.model = cfg.review.ollama_model
  if (env.CELEVENT_MODEL) cfg.review.model = env.CELEVENT_MODEL
  if (env.DRY_RUN != null) cfg.repost.dry_run = truthy(env.DRY_RUN)

  cfg.env = {
    databaseUrl: env.DATABASE_URL ?? 'postgres://celevent:celevent@localhost:5432/celevent',
    llmProvider,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    ollamaApiKey: env.OLLAMA_API_KEY,
    // Ollama Cloud when a key is set, otherwise the local daemon.
    ollamaHost: env.OLLAMA_HOST ?? (env.OLLAMA_API_KEY ? 'https://ollama.com' : 'http://localhost:11434'),
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    authMode: env.BSKY_AUTH ?? (env.BSKY_APP_PASSWORD ? 'app_password' : 'oauth'),
    service: env.BSKY_SERVICE ?? 'https://bsky.social',
    identifier: env.BSKY_IDENTIFIER,
    appPassword: env.BSKY_APP_PASSWORD,
    oauthDid: env.BSKY_OAUTH_DID,
    oauthScope: env.BSKY_OAUTH_SCOPE ?? 'atproto transition:generic',
    oauthPort: Number(env.BSKY_OAUTH_PORT ?? 8789),
  }

  validate(cfg)
  return cfg
}

function validate(cfg) {
  const need = (cond, msg) => { if (!cond) throw new Error(`config: ${msg}`) }
  need(cfg.region?.location_terms?.length, 'region.location_terms is required')
  need(cfg.review?.batch_size > 0, 'review.batch_size must be > 0')
  need(cfg.review.min_confidence >= 0 && cfg.review.min_confidence <= 1, 'review.min_confidence must be 0..1')
  need(['app_password', 'oauth'].includes(cfg.env.authMode), 'BSKY_AUTH must be app_password or oauth')
  need(['anthropic', 'ollama'].includes(cfg.env.llmProvider), 'LLM_PROVIDER must be anthropic or ollama')
}
