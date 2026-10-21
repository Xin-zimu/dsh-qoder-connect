import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderLlmError } from '../../src/qoder/errors.ts'
import { parseQoderSse } from '../../src/qoder/transport/wire/sse.ts'

function streamOf(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

function data(body: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}`
}

const done = `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}`

test('parseQoderSse unwraps text, disjoint usage, and envelope-body DONE', async () => {
  const body = JSON.stringify({
    choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    },
  })
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    `data: ${JSON.stringify({ statusCodeValue: 200, body })}`,
    `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}`,
  ]))) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual((chunks[3] as { usage: unknown }).usage, {
    inputTokens: 7,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  })
})

test('parseQoderSse separates native reasoning and removes cross-channel thinking tags', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { reasoning_content: '<thinking>inspect the input' } }] }),
    data({ choices: [{ delta: { content: '</thinking>\n\nFinal answer' }, finish_reason: 'stop' }] }),
    done,
  ]))) chunks.push(chunk)

  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'block-end', 'finish',
  ])
  assert.deepEqual((chunks[2] as { block: unknown }).block, { type: 'reasoning', text: 'inspect the input' })
  assert.deepEqual((chunks[5] as { block: unknown }).block, { type: 'text', text: 'Final answer' })
  assert.equal((chunks[6] as { reason: { kind: string } }).reason.kind, 'stop')
})

test('parseQoderSse extracts thinking tags split across content chunks', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { content: '<thi' } }] }),
    data({ choices: [{ delta: { content: 'nk>careful</th' } }] }),
    data({ choices: [{ delta: { content: 'ink>\nanswer' }, finish_reason: 'stop' }] }),
    done,
  ]))) chunks.push(chunk)
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(blocks, [
    { type: 'reasoning', text: 'careful' },
    { type: 'text', text: 'answer' },
  ])
})

test('parseQoderSse assembles interleaved parallel tool calls', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-a', function: { name: 'add', arguments: '{"a":' } },
      { index: 1, id: 'call-b', function: { name: 'echo', arguments: '{"text":' } },
    ] } }] }),
    data({ choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: '"ok"}' } },
      { index: 0, function: { arguments: '2}' } },
    ] }, finish_reason: 'tool_calls' }] }),
    done,
  ]))) chunks.push(chunk)

  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(blocks, [
    { type: 'tool-call', id: 'call-a', name: 'add', arguments: '{"a":2}' },
    { type: 'tool-call', id: 'call-b', name: 'echo', arguments: '{"text":"ok"}' },
  ])
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'tool-calls')
})

test('parseQoderSse normalizes absent tool arguments to an empty object', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-empty', function: { name: 'ping' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    done,
  ]))) chunks.push(chunk)
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(blockEnd?.block, {
    type: 'tool-call', id: 'call-empty', name: 'ping', arguments: '{}',
  })
})

test('parseQoderSse tolerates subsequent tool-call deltas with empty string or null id', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-tolerant', function: { name: 'calc', arguments: '{"x":' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { arguments: '1' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { arguments: '0}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    done,
  ]))) chunks.push(chunk)
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(blockEnd?.block, {
    type: 'tool-call', id: 'call-tolerant', name: 'calc', arguments: '{"x":10}',
  })
})

test('parseQoderSse tolerates subsequent tool-call deltas with empty string or null name', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-tolerant-name', function: { name: 'calc', arguments: '{"x":' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '1' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '0}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    done,
  ]))) chunks.push(chunk)
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(blockEnd?.block, {
    type: 'tool-call', id: 'call-tolerant-name', name: 'calc', arguments: '{"x":10}',
  })
})

test('parseQoderSse accepts a reasoning-only response', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { reasoning_content: 'Only reasoning' }, finish_reason: 'stop' }] }),
    done,
  ]))) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'reasoning-delta', 'block-end', 'finish',
  ])
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'stop')
})

test('parseQoderSse rejects unidentifiable tool calls and unknown finish reasons', async () => {
  const invalidStreams = [
    [
      // No id and no name: nothing could execute this call.
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bad', arguments: '{}' } }] } }] }),
      done,
    ],
    [data({ choices: [{ delta: { content: 'blocked' }, finish_reason: 'new_reason' }] }), done],
  ]
  for (const lines of invalidStreams) {
    await assert.rejects(async () => {
      for await (const _chunk of parseQoderSse(streamOf(lines))) continue
    }, (error: Error) => error instanceof QoderLlmError && error.code === 'MALFORMED_RESPONSE')
  }
})

test('parseQoderSse hands unparsable arguments to the harness instead of ending the turn', async () => {
  // A length-capped call whose arguments never closed is truncation, not corruption: the
  // harness keeps the raw text and answers the model, so the turn lives.
  const chunks: { type: string; [key: string]: unknown }[] = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-bad', function: { name: 'bad', arguments: '{' } },
    ] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    done,
  ]))) chunks.push(chunk as { type: string })

  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'tool-call-delta', 'block-end', 'finish',
  ])
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'tool-calls')
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end') as {
    block: { name: string; arguments: string }
  }
  assert.equal(blockEnd.block.name, 'bad')
  assert.equal(blockEnd.block.arguments, '{')
})

test('parseQoderSse survives a torn tail after a complete argument object, and reports it', async () => {
  // Captured from the live upstream for #21 (raw-before.txt): the call's arguments close as a
  // valid object, then the provider appends one more fragment under the same index - and a
  // frame carries it as a second entry rather than a new index - while the terminal reason is
  // `tool_calls`, not `length`.
  const diagnostics: string[] = []
  const chunks: { type: string; [key: string]: unknown }[] = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: {
      content: '', role: 'assistant',
      tool_calls: [{ function: { arguments: '', name: 'emit_report' }, id: 'call_1a3624ed1c5e4f3aad8cb48b', index: 0, type: 'function' }],
    } }] }),
    data({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"summary":"report' }, id: '', index: 0, type: 'function' }] } }] }),
    data({ choices: [{ delta: { tool_calls: [
      { function: { arguments: '"}' }, id: '', index: 0, type: 'function' },
      { function: { arguments: '在' }, id: '', index: 0, type: 'function' },
    ] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    done,
  ]), { onDiag: message => diagnostics.push(message) })) chunks.push(chunk as { type: string })

  const blockEnd = chunks.find(chunk => chunk.type === 'block-end') as {
    block: { type: string; name: string; arguments: string }
  }
  assert.equal(blockEnd.block.name, 'emit_report')
  // The block carries what upstream sent. The shim forwards deltas only, so the
  // adapter layer (not this one) rebuilds the call from the delta stream.
  assert.equal(blockEnd.block.arguments, '{"summary":"report"}在')
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'tool-calls')
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0]!, /damaged arguments \(closed at 20 chars, 1-char tail\)/u)
})

test('parseQoderSse answers a never-closed argument object as a tool error, not a dead turn', async () => {
  // Third live shape for #21: the arguments stop mid-string and the provider still claims
  // `tool_calls`. The bytes began as JSON, so the harness gets the call and reports it.
  const diagnostics: string[] = []
  const chunks: { type: string; [key: string]: unknown }[] = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-open', function: { name: 'emit_report', arguments: '{"summary":"a long' } },
    ] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    done,
  ]), { onDiag: message => diagnostics.push(message) })) chunks.push(chunk as { type: string })

  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'tool-calls')
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end') as { block: { arguments: string } }
  assert.equal(blockEnd.block.arguments, '{"summary":"a long')
  assert.match(diagnostics[0]!, /never closed/u)
})

test('parseQoderSse keeps a payload that never claimed to be JSON fatal', async () => {
  // Not a damaged attempt: a tool call whose arguments are prose means the stream itself is
  // wrong, and that stays loud.
  for (const args of ['not json at all', '}', '```json\n{}\n```']) {
    await assert.rejects(async () => {
      for await (const _chunk of parseQoderSse(streamOf([
        data({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call-foreign', function: { name: 'emit_report', arguments: args } },
        ] } }] }),
        done,
      ]))) continue
    }, (error: Error) => error instanceof QoderLlmError && error.code === 'MALFORMED_RESPONSE')
  }
})

test('parseQoderSse hands a truncated tool call to the harness instead of ending the turn', async () => {
  // pi-ai turns unfinishable arguments into `{}` plus a tool error, so the call must be
  // emitted rather than thrown.
  const chunks: { type: string; [key: string]: unknown }[] = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-cmp', function: { name: 'compress', arguments: '{"summary":"' } },
    ] } }] }),
    data({ choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: 'long summary that never closes' } },
    ] }, finish_reason: 'length' }] }),
    done,
  ]))) chunks.push(chunk as { type: string })

  // The call survives so the harness can report the tool error back to the model.
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'finish',
  ])
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'tool-calls')
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end') as {
    block: { type: string; name: string; arguments: string }
  }
  assert.equal(blockEnd.block.name, 'compress')
  assert.throws(() => JSON.parse(blockEnd.block.arguments))
})

test('parseQoderSse ends a truncated call with no identifying fields without an error', async () => {
  // A nameless call cannot be executed: it is dropped and the turn ends as `max-tokens`.
  const chunks: { type: string; [key: string]: unknown }[] = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"sum' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    done,
  ]))) chunks.push(chunk as { type: string })

  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'max-tokens')
  assert.equal(chunks.some(chunk => chunk.type === 'block-end'), false)

  // Without the cap, an unnamed tool call is still provider corruption.
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] }),
      done,
    ]))) continue
  }, (error: Error) => (
    error instanceof QoderLlmError && error.code === 'MALFORMED_RESPONSE'
  ))
})

test('parseQoderSse keeps rejecting a truncated-stream EOF as a transport failure', async () => {
  // A stream that never reached [DONE] stays a retryable transport fault.
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      data({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }] }),
    ]))) continue
  }, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal(error.code, 'TRANSPORT')
    assert.match(error.message, /stream ended without/u)
    assert.doesNotMatch(error.message, /\d/u)
    return true
  })
})

test('parseQoderSse accepts a final frame without a trailing newline', async () => {
  const encoder = new TextEncoder()
  const inner = JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n`))
      controller.enqueue(encoder.encode('data: [DONE]'))
      controller.close()
    },
  })
  const chunks = []
  for await (const chunk of parseQoderSse(stream)) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('parseQoderSse accepts statusless envelopes and ignores bodyless control frames', async () => {
  const inner = JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    `data: ${JSON.stringify({ event: 'ping' })}`,
    `data: ${JSON.stringify({ body: inner })}`,
    `data: ${JSON.stringify({ body: '[DONE]' })}`,
  ]))) chunks.push(chunk)

  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'text-delta', 'block-end', 'finish',
  ])
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'stop')
})

test('parseQoderSse rejects invalid status, malformed body, and premature EOF', async () => {
  const invalid = [
    [`data: ${JSON.stringify({ statusCodeValue: '200', body: '{}' })}`],
    [`data: ${JSON.stringify({ statusCodeValue: 200, body: 42 })}`],
    [`data: ${JSON.stringify({ statusCodeValue: 200, body: '{}' })}`],
  ]
  for (const lines of invalid) {
    await assert.rejects(async () => {
      for await (const _chunk of parseQoderSse(streamOf(lines))) continue
    }, (error: Error) => {
      assert.ok(error instanceof QoderLlmError)
      return true
    })
  }
})

test('parseQoderSse treats EOF after finish_reason as a retryable transport truncation', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      data({ choices: [{ delta: { content: 'complete-looking' }, finish_reason: 'stop' }] }),
    ]))) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'TRANSPORT')
})

test('parseQoderSse preserves explicit upstream error statuses', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      `data: ${JSON.stringify({ statusCodeValue: 503, body: 'unavailable' })}`,
    ]))) continue
  }, (error: Error) => (
    error instanceof QoderLlmError
    && error.code === 'SERVER'
    && error.failure.status === 503
    && error.message === 'Qoder service returned upstream error status 503: unavailable'
  ))
})

test('parseQoderSse forwards the envelope body into the error message', async () => {
  // A non-200 envelope's body carries the upstream's own reason (quota, region,
  // risk control); discarding it made every rejection read as a bare "invalid API key".
  const upstreamBody = JSON.stringify({ code: 403, message: 'quota exhausted for this model' })
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      `data: ${JSON.stringify({ statusCodeValue: 403, body: upstreamBody })}`,
    ]))) continue
  }, (error: Error) => (
    error instanceof QoderLlmError
    && error.code === 'AUTH'
    && error.failure.status === 403
    && error.message === `Qoder service returned upstream error status 403: ${upstreamBody}`
  ))
})

test('parseQoderSse rejects an oversized unterminated frame', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: 12345678901234567890'))
      controller.close()
    },
  })
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(stream, { maxBufferChars: 16 })) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'MALFORMED_RESPONSE')
})
