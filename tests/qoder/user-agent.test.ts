/**
 * One client identity for every upstream host.
 *
 * The plugin used to send three different User-Agents (the host attribution on
 * chat, `qoder/…` on metadata, and Node's default `node` on catalog/queue/upload),
 * so the same subscriber looked like three unrelated clients. These tests pin the
 * single constant onto each outbound channel and refuse the host attribution.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createQoderTransport } from '../../src/qoder/transport/index.ts'
import { QoderImageUploader } from '../../src/qoder/transport/image-upload.ts'
import { openApiJsonRequest } from '../../src/qoder/transport/request.ts'
import { qoderIdeVersion, qoderUserAgent, type CosyCredentials } from '../../src/qoder/transport/wire/cosy.ts'

/** The literal the upstream must see; a version bump changes it in one place. */
const EXPECTED_USER_AGENT = 'qoder/1.1.76'

interface RecordedRequest {
  url: string
  headers: Record<string, string>
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

function assertQoderIdentity(request: RecordedRequest): void {
  const headers = request.headers
  // Header lookup is case-insensitive on the wire; the object keeps what we set.
  const name = Object.keys(headers).find(key => key.toLowerCase() === 'user-agent')
  assert.ok(name, `${request.url} sent no user-agent`)
  assert.equal(headers[name], EXPECTED_USER_AGENT, `${request.url} sent the wrong user-agent`)
  const versionNames = Object.keys(headers).filter(key => key.toLowerCase() === 'cosy-version')
  assert.equal(versionNames.length, 1, `${request.url} must send exactly one version header`)
  assert.equal(new Headers(headers).get('cosy-version'), qoderIdeVersion)
  for (const [key, value] of Object.entries(headers)) {
    assert.ok(
      !String(value).includes('deepseek-harness'),
      `${request.url} leaked the host identity in ${key}`,
    )
  }
}

const credentials: CosyCredentials = {
  userID: 'user-ua-test',
  authToken: 'jt-ua-test',
  name: 'UA Test',
  email: 'ua@example.com',
  machineID: 'machine-ua-test',
}

test('the unified identity derives from the one version constant', () => {
  assert.equal(qoderUserAgent, `qoder/${qoderIdeVersion}`)
  assert.equal(qoderUserAgent, EXPECTED_USER_AGENT)
})

test('metadata requests send the Qoder identity', async () => {
  const seen: RecordedRequest[] = []
  const body = await openApiJsonRequest<{ ok: boolean }>(
    (async (input: URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: headerRecord(init) })
      return new Response(JSON.stringify({ ok: true }))
    }) as typeof fetch,
    { url: 'https://openapi.qoder.sh/api/v1/userinfo', operation: 'UA test' },
  )

  assert.equal(body.ok, true)
  assert.equal(seen.length, 1)
  assertQoderIdentity(seen[0]!)
})

test('metadata normalizes conflicting version headers without removing other overrides', async () => {
  await openApiJsonRequest(
    (async (_input: unknown, init?: RequestInit) => {
      const headers = headerRecord(init)
      assertQoderIdentity({ url: 'metadata', headers })
      assert.equal(new Headers(headers).get('cosy-clienttype'), '10')
      return new Response('{}')
    }) as typeof fetch,
    {
      url: 'https://openapi.qoder.sh/api/v1/userinfo',
      operation: 'version header test',
      headers: { 'cosy-version': 'old-lower', 'Cosy-Version': 'old-title', 'COSY-VERSION': 'old-upper', 'cosy-clienttype': '10' },
    },
  )
})

test('the model catalog sends the Qoder identity on its COSY-signed GET', async () => {
  const seen: RecordedRequest[] = []
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-ua-catalog'),
    resolveMachineId: () => 'machine-ua-test',
    fetch: (async (input: URL | Request, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, headers: headerRecord(init) })
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-ua-catalog' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-ua-catalog' }))
      if (url.includes('/model/list')) {
        return new Response(JSON.stringify({ assistant: [{ key: 'cmodel', enable: true, display_name: 'Cantus' }] }))
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await transport.discoverModels()

  const catalog = seen.filter(entry => entry.url.includes('/model/list'))
  assert.equal(catalog.length, 1)
  assertQoderIdentity(catalog[0]!)
})

test('the chat stream and its queue poll share the Qoder identity', async () => {
  const seen: RecordedRequest[] = []
  const queueBody = JSON.stringify({
    code: '10605',
    message: JSON.stringify({ isQueued: true, retryAfterSeconds: 2, queueType: 'p3' }),
  })
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-ua-chat'),
    resolveMachineId: () => 'machine-ua-test',
    queueWaitBudgetMs: () => 80,
    fetch: (async (input: URL | Request, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, headers: headerRecord(init) })
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-ua-chat' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-ua-chat' }))
      if (url.includes('/ask/queue/status')) {
        return new Response(JSON.stringify({ isQueued: false, serviceAvailable: false, retryAfterSeconds: 2 }))
      }
      if (url.includes('/agent_chat_generation')) return new Response(queueBody, { status: 403 })
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  })

  const chat = seen.filter(entry => entry.url.includes('/agent_chat_generation'))
  const poll = seen.filter(entry => entry.url.includes('/ask/queue/status'))
  assert.ok(chat.length >= 1, 'the chat call was not made')
  assert.ok(poll.length >= 1, 'the queue poll was not made')
  for (const entry of [...chat, ...poll]) assertQoderIdentity(entry)
})

test('the image upload sends the Qoder identity on its COSY-signed PUT', async () => {
  const seen: RecordedRequest[] = []
  const uploader = new QoderImageUploader({
    fetch: (async (input: URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: headerRecord(init) })
      return new Response(JSON.stringify({ result: { oss_url: 'https://oss.qoder.sh/a.png' } }))
    }) as typeof fetch,
  })

  const url = await uploader.resolveImageUrl(requestImage(), credentials)

  assert.equal(url, 'https://oss.qoder.sh/a.png')
  assert.equal(seen.length, 1)
  assertQoderIdentity(seen[0]!)
})

function requestImage(overrides: Partial<RequestImageAttachment> = {}): RequestImageAttachment {
  return {
    variantId: 'sha256:variant-1' as never,
    attachment: {
      attachmentId: 'sha256:image-1' as never,
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    },
    data: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
    ...overrides,
  } as RequestImageAttachment
}
