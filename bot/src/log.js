import { randomUUID } from 'node:crypto'

/**
 * Tiny structured logger with spans. Every line is one JSON object, so the
 * output can go straight into Loki, Datadog, CloudWatch, or `jq`.
 *
 *   const span = log.span('collect.search', { q })
 *   ...
 *   span.end({ found: 12 })   // -> {"msg":"span","span":"collect.search","ms":341,...}
 *
 * Spans carry the run's trace_id so one run's lines can be grepped together.
 * This is deliberately dependency-free; swapping in OpenTelemetry later only
 * means reimplementing span().
 */
export function createLogger({ traceId = randomUUID(), sink = defaultSink, base = {} } = {}) {
  const emit = (level, msg, fields = {}) =>
    sink({ ts: new Date().toISOString(), level, msg, trace_id: traceId, ...base, ...fields })

  const log = {
    traceId,
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
    child: (fields) => createLogger({ traceId, sink, base: { ...base, ...fields } }),
    span(name, attrs = {}) {
      const start = performance.now()
      let ended = false
      return {
        end(result = {}) {
          if (ended) return
          ended = true
          const ms = Math.round(performance.now() - start)
          emit('info', 'span', { span: name, ms, ...attrs, ...result })
          return ms
        },
        fail(err, result = {}) {
          if (ended) return
          ended = true
          const ms = Math.round(performance.now() - start)
          emit('error', 'span', { span: name, ms, ...attrs, ...result, error: errMsg(err) })
          return ms
        },
      }
    },
    /** Run fn inside a span; returns fn's result, records failure and rethrows. */
    async trace(name, attrs, fn) {
      const s = log.span(name, attrs)
      try {
        const out = await fn()
        s.end()
        return out
      } catch (err) {
        s.fail(err)
        throw err
      }
    },
  }
  return log
}

export const errMsg = (err) => (err instanceof Error ? err.message : String(err))

function defaultSink(line) {
  const out = line.level === 'error' ? process.stderr : process.stdout
  out.write(JSON.stringify(line) + '\n')
}

/** Silent logger that records lines, for tests. */
export function memoryLogger() {
  const lines = []
  const log = createLogger({ traceId: 'test', sink: (l) => lines.push(l) })
  log.lines = lines
  return log
}

/** Percentile over a numeric array (nearest-rank). */
export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}
