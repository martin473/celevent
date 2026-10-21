/**
 * Ollama calls used by discovery and scraping: chat with tool calling, plus
 * Ollama's hosted web search and web fetch (these need OLLAMA_API_KEY and
 * always go to ollama.com, even if chat runs on a local daemon).
 */
export function ollamaApi({ host = 'https://ollama.com', apiKey, fetchImpl = fetch, sleep, timeoutMs = 90_000 }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const base = host.replace(/\/+$/, '')

  async function post(url, body, label) {
    let lastErr
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
      })
      if (res.ok) return res.json()
      const detail = await res.text().catch(() => '')
      lastErr = new Error(`ollama ${label} ${res.status}: ${detail.slice(0, 300)}`)
      if (res.status !== 429 && res.status < 500) throw lastErr
      await wait(1000 * 2 ** attempt)
    }
    throw lastErr
  }

  return {
    /** One /api/chat round trip. Returns the assistant message. */
    async chat({ model, messages, tools, format, temperature = 0 }) {
      const data = await post(`${base}/api/chat`, {
        model, messages, tools, format, stream: false, options: { temperature },
      }, 'chat')
      return { message: data.message ?? { role: 'assistant', content: '' }, usage: { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 } }
    },
    async webSearch(query, maxResults = 5) {
      if (!apiKey) throw new Error('web search needs OLLAMA_API_KEY')
      const data = await post('https://ollama.com/api/web_search', { query, max_results: maxResults }, 'web_search')
      return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, content: (r.content ?? '').slice(0, 800) }))
    },
    async webFetch(url) {
      if (!apiKey) throw new Error('web fetch needs OLLAMA_API_KEY')
      const data = await post('https://ollama.com/api/web_fetch', { url }, 'web_fetch')
      return { title: data.title, content: (data.content ?? '').slice(0, 6000), links: (data.links ?? []).slice(0, 60) }
    },
  }
}

/**
 * Generic tool-calling loop. `tools` maps name -> { description, parameters,
 * run(args) }. The loop ends when the model calls `finalTool` (whose args are
 * returned) or after maxSteps.
 */
export async function runToolLoop({ api, model, system, user, tools, finalTool, maxSteps = 8, log }) {
  const specs = Object.entries(tools).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description, parameters: t.parameters },
  }))
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }]
  const usage = { input: 0, output: 0 }

  const finalOnly = specs.filter((t) => t.function.name === finalTool)
  for (let step = 0; step < maxSteps; step++) {
    // Last step: only the final tool is offered, so a model that keeps
    // researching is made to answer with what it has instead of timing out.
    const last = step === maxSteps - 1
    if (last) messages.push({ role: 'user', content: `No more searches. Call ${finalTool} now with what you have found; leave unknown fields empty.` })
    const { message, usage: u } = await api.chat({ model, messages, tools: last ? finalOnly : specs })
    usage.input += u.input
    usage.output += u.output
    messages.push(message)
    const calls = message.tool_calls ?? []
    if (!calls.length) {
      messages.push({ role: 'user', content: `Call ${finalTool} with your answer now.` })
      continue
    }
    for (const call of calls) {
      const name = call.function?.name
      const args = parseArgs(call.function?.arguments)
      if (name === finalTool) return { result: args, usage, steps: step + 1 }
      const tool = tools[name]
      let output
      try {
        output = tool ? await tool.run(args) : { error: `unknown tool ${name}` }
      } catch (err) {
        output = { error: err.message }
      }
      log?.info('tool call', { tool: name, args })
      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(output).slice(0, 8000) })
    }
  }
  return { result: null, usage, steps: maxSteps }
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a
  try { return JSON.parse(a ?? '{}') } catch { return {} }
}
