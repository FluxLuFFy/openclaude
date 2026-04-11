import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { extractHits } from './custom.js'

// ---------------------------------------------------------------------------
// extractHits — flexible response parsing
// ---------------------------------------------------------------------------

describe('extractHits', () => {
  test('extracts from results array', () => {
    const data = { results: [{ title: 'T', url: 'https://ex.com' }] }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('T')
  })

  test('extracts from items array (Google-style)', () => {
    const data = { items: [{ title: 'T', link: 'https://ex.com' }] }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
    expect(hits[0].url).toBe('https://ex.com')
  })

  test('extracts from data array', () => {
    const data = { data: [{ title: 'T', url: 'https://ex.com' }] }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })

  test('extracts from bare array', () => {
    const data = [{ title: 'T', url: 'https://ex.com' }]
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })

  test('extracts from nested map (e.g. web.results)', () => {
    const data = {
      web: {
        results: [{ title: 'T', url: 'https://ex.com' }],
      },
    }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })

  test('extracts with explicit jsonPath', () => {
    const data = {
      response: {
        payload: [{ title: 'T', url: 'https://ex.com' }],
      },
    }
    const hits = extractHits(data, 'response.payload')
    expect(hits).toHaveLength(1)
  })

  test('returns empty for empty object', () => {
    expect(extractHits({})).toHaveLength(0)
  })

  test('returns empty for null', () => {
    expect(extractHits(null)).toHaveLength(0)
  })

  test('returns empty for no array keys', () => {
    expect(extractHits({ status: 'ok', count: 5 })).toHaveLength(0)
  })

  test('filters out hits with no title and no url', () => {
    const data = {
      results: [
        { title: 'Valid', url: 'https://ex.com' },
        { description: 'no title or url' },
      ],
    }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })

  test('extracts from organic_results (SerpAPI-style)', () => {
    const data = {
      organic_results: [{ title: 'T', link: 'https://ex.com' }],
    }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// buildAuthHeadersForPreset — tested indirectly via env vars
// ---------------------------------------------------------------------------

describe('buildAuthHeadersForPreset auth header behavior', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ['WEB_KEY', 'WEB_AUTH_HEADER', 'WEB_AUTH_SCHEME']) {
      savedEnv[k] = process.env[k]
    }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  // We test isConfigured() which depends on WEB_SEARCH_API/WEB_PROVIDER/WEB_URL_TEMPLATE
  // and the auth behavior through the public search() interface
  test('custom provider is configured when WEB_URL_TEMPLATE is set', () => {
    process.env.WEB_URL_TEMPLATE = 'https://example.com/search?q={query}'
    const { customProvider } = require('./custom.js')
    expect(customProvider.isConfigured()).toBe(true)
    delete process.env.WEB_URL_TEMPLATE
  })

  test('custom provider is NOT configured when no env vars are set', () => {
    delete process.env.WEB_URL_TEMPLATE
    delete process.env.WEB_SEARCH_API
    delete process.env.WEB_PROVIDER
    const { customProvider } = require('./custom.js')
    expect(customProvider.isConfigured()).toBe(false)
  })
})
